/**
 * TURN DETECTION — the knob almost all of the audible quality hangs on, made measurable without
 * a Google account.
 *
 * 🔴 READ THIS BEFORE QUOTING A NUMBER FROM IT. This is NOT Google's voice activity detector.
 * The real one runs on their side of the Live session, its algorithm is not published, and it
 * cannot be observed from here. What this is: the same four parameters, with the same names and
 * the same units, over the same arithmetic — a frame is speech or it is not, a turn ends after a
 * run of non-speech frames long enough to count.
 *
 * So the honest claim is bounded, and it is still worth a great deal:
 *
 *   ✅ it tells you how a given `silenceDurationMs` behaves against a KNOWN pause structure —
 *      which pauses it survives, which it cuts through, and how late it fires
 *   ✅ it turns "sweep 400 / 600 / 800 / 1000 / 1200" (docs/TUNING.md §3.3) into a command that
 *      runs in a second, on a laptop, with no credential, before anybody spends a call on it
 *   ❌ it does NOT predict what Google's detector will do with the same setting
 *   ❌ a number from here is a starting point for a real measurement, never a substitute
 *
 * The one property that IS transferable is the shape of the failure. If 400 ms cuts a manager off
 * mid-sentence on a fixture with 500 ms thinking pauses, it will cut them off on a real call too,
 * because the pause is in the human and not in the detector.
 *
 * ⚠️ Sensitivity is the weakest analogy here. Google exposes `START_SENSITIVITY_LOW/HIGH` and
 * says nothing about what they mean numerically. This maps them to an energy threshold and a
 * required run length, which is a plausible reading and is not their implementation. Treat a
 * sensitivity comparison from this file as a hypothesis; treat a silence-duration comparison as
 * useful.
 */

import { CARRIER_AUDIO } from '../audio/format.ts';
import { decode } from '../audio/mulaw.ts';
import { msToFrames } from './leg.ts';
import type { Frame } from './leg.ts';

export type StartSensitivity = 'START_SENSITIVITY_LOW' | 'START_SENSITIVITY_HIGH';
export type EndSensitivity = 'END_SENSITIVITY_LOW' | 'END_SENSITIVITY_HIGH';

export interface VadSettings {
    startOfSpeechSensitivity: StartSensitivity;
    endOfSpeechSensitivity: EndSensitivity;
    prefixPaddingMs: number;
    silenceDurationMs: number;
}

/**
 * Root-mean-square amplitude, in PCM16 units, above which a frame counts as speech.
 *
 * These two numbers are ours and are not from any specification. LOW is deliberately well above
 * the noise a kitchen makes and below ordinary speech; HIGH is low enough that a dropped tray
 * trips it, which is the behaviour `docs/TUNING.md` warns about.
 */
const START_THRESHOLD: Record<StartSensitivity, number> = {
    START_SENSITIVITY_LOW: 1_200,
    START_SENSITIVITY_HIGH: 300,
};

/** Consecutive speech frames needed before a turn is considered started. 20 ms each. */
const START_RUN_FRAMES: Record<StartSensitivity, number> = {
    START_SENSITIVITY_LOW: 3,
    START_SENSITIVITY_HIGH: 1,
};

/**
 * How close to the START threshold a frame may be and still count as silence for ENDING a turn.
 *
 * 🔴 A FRACTION, NOT AN ABSOLUTE, AND THAT IS A BUG FIX. This was two independent tables, and
 * the file claimed hysteresis — "lower than the start threshold on purpose" — as a design
 * property. It held for exactly ONE of the four legal sensitivity pairs. LOW/HIGH gave
 * end=1500 against start=1200; HIGH/LOW gave 600 against 300; HIGH/HIGH gave 1500 against 300.
 * In those three the detector ends a turn on audio it would have called speech, which is a
 * turn ending mid-word — the precise failure the comment said the design prevented.
 *
 * Deriving it from the start threshold makes the invariant hold by construction rather than by
 * a reader noticing. The pinned LOW/LOW pair is unchanged — 1200 x 0.5 = 600, exactly what the
 * old table said — so nothing that has been measured moves.
 */
const END_FRACTION: Record<EndSensitivity, number> = {
    /** Half the start threshold: a wide dead band, so a quiet syllable stays inside the turn. */
    END_SENSITIVITY_LOW: 0.5,
    /** Close underneath it: ends turns eagerly, which is what HIGH is asking for. */
    END_SENSITIVITY_HIGH: 0.9,
};

