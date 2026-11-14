/**
 * CORE-A13: audio that arrives in chunks is converted as if it had arrived whole.
 *
 * The audit measured a max error of 677 between chunked and whole-signal decimation, and an
 * odd-length PCM chunk losing a byte. Both are pinned here with their controls: the old per-chunk
 * call must show the error, so the equality below is not equality of two broken things.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createDecimator, decimate } from '../src/audio/resample.ts';
import { bytesToPcm, createPcmBytesReader, pcmToBytes } from '../src/audio/mulaw.ts';

/** A deterministic signal with energy across the band: two tones and a little pseudo-noise. */
function signal(n: number, rate = 24000): Int16Array {
    const out = new Int16Array(n);
    let seed = 12345;
    for (let i = 0; i < n; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const noise = ((seed % 2001) - 1000) * 2;
        out[i] = Math.round(9000 * Math.sin((2 * Math.PI * 440 * i) / rate) + 6000 * Math.sin((2 * Math.PI * 3100 * i) / rate) + noise);
    }
    return out;
}

/** Split into the awkward sizes a socket delivers: odd, tiny, larger than the filter. */
function chunks<T extends { length: number; subarray(a: number, b: number): T }>(whole: T, sizes: number[]): T[] {
    const out: T[] = [];
    let at = 0;
    let k = 0;
    while (at < whole.length) {
        const size = sizes[k++ % sizes.length]!;
        out.push(whole.subarray(at, Math.min(whole.length, at + size)));
        at += size;
    }
    return out;
}

const maxAbsDiff = (a: Int16Array, b: Int16Array) => {
    let m = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) m = Math.max(m, Math.abs((a[i] as number) - (b[i] as number)));
    return m;
};

function concat(parts: Int16Array[]): Int16Array {
    const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
}

describe('the stateful decimator', () => {
    const whole = signal(24000 * 2 + 7);
    const expected = decimate(whole, 24000, 8000);

    for (const sizes of [[480], [7, 1, 333, 2], [1], [24000 * 3]]) {
        test(`chunked as ${JSON.stringify(sizes)}: identical to decimating the whole signal`, () => {
            const d = createDecimator(24000, 8000);
            const out = concat([...chunks(whole, sizes).map((c) => d.push(c)), d.flush()]);
            assert.equal(out.length, expected.length);
            assert.equal(maxAbsDiff(out, expected), 0);
        });
    }

    test('CONTROL — the old per-chunk call has seams at every join', () => {
        const naive = concat(chunks(whole, [7, 1, 333, 2]).map((c) => c.length >= 3 ? decimate(c, 24000, 8000) : new Int16Array(0)));
        assert.ok(maxAbsDiff(naive, expected) > 100 || naive.length !== expected.length);
    });

    test('push after flush throws; flush twice is empty; an empty push is empty', () => {
        const d = createDecimator(24000, 8000);
        assert.equal(d.push(new Int16Array(0)).length, 0);
        d.push(signal(300));
        d.flush();
        assert.equal(d.flush().length, 0);
        assert.throws(() => d.push(signal(3)), /after flush/);
    });

    test('refuses a non-decimation, like decimate', () => {
        assert.throws(() => createDecimator(8000, 24000), /not a decimation/);
    });
});

describe('PCM bytes in chunks keep their odd byte', () => {
    const pcm = signal(1001);
    const bytes = pcmToBytes(pcm);

    test('odd-length chunks read back the exact samples', () => {
        const reader = createPcmBytesReader();
        const out = concat(chunks(bytes, [3, 5, 1, 7, 480]).map((c) => reader.push(c)));
        assert.deepEqual(out, pcm);
        assert.equal(reader.carried, 0);
    });

    test('CONTROL — bytesToPcm per chunk drops the byte and garbles what follows', () => {
        const naive = concat(chunks(bytes, [3, 5, 1, 7, 480]).map((c) => bytesToPcm(Buffer.from(c))));
        assert.notEqual(naive.length, pcm.length);
    });
});
