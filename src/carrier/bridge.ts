/**
 * THE BRIDGE — audio on one side, words on the other. This is the shape the Gemini Live adapter fills in.
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

/**
 * One sentence to say, and the id that follows it to the wire and back.
 *
 * The id is what lets a result say WHICH sentence was cut rather than how many frames were. It is
 * unique within a call. The text is a finished sentence from the backend, never assembled here.
 */
export interface Sentence {
    id: string;
    text: string;
}

/** What became of one sentence. */
export interface SentenceOutcome {
    id: string;
    text: string;
    /** How much of it the far end heard. Equal to `fullMs` only if it played to its end. */
    heardMs: number;
    fullMs: number;
}

/** What became of one `speak()`: every sentence it was given, in the order it was given them. */
export interface SpokenResult {
    sentences: SentenceOutcome[];
    /** Every sentence played to its end. False when an interrupt or the end of the call cut one. */
    complete: boolean;
}

export interface SpeechBridgeEvents {
    /** The far end finished a turn. The only event the call loop answers. */
    callerTurn(turn: CallerTurn): void;
    /**
     * Words of a turn still in progress. Never answered and never logged: a partial is a guess the
     * recogniser may still revise, and answering one is answering half a question.
     */
    interim(text: string): void;
    /**
     * The bridge cannot go on: a recogniser or synthesiser stream died. The call loop ends the call
     * through the supervisor (`internal_error`, one hangup). The message may carry what somebody
     * said, so nothing logs it; the supervisor logs the class name.
     */
    error(error: Error): void;
}

/**
 * Audio in, turns out; sentences in, audio out. Asynchronous, because a real recogniser and a real
 * synthesiser are: a turn arrives when the recogniser decides, and a sentence has been heard only
 * once its audio has played, which is long after it was handed over.
 *
 * 🔴 NOTHING HERE RETURNS A TURN. The previous interface was `push(frame): CallerTurn | null`, which
 * only a bridge that decides synchronously, frame by frame, can implement; a speech-to-text stream
 * cannot. A turn is an event now, and the call loop holds it until it is ready to answer.
 */
export interface SpeechBridge {
    on<K extends keyof SpeechBridgeEvents>(event: K, handler: SpeechBridgeEvents[K]): void;

    /** One inbound frame from the carrier. Returns at once; a turn it completes arrives as `callerTurn`. */
    sendAudio(frame: Frame): void;

    /**
     * Render these sentences and queue them on the leg. Resolves once the fate of every one is
     * known: played to its end, cut by an interrupt, or dropped by the end of the call.
     *
     * 🔴 SENTENCES, NOT A STRING. They arrive from the backend as finished sentences and they stay
     * separable all the way to the wire, so an interrupt between two of them can be logged as
     * "said the first, never said the second". Joining them here throws that away.
     *
     * 🔴 DO NOT AWAIT IT FROM THE LOOP THAT FEEDS THE LEG. Audio plays as frames go out; a loop that
     * waits for its own sentence to finish before sending the next frame waits for ever. Queue it,
     * keep the promise, read it when the call is over.
     *
     * Rejects only if the bridge itself failed, and then it also emits `error`.
     */
    speak(sentences: readonly Sentence[]): Promise<SpokenResult>;

    /**
     * Stop speaking now and drop everything queued and unplayed. A bridge that hears the far end
     * start talking over it calls this itself; the call loop may call it too. Under `OutputGate`
     * an unacknowledged disclosure keeps playing (src/carrier/outputGate.ts).
     */
    interrupt(): void;

