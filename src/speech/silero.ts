/**
 * SPIKE (it-22, I3P-09): Silero VAD v5 over onnxruntime-node, on the carrier's 8 kHz audio.
 *
 * Silero v5 takes 8 kHz natively: 256-sample chunks (32 ms) with the last 32 samples of the
 * previous chunk prepended as context, and a [2, 1, 128] recurrent state carried between chunks.
 * The model and onnxruntime are loaded only when `VCA_SILERO_MODEL` names the .onnx file, by a
 * dynamic import, so every test and the mock still run on a clone with nothing installed.
 *
 * `SileroStream` turns the per-chunk probability into the same two events `TurnDetector` gives:
 * `speech_started` after `startChunks` chunks at or above `threshold`, and `turn_ended` after
 * `silenceMs` of chunks under `threshold - 0.15` (the hysteresis `get_speech_timestamps` uses).
 * Inference is async, so events arrive by callback, in order, a few ms after their chunk.
 */

import { decode } from '../audio/mulaw.ts';

const CHUNK = 256;
const CONTEXT = 32;
const RATE = 8000;
const CHUNK_MS = (CHUNK / RATE) * 1000;

export interface SileroSettings {
    threshold: number;
    startChunks: number;
    silenceMs: number;
    /**
     * Also require the chunk to stand this many dB over the room's floor (the 20th percentile of
     * the last ~3 s of chunk energy), or null for Silero alone. Silero calls babble speech: on the
     * corpus bed it scores 0.87 at the median, so on its own it cannot tell the room from the phone.
     */
    foregroundDb: number | null;
}

/**
 * Barge-in: a little stricter on the start than Silero's 0.5 default, and 9 dB over the room's
 * floor (the margin `TURN_END.foregroundMarginDb` already uses), measured by the compare-vad script on spike/silero-vad.
 */
export const SILERO_BARGE_IN: SileroSettings = { threshold: 0.6, startChunks: 2, silenceMs: 300, foregroundDb: 9 };

const FLOOR_CHUNKS = 94;

interface OrtLike {
    Tensor: new (type: string, data: Float32Array | BigInt64Array, dims: number[]) => unknown;
    InferenceSession: { create(path: string, options?: object): Promise<SessionLike> };
}
interface SessionLike {
    run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>>;
}

export interface SileroModel {
    /** One chunk of 8 kHz float samples (-1..1) in, speech probability out; state is the caller's. */
    infer(input: Float32Array, state: Float32Array): Promise<{ prob: number; state: Float32Array }>;
}

let loading: Promise<SileroModel | null> | null = null;

/** The process's one Silero session, or null when `VCA_SILERO_MODEL` is unset or fails to load. */
export function sileroModel(env: NodeJS.ProcessEnv = process.env): Promise<SileroModel | null> {
    if (loading) return loading;
    const path = env.VCA_SILERO_MODEL;
    if (!path) return (loading = Promise.resolve(null));
    loading = (async () => {
        const ort = (await import('onnxruntime-node')) as unknown as OrtLike;
        const session = await ort.InferenceSession.create(path, { intraOpNumThreads: 1, interOpNumThreads: 1 });
        const sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(RATE)]), []);
        const model: SileroModel = {
            async infer(input, state) {
                const out = await session.run({
                    input: new ort.Tensor('float32', input, [1, input.length]),
                    state: new ort.Tensor('float32', state, [2, 1, 128]),
                    sr,
                });
                return { prob: out.output!.data[0]!, state: out.stateN!.data as Float32Array };
            },
        };
        // Warm the graph once so the first call's first chunk does not pay it.
        await model.infer(new Float32Array(CHUNK + CONTEXT), new Float32Array(256));
        return model;
    })().catch((error) => {
        process.stderr.write(`silero_unavailable ${(error as Error)?.message ?? error}\n`);
        return null;
    });
    return loading;
}

