/**
 * THE LOOPBACK CALL: the fake carrier plays a recorded venue through the runtime (TASK-3749, I3P-02).
 *
 * `runLeg` (driver.ts) proves what a socket does at the edge with a tone. This plays a CALL: the
 * venue's turns as real μ-law speech, one after another, with a restaurant-noise bed under and
 * between them, and listens to the agent the way a phone line would. It places no call and
 * reaches no carrier: it opens the one WebSocket it is handed (`connect`), like the driver.
 *
 * Turn-taking is the venue's, not a script's clock. After `start` the venue waits for the agent's
 * first utterance (the disclosure) to finish, then says its first turn; after each turn it waits
 * for the agent to answer and fall quiet, then says the next. A turn the agent never answers is
 * charged the whole wait (`replyWaitMs`) and the venue carries on, as a person on the line would.
 *
 * EVERY TIMING IS READ OFF THE WIRE (the `call.ts` header rule), on the driver's own clock:
 *   - `firstAudioMs`, per turn: from the END OF THE VENUE'S SPEECH in that turn (the clip's
 *     `speechEndMs`, not the end of the clip's trailing noise) to the first non-silent outbound
 *     `media` frame after it. This is the dead air the restaurant hears.
 *   - `startToFirstAudioMs`: from sending `start` to the first non-silent frame: the cold path to
 *     the disclosure (token check, context, synthesis).
 *   - `longestSilenceMs`: after the agent first spoke, the longest stretch in which neither the
 *     agent's audio nor the venue's speech was on the line.
 *
 * The agent's first utterance is kept (`disclosureAudio`) so the caller can transcribe it and hold
 * it to the disclosure sentence. It is the agent's speech, never the venue's, and is not logged.
 *
 * Outbound audio is modelled on a playout clock, as Twilio plays it: each 20 ms frame plays after
 * the one before, and a `mark` is echoed once the audio queued before it has played.
 */

import type { WebSocket } from 'ws';
import { CARRIER_AUDIO, MULAW_SILENCE } from '../audio/format.ts';
import { isSpeechFrame } from '../carrier/vad.ts';
import { VAD } from '../tuning/liveDefaults.ts';
import { CALL_SID, CONNECTED, STREAM_SID, isSilentPayload, startMessage } from './driver.ts';
import type { Connect } from './driver.ts';

const FRAME_MS = CARRIER_AUDIO.frameMs;
const FRAME_BYTES = CARRIER_AUDIO.bytesPerFrame;

export interface CorpusTurn {
    /** 8 kHz μ-law, speech mixed with the noise bed. */
    audio: Uint8Array;
    /** Where the speech in `audio` ends, in ms from the clip's start. First audio is timed from here. */
    speechEndMs: number;
    /** Where the speech starts. Defaults to 0. */
    speechStartMs?: number;
}

export interface CorpusCallPlan {
    token: string;
    turns: readonly CorpusTurn[];
    /** Noise played whenever no turn is: the room the venue is standing in. Silence if absent. */
    bed?: Uint8Array;
    /** How long the venue waits for an answer before it speaks again. Default 8000. */
    replyWaitMs?: number;
    /**
     * The agent counts as finished once its playout has been quiet this long. Default 1500: shorter,
     * and the venue talks into the pause between two sentences of a multi-sentence reply.
     */
    quietMs?: number;
    /** After the last turn is answered, how long to wait for the agent to hang up. Default 10000. */
    endWaitMs?: number;
    /** The whole call is abandoned after this long. Default 180000. */
    timeoutMs?: number;
    /** Monotonic ms. Injectable for tests. */
    clock?: () => number;
}

export interface CorpusTurnOutcome {
    turn: number;
    /** On the driver's clock, ms from `start`. */
    speechEndAtMs: number;
    /** End of the venue's speech to the agent's first audible frame; null when it never answered. */
    firstAudioMs: number | null;
    /**
     * The server ended the call before the venue's wait for an answer ran out, with no answer: a
     * call the agent or the backend ended (a refusal mid-call, a hangup), not dead air.
     */
    endedByServer?: boolean;
}