    /**
     * The call is over or ending. Close the input (a turn still open while the line is up is
     * emitted once more as a final `callerTurn`), settle every sentence still owed, resolve every
     * `speak()`, and emit nothing after. Idempotent.
     *
     * It does NOT hang up the leg. That is the supervisor's, exactly once (src/carrier/supervisor.ts).
     */
    hangup(): Promise<void>;

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

export interface ScriptedBridgeOptions {
    vad: VadSettings;
    script: readonly string[];
    speakingRateCps?: number;
}

/** One sentence handed to `speak`, where it sat in the queue, and how much of it played. */
interface SpokenEntry {
    id: string;
    sentence: string;
    queuedAtFrame: number;
    frames: number;
    heardFrames: number;
    settled: boolean;
}

/**
 * The bridge with no model in it — the counterpart of `src/agent/scriptedStub.ts`.
 *
 * Inbound: real turn detection over real audio (`src/carrier/vad.ts`), then the Nth detected turn
 * is given the Nth scripted line. The DETECTION is genuine and is the thing being measured; the
 * words are injected, because nothing in this repository can recognise speech and pretending
 * otherwise would be a lie in the one place this design cannot afford one. For the same reason it
 * never emits `interim`: it has no words until a turn is over.
 *
 * Outbound: each sentence becomes real μ-law frames of a length derived from how long a person
 * would take to say it. So dead air, queue depth and barge-in are all real quantities, and the
 * only fiction is the timbre.
 *
 * Everything is synchronous underneath (a frame in, an event out, before `sendAudio` returns), so
 * on the fake leg's virtual clock a call is as deterministic as it was before the interface went
 * async. `test/bridgeGolden.test.ts` holds it to that, call for call.
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
 * close to what the restaurant heard. `SpokenResult` is what makes the difference measurable.
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
    /** The leg reported the end of the call. No turn is flushed into a line nobody is on. */
    private lineDown = false;
    /** `hangup()` ran. Nothing is emitted, queued or written after it. */
    private closed = false;
    private readonly ids = new Set<string>();
    private readonly handlers: { [K in keyof SpeechBridgeEvents]: Array<SpeechBridgeEvents[K]> } = {
        callerTurn: [],
        interim: [],
        error: [],
    };
    /** `speak()` calls whose promise is still open. */
    private owed: Array<{ entries: SpokenEntry[]; resolve: (result: SpokenResult) => void }> = [];

    /**
     * Every sentence handed to `speak`.
     *
     * `settled` means its fate is known: a barge-in or the end of the call has decided how much
     * of it played. An unsettled entry has not been interrupted, so it played in full.
     */
    readonly spoken: SpokenEntry[] = [];

    constructor(leg: CallLeg, options: ScriptedBridgeOptions) {
        this.leg = leg;
        this.detector = new TurnDetector(options.vad);
        this.lines = [...options.script];
        this.rateCps = options.speakingRateCps ?? DEFAULT_SPEAKING_RATE_CPS;
        leg.on('hangup', () => { this.lineDown = true; });
    }

    on<K extends keyof SpeechBridgeEvents>(event: K, handler: SpeechBridgeEvents[K]): void {
        this.handlers[event].push(handler);
    }

