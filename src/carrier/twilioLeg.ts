/**
 * THE TWILIO LEG: a `CallLeg` over a Twilio Media Streams socket (`<Connect><Stream>`).
 *
 * The narrow interface in `leg.ts` was written so this file could be small: parse the vendor's
 * frames, call those methods. Read 2026-11-09 against Twilio's Media Streams WebSocket messages
 * page. What Twilio sends us, all JSON text frames:
 *
 *   connected  once, first. Carries nothing we need.
 *   start      once. `streamSid`, `callSid`, `mediaFormat` and `customParameters`, which is where
 *              the TwiML `<Parameter name="token">` arrives. Nothing else may come before it.
 *   media      base64 μ-law. Twilio documents no payload size, so it is re-chunked here into
 *              `CARRIER_AUDIO.bytesPerFrame` frames, as `leg.ts` asks, never thrown on.
 *   mark       the echo of a mark we sent, once the audio before it PLAYED.
 *   dtmf       a key press.
 *   stop       the call is over.
 *
 * What we send: `media` (base64 μ-law), `mark` and `clear`. Twilio's own page says outbound audio
 * "can be of any size" and is buffered; we still pace it at one frame per 20 ms from our own
 * queue, so the queue that `clear()` empties is the one that actually holds the unplayed audio,
 * and `queuedFrames()` is honest to within the pacer's small lead.
 *
 * 🔴 THE TOKEN IS NOT OURS TO READ. The leg hands the `start` parameters to whoever subscribed with
 * `onStart` (the stream server), which passes the token opaque to the backend. It is never logged
 * and never kept on this object.
 *
 * 🔴 NO AUDIO EITHER WAY BEFORE `accept()`. The server calls `accept()` only once the backend has
 * accepted the token. Before it, inbound media is dropped (counted, never buffered, never handed
 * to anything that could open a recogniser), and a `write()` throws: that is a bug in our code,
 * not a line condition, and no call is live yet to protect.
 *
 * 🔴 AN ECHO AFTER A CLEAR IS NOT A PLAYED MARK. Twilio echoes every pending mark when it receives
 * `clear`. Those echoes are swallowed here, by name, as `leg.ts` requires; forwarding one would
 * tell `OutputGate` that a disclosure was heard when it was thrown away.
 *
 * HANGING UP. This service holds no Twilio credential, so it cannot end a call through the REST
 * API. Closing the socket ends the `<Connect>` verb and Twilio runs the TwiML after it; the
 * backend's TwiML has nothing after it, so the call ends. Whether that holds on a live call is an
 * open unknown in TASK-3748, measured on the first dev call.
 */

import { Buffer } from 'node:buffer';
import { CARRIER_AUDIO, MULAW_SILENCE } from '../audio/format.ts';
import type { CallLeg, CallLegEvents, Frame, HangupReason } from './leg.ts';

/** The one thing the leg needs of a socket. The stream server adapts a `ws` socket to it. */
export interface MediaSocket {
    send(text: string): void;
    close(code: number, reason: string): void;
}

/** What the `start` message carried that anybody outside this file may see. */
export interface StreamStart {
    streamSid: string;
    callSid: string;
    /** Opaque. Passed to the backend and nowhere else. */
    token: string;
}

export interface TwilioLegOptions {
    /** Opaque, for logs. Never a phone number, never the token. */
    id: string;
    socket: MediaSocket;
    /** One line per event: the leg id and an event kind. Never audio, words, digits or tokens. */
    log?: (line: string) => void;
    /** Monotonic milliseconds. Injectable so a test can drive the pacer without sleeping. */
    now?: () => number;
    /**
     * Run `fn` every `ms` until the returned stop function is called. Defaults to `setInterval`.
     * A test passes a no-op and calls `tick()` itself.
     */
    every?: (ms: number, fn: () => void) => () => void;
    /** Frames the pacer may run ahead of real time, to ride over timer jitter. */
    leadFrames?: number;
}

/** A start parameter longer than this is not a token the backend minted. */
export const MAX_TOKEN_LENGTH = 4096;

/** Two frames (40 ms) ahead of real time: enough for timer jitter, short enough for barge-in. */
const DEFAULT_LEAD_FRAMES = 2;

type Phase = 'awaiting_start' | 'started' | 'live' | 'ended';
type Queued = { frame: Frame } | { mark: string };

export class TwilioLeg implements CallLeg {
    readonly id: string;

