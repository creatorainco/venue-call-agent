/**
 * Sample-rate conversion, both directions, with the anti-aliasing filter that is easy to skip.
 *
 * The outbound leg is 24 kHz from the model down to 8 kHz for the line — a 3:1 decimation. Doing
 * that by throwing away two samples in three is one line of code and it FOLDS every frequency
 * above 4 kHz back down into the speech band as a metallic ghost of the voice. It still sounds
 * like words, which is why it ships: it is intelligible, slightly wrong, and nobody can say why.
 *
 * So `decimate` low-passes first. `decimateNoFilter` exists in the test file, not here, purely as
 * the control that proves the filter is doing something.
 */

/**
 * Windowed-sinc low-pass (Hamming), designed once per call site.
 *
 * @param cutoffHz  where the passband ends
 * @param rate      the rate the filter runs at
 * @param taps      odd, so the filter has an exact integer group delay
 */
export function lowPassKernel(cutoffHz: number, rate: number, taps = 101): Float64Array {
    if (taps % 2 === 0) throw new Error('lowPassKernel: taps must be odd so the delay is an integer');
    const kernel = new Float64Array(taps);
    const mid = (taps - 1) / 2;
    const fc = cutoffHz / rate; // normalised, cycles per sample
    let sum = 0;
    for (let i = 0; i < taps; i++) {
        const n = i - mid;
        const sinc = n === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * n) / (Math.PI * n);
        const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1));
        const v = sinc * window;
        kernel[i] = v;
        sum += v;
    }
    // Normalise to unity DC gain, so a constant signal keeps its level and silence stays silent.
    for (let i = 0; i < taps; i++) kernel[i] = (kernel[i] as number) / sum;
    return kernel;
}

/** Convolve, holding the edges rather than zero-padding — a zero pad clicks at frame joins. */
export function filter(input: Float64Array | Int16Array, kernel: Float64Array): Float64Array {
    const n = input.length;
    const taps = kernel.length;
    const mid = (taps - 1) / 2;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        let acc = 0;
        for (let k = 0; k < taps; k++) {
            const j = i + k - mid;
            const s = j < 0 ? input[0] : j >= n ? input[n - 1] : input[j];
            acc += (kernel[k] as number) * (s as number);
        }
        out[i] = acc;
    }
    return out;
}

const clamp16 = (v: number): number => (v > 32767 ? 32767 : v < -32768 ? -32768 : Math.round(v));

/**
 * Down to a lower rate, filtering first.
 *
 * The cutoff sits at 0.45 × the OUTPUT rate — below Nyquist with room for the filter's roll-off,
 * because a cutoff exactly at Nyquist leaves the transition band folding back.
 */
export function decimate(input: Int16Array, fromRate: number, toRate: number): Int16Array {
    if (toRate >= fromRate) throw new Error(`decimate: ${fromRate} → ${toRate} is not a decimation`);
    const kernel = lowPassKernel(0.45 * toRate, fromRate);
    const filtered = filter(input, kernel);
    const ratio = fromRate / toRate;
    const outLength = Math.floor(input.length / ratio);
    const out = new Int16Array(outLength);
    for (let i = 0; i < outLength; i++) out[i] = clamp16(filtered[Math.round(i * ratio)] as number);
    return out;
}

/**
 * Up to a higher rate, by linear interpolation.
 *
 * No filter needed on the way up in this direction: interpolation introduces images above the
 * original Nyquist, and the model's own front end is what consumes them. Upsampling is also the
 * leg we mostly do NOT have to do — the Live API resamples declared input itself — so this exists
 * for the offline harness rather than the call path.
 */
export function upsampleLinear(input: Int16Array, fromRate: number, toRate: number): Int16Array {
    if (toRate <= fromRate) throw new Error(`upsampleLinear: ${fromRate} → ${toRate} is not an upsample`);
    const ratio = toRate / fromRate;
    const outLength = Math.floor(input.length * ratio);
    const out = new Int16Array(outLength);
    for (let i = 0; i < outLength; i++) {
        const pos = i / ratio;
        const a = Math.floor(pos);
        const b = Math.min(a + 1, input.length - 1);
        const frac = pos - a;
        out[i] = clamp16((input[a] as number) * (1 - frac) + (input[b] as number) * frac);
    }
    return out;
}
