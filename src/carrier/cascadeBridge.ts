/**
 * THE CASCADE BRIDGE: the real `SpeechBridge` on the phone runtime (I3P-01, TASK-3748).
 *
 * It composes parts that already exist and are tested on their own, and adds no intelligence:
 *
 *   in   carrier frames -> `StreamingStt` (final transcripts become `callerTurn`)
 *                       -> `TurnDetector` (speech over our audio is a barge-in: `interrupt()`)
 *   out  finished backend sentence -> `Tts.synthesize` -> μ-law frames -> `OutputGate` -> leg
 *
 * 🔴 IT NEVER COMPOSES TEXT. `speak()` synthesises exactly the strings it is handed, which the call
 * loop takes from the agent, which takes them from the backend, the call context or the four fixed
 * phrases. Nothing here builds, joins, trims or rewrites a sentence; `test/cascadeBridge.test.ts`
 * holds every synthesised string to the allowed set.
 *
 * 🔴 ONE SENTENCE ON THE LEG AT A TIME. Each sentence is written whole, followed by a carrier mark,
 * and the next is not written until that mark comes back (the rule `ScriptedBridge` records from
 * the `they-interrupt` fixture): an interrupt costs one sentence, not a paragraph, and the
 * transcript stays close to what was heard. A mark that never returns stalls the agent, which is
 * the gate's fail-closed shape; the call cap ends a call that goes quiet.
 *
 * 🔴 THE DISCLOSURE IS SYNTHESISED BEFORE ITS RANGE OPENS. `OutputGate` protects the frames written
 * between `beginDisclosure()` and `endDisclosure()`, so those writes must be synchronous. Synthesis
 * is not, so `speakDisclosure()` awaits the audio first (pre-rendered, so it is a cache hit) and
 * only then opens the range, writes it and closes it.
 *
 * A TURN MAY END ON THE INTERIM (I3P-07). With interim results on, a still interim that a keyword
 * cue decides, or a short invited answer, ends the venue's turn before the recogniser's final
 * (`src/speech/turnEnd.ts`); the final that follows is dropped when it is the same turn and
 * answered as a new one when it is not. `earlyTurnEnd: false` restores final-only turns.
 *
 * HOW MUCH WAS HEARD. A sentence whose mark came back was heard in full. One cut by a barge-in was
 * heard up to the frames the clear threw away. One still playing when the line went down is
 * reported as unheard: the carrier's queue is gone and nothing can say how far it got, and this
 * accounting under-claims rather than over-claims.
 */

import { CARRIER_AUDIO, MULAW_SILENCE } from '../audio/format.ts';
import { TURN_END } from '../tuning/cascadeDefaults.ts';
import { StreamingStt } from '../speech/stt.ts';
import type { SpeechStreamFactory } from '../speech/stt.ts';
import type { Tts } from '../speech/tts.ts';
import { sentenceDurationMs } from './bridge.ts';
import type { Sentence, SentenceOutcome, SpeechBridge, SpeechBridgeEvents, SpokenResult } from './bridge.ts';
import type { Frame } from './leg.ts';
import type { OutputGate } from './outputGate.ts';
import { TurnDetector } from './vad.ts';
import type { VadSettings } from './vad.ts';
import { continues, earlySettleMs, earlyTurn, ForegroundSpeech, sameTurn } from '../speech/turnEnd.ts';
import type { EarlyTurn } from '../speech/turnEnd.ts';
import { SileroStream, sileroLoaded } from '../speech/silero.ts';
import type { SileroEvent } from '../speech/silero.ts';
import { smartTurnLoaded } from '../speech/smartTurn.ts';
import { decode } from '../audio/mulaw.ts';
import { upsampleLinear } from '../audio/resample.ts';
import { keywordIntent } from '../agent/intent.ts';

/**
 * SPIKE it-22 (I3P-10): Smart Turn v3 ends a turn on the interim. Silero (with the 9 dB foreground
 * gate) marks a 200 ms pause in the venue's speech; Smart Turn reads the turn's audio, upsampled
 * to 16 kHz; above `SMART_TURN.threshold` the turn ends on the interim once it has stood
 * `SMART_TURN.interimSettleMs`, instead of waiting for Google's final. Never on a goodbye.
 */
