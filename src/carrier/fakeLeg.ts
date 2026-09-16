/**
 * A TELEPHONE LEG WITH NO TELEPHONE, ON A CLOCK THAT IS NOT THE WALL CLOCK.
 *
 * WHAT THIS BUYS THAT THE TEXT HARNESS CANNOT. `src/harness/replay.ts` hands the agent a string
 * and reads the strings back. Everything it checks is a claim about a transcript, and a transcript
 * is identical whether the audio underneath it was correct, silent, deafening, or three seconds
 * late. The failures this leg can see and that one cannot:
 *
 *   - dead air: how long the restaurant waits between finishing a sentence and hearing a reply
 *   - talking over an interrupt, because the queue was never cleared
 *   - a frame of the wrong length, which a carrier plays as a click rather than as less audio
 *   - 0x00 "silence", which is full-scale negative and plays as a roar
 *   - audio written after the far end hung up, which is billed and heard by nobody
 *
 * 🔴 THE CLOCK IS VIRTUAL AND THAT IS THE POINT. One frame is one tick, and a tick is
 * `CARRIER_AUDIO.frameMs` of call time no matter how long it took to compute. A six-minute call
 * runs in milliseconds, the result is bit-identical on every machine, and CI does not wait for a
 * conversation. A test that sleeps for real is a test nobody runs.
 *
 * 🔴 THE FAR END WAITS FOR AN ANSWER, NOT MERELY FOR SILENCE — and getting that wrong made the
 * first version of this file useless in a way that looked like it worked. A turn whose
 * `startWhen` is `after-we-finish` originally began as soon as our queue drained and a 400 ms gap
 * passed. But the turn detector waits 800 ms before it believes a turn is over, so the far end
 * started its SECOND sentence 400 ms into a silence the detector was still measuring: all three
 * turns ran together as one long utterance, the detector reported one turn, and the run printed
 * a plausible-looking dead-air figure for a conversation that never happened.
 *
 * So the rule is the human one: they speak again once we have ANSWERED and stopped — audible at
 * least once since their last turn, then quiet for `gapMs`. If we never answer they wait
 * `patienceMs` and speak anyway, which is also what a person does and is what stops a silent
 * agent hanging the whole run. `interrupt` is the deliberate other case: it starts talking WHILE
 * we are, which is the only way to test that barge-in works.
 *
 * ⚠️ THE FAR END'S WORDS ARE INJECTED, NOT RECOGNISED. There is no speech recognition here and
 * pretending otherwise would be the fabrication this design exists to prevent. A timeline entry
 * carries BOTH the audio envelope — how long they speak, how long they pause — and the text. The
 * envelope is real and is what the turn detector works on; the text is handed over once the
 * detector says a turn ended. Turn-taking and transport are measured here; recognition is not.
 * `docs/WHAT-CANNOT-BE-TESTED.md` repeats this where somebody will look for it.
 */

import { CARRIER_AUDIO, MULAW_SILENCE, silentCarrierFrame } from '../audio/format.ts';
import { encode } from '../audio/mulaw.ts';
import { assertFrame, framesToMs, msToFrames } from './leg.ts';
import type { CallLeg, CallLegEvents, Frame, HangupReason } from './leg.ts';

/** When the far end starts a turn. */
export type TurnStart =
    /** Politely, once our audio has stopped and `gapMs` of quiet has passed. The normal case. */
    | 'after-we-finish'
    /** Rudely, `gapMs` after we START speaking. The only way to exercise barge-in. */
    | 'interrupt'
    /** At an absolute point in call time. For an answering machine beep, or a hang-up race. */
    | { atMs: number };

