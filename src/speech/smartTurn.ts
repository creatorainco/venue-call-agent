/**
 * SPIKE (it-22, I3P-10): Smart Turn v3 (pipecat-ai/smart-turn, BSD-2) over onnxruntime-node.
 *
 * The model reads the last 8 s of a turn's audio as Whisper log-mel features (16 kHz, 80 bins,
 * 800 frames) and returns the probability that the speaker has finished. It was trained on 16 kHz
 * speech; the line carries 8 kHz, so the audio is upsampled here and has no energy over 4 kHz.
 * That is the spike's open risk (research.md, I3P-10).
 *
 * Loaded only when `VCA_SMART_TURN_MODEL` names the .onnx file, by a dynamic import, so the
 * tests and the mock still run with nothing installed.
 *
 * The features follow transformers' `WhisperFeatureExtractor(chunk_length=8)` as the reference
 * `inference.py` calls it: the waveform is zero-padded at the front to 8 s, normalised to zero mean
 * and unit variance, framed with a periodic 400-point Hann window every 160 samples (centred,
 * reflect padding), power spectrum, Slaney mel filters, log10, clamped to 8 below the maximum,
 * then (x + 4) / 4. The last STFT frame is dropped, as Whisper does.
 */

const SR = 16000;
const N_FFT = 400;
const HOP = 160;
const N_MELS = 80;
const SECONDS = 8;
const SAMPLES = SR * SECONDS;
const FRAMES = SAMPLES / HOP; // 800 after the last of 801 is dropped
const BINS = N_FFT / 2 + 1;

// ── the mel filter bank (Slaney scale and norm), built once ─────────────────────────────────────
const hzToMel = (f: number): number => (f < 1000 ? (3 * f) / 200 : 15 + Math.log(f / 1000) * (27 / Math.log(6.4)));
const melToHz = (m: number): number => (m < 15 ? (200 * m) / 3 : 1000 * Math.exp((m - 15) * (Math.log(6.4) / 27)));

function melFilters(): Float32Array[] {
    const fftFreqs = Array.from({ length: BINS }, (_, i) => (i * (SR / 2)) / (BINS - 1));
    const mMin = hzToMel(0);
    const mMax = hzToMel(SR / 2);
    const pts = Array.from({ length: N_MELS + 2 }, (_, i) => melToHz(mMin + ((mMax - mMin) * i) / (N_MELS + 1)));
    const filters: Float32Array[] = [];
    for (let m = 0; m < N_MELS; m += 1) {
        const row = new Float32Array(BINS);
        const enorm = 2 / (pts[m + 2]! - pts[m]!);
        for (let k = 0; k < BINS; k += 1) {
            const down = (fftFreqs[k]! - pts[m]!) / (pts[m + 1]! - pts[m]!);
            const up = (pts[m + 2]! - fftFreqs[k]!) / (pts[m + 2]! - pts[m + 1]!);
            row[k] = Math.max(0, Math.min(down, up)) * enorm;
        }
        filters.push(row);
    }
    return filters;
}
const MEL = melFilters();
const WINDOW = Float64Array.from({ length: N_FFT }, (_, n) => 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N_FFT));

// ── a mixed-radix FFT for n = 400 = 2^4 * 5^2, twiddles from one table ──────────────────────────
const COS = Float64Array.from({ length: N_FFT }, (_, j) => Math.cos((-2 * Math.PI * j) / N_FFT));
const SIN = Float64Array.from({ length: N_FFT }, (_, j) => Math.sin((-2 * Math.PI * j) / N_FFT));
function fft(re: Float64Array, im: Float64Array): void {
    const n = re.length;
    if (n === 1) return;
    const p = n % 2 === 0 ? 2 : n % 5 === 0 ? 5 : n % 3 === 0 ? 3 : n;
    if (p === n) {
        // a prime length: plain DFT
        const r = new Float64Array(n), i2 = new Float64Array(n);
        for (let k = 0; k < n; k += 1) {
            for (let t = 0; t < n; t += 1) {
                const a = (-2 * Math.PI * k * t) / n;
                r[k]! += re[t]! * Math.cos(a) - im[t]! * Math.sin(a);
                i2[k]! += re[t]! * Math.sin(a) + im[t]! * Math.cos(a);
            }
        }
        re.set(r); im.set(i2);
        return;
    }
    const m = n / p;
    const subRe: Float64Array[] = [], subIm: Float64Array[] = [];
    for (let q = 0; q < p; q += 1) {
        const sr = new Float64Array(m), si = new Float64Array(m);
        for (let t = 0; t < m; t += 1) { sr[t] = re[t * p + q]!; si[t] = im[t * p + q]!; }
        fft(sr, si);
        subRe.push(sr); subIm.push(si);
    }
    const stride = N_FFT / n;
    for (let k = 0; k < n; k += 1) {
        let accR = 0, accI = 0;
        for (let q = 0; q < p; q += 1) {
            const j = ((q * k) % n) * stride;
            const c = COS[j]!, s = SIN[j]!;
            const xr = subRe[q]![k % m]!, xi = subIm[q]![k % m]!;
            accR += xr * c - xi * s;
            accI += xr * s + xi * c;
        }
        re[k] = accR; im[k] = accI;
    }
}

