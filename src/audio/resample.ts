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

/**
 * Decimation for a STREAM of chunks (CORE-A13).
 *
 * Calling `decimate` once per chunk is wrong in three ways the audit measured (maxErr 677): each
 * chunk's filter holds its own edges, so every chunk join is a seam; the output phase restarts at
 * every chunk, so a chunk whose length is not a multiple of the ratio drifts; and the kernel is
 * rebuilt per call. This keeps the filter history and the output phase across chunks and builds
 * the kernel once, so feeding a signal in any chunking and then calling `flush()` gives exactly
 * what `decimate` gives for the whole signal at once. `test/audio.test.ts` holds it to that.
 */
export interface Decimator {
    /** The next chunk of input. Returns every output sample that no longer needs future input. */
    push(input: Int16Array): Int16Array;
    /** End of stream: the samples held back for look-ahead, with the last input sample held. */
    flush(): Int16Array;
}

export function createDecimator(fromRate: number, toRate: number, taps = 101): Decimator {
    if (toRate >= fromRate) throw new Error(`decimate: ${fromRate} → ${toRate} is not a decimation`);
    const kernel = lowPassKernel(0.45 * toRate, fromRate, taps);
    const mid = (taps - 1) / 2;
    const ratio = fromRate / toRate;

    let held = new Float64Array(0); // input samples from absolute index `base` on
    let base = 0;
    let total = 0; // input samples received
    let first = 0;
    let next = 0; // the next output index
    let flushed = false;

    const sampleAt = (j: number): number => {
        if (j < 0) return first;
        if (j >= total) return held[total - 1 - base] as number;
        return held[j - base] as number;
    };

    function emit(limit: (pos: number) => boolean): Int16Array {
        const out: number[] = [];
        for (;;) {
            const pos = Math.round(next * ratio);
            if (!limit(pos)) break;
            let acc = 0;
            for (let k = 0; k < taps; k++) acc += (kernel[k] as number) * sampleAt(pos + k - mid);
            out.push(clamp16(acc));
            next++;
        }
        // Drop history no later output can reach.
        const keepFrom = Math.max(0, Math.min(total - 1, Math.round(next * ratio) - mid));
        if (keepFrom > base) {
            held = held.slice(keepFrom - base);
            base = keepFrom;
        }
        return Int16Array.from(out);
    }

    return {
        push(input: Int16Array): Int16Array {
            if (flushed) throw new Error('decimator: push() after flush()');
            if (input.length === 0) return new Int16Array(0);
            if (total === 0) first = input[0] as number;
            const grown = new Float64Array(held.length + input.length);
            grown.set(held);
            grown.set(input, held.length);
            held = grown;
            total += input.length;
            return emit((pos) => pos + mid < total && next < Math.floor(total / ratio));
        },
        flush(): Int16Array {
            if (flushed) return new Int16Array(0);
            flushed = true;
            if (total === 0) return new Int16Array(0);
            const outLength = Math.floor(total / ratio);
            return emit(() => next < outLength);
        },
    };
}
