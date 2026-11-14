/**
 * Streaming recognition: config first, batched audio, rollover, finals only. A fake gRPC stream
 * stands in for `@google-cloud/speech`; nothing here talks to Google.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { StreamingStt, finalTranscripts, streamingConfigRequest, type RecognizeStream, type SpeechStreamFactory } from '../src/speech/stt.ts';
import { STT } from '../src/tuning/cascadeDefaults.ts';

class FakeStream extends EventEmitter implements RecognizeStream {
    writes: Array<Record<string, unknown>> = [];
    ended = false;
    write(message: unknown): boolean {
        this.writes.push(message as Record<string, unknown>);
        return true;
    }
    end(): void {
        this.ended = true;
    }
}

function fakeFactory(): SpeechStreamFactory & { streams: FakeStream[] } {
    const streams: FakeStream[] = [];
    return {
        recognizer: 'projects/p/locations/us/recognizers/_',
        streams,
        open() {
            const s = new FakeStream();
            streams.push(s);
            return s;
        },
    };
}

const frame = (fill = 0x7f) => new Uint8Array(160).fill(fill);

describe('the first message on every stream is the config, with the audio declared', () => {
    test('MULAW, 8000 Hz, mono, explicit decoding, the telephony model, finals only', () => {
        const config = streamingConfigRequest('projects/p/locations/us/recognizers/_') as any;
        assert.equal(config.recognizer, 'projects/p/locations/us/recognizers/_');
        assert.deepEqual(config.streamingConfig.config.explicitDecodingConfig,
            { encoding: 'MULAW', sampleRateHertz: 8000, audioChannelCount: 1 });
        assert.equal(config.streamingConfig.config.model, STT.model);
        assert.equal(config.streamingConfig.streamingFeatures.interimResults, false);
    });
});

describe('batching (CS-01: never one write per 20 ms frame)', () => {
    test('nothing opens until a batch is full; then config, then one audio write per batch', () => {
        const factory = fakeFactory();
        const stt = new StreamingStt({ factory, onFinal: () => {}, onError: () => {} });
        const perBatch = Math.round((8000 * STT.batchMs) / 1000) / 160;
        for (let i = 0; i < perBatch - 1; i++) stt.push(frame());
        assert.equal(factory.streams.length, 0, 'no Google session for less than one batch');
        stt.push(frame());
        const [s] = factory.streams;
        assert.equal(s!.writes.length, 2);
        assert.ok('streamingConfig' in s!.writes[0]!);
        assert.equal((s!.writes[1]!.audio as Buffer).length, perBatch * 160);
    });

    test('close sends the partial batch and ends the stream, once', () => {
        const factory = fakeFactory();
        const stt = new StreamingStt({ factory, onFinal: () => {}, onError: () => {} });
        stt.push(frame());
        stt.close();
        stt.close();
        stt.push(frame());
        const [s] = factory.streams;
        assert.equal((s!.writes[1]!.audio as Buffer).length, 160);
        assert.equal(s!.ended, true);
        assert.equal(s!.writes.length, 2, 'nothing is written after close');
    });
});

describe('rollover before the stream cap', () => {
    test('past rolloverMs the old stream ends and the next batch opens a fresh one, config first', () => {
        const factory = fakeFactory();
        let now = 0;
        const stt = new StreamingStt({ factory, clock: () => now, batchMs: 20, rolloverMs: 1000, onFinal: () => {}, onError: () => {} });
        stt.push(frame());
        now = 999;
        stt.push(frame());
        assert.equal(stt.streamsOpened, 1);
        now = 1000;
        stt.push(frame());
        assert.equal(stt.streamsOpened, 2);
        const [old, fresh] = factory.streams;
        assert.equal(old!.ended, true);
        assert.ok('streamingConfig' in fresh!.writes[0]!);
        assert.ok('audio' in fresh!.writes[1]!);
    });

    test('a final the old stream still owes after rollover is delivered', () => {
        const factory = fakeFactory();
        let now = 0;
        const heard: string[] = [];
        const stt = new StreamingStt({ factory, clock: () => now, batchMs: 20, rolloverMs: 10, onFinal: (t) => heard.push(t), onError: () => {} });
        stt.push(frame());
        now = 10;
        stt.push(frame());
        factory.streams[0]!.emit('data', { results: [{ isFinal: true, alternatives: [{ transcript: 'late words' }] }] });
        assert.deepEqual(heard, ['late words']);
    });
});

describe('results', () => {
    test('only finals, trimmed, and blank ones dropped', () => {
        assert.deepEqual(finalTranscripts({
            results: [
                { isFinal: false, alternatives: [{ transcript: 'what ti' }] },
                { isFinal: true, alternatives: [{ transcript: ' what time are they coming ' }] },
                { isFinal: true, alternatives: [{ transcript: '   ' }] },
            ],
        }), ['what time are they coming']);
        assert.deepEqual(finalTranscripts(null), []);
    });

    test('a stream error reaches onError while the call is live, and not after close', () => {
        const factory = fakeFactory();
        const errors: Error[] = [];
        const stt = new StreamingStt({ factory, batchMs: 20, onFinal: () => {}, onError: (e) => errors.push(e) });
        stt.push(frame());
        factory.streams[0]!.emit('error', new Error('UNAVAILABLE'));
        stt.close();
        factory.streams[0]!.emit('error', new Error('CANCELLED'));
        assert.deepEqual(errors.map((e) => e.message), ['UNAVAILABLE']);
    });
});
