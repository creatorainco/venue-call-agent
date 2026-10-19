import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LivePipeline } from '../src/live/pipeline.ts';
import { CARRIER_AUDIO, MODEL_AUDIO } from '../src/audio/format.ts';
import { pcmToBytes } from '../src/audio/mulaw.ts';
import { SeamRefusal } from '../src/seam/client.ts';
import type { SeamClient } from '../src/seam/client.ts';
import type { CallEventResult } from '../src/seam/types.ts';
import type { PcmChunk, SessionEvent, SessionTransport } from '../src/live/session.ts';

const audio = (count = 960): SessionEvent => ({ kind: 'audio', audio: {
    data: pcmToBytes(new Int16Array(count).fill(6000)), sampleRate: MODEL_AUDIO.out.sampleRate, encoding: 'pcm_s16le',
} });
const tool = (id = 'a'): SessionEvent => ({ kind: 'tool_call', id, name: 'log_unanswered_question', args: { question_verbatim: 'Synthetic question?' } });
const response = (): CallEventResult => ({ recorded: true, say: 'Synthetic backend reply.', do_not_call: false });
function rig(allow?: () => boolean, ignoreClear = false) {
    let emit!: (event: SessionEvent) => void;
    let closes = 0;
    let clears = 0;
    let writes = 0;
    const queue: Buffer[] = [];
    const inputs: PcmChunk[] = [];
    const results: unknown[] = [];
    const transcripts: unknown[] = [];
    const calls: unknown[] = [];
    const seam: SeamClient = {
        callContext: async () => { throw new Error('not a conversation policy'); },
        callFact: async (topic) => ({ topic, known: true, say: 'Synthetic fact.' }),
        callEvent: async (input) => { calls.push(input); return response(); },
    };
    const transport: SessionTransport = {
        sendAudio(chunk) { inputs.push(chunk); },
        sendToolResult(id, result) { results.push({ id, result }); },
        close() { closes++; },
    };
    const pipeline = new LivePipeline({
        connect: async (_signal, receive) => { emit = receive; return transport; }, seam,
        playback: { write(frame) { writes++; queue.push(frame); }, clear() { clears++; if (!ignoreClear) queue.length = 0; } },
        ...(allow ? { authorizeAudio: allow } : {}),
        transcript(event) { transcripts.push(event); },
    });
    return { pipeline, transport, queue, inputs, results, calls, seam, transcripts,
        emit: (event: SessionEvent) => emit(event),
        get closes() { return closes; }, get clears() { return clears; }, get writes() { return writes; },
    };
}

test('offline session converts audio in both directions and finishes a partial frame', async () => {
    const r = rig(() => true); // Test-only policy; not proof of disclosure.
    await r.pipeline.connect();
    r.pipeline.pushCarrier(new Uint8Array([0xff, 0x00]));
    assert.equal(r.inputs[0]?.sampleRate, CARRIER_AUDIO.sampleRate);
    assert.deepEqual([...r.inputs[0]!.data], [0, 0, 0x84, 0x82]);
    r.emit(audio(481));
    r.emit({ kind: 'turn_complete' });
    assert.equal(r.queue.length, 1);
    assert.equal(r.queue[0]?.length, CARRIER_AUDIO.bytesPerFrame);
    r.emit(audio(480));
    r.emit({ kind: 'turn_complete' });
    assert.equal(r.queue.length, 2);
    r.pipeline.close();
});

test('CONTROL — ready session cannot emit without explicit conversation authorization', async () => {
    const r = rig();
    await r.pipeline.connect();
    r.emit(audio());
    assert.equal(r.writes, 0);
    assert.equal(r.pipeline.state, 'closed');
    assert.deepEqual(r.pipeline.failure, { kind: 'audio_not_authorized' });
});

async function interruptScenario(ignoreClear = false) {
    const r = rig(() => true, ignoreClear);
    await r.pipeline.connect();
    r.emit(audio());
    assert.ok(r.queue.length > 0);
    r.emit({ kind: 'interrupted' });
    assert.equal(r.queue.length, 0, 'interruption left queued playback');
    const writes = r.writes;
    r.emit(audio());
    r.emit({ kind: 'turn_complete' });
    assert.equal(r.writes, writes, 'interrupted tail must not be flushed');
    r.emit(audio(480));
    r.emit({ kind: 'turn_complete' });
    assert.equal(r.queue.length, 1);
    r.pipeline.close();
}

test('interruption clears both playback and converter tail, then accepts a fresh turn', async () => {
    await interruptScenario();
});

test('CONTROL — integration assertion detects a playback sink that ignores clear', async () => {
    await assert.rejects(interruptScenario(true), /interruption left queued playback/);
});