const envNumber = (name: string, fallback: number): number => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && process.env[name] !== '' && process.env[name] !== undefined ? v : fallback;
};
/** Spike knobs: `VCA_SMART_TURN_PAUSE_MS` and `VCA_SMART_TURN_THRESHOLD` override for a second soak. */
export const SMART_TURN = {
    pauseMs: envNumber('VCA_SMART_TURN_PAUSE_MS', 200),
    threshold: envNumber('VCA_SMART_TURN_THRESHOLD', 0.5),
    interimSettleMs: 150,
    prefixMs: 300,
    maxSeconds: 8,
} as const;
const RING_SAMPLES = 8000 * SMART_TURN.maxSeconds;

export interface CascadeBridgeOptions {
    tts: Pick<Tts, 'synthesize'>;
    speech: SpeechStreamFactory;
    vad: VadSettings;
    /** Injected so the recogniser's rollover is testable. */
    sttClock?: () => number;
    /**
     * Told when a sentence's synthesis returned (`tts_first_byte`) and when its first frame was
     * written to the gate (`first_frame_out`): the stage timings (I3P-03). The id, never the text.
     */
    onStage?: (id: string, stage: 'tts_first_byte' | 'first_frame_out') => void;
    /** End a turn on a still interim (`src/speech/turnEnd.ts`). Default true. */
    earlyTurnEnd?: boolean;
    /**
     * Told the interim a settle timer is now waiting on: the turn this bridge may end early, so
     * the agent can start on it (`CallAgent.prefetch`). Text, never logged.
     */
    onSpeculate?: (text: string) => void;
    /** Event words and numbers only, never a transcript: `turn_end early`, `final_same_turn`. */
    log?: (line: string) => void;
    /** Injected so the interim's settle timer is testable. */
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
}

/** The sentence on the leg, waiting for its mark. */
interface Playing {
    mark: string;
    id: string;
    text: string;
    frames: number;
    /** The disclosure: a barge-in does not cut it (`OutputGate`), so it is never settled as cut. */
    protected: boolean;
    resolve: (outcome: SentenceOutcome) => void;
}

/** Split synthesised μ-law into carrier frames; the last is padded with μ-law silence. */
export function toFrames(audio: Uint8Array): Frame[] {
    const size = CARRIER_AUDIO.bytesPerFrame;
    const frames: Frame[] = [];
    for (let at = 0; at < audio.length; at += size) {
        const frame = new Uint8Array(size).fill(MULAW_SILENCE);
        frame.set(audio.subarray(at, Math.min(audio.length, at + size)));
        frames.push(frame);
    }
    return frames;
}

const msOf = (frames: number): number => frames * CARRIER_AUDIO.frameMs;

export class CascadeBridge implements SpeechBridge {
    private readonly gate: OutputGate;
    private readonly tts: Pick<Tts, 'synthesize'>;
    private readonly detector: TurnDetector;
    private readonly stt: StreamingStt;
    private readonly onStage: NonNullable<CascadeBridgeOptions['onStage']>;
    private readonly handlers: { [K in keyof SpeechBridgeEvents]: Array<SpeechBridgeEvents[K]> } = {
        callerTurn: [],
        interim: [],
        error: [],
    };
    private readonly ids = new Set<string>();
    private readonly earlyEnabled: boolean;
    private readonly log: (line: string) => void;
    private readonly onSpeculate: (text: string) => void;
    private readonly setTimer: (fn: () => void, ms: number) => unknown;
    private readonly clearTimer: (handle: unknown) => void;
    /** The next venue turn is the hello after the disclosure: a short one may end on the interim. */
    private expectShort = true;
    /** The interim being watched, and its settle timer. */
    private interimText = '';
    private settleTimer: unknown = null;
    private speculateTimer: unknown = null;
    /** The turn ended on an interim, until the recogniser's final for it arrives. */
    private early: EarlyTurn | null = null;
    /** The person at the phone against the room: an early end needs their voice, not babble. */
    private readonly foreground = new ForegroundSpeech();
    /** SPIKE it-22: the pause detector, the last 8 s of the venue's audio, and the turn's start. */
    private readonly pause: SileroStream | null;
    private readonly ring = new Int16Array(RING_SAMPLES);
    private ringSamples = 0;
    private turnStartSample: number | null = null;
    private smartComplete = false;
    private smartTimer: unknown = null;
    private smartSeq = 0;

    private frame = -1;
    private lastAudible = -1;
    private closed = false;
    private lineDown = false;
    /** Bumped by every interrupt and by the end of the line: sentences queued before it are dropped. */
    private generation = 0;
    private markSeq = 0;
    private playing: Playing | null = null;
    /** `speak()` calls run one after another, in the order they were made. */
    private chain: Promise<unknown> = Promise.resolve();

