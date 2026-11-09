/**
 * THE OUTPUT GATE — every outbound frame passes through here, and here is where `src/state.ts`
 * stops being a description and starts being enforced.
 *
 * It is a `CallLeg` wrapped around a `CallLeg`, so the bridge writes to it without knowing it is
 * there. Three rules, each one a thing that used to be true only by convention:
 *
 *   1. NOTHING BEFORE THE DISCLOSURE. A write while `idle` or `connected` throws. That is a bug in
 *      the caller, not a condition to recover from, and a live call must never paper over it.
 *   2. NOTHING AFTER THE END. A write after `ended` is dropped, counted and logged — not thrown,
 *      because the far end hanging up mid-sentence is normal and the loop that wrote is the bug.
 *   3. THE DISCLOSURE CANNOT BE INTERRUPTED. The frames written between `beginDisclosure()` and
 *      `endDisclosure()` are the protected range, followed by a carrier mark. Until that mark comes
 *      back, `clear()` drops only what was written AFTER the range, and that audio is held here
 *      rather than queued on the leg. Before this gate a "hello?" over the first second of the
 *      disclosure cleared the whole queue: the restaurant heard a voice it had not been told was
 *      automated.
 *
 * 🔴 WHY THE MARK AND NOT A FRAME COUNT. "The disclosure was heard" is a claim about PLAYOUT, and
 * only the far side of the queue knows what played. Counting frames sent is counting what we
 * intended. If the mark never comes back — the far end hung up mid-disclosure — the disclosure was
 * not heard, and the report says so rather than assuming it.
 *
 * 🔴 IT FAILS CLOSED. If a mark is lost on a live line, everything after the disclosure stays held
 * and the agent goes quiet. Silence is recoverable; a sentence spoken to somebody who was never
 * told this is an automated call is not. The call cap ends a call that goes quiet.
 *
 * ONE REPLAY. If the far end spoke over more than half of the protected range, the same frames are
 * played once more, under a fresh mark, before anything held is released. The gate holds frames,
 * never words, so it cannot fabricate a sentence: what it replays is what the backend supplied.
 *
 * LEADING SILENCE IS NOT THE DISCLOSURE. Silent frames written after `beginDisclosure()` and before
 * the first audible one (the model's latency) go to the leg but not into the range: they are not
 * replayed, they do not count toward "talked over more than half", and talk during them is not
 * talk over the disclosure, because nothing of it was playing yet.
 *
 * 🔴 A HANGUP EXCUSES ONLY A DISCLOSURE STILL PLAYING. `disclosure().cutByHangup` is true only
 * when the far end hung up while the leg still had audio queued ahead of the disclosure's mark.
 * A disclosure that stopped playing earlier — cleared by a bug, the gate then failing closed and
 * the confused restaurant hanging up into the silence — is not excused by that later hangup.
 */

import { canTransition, mayEmitAudio } from '../state.ts';
import type { CallState } from '../state.ts';
import { MULAW_SILENCE } from '../audio/format.ts';
import type { CallLeg, CallLegEvents, Frame, HangupReason } from './leg.ts';

export interface OutputGateOptions {
    /**
     * True when an inbound frame carries the far end's speech. Used only to measure how much of
     * the disclosure they talked over; the gate does not detect turns and must not start to.
     */
    isSpeech: (frame: Frame) => boolean;
    /**
     * One line per event: the leg id and an event kind. Never audio, never words, never a number
     * dialled. Defaults to stderr.
     */
    log?: (line: string) => void;
}

/** What the gate saw of the disclosure, for `measure()` in call.ts. */
export interface DisclosureRecord {
    /** A protected range was opened at all. False on a call that was refused before it spoke. */
    started: boolean;
    /** The carrier acknowledged the last frame of the latest protected range. */
    heard: boolean;
    /** How many times the range was played again because it was talked over. At most one. */
    replays: number;
    /**
     * The far end hung up while the disclosure was still queued to play: its mark pending AND the
     * leg still holding audio ahead of it at the last frame before the hangup. Only this excuses
     * an unheard disclosure. A pending mark over an empty queue is a mark something threw away.
     */
    cutByHangup: boolean;
    /** Call frames in which protected audio was playing. Talk-over in these is not a barge-in failure. */
    protectedFrames: ReadonlySet<number>;
    /** Writes refused because the call had ended. Each is a frame the loop should never have made. */
    droppedAfterEnd: number;
    /** Held frames that a barge-in threw away before they reached the leg. */
    heldCleared: number;
}