    sendAudio(frame: Frame): void {
        if (this.closed) return;
        this.frame += 1;
        const event = this.detector.push(frame);
        if (event?.kind === 'speech_started' && this.speaking()) {
            // A human started talking while we were mid-sentence. This is the whole reason
            // `clear()` exists, and it must happen here rather than after the turn completes —
            // waiting for the turn to end means talking over the entire interruption.
            this.interrupt();
        }
        if (event?.kind === 'turn_ended') {
            this.detected += 1;
            const turn = this.take(event.lastAudibleAt ?? this.frame, event.at);
            if (turn) this.emit('callerTurn', turn);
        }
        this.payOwed();
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

    speak(sentences: readonly Sentence[]): Promise<SpokenResult> {
        for (const { id } of sentences) {
            // Thrown, not resolved: a sentence with no id, or another sentence's id, is a bug in the
            // caller, and an outcome that cannot say which sentence it is about is not an outcome.
            if (!id || this.ids.has(id)) {
                throw new Error(`ScriptedBridge.speak: sentence id ${JSON.stringify(id)} is empty or already used`);
            }
            this.ids.add(id);
        }
        if (this.closed) {
            // The call is over. Nothing is queued, and every sentence is reported as unheard.
            const unheard = sentences.map(({ id, text }) => ({
                id, text, heardMs: 0, fullMs: sentenceDurationMs(text, this.rateCps),
            }));
            return Promise.resolve({ sentences: unheard, complete: unheard.length === 0 });
        }
        const entries: SpokenEntry[] = [];
        for (const { id, text: sentence } of sentences) {
            const frames = msToFrames(sentenceDurationMs(sentence, this.rateCps));
            const startFrame = Math.max(this.frame + 1, this.queuedUntilFrame + 1);
            const entry = { id, sentence, queuedAtFrame: startFrame, frames, heardFrames: 0, settled: false };
            this.spoken.push(entry);
            entries.push(entry);
            for (let i = 0; i < frames; i += 1) this.leg.write(spokenFrame(startFrame + i));
            // A short gap between sentences, as a person leaves.
            const gap = msToFrames(INTER_SENTENCE_GAP_MS);
            for (let i = 0; i < gap; i += 1) this.leg.write(silentCarrierFrame());
            // INCLUSIVE index of the last frame queued. Both read sites use `+ 1` to get the
            // next free frame, and `interrupt` sets it to `this.frame`, which has already gone
            // out — so "last queued", not "one past". Writing the exclusive end here drifted
            // every sentence's recorded start one frame later than its audio, cumulatively.
            this.queuedUntilFrame = startFrame + frames + gap - 1;
        }
        return new Promise((resolve) => {
            this.owed.push({ entries, resolve });
            this.payOwed();
        });
    }

    padSilence(ms: number): void {
        if (this.closed) return;
        const frames = msToFrames(ms);
        const startFrame = Math.max(this.frame + 1, this.queuedUntilFrame + 1);
        for (let i = 0; i < frames; i += 1) this.leg.write(silentCarrierFrame());
        this.queuedUntilFrame = startFrame + frames - 1;   // inclusive; see speak()
    }

    interrupt(): void {
        const dropped = this.leg.queuedFrames();
        if (!dropped) return;
        this.leg.clear();
        // Frames 0..this.frame have gone out, so that is this.frame + 1 played. Whatever the leg
        // kept after the clear still plays: `OutputGate` keeps an unacknowledged disclosure, and
        // settling that as cut would report a sentence the restaurant hears in full as lost.
        const kept = this.leg.queuedFrames();
        const audibleUntil = this.frame + 1 + kept;
        for (const entry of this.spoken) {
            if (entry.settled || entry.queuedAtFrame + entry.frames <= audibleUntil) continue;
            entry.heardFrames = Math.min(entry.frames, Math.max(0, audibleUntil - entry.queuedAtFrame));
            entry.settled = true;
        }
        this.queuedUntilFrame = audibleUntil - 1;   // inclusive; see speak()
        this.payOwed();
    }

    async hangup(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        // The recogniser's last word, but only while somebody is still on the line: a turn the far
        // end was in when they hung up is a turn nobody is left to answer, and the loop before the
        // async interface never flushed one either.
        if (!this.lineDown) {
            const event = this.detector.flush();
            if (event) {
                this.detected += 1;
                const turn = this.take(event.lastAudibleAt ?? this.frame, event.at);
                if (turn) this.emit('callerTurn', turn);
            }
        }
        // Every inbound frame was sent here, one per frame of call time, so `frame + 1` is the
        // count of frames that played. Whatever is still queued never will.
        this.settle(this.frame + 1);
        this.payOwed();
    }

    /**
     * Audio was inserted below the bridge — `OutputGate` replaying a talked-over disclosure — so
     * every sentence that had not started yet starts `frames` later. Without this the accounting
     * of what was heard drifts by the length of the disclosure on exactly the calls that matter.
     */
    delay(frames: number): void {
        for (const entry of this.spoken) {
            if (!entry.settled && entry.queuedAtFrame > this.frame) entry.queuedAtFrame += frames;
        }
        this.queuedUntilFrame += frames;
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
        return this.spoken.map((e) => ({ sentence: e.sentence, ...this.outcome(e) }));
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

    /**
     * Fire an event. An `error` nobody listens for is thrown instead: a bridge failure that
     * reaches no one is a call that goes on with a dead recogniser.
     */
    protected emit<K extends keyof SpeechBridgeEvents>(event: K, ...args: Parameters<SpeechBridgeEvents[K]>): void {
        const handlers = this.handlers[event] as Array<(...a: Parameters<SpeechBridgeEvents[K]>) => void>;
        if (event === 'error' && handlers.length === 0) throw args[0];
        for (const handler of handlers) handler(...args);
    }

    /** Heard frames and full frames, in milliseconds. Unsettled means it played to its end. */
    private outcome(entry: SpokenEntry): { heardMs: number; fullMs: number } {
        return {
            heardMs: (entry.settled ? entry.heardFrames : entry.frames) * CARRIER_AUDIO.frameMs,
            fullMs: entry.frames * CARRIER_AUDIO.frameMs,
        };
    }

    /**
     * Resolve every `speak()` whose sentences all have a known fate: settled by an interrupt or the
     * end of the call, or played through. Played through is the same arithmetic `heard()` uses, so
     * a `SpokenResult` and the report can never tell two stories about one sentence.
     */
    private payOwed(): void {
        if (!this.owed.length) return;
        const played = this.frame + 1;
        const still: typeof this.owed = [];
        for (const debt of this.owed) {
            const known = debt.entries.every((e) => e.settled || e.queuedAtFrame + e.frames <= played);
            if (!known) {
                still.push(debt);
                continue;
            }
            const sentences = debt.entries.map((e) => ({ id: e.id, text: e.sentence, ...this.outcome(e) }));
            debt.resolve({ sentences, complete: sentences.every((s) => s.heardMs === s.fullMs) });
        }
        this.owed = still;
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