/** 16 kHz float samples (any length; the last 8 s are used) to the model's [80, 800] input. */
export function whisperFeatures(audio16k: Float32Array): Float32Array {
    const x = new Float64Array(SAMPLES);
    const take = audio16k.subarray(Math.max(0, audio16k.length - SAMPLES));
    x.set(take, SAMPLES - take.length);
    let mean = 0;
    for (const v of x) mean += v;
    mean /= SAMPLES;
    let variance = 0;
    for (const v of x) variance += (v - mean) ** 2;
    variance /= SAMPLES;
    const scale = 1 / Math.sqrt(variance + 1e-7);
    for (let i = 0; i < SAMPLES; i += 1) x[i] = (x[i]! - mean) * scale;
    const pad = N_FFT / 2;
    const at = (i: number): number => {
        if (i < 0) return x[-i]!;
        if (i >= SAMPLES) return x[2 * (SAMPLES - 1) - i]!;
        return x[i]!;
    };
    const logMel = new Float32Array(N_MELS * FRAMES);
    const re = new Float64Array(N_FFT), im = new Float64Array(N_FFT);
    const power = new Float64Array(BINS);
    let max = -Infinity;
    // A frame of the constant that the zero front-padding normalised to has the same spectrum each
    // time: computed once and reused, which is most of an 8 s window on a short turn.
    let constFrame: Float64Array | null = null;
    const constValue = (0 - mean) * scale;
    for (let f = 0; f < FRAMES; f += 1) {
        const start = f * HOP - pad;
        const inPad = start + N_FFT <= SAMPLES - take.length && start >= 0;
        let spec: Float64Array;
        if (inPad && constFrame !== null) {
            spec = constFrame;
        } else {
            for (let t = 0; t < N_FFT; t += 1) { re[t] = (inPad ? constValue : at(start + t)) * WINDOW[t]!; im[t] = 0; }
            fft(re, im);
            for (let k = 0; k < BINS; k += 1) power[k] = re[k]! * re[k]! + im[k]! * im[k]!;
            spec = Float64Array.from(power);
            if (inPad) constFrame = spec;
        }
        for (let m = 0; m < N_MELS; m += 1) {
            const row = MEL[m]!;
            let e = 0;
            for (let k = 0; k < BINS; k += 1) e += row[k]! * spec[k]!;
            const v = Math.log10(Math.max(e, 1e-10));
            logMel[m * FRAMES + f] = v;
            if (v > max) max = v;
        }
    }
    for (let i = 0; i < logMel.length; i += 1) logMel[i] = (Math.max(logMel[i]!, max - 8) + 4) / 4;
    return logMel;
}

interface OrtLike {
    Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
    InferenceSession: { create(path: string, options?: object): Promise<{ run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>> }> };
}

export interface SmartTurnModel {
    /** Probability (0..1) that the turn in this 16 kHz audio is complete. */
    complete(audio16k: Float32Array): Promise<number>;
}

let loaded: SmartTurnModel | null = null;
let loading: Promise<SmartTurnModel | null> | null = null;

export function smartTurnLoaded(): SmartTurnModel | null {
    return loaded;
}

export function warmSmartTurn(env: NodeJS.ProcessEnv = process.env): Promise<SmartTurnModel | null> {
    if (loading) return loading;
    const path = env.VCA_SMART_TURN_MODEL;
    if (!path) return (loading = Promise.resolve(null));
    loading = (async () => {
        const ort = (await import('onnxruntime-node')) as unknown as OrtLike;
        const session = await ort.InferenceSession.create(path, { intraOpNumThreads: 1, interOpNumThreads: 1, executionMode: 'sequential' });
        const model: SmartTurnModel = {
            async complete(audio16k) {
                const features = whisperFeatures(audio16k);
                const out = await session.run({ input_features: new ort.Tensor('float32', features, [1, N_MELS, FRAMES]) });
                const first = Object.values(out)[0]!;
                return first.data[0]!;
            },
        };
        await model.complete(new Float32Array(SR));
        loaded = model;
        return model;
    })().catch((error) => {
        process.stderr.write(`smart_turn_unavailable ${(error as Error)?.message ?? error}\n`);
        return null;
    });
    return loading;
}