type Held = { frame: Frame } | { mark: string };

export class OutputGate implements CallLeg {
    readonly id: string;

    private readonly leg: CallLeg;
    private readonly isSpeech: (frame: Frame) => boolean;
    private readonly log: (line: string) => void;

    private current: CallState = 'idle';

    /** Between `beginDisclosure()` and `endDisclosure()`: frames written now are the range. */
    private protecting = false;
    private range: Frame[] = [];
    /** The mark that releases the range. Null once released, or before any range. */
    private pendingMark: string | null = null;
    private markSeq = 0;
    private acknowledged = false;
    private started = false;
    private replays = 0;
    /** Inbound frames of far-end speech while the current range plays. */
    private overlap = 0;
    /** Frames the leg plays before the current range starts: leading silence, earlier audio. */
    private untilRange = 0;
    /** The leg's queue depth at the last frame, sampled while a mark is pending. */
    private lastQueued = 0;
    private cutByHangup = false;
    private held: Held[] = [];
    private inboundFrames = 0;
    private readonly protectedAt = new Set<number>();
    private dropped = 0;
    private heldCleared = 0;
    private readonly replayHandlers: Array<(frames: number) => void> = [];

    constructor(leg: CallLeg, options: OutputGateOptions) {
        this.leg = leg;
        this.id = leg.id;
        this.isSpeech = options.isSpeech;
        this.log = options.log ?? ((line) => { process.stderr.write(`${line}\n`); });
        leg.on('inbound', (frame) => this.onInbound(frame));
        leg.on('marked', (name) => this.onMarked(name));
        leg.on('hangup', (reason) => {
            // Read before end(): `pendingMark` survives it, `protecting` does not.
            if (reason === 'far_end_hung_up' && this.current !== 'ended') {
                this.cutByHangup = this.protecting || (this.pendingMark !== null && this.lastQueued > 0);
            }
            this.end();
        });
    }

    get state(): CallState { return this.current; }

    /** True while the latest disclosure has been sent but its mark has not come back. */
    get disclosurePending(): boolean { return this.protecting || this.pendingMark !== null; }

    /** The line was answered. */
    connect(): void { this.enter('connected'); }

    /**
     * Move to a state the call chose. Throws on an illegal move: the state machine is the
     * authority, and a call loop that asks for an illegal move has a bug that must not be hidden.
     * `disclosing` goes through `beginDisclosure()` instead, because it opens a protected range.
     */
    enter(to: CallState): void {
        if (to === 'disclosing') {
            throw new Error('OutputGate.enter: use beginDisclosure(), which opens the protected range');
        }
        if (to === 'ended') {
            this.end();
            return;
        }
        this.move(to);
    }

    /** Open the protected range. Every frame written until `endDisclosure()` belongs to it. */
    beginDisclosure(): void {
        this.move('disclosing');
        this.protecting = true;
        this.started = true;
        this.acknowledged = false;
        this.range = [];
        this.replays = 0;
        this.overlap = 0;
    }

    /** Close the range and put the carrier mark behind it. Nothing held is released until it returns. */
    endDisclosure(): void {
        if (!this.protecting) throw new Error('OutputGate.endDisclosure: no protected range is open');
        this.protecting = false;
        if (this.current === 'ended') return;
        this.placeMark();
    }

    /**
     * The far end hung up, or we did. Unconditional: see the note on hangups in state.ts. Whatever
     * was held never plays, and a pending mark now never comes back.
     */
    end(): void {
        this.current = 'ended';
        this.protecting = false;
        this.held = [];
    }

    on<K extends keyof CallLegEvents>(event: K, handler: CallLegEvents[K]): void {
        this.leg.on(event, handler);
    }

    /** Called with the number of frames replayed, so a bridge can move its own bookkeeping. */
    onReplay(handler: (frames: number) => void): void {
        this.replayHandlers.push(handler);
    }