export interface TurnEvent {
    kind: 'speech_started' | 'turn_ended';
    /** Frames since the call connected. */
    at: number;
    /** On `turn_ended`: the frame the last audible sound was in, before the silence run. */
    lastAudibleAt?: number;
    /** On `turn_ended`: how long after the last audible frame this fired, in ms. */
    latencyMs?: number;
    /** On `speech_started`: the frame audio should be replayed from, honouring prefixPaddingMs. */
    replayFrom?: number;
}

/**
 * Feed it frames; it tells you when a turn started and when it ended.
 *
 * Stateful and single-call. Construct one per leg.
 */
export class TurnDetector {
    // No `constructor(private readonly settings)`. A parameter property typechecks and throws
    // ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX at runtime under Node's type stripping.
    private readonly settings: VadSettings;
    private readonly startThreshold: number;
    private readonly endThreshold: number;
    private readonly startRun: number;
    private readonly silenceFrames: number;
    private readonly prefixFrames: number;

    private frame = -1;
    private speechRun = 0;
    private silenceRun = 0;
    private inSpeech = false;
    private lastAudible = -1;

    /** Every frame's RMS, kept so a sweep can re-score without regenerating audio. */
    readonly energy: number[] = [];

    constructor(settings: VadSettings) {
        this.settings = settings;
        this.startThreshold = START_THRESHOLD[settings.startOfSpeechSensitivity];
        this.endThreshold = this.startThreshold * END_FRACTION[settings.endOfSpeechSensitivity];
        // Belt and braces: the invariant is now structural, so if it ever breaks again it broke
        // in a way somebody meant, and they should have to see this line to do it.
        if (!(this.endThreshold < this.startThreshold)) {
            throw new Error(
                `TurnDetector: end threshold ${this.endThreshold} is not below start `
                + `${this.startThreshold}. Without hysteresis a quiet syllable ends the turn.`,
            );
        }
        this.startRun = START_RUN_FRAMES[settings.startOfSpeechSensitivity];
        this.silenceFrames = msToFrames(settings.silenceDurationMs);
        this.prefixFrames = msToFrames(settings.prefixPaddingMs);
    }

    /** Push one inbound frame. Returns an event if this frame caused one, else null. */
    push(frame: Frame): TurnEvent | null {
        this.frame += 1;
        const rms = frameEnergy(frame);
        this.energy.push(rms);

        if (!this.inSpeech) {
            if (rms >= this.startThreshold) {
                this.speechRun += 1;
                if (this.speechRun >= this.startRun) {
                    this.inSpeech = true;
                    this.silenceRun = 0;
                    this.lastAudible = this.frame;
                    const startedAt = this.frame - (this.startRun - 1);
                    return {
                        kind: 'speech_started',
                        at: startedAt,
                        replayFrom: Math.max(0, startedAt - this.prefixFrames),
                    };
                }
            } else {
                this.speechRun = 0;
            }
            return null;
        }

        if (rms >= this.endThreshold) {
            this.silenceRun = 0;
            this.lastAudible = this.frame;
            return null;
        }

        this.silenceRun += 1;
        if (this.silenceRun >= this.silenceFrames) {
            this.inSpeech = false;
            this.speechRun = 0;
            const lastAudibleAt = this.lastAudible;
            this.silenceRun = 0;
            return {
                kind: 'turn_ended',
                at: this.frame,
                lastAudibleAt,
                latencyMs: (this.frame - lastAudibleAt) * CARRIER_AUDIO.frameMs,
            };
        }
        return null;
    }

    /**
     * The far end stopped sending. If a turn was open, close it — otherwise a caller who hangs up
     * mid-sentence never gets a turn and the last thing they said is lost.
     */
    flush(): TurnEvent | null {
        if (!this.inSpeech) return null;
        this.inSpeech = false;
        return {
            kind: 'turn_ended',
            at: this.frame,
            lastAudibleAt: this.lastAudible,
            latencyMs: (this.frame - this.lastAudible) * CARRIER_AUDIO.frameMs,
        };
    }

    get describe(): string {
        return `silence=${this.settings.silenceDurationMs}ms start=${this.settings.startOfSpeechSensitivity} `
            + `end=${this.settings.endOfSpeechSensitivity} prefix=${this.settings.prefixPaddingMs}ms`;
    }
}

/** RMS of a μ-law frame, in PCM16 units. Decodes through the real codec, not an approximation. */
export function frameEnergy(frame: Frame): number {
    const pcm = decode(Buffer.from(frame));
    let sum = 0;
    for (const sample of pcm) sum += sample * sample;
    return Math.sqrt(sum / pcm.length);
}