    private readonly socket: MediaSocket;
    private readonly log: (line: string) => void;
    private readonly now: () => number;
    private readonly every: (ms: number, fn: () => void) => () => void;
    private readonly leadFrames: number;

    private readonly handlers: {
        inbound: Array<CallLegEvents['inbound']>;
        hangup: Array<CallLegEvents['hangup']>;
        marked: Array<CallLegEvents['marked']>;
    } = { inbound: [], hangup: [], marked: [] };
    private readonly startHandlers: Array<(start: StreamStart) => void> = [];
    private readonly dtmfHandlers: Array<(digit: string) => void> = [];

    private phase: Phase = 'awaiting_start';
    private streamSid = '';
    private acceptedAt: number | null = null;
    private stopPacer: (() => void) | null = null;

    /** Inbound bytes short of a whole frame, carried to the next `media` message. */
    private inboundRest: Buffer = Buffer.alloc(0);
    /** Outbound bytes short of a whole frame, carried until more arrive or a mark flushes them. */
    private outboundRest: Buffer = Buffer.alloc(0);
    private queue: Queued[] = [];
    /** Start of the current run of outbound audio, and how many frames of it have been sent. */
    private spurtStart: number | null = null;
    private sentInSpurt = 0;
    /** Marks sent to Twilio and not yet echoed. */
    private readonly sentMarks = new Set<string>();
    /** Marks that were pending at Twilio when we sent `clear`: their echoes are swallowed. */
    private readonly swallow = new Set<string>();
    private unknownLogged = false;

    /** Inbound media dropped because the backend had not accepted the token yet. */
    droppedBeforeAccept = 0;
    /** Frames sent to Twilio. */
    framesSent = 0;
    /** Frames discarded by `clear()` before they were sent. */
    cleared = 0;
    /** Echoes swallowed because their mark was cleared. */
    swallowedEchoes = 0;
    /** Frames written after the call ended. Must stay zero; kept so a test can prove it. */
    writtenAfterHangup = 0;
    /** Every `hangup()` our side made, including one after the far end left. */
    readonly hangupsSent: HangupReason[] = [];
    /** Why the leg ended, once it has. */
    endedBecause: HangupReason | null = null;

    constructor(options: TwilioLegOptions) {
        this.id = options.id;
        this.socket = options.socket;
        this.log = options.log ?? ((line) => { process.stderr.write(`${line}\n`); });
        this.now = options.now ?? (() => performance.now());
        this.every = options.every ?? ((ms, fn) => {
            const timer = setInterval(fn, ms);
            return () => clearInterval(timer);
        });
        this.leadFrames = options.leadFrames ?? DEFAULT_LEAD_FRAMES;
    }

    on<K extends keyof CallLegEvents>(event: K, handler: CallLegEvents[K]): void {
        (this.handlers[event] as Array<CallLegEvents[K]>).push(handler);
    }

    /** The `start` message arrived and was well formed. Fires at most once. */
    onStart(handler: (start: StreamStart) => void): void {
        this.startHandlers.push(handler);
    }

    /** A key was pressed. Only after `accept()`. */
    onDtmf(handler: (digit: string) => void): void {
        this.dtmfHandlers.push(handler);
    }

    get ended(): boolean { return this.phase === 'ended'; }
    get accepted(): boolean { return this.acceptedAt !== null; }

    /** Milliseconds since the backend accepted the call. The supervisor's clock on a real line. */
    get elapsedMs(): number {
        return this.acceptedAt === null ? 0 : this.now() - this.acceptedAt;
    }

    /**
     * The backend accepted the token. From here audio flows both ways and the pacer runs.
     * Throws unless `start` has arrived and the leg is still up: accepting anything else is a bug.
     */
    accept(): void {
        if (this.phase !== 'started') {
            throw new Error(`TwilioLeg.accept in phase ${this.phase}: only a started stream can be accepted`);
        }
        this.phase = 'live';
        this.acceptedAt = this.now();
        this.stopPacer = this.every(CARRIER_AUDIO.frameMs, () => this.tick());
    }