export interface CorpusCallOutcome {
    upgraded: boolean;
    httpStatus: number | null;
    /** Connect to the WebSocket upgrade. */
    upgradeMs: number | null;
    /** `start` sent to the first non-silent outbound frame. Null when the agent never spoke. */
    startToFirstAudioMs: number | null;
    /** How long the agent's first utterance played, by the playout clock. */
    disclosurePlayedMs: number;
    /** The agent's first utterance, μ-law, for the caller to transcribe. Never logged. */
    disclosureAudio: Uint8Array;
    turns: CorpusTurnOutcome[];
    /** Venue turns actually played before the line closed. */
    turnsPlayed: number;
    longestSilenceMs: number;
    closedBy: 'server' | 'client' | 'timeout' | 'error';
    closeCode: number | null;
    /** `start` to the close. */
    callMs: number;
    audibleFramesOut: number;
    /** Non-silent frames that arrived after the venue sent `stop`. Must be 0. */
    framesAfterStop: number;
    marksEchoed: number;
    error: string | null;
}

type Phase =
    | { kind: 'await-disclosure' }
    | { kind: 'playing'; turn: number; offset: number; startedAt: number }
    | { kind: 'await-reply'; turn: number; endedAt: number }
    | { kind: 'await-end'; since: number }
    | { kind: 'stopped' };

