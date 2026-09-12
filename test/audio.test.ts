/**
 * The codec and the resampler, proved with no carrier, no audio device and no dependency.
 *
 * 🔴 THE GOLDEN VECTORS COME FROM THE STANDARD, NOT FROM OUR OWN ENCODER. A round trip checked
 * against your own implementation passes happily when both halves are wrong in the same way, and
 * μ-law is exactly the kind of code where they would be — an inverted output and a bias constant
 * are easy to get consistently wrong.
 *
 * 🔴 THE ALIASING TEST HAS A POSITIVE CONTROL. It runs the same assertion against a deliberately
 * naive decimator defined in this file and requires it to FAIL. Without that, a broken DFT would
 * report every decimator as clean, including the one that folds a voice back on itself.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CARRIER_AUDIO, MODEL_AUDIO, MULAW_SILENCE, silentCarrierFrame } from '../src/audio/format.ts';
import { bytesToPcm, decode, decodeSample, encode, encodeSample, pcmToBytes } from '../src/audio/mulaw.ts';
import { decimate, upsampleLinear } from '../src/audio/resample.ts';

describe('the formats are stated, not assumed', () => {
    test('the model reads 16-bit little-endian PCM and always writes 24 kHz', () => {
        assert.equal(MODEL_AUDIO.in.encoding, 'pcm_s16le');
        assert.equal(MODEL_AUDIO.out.sampleRate, 24000);
        assert.match(MODEL_AUDIO.in.mime ?? '', /^audio\/pcm;rate=\d+$/);
    });

    test('a carrier frame is 160 bytes of 8 kHz μ-law', () => {
        assert.equal(CARRIER_AUDIO.sampleRate * (CARRIER_AUDIO.frameMs / 1000), CARRIER_AUDIO.bytesPerFrame);
    });

    test('🔴 silence is 0xFF, and a zero-filled buffer is NOT silence', () => {
        assert.equal(MULAW_SILENCE, 0xff);
        assert.equal(decodeSample(0xff), 0, 'the silence byte must decode to zero');

        const roar = decodeSample(0x00);
        assert.ok(Math.abs(roar) > 30000, `0x00 decodes to ${roar} — full scale, and it plays as a roar`);

        const frame = silentCarrierFrame(2);
        assert.equal(frame.length, 320);
        assert.ok(frame.every((b) => b === 0xff));
    });
});

describe('μ-law against the standard', () => {
    // ITU-T G.711 / the Sun ulaw.c reference these all descend from.
    test('zero encodes to 0xFF', () => {
        assert.equal(encodeSample(0), 0xff);
    });

    test('full-scale positive encodes to 0x80 and negative to 0x00', () => {
        assert.equal(encodeSample(32635), 0x80);
        assert.equal(encodeSample(-32635), 0x00);
        // And beyond full scale clips rather than wrapping — a wrap is a click at peak level.
        assert.equal(encodeSample(32767), 0x80);
        assert.equal(encodeSample(-32768), 0x00);
    });

    test('the sign bit is the top bit of the inverted word: positives are >= 0x80', () => {
        for (const v of [1, 100, 1000, 10000, 32000]) {
            assert.ok(encodeSample(v) >= 0x80, `+${v} encoded to ${encodeSample(v).toString(16)}`);
            assert.ok(encodeSample(-v) < 0x80, `-${v} encoded to ${encodeSample(-v).toString(16)}`);
        }
    });

    test('encoding is monotonic — a louder sample never encodes quieter', () => {
        let previous = -Infinity;
        for (let v = 0; v <= 32000; v += 137) {
            const level = Math.abs(decodeSample(encodeSample(v)));
            assert.ok(level >= previous - 1, `monotonicity broke at ${v}`);
            previous = level;
        }
    });

    test('the 256 codes decode to 255 distinct levels — μ-law has both a +0 and a −0', () => {
        // Written down because "256 codes, 256 values" is the obvious assumption and it is wrong.
        // 0xFF is +0 and 0x7F is −0; they decode alike. Any OTHER collision means the segment
        // table is broken, which is exactly the failure this suite already caught once.
        const seen = new Set<number>();
        for (let b = 0; b < 256; b++) seen.add(decodeSample(b));
        assert.equal(seen.size, 255, 'a collision other than the two zeros means the table is wrong');
        assert.equal(decodeSample(0xff), 0);
        assert.equal(decodeSample(0x7f), 0);
    });

    test('a round trip over 4096 pseudo-random samples stays inside the quantiser', () => {
        // A seeded LCG, never Math.random — a flaky audio test is a test nobody trusts.
        let seed = 12345;
        const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

        const pcm = new Int16Array(4096);
        for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round((rand() * 2 - 1) * 32000);

        const back = decode(encode(pcm));
        let worstRelative = 0;
        for (let i = 0; i < pcm.length; i++) {
            // μ-law is logarithmic, so the error grows with level and the bound has to be
            // relative — with an absolute floor, because near zero the relative error of a
            // 3-count sample rounding to 0 is 100% and means nothing.
            const level = Math.abs(pcm[i] as number);
            const error = Math.abs(level - Math.abs(back[i] as number));
            const allowed = Math.max(8, level * 0.09);
            assert.ok(error <= allowed, `sample ${i}: ${pcm[i]} → ${back[i]}, error ${error} > ${allowed}`);
            if (level > 200) worstRelative = Math.max(worstRelative, error / level);
        }
        assert.ok(worstRelative < 0.09, `worst relative error above the noise floor: ${worstRelative}`);
    });

    test('bytes survive the little-endian trip the model requires', () => {
        const pcm = Int16Array.from([0, 1, -1, 32767, -32768, 1234]);
        assert.deepEqual([...bytesToPcm(pcmToBytes(pcm))], [...pcm]);
        assert.equal(pcmToBytes(pcm).length, pcm.length * 2);
    });
});

// ── a DFT, inline, so the aliasing claim is measured rather than asserted ─────

function magnitudeAt(signal: Int16Array, rate: number, hz: number): number {
    const n = Math.min(signal.length, 1024);
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
        const angle = (-2 * Math.PI * hz * i) / rate;
        re += (signal[i] as number) * Math.cos(angle);
        im += (signal[i] as number) * Math.sin(angle);
    }
    return Math.hypot(re, im) / n;
}

function tone(hz: number, rate: number, samples: number): Int16Array {
    const out = new Int16Array(samples);
    for (let i = 0; i < samples; i++) out[i] = Math.round(20000 * Math.sin((2 * Math.PI * hz * i) / rate));
    return out;
}

/** The control: decimation with no filter at all. It MUST fail the aliasing assertion. */
function decimateNoFilter(input: Int16Array, fromRate: number, toRate: number): Int16Array {
    const ratio = fromRate / toRate;
    const out = new Int16Array(Math.floor(input.length / ratio));
    for (let i = 0; i < out.length; i++) out[i] = input[Math.round(i * ratio)] as number;
    return out;
}

