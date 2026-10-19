import { test } from 'node:test';
import assert from 'node:assert/strict';
import { carrierToPcm, ModelAudioFramer } from '../src/live/audio.ts';
import { CARRIER_AUDIO, MODEL_AUDIO, MULAW_SILENCE } from '../src/audio/format.ts';
import { decimate } from '../src/audio/resample.ts';
import { decode, encode, pcmToBytes } from '../src/audio/mulaw.ts';

function waveform(length: number, frequency = 1000): Int16Array {
    return Int16Array.from({ length }, (_, i) => Math.round(12000 * Math.sin(2 * Math.PI * frequency * i / MODEL_AUDIO.out.sampleRate)));
}
function expected(pcm: Int16Array): Buffer {
    const payload = encode(decimate(pcm, MODEL_AUDIO.out.sampleRate, CARRIER_AUDIO.sampleRate));
    const output = Buffer.alloc(Math.ceil(payload.length / CARRIER_AUDIO.bytesPerFrame) * CARRIER_AUDIO.bytesPerFrame, MULAW_SILENCE);
    payload.copy(output);
    return output;
}
function stream(pcm: Int16Array, cuts: number[]): Buffer {
    const framer = new ModelAudioFramer();
    const data = pcmToBytes(pcm);
    const frames: Buffer[] = [];
    for (let pos = 0, i = 0; pos < data.length; i++) {
        const end = Math.min(data.length, pos + cuts[i % cuts.length]!);
        frames.push(...framer.push(data.subarray(pos, end)));
        pos = end;
    }
    frames.push(...framer.finish());
    for (const frame of frames) assert.equal(frame.length, CARRIER_AUDIO.bytesPerFrame);
    assert.deepEqual(framer.finish(), []);
    return Buffer.concat(frames);
}

test('carrier input uses reference μ-law values and declares its actual rate', () => {
    const chunk = carrierToPcm(new Uint8Array([0xff, 0x00, 0x80]));
    assert.equal(chunk.sampleRate, CARRIER_AUDIO.sampleRate);
    assert.equal(chunk.encoding, 'pcm_s16le');
    assert.deepEqual([...chunk.data], [0, 0, 0x84, 0x82, 0x7c, 0x7d]);
    assert.throws(() => carrierToPcm(new Uint8Array()), /empty/);
});

test('stream matches whole-buffer filter across odd bytes, tiny and uneven chunks', () => {
    for (const length of [0, 1, 2, 3, 49, 50, 51, 479, 480, 481, 997, 24000]) {
        const pcm = waveform(length);
        for (const cuts of [[1], [7, 13, 2, 101], [960], [48000]]) {
            assert.deepEqual(stream(pcm, cuts), expected(pcm), `length=${length}, cuts=${cuts}`);
        }
    }
});

test('silence stays 0xff; final padding never becomes full-scale noise', () => {
    const output = stream(new Int16Array(483), [17]);
    assert.equal(output.length, 2 * CARRIER_AUDIO.bytesPerFrame);
    assert.ok(output.every((byte) => byte === MULAW_SILENCE));
});

test('reset discards half samples, pending audio and filter history', () => {
    const framer = new ModelAudioFramer();
    framer.push(pcmToBytes(waveform(300)));
    framer.push(new Uint8Array([0x12]));
    framer.reset();
    const frames = [...framer.push(pcmToBytes(new Int16Array(480))), ...framer.finish()];
    assert.equal(frames.length, 1);
    assert.ok(frames[0]!.every((byte) => byte === MULAW_SILENCE));
    assert.throws(() => framer.push(new Uint8Array()), /finished/);
    framer.reset();
    assert.deepEqual(framer.finish(), []);
});

test('CONTROL — incomplete samples and wrong-rate audio are rejected', () => {
    const framer = new ModelAudioFramer();
    assert.throws(() => framer.push(new Uint8Array([0, 0]), 16000), /sample rate/);
    framer.push(new Uint8Array([0]));
    assert.throws(() => framer.finish(), /truncated/);
    framer.push(new Uint8Array([0]));
    assert.deepEqual(framer.finish(), []);
});

function assertNoAlias(samples: Int16Array): void {
    const middle = samples.slice(100, -100);
    const rms = Math.sqrt(middle.reduce((sum, sample) => sum + sample * sample, 0) / middle.length);
    assert.ok(rms < 200, `aliased RMS ${rms} exceeds 200`);
}

test('high-frequency input is attenuated before decimation', () => {
    assertNoAlias(decode(stream(waveform(24000, 6000), [37, 991])));
});

test('CONTROL — anti-alias assertion rejects unfiltered downsampling', () => {
    const input = waveform(24000, 6000);
    const naive = Int16Array.from(input.filter((_, i) => i % 3 === 0));
    assert.throws(() => assertNoAlias(naive), /aliased RMS/);
});

test('CONTROL — resetting resampler at each network chunk changes the waveform', () => {
    const input = waveform(2400);
    const broken = Buffer.concat([stream(input.slice(0, 701), [1402]), stream(input.slice(701), [3398])]);
    assert.throws(() => assert.deepEqual(broken, expected(input)), assert.AssertionError);
});
