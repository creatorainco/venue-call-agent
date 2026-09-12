/**
 * THE BRIDGE — audio on one side, words on the other. This is the shape TASK-970 fills in.
 *
 * WHY IT IS WORTH NAMING SEPARATELY. Before this file the largest job on the feature was
 * described as "the Gemini Live adapter", which is a project, not a component. Split at this
 * seam it is two jobs with different risks:
 *
 *   `CallLeg`      — frames in, frames out. Carrier-shaped, no intelligence. DONE, with a fake.
 *   `SpeechBridge` — frames to turns, sentences to frames. THIS IS THE OPEN WORK.
 *   `CallAgent`    — turns to decisions and tool calls. DONE, with a reference implementation.
 *
 * A person implementing the bridge against Gemini Live has to make four things work — send PCM at
 * a declared rate, receive 24 kHz PCM back, notice the interrupt signal, and route function calls
 * — and every one of them is checkable against the fake before a single call is placed.
 *
 * 🔴 ONE HONEST COMPLICATION, WHICH THE THREE-BOX PICTURE ABOVE HIDES. With a NATIVE-AUDIO model
 * the bridge and the agent are the same object: the model hears audio and emits audio, and there
 * is no text turn boundary we control. With a HALF-CASCADE model (text plus TTS) they really are
 * separable. These interfaces describe the two JOBS either way, and one class may implement both.
 * What must not happen is the jobs blurring — the moment the thing that renders audio also
 * decides which sentence to say, the no-fabrication property is gone, because the words stopped
 * being finished strings from the backend. `docs/TUNING.md` §2 has the model choice; this is the
 * structural consequence of it.
 */

import { CARRIER_AUDIO, silentCarrierFrame } from '../audio/format.ts';
import { encode } from '../audio/mulaw.ts';
import { msToFrames } from './leg.ts';
import type { CallLeg, Frame } from './leg.ts';
import { TurnDetector } from './vad.ts';
import type { VadSettings } from './vad.ts';

/** A completed thing the far end said, as text, with when it happened. */
export interface CallerTurn {
    text: string;
    /** Frame the last audible sound landed in. TTFA is measured from here, not from the detection. */
    lastAudibleFrame: number;
    /** Frame the detector decided the turn was over. Always >= lastAudibleFrame. */
    detectedFrame: number;
}

export interface SpeechBridge {
    /** One inbound frame. Returns a turn if this frame completed one. */
    push(frame: Frame): CallerTurn | null;

    /** The far end stopped sending. Returns a final turn if one was still open. */
    flush(): CallerTurn | null;

    /**
     * Render these sentences and queue them on the leg.
     *
     * 🔴 SENTENCES, NOT A STRING. They arrive from the backend as finished sentences and they stay
     * separable all the way to the wire, so an interrupt between two of them can be logged as
     * "said the first, never said the second". Joining them here throws that away.
     */
    speak(sentences: readonly string[]): void;

    /** The far end started talking. Stop, and drop everything queued. */
    bargeIn(): void;

    /** True while there is unplayed speech on the leg. */
    speaking(): boolean;

    /**
     * Optional, and only a FAKE needs it: queue `ms` of silence before the next speech.
     *
     * A real bridge has real latency — the model takes as long as it takes — so there is nothing
     * to simulate and this is absent. The scripted bridge implements it so a sweep can ask the
     * question that actually decides whether this feature sounds broken: given a turn detector
     * that waits 800 ms and a model that thinks for 900, how long does the restaurant sit in
     * silence? That number is the sum, and nobody had added it up.
     */
    padSilence?(ms: number): void;
}