export interface TimelineTurn {
    /** What they said. Handed over only once the detector decides the turn ended. */
    text: string;
    /**
     * How long they speak, in runs of sound, with a pause between each.
     *
     * 🔴 ONE UTTERANCE IS NOT ONE UNBROKEN RUN OF SOUND, AND A SWEEP THAT PRETENDS OTHERWISE
     * MEASURES NOTHING. People stop in the middle of a sentence — after "hang on", before a number,
     * while they look something up. Those pauses are the entire reason `silenceDurationMs` is a
     * hard choice: set it shorter than a thinking pause and the agent answers half a question.
     *
     * The first version of this file generated one continuous tone per turn. The sweep it
     * produced was a straight line — dead air rose with the setting and nothing ever got worse at
     * the low end — which made 200 ms look like the obvious answer. It is not; the fixture simply
     * had no pause for it to cut through. A tuning instrument that cannot show a cost is an
     * argument for the cheapest setting.
     */
    segmentsMs: number[];
    /**
     * The thinking pause between runs. CHOSEN, not measured: hesitation pauses in conversational
     * speech run roughly 200–1000 ms and this sits in the middle.
     *
     * The knee in a sweep is therefore a property of THIS number. That is not a flaw — the knee
     * says "settings below this cut through a pause of this length", which is the question being
     * asked. Change it and re-run to ask about a slower speaker.
     */
    internalPauseMs?: number;
    startWhen?: TurnStart;
    /** The pause: after our audio stops for `after-we-finish`, after it starts for `interrupt`. */
    gapMs?: number;
}

export interface FakeLegOptions {
    id?: string;
    turns: readonly TimelineTurn[];
    /**
     * Silence after the last turn, so the agent has room to answer and hang up.
     * Too short and the call ends because the SCRIPT ran out, which scores as a truncated call.
     */
    trailingSilenceMs?: number;
    /** The far end hangs up at this point in call time, mid-anything. */
    hangUpAtMs?: number;
    /** Amplitude of generated speech, in PCM16 units. Loud enough to be speech, quiet enough to be a phone. */
    speechAmplitude?: number;
    /** Hard stop, so a bug cannot spin forever. Defaults to the call cap. */
    maxMs?: number;
    /**
     * How long the far end waits for an answer before speaking again anyway.
     *
     * Measured against OUR SILENCE. Without it, an agent that says nothing stops the conversation
     * dead and the run burns frames until the call cap; measured against the clock instead, it
     * fires mid-answer and the far end talks over a perfectly good sentence.
     */
    patienceMs?: number;
}

/** What was actually on the wire, per frame, in call time. */
export interface FrameRecord {
    /** Frames since the call connected. Multiply by CARRIER_AUDIO.frameMs for milliseconds. */
    at: number;
    /** True when the frame carried anything other than silence. */
    audible: boolean;
}

/** When each turn's audio really started and stopped. The truth a detector is scored against. */
export interface TurnTruth {
    text: string;
    startFrame: number;
    endFrame: number;
    interrupting: boolean;
}

const DEFAULT_TRAILING_SILENCE_MS = 5_000;
const DEFAULT_GAP_MS = 400;
const DEFAULT_INTERRUPT_AFTER_MS = 400;
const DEFAULT_AMPLITUDE = 8_000;
const DEFAULT_MAX_MS = 6 * 60 * 1000;
const DEFAULT_PATIENCE_MS = 8_000;
export const DEFAULT_INTERNAL_PAUSE_MS = 500;
/** A telephone-band tone. Any steady tone works; this one sits comfortably inside 300–3400 Hz. */
const TONE_HZ = 300;

export class FakeCallLeg implements CallLeg {
    readonly id: string;

    private readonly handlers: {
        inbound: Array<CallLegEvents['inbound']>;
        hangup: Array<CallLegEvents['hangup']>;
    } = { inbound: [], hangup: [] };

    private readonly turns: readonly TimelineTurn[];
    private readonly amplitude: number;
    private readonly trailingFrames: number;
    private readonly hangUpAtFrame: number | null;
    private readonly maxFrames: number;
    private readonly patienceFrames: number;

    private queue: Frame[] = [];
    private tick = 0;
    private done = false;

    // Timeline state.
    private cursor = 0;
    private turnActive = false;
    private segIndex = 0;
    private segFramesLeft = 0;
    private pauseFramesLeft = 0;
    private currentStart = -1;
    private currentInterrupting = false;
    /** Frames of continuous quiet on OUR side. Reset whenever we play something audible. */
    private ourQuietFrames = 0;
    /** Frames since we last started speaking, for the `interrupt` case. */
    private framesSinceWeStarted = -1;
    private exhaustedAtFrame: number | null = null;
    /** Have we been audible at all since their last turn ended? They wait for an answer. */
    private weAnsweredSinceTheirTurn = false;
    /** Frames since their last turn ended, for the patience fallback. */
    private framesSinceTheirTurn = 0;

    /** Where each turn's audio really was. Not visible to the detector. */
    readonly truth: TurnTruth[] = [];

