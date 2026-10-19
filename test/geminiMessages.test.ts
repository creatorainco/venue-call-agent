import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geminiEvents } from '../src/live/geminiMessages.ts';
import { MODEL_AUDIO } from '../src/audio/format.ts';

const part = () => ({ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AQACAA==' } });

test('SDK envelope maps cancellation and tools before audio, with completion last', () => {
    const events = geminiEvents({
        toolCallCancellation: { ids: ['cancelled'] },
        toolCall: { functionCalls: [{ id: 'one', name: 'lookup_booking_fact', args: { topic: 'arrival_time' } }] },
        serverContent: {
            inputTranscription: { text: 'Synthetic input.' },
            outputTranscription: { text: 'Synthetic output.' },
            modelTurn: { parts: [part()] }, turnComplete: true,
        },
    });
    assert.deepEqual(events.map((e) => e.kind), ['tool_cancel', 'tool_call', 'transcript', 'transcript', 'audio', 'turn_complete']);
    assert.deepEqual(events[0], { kind: 'tool_cancel', ids: ['cancelled'] });
    assert.deepEqual(events[1], { kind: 'tool_call', id: 'one', name: 'lookup_booking_fact', args: { topic: 'arrival_time' } });
    assert.deepEqual(events[4], { kind: 'audio', audio: { data: Buffer.from([1, 0, 2, 0]), encoding: 'pcm_s16le', sampleRate: MODEL_AUDIO.out.sampleRate } });
});

test('interrupted envelope reports interruption and never forwards its audio tail', () => {
    const events = geminiEvents({ serverContent: { interrupted: true, modelTurn: { parts: [part()] }, turnComplete: true } });
    assert.deepEqual(events, [{ kind: 'interrupted' }, { kind: 'turn_complete' }]);
});

test('generation completion, thoughts, text and metadata are not playable audio', () => {
    assert.deepEqual(geminiEvents({ setupComplete: {}, usageMetadata: {} }), []);
    assert.deepEqual(geminiEvents({ serverContent: { generationComplete: true, modelTurn: { parts: [
        { text: 'Synthetic text.' }, { ...part(), thought: true },
    ] } } }), []);
    assert.deepEqual(geminiEvents({ goAway: { timeLeft: '5s' }, serverContent: { modelTurn: { parts: [part()] } } }), [{ kind: 'closed' }]);
});

test('CONTROL — malformed PCM MIME, base64 and sample sizes fail before event delivery', () => {
    for (const inlineData of [
        { mimeType: 'audio/pcm;rate=16000', data: 'AQACAA==' },
        { mimeType: 'audio/wav', data: 'AQACAA==' },
        { mimeType: 'audio/pcm;rate=24000', data: '!!!!' },
        { mimeType: 'audio/pcm;rate=24000', data: 'AQACAA' },
        { mimeType: 'audio/pcm;rate=24000', data: 'AQ==' },
        { mimeType: 'audio/pcm;rate=24000', data: 'AB==' },
        { mimeType: 'audio/pcm;rate=24000', data: '' },
    ]) {
        assert.throws(() => geminiEvents({ serverContent: { modelTurn: { parts: [part(), { inlineData }] } } }), /^Error: invalid Gemini server message$/);
    }
});

test('CONTROL — invalid tool and cancellation envelopes cannot become valid events', () => {
    for (const message of [
        null, [], { toolCall: { functionCalls: {} } },
        { toolCall: { functionCalls: [{ name: 'lookup_booking_fact' }] } },
        { toolCallCancellation: { ids: [''] } },
        { toolCallCancellation: { ids: [3] } },
        { serverContent: { interrupted: 'true' } },
        { serverContent: { modelTurn: { parts: {} } } },
        { serverContent: { inputTranscription: { text: 3 } } },
    ]) assert.throws(() => geminiEvents(message), /invalid Gemini server message/);
});

test('decoder does not touch convenience getters or modify SDK input', () => {
    const message = { toolCall: { functionCalls: [{ id: 'a', name: 'report_answerer', args: { answerer: 'human' } }] } };
    Object.defineProperty(message, 'data', { get() { throw new Error('getter must not run'); } });
    const before = JSON.stringify(message);
    assert.equal(geminiEvents(message).length, 1);
    assert.equal(JSON.stringify(message), before);
});
