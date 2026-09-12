/**
 * G.711 μ-law, both directions.
 *
 * ITU-T G.711, the same segment table as the Sun `ulaw.c` reference every telephony stack
 * descends from. Deliberately written out rather than pulled from a package: it is forty lines,
 * it has no dependencies, and a repository that can run its whole test suite with zero installed
 * packages is a repository an intern can start on in five minutes.
 *
 * 🔴 THE OUTPUT IS INVERTED, and that is not a bug. μ-law stores the ones' complement of the
 * sign/exponent/mantissa word, which is why encoded silence is 0xFF and a zero-filled buffer is
 * full-scale negative. See MULAW_SILENCE in format.ts.
 */

const BIAS = 0x84;   // 132
const CLIP = 32635;  // the largest magnitude representable after the bias is added

/**
 * Exponent lookup over the top 8 bits of (magnitude + BIAS), 256 entries.
 *
 * The standard's `exp_lut` is a literal table of 256 numbers whose structure is eight runs of
 * doubling length: 2 zeros, 2 ones, 4 twos, 8 threes, 16 fours, 32 fives, 64 sixes, 128 sevens.
 * Built here from that rule rather than pasted, because the rule is checkable by eye and a
 * 256-number literal is not.
 *
 * ⚠️ IT WAS PASTED FIRST, AND IT WAS WRONG — 128 entries with the runs shifted by one. Every
 * sample above about 8 kHz of amplitude encoded to the wrong segment, the round trip was off by
 * 16,000, and `npm test` said so within a second because the golden vectors come from the
 * standard rather than from this file. That is the whole argument for golden vectors.
 */
const SEGMENT = (() => {
    const table = new Uint8Array(256);
    let index = 0;
    for (let exponent = 0; exponent < 8; exponent++) {
        const run = exponent === 0 ? 2 : 1 << exponent;
        for (let i = 0; i < run && index < 256; i++) table[index++] = exponent;
    }
    return table;
})();

/** One 16-bit signed sample → one μ-law byte. */
export function encodeSample(sample: number): number {
    let s = Math.max(-32768, Math.min(32767, Math.round(sample)));
    const sign = s < 0 ? 0x80 : 0x00;
    if (s < 0) s = -s;
    if (s > CLIP) s = CLIP;
    s += BIAS;

    const exponent = SEGMENT[(s >> 7) & 0xff] as number;
    const mantissa = (s >> (exponent + 3)) & 0x0f;
    return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

/** One μ-law byte → one 16-bit signed sample. */
export function decodeSample(byte: number): number {
    const u = ~byte & 0xff;
    let t = ((u & 0x0f) << 3) + BIAS;
    t <<= (u & 0x70) >> 4;
    t -= BIAS;
    // μ-law has TWO zero codes — 0xFF is +0 and 0x7F is −0. Negating zero in JavaScript produces
    // `-0`, which is numerically fine and compares UNEQUAL to 0 under Object.is and
    // assert.strictEqual. Normalising here keeps that curiosity out of everyone else's code.
    if (t === 0) return 0;
    return (u & 0x80) ? -t : t;
}

/** A whole frame. `Int16Array` in, μ-law bytes out. */
export function encode(pcm: Int16Array): Buffer {
    const out = Buffer.allocUnsafe(pcm.length);
    for (let i = 0; i < pcm.length; i++) out[i] = encodeSample(pcm[i] as number);
    return out;
}

/** A whole frame, the other way. */
export function decode(mulaw: Buffer | Uint8Array): Int16Array {
    const out = new Int16Array(mulaw.length);
    for (let i = 0; i < mulaw.length; i++) out[i] = decodeSample(mulaw[i] as number);
    return out;
}

/** Little-endian 16-bit PCM bytes, which is the only thing the model accepts. */
export function pcmToBytes(pcm: Int16Array): Buffer {
    const out = Buffer.allocUnsafe(pcm.length * 2);
    for (let i = 0; i < pcm.length; i++) out.writeInt16LE(pcm[i] as number, i * 2);
    return out;
}

export function bytesToPcm(bytes: Buffer): Int16Array {
    const out = new Int16Array(bytes.length >> 1);
    for (let i = 0; i < out.length; i++) out[i] = bytes.readInt16LE(i * 2);
    return out;
}