    /** Every outbound frame that actually left, in call time. Cleared frames never appear. */
    readonly outbound: FrameRecord[] = [];
    /**
     * Every inbound frame, in call time.
     *
     * Kept so that "we talked over them" is measurable from the WIRE rather than from either
     * side's account of itself — the same reason the replay harness scores off the mock's journal
     * instead of the agent's self-report.
     */
    readonly inbound: FrameRecord[] = [];
    /** Frames discarded by `clear()`. The size of the interrupt we did not inflict. */
    cleared = 0;
    /** Frames written after the call ended. Must always be zero; kept so a test can prove it. */
    writtenAfterHangup = 0;

    constructor(options: FakeLegOptions) {
        this.id = options.id ?? 'fake-leg';
        this.turns = options.turns;
        this.amplitude = options.speechAmplitude ?? DEFAULT_AMPLITUDE;
        this.trailingFrames = msToFrames(options.trailingSilenceMs ?? DEFAULT_TRAILING_SILENCE_MS);
        this.hangUpAtFrame = options.hangUpAtMs === undefined ? null : msToFrames(options.hangUpAtMs);
        this.maxFrames = msToFrames(options.maxMs ?? DEFAULT_MAX_MS);
        this.patienceFrames = msToFrames(options.patienceMs ?? DEFAULT_PATIENCE_MS);
    }

    on<K extends keyof CallLegEvents>(event: K, handler: CallLegEvents[K]): void {
        (this.handlers[event] as Array<CallLegEvents[K]>).push(handler);
    }

    write(frame: Frame): void {
        assertFrame(frame, 'FakeCallLeg.write');
        if (this.done) {
            // Not an exception. A real integration writes into a dead socket and gets nothing
            // back; the bug is that it kept generating audio. Count it and let a test fail on it.
            this.writtenAfterHangup += 1;
            return;
        }
        this.queue.push(frame);
    }

    clear(): void {
        this.cleared += this.queue.length;
        this.queue = [];
    }

    queuedFrames(): number {
        return this.queue.length;
    }

    async hangup(reason: HangupReason): Promise<void> {
        this.end(reason);
    }

    get elapsedFrames(): number { return this.tick; }
    get elapsedMs(): number { return framesToMs(this.tick); }
    get ended(): boolean { return this.done; }
    /** True once every scripted turn has been delivered. */
    get scriptFinished(): boolean { return this.cursor >= this.turns.length && !this.turnActive; }

    /**
     * Advance the call by exactly one frame: play at most one outbound frame, deliver one inbound.
     *
     * Returns false once the call is over. The caller loops on it; nothing here sleeps.
     */
    advance(): boolean {
        if (this.done) return false;

        if (this.hangUpAtFrame !== null && this.tick >= this.hangUpAtFrame) {
            this.end('far_end_hung_up');
            return false;
        }
        if (this.tick >= this.maxFrames) {
            this.end('call_too_long');
            return false;
        }

        // Outbound first: what plays during this frame was queued before it.
        const playing = this.queue.shift();
        const audible = playing !== undefined && !isSilent(playing);
        this.outbound.push({ at: this.tick, audible });
        this.framesSinceTheirTurn += 1;
        if (audible) {
            this.weAnsweredSinceTheirTurn = true;
            this.ourQuietFrames = 0;
            if (this.framesSinceWeStarted < 0) this.framesSinceWeStarted = 0;
            else this.framesSinceWeStarted += 1;
        } else {
            this.ourQuietFrames += 1;
            if (this.framesSinceWeStarted >= 0) this.framesSinceWeStarted += 1;
            if (this.queue.length === 0) this.framesSinceWeStarted = -1;
        }

        const inbound = this.nextInboundFrame();
        if (inbound === null) {
            // This tick never happens. Undo the dequeue above rather than leaving a phantom
            // frame in the record: it made `framesOut` exactly one greater than `framesIn` on
            // every call that ran its script out — 7 of 15 fixtures — and any arithmetic over
            // the two would have been quietly wrong by one frame.
            this.outbound.pop();
            if (playing !== undefined) this.queue.unshift(playing);
            this.end('timeline_exhausted');
            return false;
        }

        this.inbound.push({ at: this.tick, audible: !isSilent(inbound) });
        this.tick += 1;
        for (const handler of this.handlers.inbound) handler(inbound);
        return !this.done;
    }