/**
 * The bridge with no model in it — the counterpart of `src/agent/scriptedStub.ts`.
 *
 * Inbound: real turn detection over real audio (`src/carrier/vad.ts`), then the Nth detected turn
 * is given the Nth scripted line. The DETECTION is genuine and is the thing being measured; the
 * words are injected, because nothing in this repository can recognise speech and pretending
 * otherwise would be a lie in the one place this design cannot afford one.
 *
 * Outbound: each sentence becomes real μ-law frames of a length derived from how long a person
 * would take to say it. So dead air, queue depth and barge-in are all real quantities, and the
 * only fiction is the timbre.
 *
 * 🔴 A DESIGN NOTE FOR WHOEVER IMPLEMENTS THE REAL ONE, found by running this against the
 * `they-interrupt` fixture. The reference agent hands over four sentences in one turn, so four
 * sentences' worth of audio — twenty-four seconds of it — sits in the queue at once. A
 * manager who cuts in two seconds later loses the other twenty-two, and the TRANSCRIPT still
 * records all four as spoken, because a transcript is a record of what was SENT.
 *
 * That gap is not a flaw in the fake; it is what a telephone does. What follows from it is a rule
 * for the real bridge: hand the leg ONE sentence at a time and wait for it to drain, so an
 * interrupt costs one sentence rather than a paragraph, and so what the transcript claims stays
 * close to what the restaurant heard. `heard()` below is what makes the difference measurable.
 */
export class ScriptedBridge implements SpeechBridge {
    // No parameter properties anywhere in this repository: `constructor(private readonly x)` is
    // unerasable syntax, it typechecks, and it throws ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX at
    // runtime. `erasableSyntaxOnly` in tsconfig.json catches it now; it did not always.
    private readonly leg: CallLeg;
    private readonly detector: TurnDetector;
    private readonly lines: string[];
    private readonly rateCps: number;
    private consumed = 0;
    private frame = -1;
    private queuedUntilFrame = -1;
    /** Turns the detector found, whether or not the script had a line for one. */
    private detected = 0;

    /**
     * Every sentence handed to `speak`.
     *
     * `settled` means its fate is known: a barge-in or the end of the call has decided how much
     * of it played. An unsettled entry has not been interrupted, so it played in full.
     */
    readonly spoken: Array<{
        sentence: string;
        queuedAtFrame: number;
        frames: number;
        heardFrames: number;
        settled: boolean;
    }> = [];

    constructor(
        leg: CallLeg,
        options: { vad: VadSettings; script: readonly string[]; speakingRateCps?: number },
    ) {
        this.leg = leg;
        this.detector = new TurnDetector(options.vad);
        this.lines = [...options.script];
        this.rateCps = options.speakingRateCps ?? DEFAULT_SPEAKING_RATE_CPS;
    }

    push(frame: Frame): CallerTurn | null {
        this.frame += 1;
        const event = this.detector.push(frame);
        if (event?.kind === 'speech_started' && this.speaking()) {
            // A human started talking while we were mid-sentence. This is the whole reason
            // `clear()` exists, and it must happen here rather than after the turn completes —
            // waiting for the turn to end means talking over the entire interruption.
            this.bargeIn();
        }
        if (event?.kind !== 'turn_ended') return null;
        this.detected += 1;
        return this.take(event.lastAudibleAt ?? this.frame, event.at);
    }

    flush(): CallerTurn | null {
        const event = this.detector.flush();
        if (!event) return null;
        this.detected += 1;
        return this.take(event.lastAudibleAt ?? this.frame, event.at);
    }

    private take(lastAudibleFrame: number, detectedFrame: number): CallerTurn | null {
        const text = this.lines[this.consumed];
        if (text === undefined) {
            // The detector found a turn the script does not have a line for. That is a real
            // finding — the audio was segmented differently than the fixture assumed — and it is
            // reported by the runner rather than swallowed here.
            return null;
        }
        this.consumed += 1;
        return { text, lastAudibleFrame, detectedFrame };
    }

    speak(sentences: readonly string[]): void {
        for (const sentence of sentences) {
            const frames = msToFrames(sentenceDurationMs(sentence, this.rateCps));
            const startFrame = Math.max(this.frame + 1, this.queuedUntilFrame + 1);
            this.spoken.push({ sentence, queuedAtFrame: startFrame, frames, heardFrames: 0, settled: false });
            for (let i = 0; i < frames; i += 1) this.leg.write(spokenFrame(startFrame + i));
            // A short gap between sentences, as a person leaves.
            for (let i = 0; i < msToFrames(INTER_SENTENCE_GAP_MS); i += 1) this.leg.write(silentCarrierFrame());
            this.queuedUntilFrame = startFrame + frames + msToFrames(INTER_SENTENCE_GAP_MS);
        }
    }