    /** Every string handed to synthesis, in order. The no-composition test reads it. */
    readonly synthesised: string[] = [];

    constructor(gate: OutputGate, options: CascadeBridgeOptions) {
        this.gate = gate;
        this.tts = options.tts;
        this.onStage = options.onStage ?? (() => {});
        this.earlyEnabled = options.earlyTurnEnd ?? true;
        this.log = options.log ?? (() => {});
        this.onSpeculate = options.onSpeculate ?? (() => {});
        this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
        this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
        this.detector = new TurnDetector(options.vad);
        const silero = sileroLoaded();
        this.pause = silero === null || smartTurnLoaded() === null || !(options.earlyTurnEnd ?? true)
            ? null
            : new SileroStream(silero, { threshold: 0.6, startChunks: 2, silenceMs: SMART_TURN.pauseMs, foregroundDb: 9 }, (e) => this.onPause(e));
        this.stt = new StreamingStt({
            factory: options.speech,
            onFinal: (text) => this.onFinal(text),
            onInterim: (text) => this.onInterim(text),
            onError: (error) => this.fail(error),
            ...(options.sttClock ? { clock: options.sttClock } : {}),
        });
        gate.on('marked', (name) => this.onMarked(name));
        gate.onDisclosureHeard(() => this.onDisclosureHeard());
        gate.on('hangup', () => {
            this.lineDown = true;
            this.abandon();
        });
    }

    /** Open the recogniser now, at call start (I3P-08), not on the first batch of audio. */
    start(): void {
        if (!this.closed) this.stt.start();
    }

    /**
     * Whether the venue's next turn is the hello after the disclosure (true at call start; the call
     * loop clears it at the first venue turn). Such a short turn may end on the interim; see
     * `src/speech/turnEnd.ts`.
     */
    expectShortTurn(value: boolean): void {
        this.expectShort = value;
    }

    on<K extends keyof SpeechBridgeEvents>(event: K, handler: SpeechBridgeEvents[K]): void {
        this.handlers[event].push(handler);
    }

    sendAudio(frame: Frame): void {
        if (this.closed) return;
        this.frame += 1;
        this.stt.push(frame);
        if (this.earlyEnabled) this.foreground.push(frame);
        if (this.pause !== null) {
            for (const sample of decode(Buffer.from(frame))) {
                this.ring[this.ringSamples % RING_SAMPLES] = sample;
                this.ringSamples += 1;
            }
            this.pause.push(frame);
        }
        const event = this.detector.push(frame);
        if (event?.kind === 'speech_started' && this.speaking()) this.interrupt();
        if (event?.kind === 'turn_ended') this.lastAudible = event.lastAudibleAt ?? this.frame;
    }

    /** The venue's audio from `fromSample` (absolute) to now, at most 8 s, upsampled to 16 kHz. */
    private turnAudio16k(fromSample: number): Float32Array {
        const from = Math.max(fromSample, this.ringSamples - RING_SAMPLES, 0);
        const pcm = new Int16Array(this.ringSamples - from);
        for (let i = 0; i < pcm.length; i += 1) pcm[i] = this.ring[(from + i) % RING_SAMPLES]!;
        if (pcm.length < 2) return new Float32Array(0);
        return Float32Array.from(upsampleLinear(pcm, 8000, 16000), (v) => v / 32768);
    }

    private onPause(event: SileroEvent): void {
        if (this.closed || this.lineDown) return;
        if (event.kind === 'speech_started') {
            this.smartComplete = false;
            this.cancelSmart();
            if (this.turnStartSample === null) {
                this.turnStartSample = Math.max(0, (event.atFrame + 1) * 160 - 512 - SMART_TURN.prefixMs * 8);
            }
            return;
        }
        const model = smartTurnLoaded();
        if (model === null || this.turnStartSample === null || this.early !== null) return;
        const seq = ++this.smartSeq;
        const startedAt = Date.now();
        void model.complete(this.turnAudio16k(this.turnStartSample)).then((p) => {
            // A newer pause or new speech since: this reading is stale.
            if (seq !== this.smartSeq || this.closed || this.lineDown || this.pause?.inSpeech) return;
            this.log(`smart_turn p=${p.toFixed(2)} ms=${Date.now() - startedAt}`);
            if (p < SMART_TURN.threshold) return;
            this.smartComplete = true;
            this.armSmart();
        }, () => {});
    }