test('tool routing waits for backend then sends exactly one result to session', async () => {
    const r = rig(() => true);
    await r.pipeline.connect();
    let resolve!: (value: CallEventResult) => void;
    r.seam.callEvent = () => new Promise((done) => { resolve = done; });
    r.emit(tool());
    r.emit(tool());
    await Promise.resolve();
    assert.equal(r.results.length, 0);
    resolve(response());
    await r.pipeline.settled();
    assert.deepEqual(r.results, [{ id: 'a', result: response() }]);
    r.emit(audio());
    assert.ok(r.writes > 0);
    r.pipeline.close();
});

test('CONTROL — audio cannot overtake an unfinished backend write', async () => {
    const r = rig(() => true);
    await r.pipeline.connect();
    let resolve!: (value: CallEventResult) => void;
    r.seam.callEvent = () => new Promise((done) => { resolve = done; });
    r.emit(tool());
    await Promise.resolve();
    r.emit(audio());
    assert.equal(r.writes, 0);
    assert.equal(r.pipeline.state, 'closed');
    resolve(response());
    await r.pipeline.settled();
    assert.equal(r.results.length, 0);
});

for (const ending of ['hangup', 'cancel', 'stop'] as const) {
    test(`${ending} during tool call never delivers a late response or stale audio`, async () => {
        const r = rig(() => true);
        await r.pipeline.connect();
        let resolve!: (value: CallEventResult) => void;
        r.seam.callEvent = () => new Promise((done) => { resolve = done; });
        r.emit(tool());
        await Promise.resolve();
        if (ending === 'hangup') r.pipeline.close();
        else r.emit({ kind: 'tool_cancel', ids: ['a'] });
        resolve({ ...response(), do_not_call: ending === 'stop' });
        await r.pipeline.settled();
        assert.equal(r.results.length, 0);
        if (ending !== 'cancel') {
            r.emit(audio());
            assert.equal(r.writes, 0);
            assert.equal(r.pipeline.state, 'closed');
            assert.equal(r.closes, 1);
        }
        r.pipeline.close();
    });
}

test('backend refusal closes session and clears already buffered playback', async () => {
    const r = rig(() => true);
    await r.pipeline.connect();
    r.emit(audio());
    r.seam.callEvent = async () => { throw new SeamRefusal('token_expired', 'synthetic'); };
    r.emit(tool());
    await r.pipeline.settled();
    assert.deepEqual(r.pipeline.failure, { kind: 'refused', reason: 'token_expired' });
    assert.equal(r.queue.length, 0);
    assert.equal(r.closes, 1);
    const writes = r.writes;
    r.emit(audio());
    r.pipeline.pushCarrier(new Uint8Array([0xff]));
    assert.equal(r.writes, writes);
    assert.equal(r.inputs.length, 0);
});

test('invalid output rate or input failure closes and clears all layers', async () => {
    for (const kind of ['rate', 'send'] as const) {
        const r = rig(() => true);
        await r.pipeline.connect();
        r.emit(audio());
        if (kind === 'rate') {
            r.emit({ kind: 'audio', audio: { data: new Uint8Array([0, 0]), sampleRate: 16000, encoding: 'pcm_s16le' } });
        } else {
            r.transport.sendAudio = () => { throw new Error('private detail'); };
            r.pipeline.pushCarrier(new Uint8Array([0xff]));
        }
        assert.equal(r.pipeline.state, 'closed');
        assert.equal(r.queue.length, 0);
        assert.equal(r.closes, 1);
    }
});

test('transcript reports remain separate from evidence of playback', async () => {
    const r = rig();
    await r.pipeline.connect();
    const event: SessionEvent = { kind: 'transcript', direction: 'output', text: 'Synthetic transcript.' };
    r.emit(event);
    assert.deepEqual(r.transcripts, [event]);
    assert.equal(r.writes, 0);
    r.pipeline.close();
    r.emit(event);
    assert.equal(r.transcripts.length, 1);
});

test('CONTROL — partial PCM cannot wait in converter until backend permission arrives', async () => {
    const r = rig(() => true);
    await r.pipeline.connect();
    let resolve!: (value: CallEventResult) => void;
    r.seam.callEvent = () => new Promise((done) => { resolve = done; });
    r.emit(tool());
    await Promise.resolve();
    r.emit(audio(3));
    assert.equal(r.pipeline.state, 'closed', 'partial audio must be rejected immediately');
    resolve(response());
    await r.pipeline.settled();
    r.emit({ kind: 'turn_complete' });
    assert.equal(r.writes, 0);
});

test('policy revocation between chunks clears already buffered audio', async () => {
    let allow = true;
    const r = rig(() => allow);
    await r.pipeline.connect();
    r.emit(audio());
    assert.ok(r.queue.length > 0);
    allow = false;
    r.emit(audio(3));
    assert.equal(r.queue.length, 0);
    assert.equal(r.pipeline.state, 'closed');
});