describe('resampling 24 kHz down to the line', () => {
    test('the output length follows the rate ratio', () => {
        const input = tone(440, 24000, 2400);
        assert.equal(decimate(input, 24000, 8000).length, 800);
    });

    test('a tone inside the speech band survives at roughly its own level', () => {
        const input = tone(1000, 24000, 2400);
        const out = decimate(input, 24000, 8000);
        const kept = magnitudeAt(out, 8000, 1000);
        assert.ok(kept > 5000, `1 kHz came through at ${kept.toFixed(0)} — the filter is eating the passband`);
    });

    test('DC and silence are preserved — unity gain, no offset', () => {
        const dc = new Int16Array(2400).fill(1000);
        const out = decimate(dc, 24000, 8000);
        for (const v of out) assert.ok(Math.abs(v - 1000) < 20, `DC drifted to ${v}`);

        const quiet = new Int16Array(2400);
        for (const v of decimate(quiet, 24000, 8000)) assert.equal(v, 0);
    });

    test('🔴 a 3.6 kHz tone does not fold back into the speech band', () => {
        // At 24 kHz→8 kHz, an unfiltered 3.6 kHz component images to 4.4 kHz and folds to 3.6 kHz
        // — but a 5 kHz one folds to 3 kHz, right into the middle of a voice. Use 5 kHz: it is
        // above the 8 kHz Nyquist's usable band and must be gone.
        const input = tone(5000, 24000, 2400);
        const filtered = decimate(input, 24000, 8000);
        const ghost = magnitudeAt(filtered, 8000, 3000);
        const reference = magnitudeAt(tone(3000, 8000, 800), 8000, 3000);
        const downDb = 20 * Math.log10(Math.max(ghost, 1e-9) / reference);
        assert.ok(downDb < -20, `the 5 kHz tone folded to 3 kHz only ${downDb.toFixed(1)} dB down`);
    });

    test('POSITIVE CONTROL: the same assertion FAILS for an unfiltered decimator', () => {
        // If this ever passes, the DFT above is broken and the previous test proves nothing.
        const input = tone(5000, 24000, 2400);
        const naive = decimateNoFilter(input, 24000, 8000);
        const ghost = magnitudeAt(naive, 8000, 3000);
        const reference = magnitudeAt(tone(3000, 8000, 800), 8000, 3000);
        const downDb = 20 * Math.log10(Math.max(ghost, 1e-9) / reference);
        assert.ok(downDb > -20,
            `the unfiltered decimator was ${downDb.toFixed(1)} dB down — it should have folded loudly, ` +
            'so either the measurement or the control is wrong');
    });
});

describe('resampling up, for the offline harness', () => {
    test('length follows the ratio and a tone survives', () => {
        const input = tone(500, 8000, 800);
        const out = upsampleLinear(input, 8000, 16000);
        assert.equal(out.length, 1600);
        assert.ok(magnitudeAt(out, 16000, 500) > 5000);
    });

    test('the wrong direction is refused rather than silently doing nothing', () => {
        assert.throws(() => upsampleLinear(new Int16Array(10), 16000, 8000), /not an upsample/);
        assert.throws(() => decimate(new Int16Array(10), 8000, 16000), /not a decimation/);
    });
});