    /** End the turn on the interim once it has stood `interimSettleMs` with Smart Turn's yes. */
    private armSmart(): void {
        this.cancelSmart();
        const text = this.interimText;
        this.smartTimer = this.setTimer(() => {
            this.smartTimer = null;
            if (!this.smartComplete || this.closed || this.lineDown || this.early !== null) return;
            if (text === '' || this.interimText !== text) return;
            if (keywordIntent(text) === 'confirm' || !this.foreground.heard()) return;
            this.cancelSettle();
            this.smartComplete = false;
            this.early = earlyTurn(text);
            this.expectShort = false;
            this.log('turn_end smart');
            this.emitTurn(text, true);
        }, SMART_TURN.interimSettleMs);
    }

    private cancelSmart(): void {
        if (this.smartTimer === null) return;
        this.clearTimer(this.smartTimer);
        this.smartTimer = null;
    }

    speak(sentences: readonly Sentence[]): Promise<SpokenResult> {
        return this.enqueue(sentences, false);
    }

    /**
     * The first sentence of the call, under `OutputGate`'s protected range. Must be the first
     * thing spoken: the gate throws on any audio before a disclosure has begun.
     */
    speakDisclosure(sentence: Sentence): Promise<SpokenResult> {
        return this.enqueue([sentence], true);
    }

    interrupt(): void {
        this.generation += 1;
        const current = this.playing;
        const before = this.gate.queuedFrames();
        if (before === 0 && current === null) return;
        this.gate.clear();
        if (current === null || current.protected) return;
        // The current sentence is the last thing queued, so the frames the clear dropped are its
        // tail (and, with a disclosure pending, all of it: it was held behind the mark).
        const dropped = before - this.gate.queuedFrames();
        this.settle(current, Math.max(0, current.frames - Math.min(current.frames, dropped)));
    }

    async hangup(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        this.pause?.close();
        this.cancelSmart();
        this.cancelSettle();
        this.stt.close();
        this.abandon();
    }

    speaking(): boolean {
        return this.playing !== null || this.gate.queuedFrames() > 0;
    }

    private enqueue(sentences: readonly Sentence[], protect: boolean): Promise<SpokenResult> {
        for (const { id } of sentences) {
            if (!id || this.ids.has(id)) {
                throw new Error(`CascadeBridge.speak: sentence id ${JSON.stringify(id)} is empty or already used`);
            }
            this.ids.add(id);
        }
        const generation = this.generation;
        const run = this.chain.then(() => this.play(sentences, generation, protect));
        this.chain = run.catch(() => {});
        return run;
    }

    private async play(sentences: readonly Sentence[], generation: number, protect: boolean): Promise<SpokenResult> {
        const out: SentenceOutcome[] = [];
        for (const { id, text } of sentences) {
            // A barge-in drops what is queued, but never the disclosure: `OutputGate` plays it whole.
            const dropped = (): boolean => this.closed || this.lineDown || (!protect && generation !== this.generation);
            if (dropped()) {
                out.push({ id, text, heardMs: 0, fullMs: sentenceDurationMs(text) });
                continue;
            }
            this.synthesised.push(text);
            let audio: Uint8Array;
            try {
                audio = await this.tts.synthesize(text);
            } catch (error) {
                const failure = error instanceof Error ? error : new Error('synthesis failed');
                this.fail(failure);
                throw failure;
            }
            this.onStage(id, 'tts_first_byte');
            const frames = toFrames(audio);
            if (dropped() || frames.length === 0) {
                out.push({ id, text, heardMs: 0, fullMs: msOf(frames.length) });
                continue;
            }
            out.push(await this.write(id, text, frames, protect));
        }
        return { sentences: out, complete: out.every((s) => s.fullMs > 0 && s.heardMs === s.fullMs) };
    }

    /**
     * Write one sentence and its mark; resolves once the mark is back, or the sentence is cut. The
     * disclosure resolves when the gate reports its protected range heard (`onDisclosureHeard`).
     */
    private write(id: string, text: string, frames: Frame[], protect: boolean): Promise<SentenceOutcome> {
        return new Promise<SentenceOutcome>((resolve) => {
            this.markSeq += 1;
            const mark = `say:${this.markSeq}`;
            this.playing = { mark, id, text, frames: frames.length, protected: protect, resolve };
            if (protect) this.gate.beginDisclosure();
            this.onStage(id, 'first_frame_out');
            for (const frame of frames) this.gate.write(frame);
            // The disclosure carries no mark of its own: the gate's mark behind the range is the
            // one that says it played, and it survives a barge-in. A mark of ours would sit in the
            // gate's held queue, and the barge-in's clear() would drop it, leaving the disclosure
            // unsettled and every later sentence waiting behind it for the rest of the call.
            if (protect) this.gate.endDisclosure();
            else this.gate.mark(mark);
        });
    }