/** Synchronously: the loaded model, or null while it loads or when it is off. */
let loaded: SileroModel | null = null;
export function sileroLoaded(): SileroModel | null {
    return loaded;
}
export async function warmSilero(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
    loaded = await sileroModel(env);
    return loaded !== null;
}

export interface SileroEvent {
    kind: 'speech_started' | 'turn_ended';
    /** Carrier frame (20 ms) the chunk ended in. */
    atFrame: number;
    /** On `turn_ended`: the carrier frame of the last chunk at or above the threshold. */
    lastAudibleFrame?: number;
}

export class SileroStream {
    readonly #model: SileroModel;
    readonly #settings: SileroSettings;
    readonly #onEvent: (event: SileroEvent) => void;
    #pending: number[] = [];
    #context: Float32Array = new Float32Array(CONTEXT);
    #state: Float32Array = new Float32Array(256);
    #chain: Promise<void> = Promise.resolve();
    #frames = 0;
    #inSpeech = false;
    #run = 0;
    #silentMs = 0;
    #lastAudibleFrame = -1;
    #closed = false;
    readonly #energies: number[] = [];
    /** Every chunk's probability, for the offline comparison. */
    readonly probs: number[] = [];

    constructor(model: SileroModel, settings: SileroSettings, onEvent: (event: SileroEvent) => void) {
        this.#model = model;
        this.#settings = settings;
        this.#onEvent = onEvent;
    }

    get inSpeech(): boolean {
        return this.#inSpeech;
    }

    push(frame: Uint8Array): void {
        if (this.#closed) return;
        this.#frames += 1;
        for (const s of decode(Buffer.from(frame))) this.#pending.push(s / 32768);
        while (this.#pending.length >= CHUNK) {
            const chunk = this.#pending.splice(0, CHUNK);
            const atFrame = this.#frames - 1;
            const input = new Float32Array(CONTEXT + CHUNK);
            input.set(this.#context, 0);
            input.set(chunk, CONTEXT);
            let sum = 0;
            for (const x of chunk) sum += x * x;
            const rms = Math.sqrt(sum / CHUNK);
            this.#context = input.slice(input.length - CONTEXT);
            this.#chain = this.#chain.then(() => this.#score(input, atFrame, rms));
        }
    }

    /** Resolves once every chunk pushed so far has been scored. */
    drain(): Promise<void> {
        return this.#chain;
    }

    close(): void {
        this.#closed = true;
    }

    #foreground(rms: number): boolean {
        const db = this.#settings.foregroundDb;
        this.#energies.push(rms);
        if (this.#energies.length > FLOOR_CHUNKS) this.#energies.shift();
        if (db === null) return true;
        const sorted = [...this.#energies].sort((a, b) => a - b);
        const floor = sorted[Math.floor(sorted.length * 0.2)] ?? 0;
        return rms > 0 && rms >= floor * 10 ** (db / 20);
    }

    async #score(input: Float32Array, atFrame: number, rms: number): Promise<void> {
        if (this.#closed) return;
        const { prob: raw, state } = await this.#model.infer(input, this.#state);
        this.#state = state;
        this.probs.push(raw);
        const prob = this.#foreground(rms) ? raw : 0;
        const { threshold, startChunks, silenceMs } = this.#settings;
        if (!this.#inSpeech) {
            this.#run = prob >= threshold ? this.#run + 1 : 0;
            if (this.#run >= startChunks) {
                this.#inSpeech = true;
                this.#silentMs = 0;
                this.#lastAudibleFrame = atFrame;
                this.#onEvent({ kind: 'speech_started', atFrame });
            }
            return;
        }
        if (prob >= threshold - 0.15) {
            this.#silentMs = 0;
            this.#lastAudibleFrame = atFrame;
            return;
        }
        this.#silentMs += CHUNK_MS;
        if (this.#silentMs >= silenceMs) {
            this.#inSpeech = false;
            this.#run = 0;
            this.#silentMs = 0;
            this.#onEvent({ kind: 'turn_ended', atFrame, lastAudibleFrame: this.#lastAudibleFrame });
        }
    }
}