    /** One text frame from the socket. The stream server calls this for every message. */
    receive(text: string): void {
        if (this.phase === 'ended') return;
        let message: TwilioMessage;
        try {
            message = JSON.parse(text) as TwilioMessage;
        } catch {
            this.violation('unparseable_message');
            return;
        }
        if (message === null || typeof message !== 'object') {
            this.violation('unparseable_message');
            return;
        }

        switch (message.event) {
            case 'connected':
                if (this.phase !== 'awaiting_start') this.violation('connected_out_of_order');
                return;
            case 'start':
                this.onStartMessage(message);
                return;
            case 'media':
                this.onMedia(message);
                return;
            case 'mark':
                this.onMarkEcho(message);
                return;
            case 'dtmf':
                if (this.phase !== 'live') return;
                if (typeof message.dtmf?.digit === 'string') {
                    for (const handler of this.dtmfHandlers) handler(message.dtmf.digit);
                }
                return;
            case 'stop':
                this.end('far_end_hung_up');
                return;
            default:
                // Twilio may add an event; an unknown one is logged once and ignored, not fatal.
                if (!this.unknownLogged) {
                    this.unknownLogged = true;
                    this.log(`twilio-leg ${this.id} unknown_event`);
                }
        }
    }

    /** A binary frame. Twilio sends none, so it is a peer we do not understand. */
    receiveBinary(): void {
        this.violation('binary_frame');
    }

    /** The socket closed under us. After `stop` this is a no-op; before it, the transport failed. */
    socketClosed(): void {
        this.end('transport_failed');
    }

    write(frame: Frame): void {
        if (this.phase === 'ended') {
            this.writtenAfterHangup += 1;
            return;
        }
        if (this.phase !== 'live') {
            throw new Error(
                `TwilioLeg.write in phase ${this.phase}: no audio may leave before the backend accepts the call`,
            );
        }
        let bytes = this.outboundRest.length ? Buffer.concat([this.outboundRest, frame]) : Buffer.from(frame);
        const size = CARRIER_AUDIO.bytesPerFrame;
        while (bytes.length >= size) {
            this.queue.push({ frame: bytes.subarray(0, size) });
            bytes = bytes.subarray(size);
        }
        this.outboundRest = bytes;
        this.tick();
    }

    clear(): void {
        if (this.phase === 'ended') return;
        for (const item of this.queue) if ('frame' in item) this.cleared += 1;
        this.queue = [];
        this.outboundRest = Buffer.alloc(0);
        this.spurtStart = null;
        if (this.phase !== 'live') return;
        this.send({ event: 'clear', streamSid: this.streamSid });
        for (const name of this.sentMarks) this.swallow.add(name);
        this.sentMarks.clear();
    }

    queuedFrames(): number {
        let frames = 0;
        for (const item of this.queue) if ('frame' in item) frames += 1;
        return frames;
    }

    /**
     * A mark behind everything written so far. A partial frame still owed is padded with μ-law
     * silence and queued first, so the mark really is behind all of it.
     */
    mark(name: string): void {
        if (this.phase === 'ended') return;
        if (this.phase !== 'live') {
            throw new Error(`TwilioLeg.mark in phase ${this.phase}: nothing can play before the call is accepted`);
        }
        if (this.outboundRest.length) {
            const padded = Buffer.alloc(CARRIER_AUDIO.bytesPerFrame, MULAW_SILENCE);
            this.outboundRest.copy(padded);
            this.queue.push({ frame: padded });
            this.outboundRest = Buffer.alloc(0);
        }
        this.queue.push({ mark: name });
        this.tick();
    }

    async hangup(reason: HangupReason): Promise<void> {
        this.hangupsSent.push(reason);
        this.end(reason);
    }

    /**
     * The pacer. Sends every frame whose time has come, plus `leadFrames` of lead, and every mark
     * that has reached the head of the queue. The interval calls it every frame; `write()` and
     * `mark()` call it too, so the first audio of a sentence leaves at once rather than up to one
     * frame late.
     */
    tick(): void {
        if (this.phase !== 'live') return;
        const now = this.now();
        // A run of audio ends once everything sent in it has had time to play: Twilio's buffer is
        // empty, so the next write starts a new run and silence between sentences is not owed back
        // as a burst. Ending it any earlier (say, whenever our own queue empties) lets a writer that
        // hands over one frame at a time push every frame out at once.
        if (
            this.spurtStart !== null
            && !this.queue.some((item) => 'frame' in item)
            && now - this.spurtStart >= this.sentInSpurt * CARRIER_AUDIO.frameMs
        ) {
            this.spurtStart = null;
        }
        if (this.spurtStart === null && this.queue.some((item) => 'frame' in item)) {
            this.spurtStart = now;
            this.sentInSpurt = 0;
        }
        const due = this.spurtStart === null
            ? 0
            : Math.floor((now - this.spurtStart) / CARRIER_AUDIO.frameMs) + this.leadFrames;
        while (this.queue.length && this.phase === 'live') {
            const head = this.queue[0]!;
            if ('mark' in head) {
                this.queue.shift();
                this.sentMarks.add(head.mark);
                this.send({ event: 'mark', streamSid: this.streamSid, mark: { name: head.mark } });
                continue;
            }
            if (this.sentInSpurt >= due) break;
            this.queue.shift();
            this.sentInSpurt += 1;
            this.framesSent += 1;
            this.send({
                event: 'media',
                streamSid: this.streamSid,
                media: { payload: Buffer.from(head.frame).toString('base64') },
            });
        }
    }