    padSilence(ms: number): void {
        const frames = msToFrames(ms);
        const startFrame = Math.max(this.frame + 1, this.queuedUntilFrame + 1);
        for (let i = 0; i < frames; i += 1) this.leg.write(silentCarrierFrame());
        this.queuedUntilFrame = startFrame + frames;
    }

    bargeIn(): void {
        const dropped = this.leg.queuedFrames();
        if (!dropped) return;
        this.leg.clear();
        // Frames 0..this.frame have gone out, so that is this.frame + 1 played.
        this.settle(this.frame + 1);
        this.queuedUntilFrame = this.frame;
    }

    /**
     * Freeze how much of each still-open sentence played, given how many frames went out in total.
     *
     * A frame count alone cannot say which sentence was cut, but the queue was filled in order and
     * every entry knows where it sat, so the arithmetic is exact rather than a guess.
     *
     * 🔴 THE ARGUMENT IS A COUNT OF FRAMES PLAYED, NOT A FRAME INDEX, and that distinction is the
     * fix for a real off-by-one. This took an index and added one to convert, which is right at a
     * barge-in — the frame being handled has gone out — and wrong at the end of a call, where the
     * frames still sitting in the queue were discarded and never played at all. A mid-sentence
     * hangup therefore credited the far end with 20 ms it did not hear. Small, and the wrong
     * direction: the whole point of this accounting is that it under-claims rather than over-.
     */
    settle(playedFrames: number): void {
        for (const entry of this.spoken) {
            if (entry.settled) continue;
            entry.heardFrames = Math.min(entry.frames, Math.max(0, playedFrames - entry.queuedAtFrame));
            entry.settled = true;
        }
    }

    /**
     * What the far end actually heard of each sentence.
     *
     * Anything still unsettled played to the end — a barge-in and the end of the call are the
     * only two things that stop audio, and both settle every open entry.
     */
    heard(): Array<{ sentence: string; heardMs: number; fullMs: number }> {
        return this.spoken.map((e) => ({
            sentence: e.sentence,
            heardMs: (e.settled ? e.heardFrames : e.frames) * CARRIER_AUDIO.frameMs,
            fullMs: e.frames * CARRIER_AUDIO.frameMs,
        }));
    }

    speaking(): boolean {
        return this.leg.queuedFrames() > 0;
    }

    /** Frame energies, for a sweep that re-scores without regenerating audio. */
    get energy(): readonly number[] {
        return this.detector.energy;
    }

    get vadDescription(): string {
        return this.detector.describe;
    }

    /** How many turns the detector found. Compare with the fixture's own count. */
    get detectedTurns(): number {
        return this.detected;
    }

    /**
     * Turns the detector found that the script had no line for.
     *
     * Non-zero means the audio was segmented differently than the fixture assumed — usually a
     * `silenceDurationMs` short enough to split one utterance in two. It is a finding, not an
     * error, and the runner prints it.
     */
    get overSegmented(): number {
        return Math.max(0, this.detected - this.consumed);
    }
}

/** Characters per second of speech. Unhurried, which is the register this call is written in. */
const DEFAULT_SPEAKING_RATE_CPS = 14;
const INTER_SENTENCE_GAP_MS = 240;
/** A different tone from the far end's, so a mixed recording is readable. */
const OUR_TONE_HZ = 440;
const OUR_AMPLITUDE = 6_000;

export function sentenceDurationMs(sentence: string, rateCps = DEFAULT_SPEAKING_RATE_CPS): number {
    return Math.max(CARRIER_AUDIO.frameMs, Math.round((sentence.length / rateCps) * 1000));
}

/** One frame of our outbound speech. Real μ-law, continuous phase, same as the far end's. */
export function spokenFrame(frameIndex: number): Frame {
    const n = CARRIER_AUDIO.bytesPerFrame;
    const pcm = new Int16Array(n);
    const base = frameIndex * n;
    for (let i = 0; i < n; i += 1) {
        const t = (base + i) / CARRIER_AUDIO.sampleRate;
        pcm[i] = Math.round(OUR_AMPLITUDE * Math.sin(2 * Math.PI * OUR_TONE_HZ * t));
    }
    return encode(pcm);
}