export async function runCorpusCall(connect: Connect, url: string, plan: CorpusCallPlan): Promise<CorpusCallOutcome> {
    const clock = plan.clock ?? (() => performance.now());
    const replyWaitMs = plan.replyWaitMs ?? 8000;
    const quietMs = plan.quietMs ?? 1500;
    const endWaitMs = plan.endWaitMs ?? 10_000;
    const timeoutMs = plan.timeoutMs ?? 180_000;
    const bed = plan.bed && plan.bed.length >= FRAME_BYTES ? plan.bed : null;

    const connectAt = clock();
    let startAt = connectAt;
    const at = (): number => clock() - startAt;

    const outcome: CorpusCallOutcome = {
        upgraded: false,
        httpStatus: null,
        upgradeMs: null,
        startToFirstAudioMs: null,
        disclosurePlayedMs: 0,
        disclosureAudio: new Uint8Array(0),
        turns: [],
        turnsPlayed: 0,
        longestSilenceMs: 0,
        closedBy: 'server',
        closeCode: null,
        callMs: 0,
        audibleFramesOut: 0,
        framesAfterStop: 0,
        marksEchoed: 0,
        error: null,
    };

    // The playout clock: when the last queued outbound frame finishes playing, and when the last
    // frame with speech in it did. Times are on the driver clock, ms from `start`.
    let playoutEnd = 0;
    let lastSpeechOut = -Infinity;
    let firstAudibleAt: number | null = null;
    const disclosure: Uint8Array[] = [];
    let disclosureOpen = true;
    // Who was audible, slot by slot (one per 20 ms), for the longest-silence reading.
    const agentSlots = new Set<number>();
    const venueSpans: Array<[number, number]> = [];

    let phase: Phase = { kind: 'await-disclosure' };
    let bedOffset = 0;
    let seq = 1;
    let sent = 0;
    let stopSent = false;

    return new Promise<CorpusCallOutcome>((resolve) => {
        const ws: WebSocket = connect(url, { perMessageDeflate: false, handshakeTimeout: 15_000 });
        let ourClose: CorpusCallOutcome['closedBy'] | null = null;
        let errored = false;
        let pacer: NodeJS.Timeout | null = null;
        let done = false;
        const markTimers = new Set<NodeJS.Timeout>();

        const finish = (): void => {
            if (done) return;
            done = true;
            if (pacer) clearInterval(pacer);
            clearTimeout(giveUp);
            for (const t of markTimers) clearTimeout(t);
            outcome.callMs = Math.round(at());
            const last = outcome.turns[outcome.turns.length - 1];
            if (last && last.firstAudioMs === null && outcome.closedBy === 'server' && at() - last.speechEndAtMs < replyWaitMs) {
                last.endedByServer = true;
            }
            outcome.disclosureAudio = Buffer.concat(disclosure);
            outcome.longestSilenceMs = longestSilence(agentSlots, venueSpans, firstAudibleAt, at());
            resolve(outcome);
        };
        const closeOurs = (by: CorpusCallOutcome['closedBy']): void => {
            if (ws.readyState !== ws.OPEN) return;
            ourClose ??= by;
            ws.close(1000, '');
            setTimeout(() => { ws.terminate(); }, 2000).unref();
        };
        const giveUp = setTimeout(() => {
            if (ws.readyState === ws.OPEN) closeOurs('timeout');
            else {
                outcome.closedBy = 'timeout';
                ws.terminate();
                finish();
            }
        }, timeoutMs);

        const send = (text: string): void => { if (ws.readyState === ws.OPEN) ws.send(text); };
        const sendStop = (): void => {
            if (stopSent) return;
            stopSent = true;
            send(JSON.stringify({ event: 'stop', sequenceNumber: String(++seq), streamSid: STREAM_SID, stop: { callSid: CALL_SID } }));
        };

        /** The next 20 ms of what the venue's line carries, and whether the venue is speaking in it. */
        const nextFrame = (): Uint8Array => {
            if (phase.kind === 'playing') {
                const audio = plan.turns[phase.turn]!.audio;
                const frame = new Uint8Array(FRAME_BYTES).fill(MULAW_SILENCE);
                frame.set(audio.subarray(phase.offset, Math.min(audio.length, phase.offset + FRAME_BYTES)));
                phase.offset += FRAME_BYTES;
                return frame;
            }
            if (bed === null) return new Uint8Array(FRAME_BYTES).fill(MULAW_SILENCE);
            const frame = new Uint8Array(FRAME_BYTES);
            for (let i = 0; i < FRAME_BYTES; i += 1) frame[i] = bed[(bedOffset + i) % bed.length]!;
            bedOffset = (bedOffset + FRAME_BYTES) % bed.length;
            return frame;
        };

        const agentQuiet = (now: number): boolean => playoutEnd <= now && now - lastSpeechOut >= quietMs;

        const startTurn = (turn: number, now: number): void => {
            if (turn >= plan.turns.length) {
                phase = { kind: 'await-end', since: now };
                return;
            }
            phase = { kind: 'playing', turn, offset: 0, startedAt: now };
            outcome.turnsPlayed += 1;
        };

        /** Advance the venue's side of the conversation. Called once per frame sent. */
        const step = (now: number): void => {
            switch (phase.kind) {
                case 'await-disclosure':
                    // The disclosure has played (speech was heard, then quiet), or it never came.
                    if ((lastSpeechOut > -Infinity && agentQuiet(now)) || (lastSpeechOut === -Infinity && now >= replyWaitMs)) {
                        disclosureOpen = false;
                        startTurn(0, now);
                    }
                    return;
                case 'playing': {
                    const turn = plan.turns[phase.turn]!;
                    if (phase.offset < turn.audio.length) return;
                    const endedAt = phase.startedAt + turn.speechEndMs;
                    venueSpans.push([phase.startedAt + (turn.speechStartMs ?? 0), endedAt]);
                    outcome.turns.push({ turn: phase.turn, speechEndAtMs: Math.round(endedAt), firstAudioMs: null });
                    phase = { kind: 'await-reply', turn: phase.turn, endedAt };
                    return;
                }
                case 'await-reply': {
                    const row = outcome.turns[outcome.turns.length - 1]!;
                    const answered = row.firstAudioMs !== null;
                    if ((answered && agentQuiet(now)) || (!answered && now - phase.endedAt >= replyWaitMs)) {
                        startTurn(phase.turn + 1, now);
                    }
                    return;
                }
                case 'await-end':
                    if (now - phase.since >= endWaitMs && agentQuiet(now)) {
                        sendStop();
                        phase = { kind: 'stopped' };
                        closeOurs('client');
                    }
                    return;
                case 'stopped':
                    return;
            }
        };

        // A function, not an inline test: `step` moves `phase` and the checker cannot see that.
        const stopped = (): boolean => phase.kind === 'stopped';
        const tick = (): void => {
            if (ws.readyState !== ws.OPEN || stopped()) return;
            // Catch up to real time: a late timer sends the frames it owes, so the venue's audio
            // keeps its own pace however the event loop jitters.
            const due = Math.floor(at() / FRAME_MS);
            while (sent < due && !stopped()) {
                const now = sent * FRAME_MS;
                step(now);
                if (stopped()) break;
                const frame = nextFrame();
                send(JSON.stringify({
                    event: 'media',
                    sequenceNumber: String(++seq),
                    streamSid: STREAM_SID,
                    media: { track: 'inbound', chunk: String(sent + 1), timestamp: String(now), payload: Buffer.from(frame).toString('base64') },
                }));
                sent += 1;
            }
        };

        ws.on('unexpected-response', (_req, res) => {
            outcome.httpStatus = res.statusCode ?? 0;
            res.resume();
            ws.terminate();
            finish();
        });
        ws.on('error', (error: Error) => {
            outcome.error = /^[A-Za-z_$][\w$]*$/.test(error.name) ? error.name : 'Error';
            errored = true;
            if (!outcome.upgraded && outcome.httpStatus === null) {
                outcome.closedBy = 'error';
                finish();
            }
        });
        ws.on('close', (code: number) => {
            outcome.closeCode = code;
            outcome.closedBy = ourClose ?? (errored || code === 1006 ? 'error' : 'server');
            finish();
        });
        ws.on('message', (data, isBinary) => {
            if (isBinary) return;
            let message: { event?: unknown; media?: { payload?: unknown }; mark?: { name?: unknown } };
            try {
                message = JSON.parse(String(data)) as typeof message;
            } catch {
                return;
            }
            const now = at();
            if (message.event === 'media' && typeof message.media?.payload === 'string') {
                const playsAt = Math.max(now, playoutEnd);
                playoutEnd = playsAt + FRAME_MS;
                const bytes = Buffer.from(message.media.payload, 'base64');
                const audible = !isSilentPayload(message.media.payload);
                if (stopSent && audible) outcome.framesAfterStop += 1;
                if (audible) {
                    outcome.audibleFramesOut += 1;
                    if (firstAudibleAt === null) {
                        firstAudibleAt = now;
                        outcome.startToFirstAudioMs = Math.round(now);
                    }
                    const row = outcome.turns[outcome.turns.length - 1];
                    if (phase.kind === 'await-reply' || phase.kind === 'playing' || phase.kind === 'await-end') {
                        if (row && row.firstAudioMs === null && now >= row.speechEndAtMs) {
                            row.firstAudioMs = Math.round(now - row.speechEndAtMs);
                        }
                    }
                }
                if (isSpeechFrame(bytes, VAD)) {
                    lastSpeechOut = playsAt + FRAME_MS;
                    agentSlots.add(Math.floor(playsAt / FRAME_MS));
                }
                if (disclosureOpen && firstAudibleAt !== null) {
                    disclosure.push(bytes);
                    outcome.disclosurePlayedMs += FRAME_MS;
                }
                return;
            }
            // Twilio echoes a mark once the audio queued before it has played.
            if (message.event === 'mark') {
                const wait = Math.max(0, playoutEnd - now);
                const timer = setTimeout(() => {
                    markTimers.delete(timer);
                    if (ws.readyState !== ws.OPEN) return;
                    outcome.marksEchoed += 1;
                    ws.send(JSON.stringify({ event: 'mark', streamSid: STREAM_SID, mark: message.mark ?? {} }));
                }, wait);
                markTimers.add(timer);
            }
        });
        ws.on('open', () => {
            outcome.upgraded = true;
            outcome.upgradeMs = Math.round(clock() - connectAt);
            send(CONNECTED);
            startAt = clock();
            send(startMessage({ token: plan.token }));
            pacer = setInterval(tick, FRAME_MS);
        });
    });
}