    private onStartMessage(message: TwilioMessage): void {
        if (this.phase !== 'awaiting_start') {
            this.violation('start_out_of_order');
            return;
        }
        const start = message.start;
        const streamSid = typeof message.streamSid === 'string' ? message.streamSid : start?.streamSid;
        if (!start || typeof streamSid !== 'string' || !streamSid || typeof start.callSid !== 'string') {
            this.violation('start_malformed');
            return;
        }
        const format = start.mediaFormat;
        if (
            !format
            || format.encoding !== 'audio/x-mulaw'
            || format.sampleRate !== CARRIER_AUDIO.sampleRate
            || format.channels !== 1
        ) {
            this.violation('media_format_unexpected');
            return;
        }
        const token = start.customParameters?.token;
        if (typeof token !== 'string' || token.trim() === '' || token.length > MAX_TOKEN_LENGTH) {
            this.violation('no_usable_token');
            return;
        }
        this.phase = 'started';
        this.streamSid = streamSid;
        for (const handler of this.startHandlers) handler({ streamSid, callSid: start.callSid, token });
    }

    private onMedia(message: TwilioMessage): void {
        if (this.phase === 'awaiting_start') {
            this.violation('media_before_start');
            return;
        }
        if (this.phase === 'started') {
            // The backend has not accepted the token. The audio is dropped, not buffered: nothing
            // may hear the line before the call is authorised.
            this.droppedBeforeAccept += 1;
            return;
        }
        const media = message.media;
        if (!media || typeof media.payload !== 'string') {
            this.violation('media_malformed');
            return;
        }
        if (media.track !== undefined && media.track !== 'inbound') return;
        const bytes = Buffer.from(media.payload, 'base64');
        let buffered = this.inboundRest.length ? Buffer.concat([this.inboundRest, bytes]) : bytes;
        const size = CARRIER_AUDIO.bytesPerFrame;
        while (buffered.length >= size && this.phase === 'live') {
            const frame = Uint8Array.from(buffered.subarray(0, size));
            buffered = buffered.subarray(size);
            for (const handler of this.handlers.inbound) handler(frame);
        }
        this.inboundRest = Buffer.from(buffered);
    }

    private onMarkEcho(message: TwilioMessage): void {
        if (this.phase !== 'live') return;
        const name = message.mark?.name;
        if (typeof name !== 'string') return;
        if (this.swallow.delete(name)) {
            this.swallowedEchoes += 1;
            return;
        }
        if (!this.sentMarks.delete(name)) return;
        for (const handler of this.handlers.marked) handler(name);
    }

    private send(message: object): void {
        try {
            this.socket.send(JSON.stringify(message));
        } catch {
            this.end('transport_failed');
        }
    }

    private violation(kind: string): void {
        this.log(`twilio-leg ${this.id} ${kind}`);
        this.end('transport_failed');
    }

    private end(reason: HangupReason): void {
        if (this.phase === 'ended') return;
        this.phase = 'ended';
        this.endedBecause = reason;
        this.stopPacer?.();
        this.stopPacer = null;
        this.queue = [];
        this.outboundRest = Buffer.alloc(0);
        this.inboundRest = Buffer.alloc(0);
        // Pending marks never fire: the far end left before the audio did (leg.ts).
        this.sentMarks.clear();
        this.swallow.clear();
        try {
            this.socket.close(1000, '');
        } catch {
            // Already closed. Ending is unconditional either way.
        }
        for (const handler of this.handlers.hangup) handler(reason);
    }
}

/** The fields of a Twilio Media Streams message this file reads. Everything else is ignored. */
interface TwilioMessage {
    event?: string;
    streamSid?: string;
    start?: {
        streamSid?: string;
        callSid?: string;
        mediaFormat?: { encoding?: string; sampleRate?: number; channels?: number };
        customParameters?: Record<string, unknown>;
    };
    media?: { track?: string; payload?: string };
    mark?: { name?: string };
    dtmf?: { digit?: string };
}