    write(frame: Frame): void {
        if (this.current === 'ended') {
            this.dropped += 1;
            if (this.dropped === 1) this.log(`output-gate ${this.id} write_after_end`);
            return;
        }
        if (this.protecting) {
            // Leading silence plays, but it is not the disclosure: see the header.
            if (this.range.length > 0 || !isSilentFrame(frame)) this.range.push(frame);
            this.leg.write(frame);
            return;
        }
        if (this.pendingMark !== null) {
            this.held.push({ frame });
            return;
        }
        if (!mayEmitAudio(this.current, this.acknowledged)) {
            throw new Error(
                `OutputGate.write in state ${this.current}: no audio may leave before the disclosure `
                + 'starts. Call beginDisclosure() first.',
            );
        }
        this.leg.write(frame);
    }

    /**
     * Barge-in. While the disclosure is unacknowledged this drops only what is held behind it; the
     * range itself keeps playing. Afterwards it is the leg's `clear()`, unchanged.
     *
     * Held marks go with the held frames. A mark marks audio, and that audio was thrown away: the
     * leg contract (leg.ts) is that a mark discarded by `clear()` never fires, and releasing it
     * later would report audio as played that nobody heard.
     */
    clear(): void {
        if (this.disclosurePending) {
            for (const item of this.held) if ('frame' in item) this.heldCleared += 1;
            this.held = [];
            return;
        }
        this.leg.clear();
    }

    queuedFrames(): number {
        let held = 0;
        for (const item of this.held) if ('frame' in item) held += 1;
        return this.leg.queuedFrames() + held;
    }

    mark(name: string): void {
        if (this.current === 'ended') return;
        if (this.pendingMark !== null) {
            this.held.push({ mark: name });
            return;
        }
        this.leg.mark(name);
    }

    async hangup(reason: HangupReason): Promise<void> {
        this.end();
        await this.leg.hangup(reason);
    }

    /** What happened to the disclosure on this call. Read once the call is over. */
    disclosure(): DisclosureRecord {
        return {
            started: this.started,
            heard: this.started && this.acknowledged && !this.disclosurePending,
            replays: this.replays,
            cutByHangup: this.cutByHangup,
            protectedFrames: this.protectedAt,
            droppedAfterEnd: this.dropped,
            heldCleared: this.heldCleared,
        };
    }

    private move(to: CallState): void {
        if (!canTransition(this.current, to)) {
            throw new Error(`OutputGate: ${this.current} -> ${to} is not a legal move (src/state.ts)`);
        }
        this.current = to;
    }

    /** Call with the range already on the leg, so whatever else is queued is ahead of it. */
    private placeMark(): void {
        this.markSeq += 1;
        this.pendingMark = `disclosure:${this.markSeq}`;
        this.lastQueued = this.leg.queuedFrames();
        this.untilRange = Math.max(0, this.lastQueued - this.range.length);
        this.leg.mark(this.pendingMark);
    }

    private onInbound(frame: Frame): void {
        const at = this.inboundFrames;
        this.inboundFrames += 1;
        // Marks fire after a frame's inbound handlers, so a range still pending here was playing in
        // this frame, its last frame included.
        if (this.pendingMark === null || this.current === 'ended') return;
        this.lastQueued = this.leg.queuedFrames();
        // Frames ahead of the range played in this frame, not the disclosure.
        if (this.untilRange > 0) {
            this.untilRange -= 1;
            return;
        }
        this.protectedAt.add(at);
        if (this.isSpeech(frame)) this.overlap += 1;
    }

    private onMarked(name: string): void {
        // A stale or foreign mark. Only the latest range's own mark releases it.
        if (name !== this.pendingMark || this.current === 'ended') return;

        if (this.replays === 0 && this.overlap * 2 > this.range.length) {
            this.replays += 1;
            this.overlap = 0;
            for (const frame of this.range) this.leg.write(frame);
            this.placeMark();
            this.log(`output-gate ${this.id} disclosure_replayed`);
            for (const handler of this.replayHandlers) handler(this.range.length);
            return;
        }

        this.pendingMark = null;
        this.acknowledged = true;
        const held = this.held;
        this.held = [];
        for (const item of held) {
            if ('frame' in item) this.leg.write(item.frame);
            else this.leg.mark(item.mark);
        }
    }
}

/** Every byte the μ-law silence byte. Not `every(b => b === 0)`: 0x00 is full-scale negative. */
function isSilentFrame(frame: Frame): boolean {
    for (const byte of frame) if (byte !== MULAW_SILENCE) return false;
    return true;
}