/**
 * The longest stretch, after the agent first spoke, with neither the agent's speech nor the
 * venue's on the line. Slot-wise at 20 ms.
 */
export function longestSilence(
    agentSlots: ReadonlySet<number>,
    venueSpans: ReadonlyArray<readonly [number, number]>,
    firstAudibleAt: number | null,
    endAt: number,
): number {
    if (firstAudibleAt === null) return 0;
    const venue = new Set<number>();
    for (const [from, to] of venueSpans) {
        for (let s = Math.floor(from / FRAME_MS); s <= Math.floor(to / FRAME_MS); s += 1) venue.add(s);
    }
    let longest = 0;
    let run = 0;
    for (let s = Math.floor(firstAudibleAt / FRAME_MS); s < Math.floor(endAt / FRAME_MS); s += 1) {
        if (agentSlots.has(s) || venue.has(s)) {
            run = 0;
            continue;
        }
        run += 1;
        if (run > longest) longest = run;
    }
    return longest * FRAME_MS;
}

/** Nearest-rank percentiles, the same arithmetic as `percentiles` in call.ts, over present values. */
export function rank(values: ReadonlyArray<number | null>, p: number): number | null {
    const xs = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
    if (!xs.length) return null;
    return xs[Math.max(1, Math.ceil((p / 100) * xs.length)) - 1]!;
}