    /** One inbound frame, or null when the script and its trailing silence are both spent. */
    private nextInboundFrame(): Frame | null {
        const turn = this.turns[this.cursor];

        if (this.turnActive && turn !== undefined) {
            if (this.segFramesLeft > 0) {
                this.segFramesLeft -= 1;
                const frame = speechFrame(this.tick, this.amplitude);
                if (this.segFramesLeft === 0) {
                    if (this.segIndex + 1 < turn.segmentsMs.length) {
                        this.pauseFramesLeft = Math.max(
                            1,
                            msToFrames(turn.internalPauseMs ?? DEFAULT_INTERNAL_PAUSE_MS),
                        );
                    } else {
                        this.endTurn(turn);
                    }
                }
                return frame;
            }
            if (this.pauseFramesLeft > 0) {
                this.pauseFramesLeft -= 1;
                if (this.pauseFramesLeft === 0) {
                    this.segIndex += 1;
                    this.segFramesLeft = Math.max(1, msToFrames(turn.segmentsMs[this.segIndex] ?? 0));
                }
                return silentCarrierFrame();
            }
        }

        if (turn === undefined) {
            if (this.exhaustedAtFrame === null) this.exhaustedAtFrame = this.tick;
            return this.tick - this.exhaustedAtFrame < this.trailingFrames ? silentCarrierFrame() : null;
        }

        if (this.shouldStart(turn)) {
            this.turnActive = true;
            this.segIndex = 0;
            this.segFramesLeft = Math.max(1, msToFrames(turn.segmentsMs[0] ?? 0));
            this.pauseFramesLeft = 0;
            this.currentStart = this.tick;
            this.currentInterrupting = turn.startWhen === 'interrupt';
            return this.nextInboundFrame();
        }
        return silentCarrierFrame();
    }

    /** A turn's last run of sound has finished. Record where it really was, and reset. */
    private endTurn(turn: TimelineTurn): void {
        this.truth.push({
            text: turn.text,
            startFrame: this.currentStart,
            endFrame: this.tick,
            interrupting: this.currentInterrupting,
        });
        this.turnActive = false;
        this.cursor += 1;
        this.weAnsweredSinceTheirTurn = false;
        this.framesSinceTheirTurn = 0;
    }

    private shouldStart(turn: TimelineTurn): boolean {
        const when = turn.startWhen ?? 'after-we-finish';
        if (typeof when === 'object') return this.tick >= msToFrames(when.atMs);
        if (when === 'interrupt') {
            const after = msToFrames(turn.gapMs ?? DEFAULT_INTERRUPT_AFTER_MS);
            return this.framesSinceWeStarted >= after;
        }
        // after-we-finish: we have answered, nothing is queued, and a gap of quiet has passed.
        // The answered condition is the load-bearing one — see the header. Without it the far end
        // talks into the detector's own silence window and the whole conversation collapses into
        // one turn, silently.
        // Patience is measured against OUR SILENCE, not against the clock. Measured against the
        // clock it fires in the middle of a long answer and the far end talks over us — which
        // reads as a barge-in bug in the report and is really the fixture losing its temper.
        if (!this.weAnsweredSinceTheirTurn) {
            return this.ourQuietFrames >= this.patienceFrames;
        }
        return this.queue.length === 0 && this.ourQuietFrames >= msToFrames(turn.gapMs ?? DEFAULT_GAP_MS);
    }

    private end(reason: HangupReason): void {
        if (this.done) return;
        this.done = true;
        this.queue = [];
        for (const handler of this.handlers.hangup) handler(reason);
    }
}

/** True when every byte is the μ-law silence byte. Not `every(b => b === 0)` — see format.ts. */
export function isSilent(frame: Frame): boolean {
    for (const byte of frame) if (byte !== MULAW_SILENCE) return false;
    return true;
}

/**
 * One frame of generated speech, μ-law encoded — the real codec, not a stand-in.
 *
 * Phase is derived from the absolute frame index, so a run of frames is one unbroken tone rather
 * than a click every 20 ms.
 */
export function speechFrame(frameIndex: number, amplitude = DEFAULT_AMPLITUDE): Frame {
    const n = CARRIER_AUDIO.bytesPerFrame;
    const pcm = new Int16Array(n);
    const base = frameIndex * n;
    for (let i = 0; i < n; i += 1) {
        const t = (base + i) / CARRIER_AUDIO.sampleRate;
        pcm[i] = Math.round(amplitude * Math.sin(2 * Math.PI * TONE_HZ * t));
    }
    return encode(pcm);
}