    private onMarked(name: string): void {
        const current = this.playing;
        if (current === null || name !== current.mark) return;
        this.settle(current, current.frames);
    }

    private onDisclosureHeard(): void {
        const current = this.playing;
        if (current === null || !current.protected) return;
        this.settle(current, current.frames);
    }

    private settle(current: Playing, heardFrames: number): void {
        if (this.playing === current) this.playing = null;
        current.resolve({ id: current.id, text: current.text, heardMs: msOf(heardFrames), fullMs: msOf(current.frames) });
    }

    /** The line is down or the bridge closed: the sentence on the leg is reported unheard. */
    private abandon(): void {
        this.generation += 1;
        const current = this.playing;
        if (current !== null) this.settle(current, 0);
    }

    private onFinal(text: string): void {
        if (this.closed || this.lineDown) return;
        this.cancelSettle();
        this.cancelSmart();
        this.smartComplete = false;
        this.smartSeq += 1;
        this.turnStartSample = null;
        this.interimText = '';
        const early = this.early;
        this.early = null;
        if (early !== null && sameTurn(early, text)) {
            this.log('final_same_turn');
            return;
        }
        if (early !== null) this.log('final_new_turn');
        this.emitTurn(text, false);
    }

    /**
     * A still interim that `earlySettleMs` accepts ends the turn when its timer fires. Every new
     * interim restarts the wait, so a turn still being spoken never ends here.
     */
    private onInterim(text: string): void {
        if (this.closed || this.lineDown) return;
        this.emit('interim', text);
        if (!this.earlyEnabled || text === this.interimText) return;
        this.interimText = text;
        this.cancelSettle();
        if (this.smartComplete && this.early === null) this.armSmart();
        if (this.early !== null) {
            if (continues(this.early, text)) return;
            // The recogniser started a new utterance without finalising the last one.
            this.early = null;
        }
        const settle = earlySettleMs(text, this.expectShort);
        if (settle === null) return;
        // The agent may start on it once it has stood a moment: not on every revision, and only
        // for a person at the phone, never the room's babble.
        this.speculateTimer = this.setTimer(() => {
            this.speculateTimer = null;
            if (this.interimText === text && this.early === null && this.foreground.heard()) this.onSpeculate(text);
        }, Math.min(settle, TURN_END.speculateAfterMs));
        this.settleTimer = this.setTimer(() => {
            this.settleTimer = null;
            if (this.closed || this.lineDown || this.interimText !== text || this.early !== null) return;
            if (!this.foreground.heard()) {
                this.log('turn_end room_only');
                return;
            }
            this.early = earlyTurn(text);
            this.expectShort = false;
            this.log(`turn_end early settle_ms=${settle}`);
            this.emitTurn(text, true);
        }, settle);
    }

    private cancelSettle(): void {
        if (this.speculateTimer !== null) {
            this.clearTimer(this.speculateTimer);
            this.speculateTimer = null;
        }
        if (this.settleTimer === null) return;
        this.clearTimer(this.settleTimer);
        this.settleTimer = null;
    }

    private emitTurn(text: string, early: boolean): void {
        if (early) this.turnStartSample = null;
        const lastAudibleFrame = this.lastAudible >= 0 ? this.lastAudible : Math.max(0, this.frame);
        this.emit('callerTurn', {
            text,
            lastAudibleFrame,
            detectedFrame: Math.max(lastAudibleFrame, this.frame),
            ...(early ? { early: true } : {}),
        });
    }

    private fail(error: Error): void {
        if (this.closed) return;
        this.emit('error', error);
    }

    /** An `error` nobody listens for is thrown: a dead recogniser must reach someone. */
    private emit<K extends keyof SpeechBridgeEvents>(event: K, ...args: Parameters<SpeechBridgeEvents[K]>): void {
        const handlers = this.handlers[event] as Array<(...a: Parameters<SpeechBridgeEvents[K]>) => void>;
        if (event === 'error' && handlers.length === 0) throw args[0];
        for (const handler of handlers) handler(...args);
    }
}
