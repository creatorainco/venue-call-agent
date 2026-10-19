import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveServerMessage } from '@google/genai';
import type { LiveConnectParameters, Session } from '@google/genai';
import { createGeminiConnector, geminiConfig } from '../src/live/geminiConnector.ts';
import { LiveSession } from '../src/live/session.ts';
import { LIVE_DEFAULTS, LIVE_MODEL } from '../src/tuning/liveDefaults.ts';
import type { SessionEvent } from '../src/live/session.ts';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const tool = { toolCall: { functionCalls: [{ id: 'one', name: 'lookup_booking_fact', args: { topic: 'arrival_time' } }] } };
function rig(early: object[] = []) {
    let params!: LiveConnectParameters;
    let closeCount = 0;
    let resolve!: (session: Pick<Session, 'close' | 'sendRealtimeInput' | 'sendToolResponse'>) => void;
    let reject!: (error: Error) => void;
    const audio: unknown[] = [];
    const results: unknown[] = [];
    const events: SessionEvent[] = [];
    const controller = new AbortController();
    const raw = {
        close() { closeCount++; },
        sendRealtimeInput(value: unknown) { audio.push(value); },
        sendToolResponse(value: unknown) { results.push(value); },
    };
    const connector = createGeminiConnector({
        apiKey: 'synthetic-test-key', systemInstruction: 'Synthetic backend instruction.',
        client: { connect(value) {
            params = value;
            early.forEach((message) => params.callbacks.onmessage(Object.assign(new LiveServerMessage(), message)));
            return new Promise((yes, no) => { resolve = yes; reject = no; });
        } },
    });
    return {
        connector, controller, raw, events, audio, results,
        get params() { return params; }, get closeCount() { return closeCount; },
        emit(message: object) { params.callbacks.onmessage(Object.assign(new LiveServerMessage(), message)); },
        resolve() { resolve(raw); }, reject() { reject(new Error('private key or URL')); },
        async ready() {
            const pending = connector(controller.signal, (event) => events.push(event));
            await Promise.resolve();
            resolve(raw);
            const transport = await pending;
            await tick();
            return transport;
        },
    };
}

test('typed config uses unchanged defaults, backend instruction and closed tool schemas', () => {
    const before = JSON.stringify(LIVE_DEFAULTS);
    const config = geminiConfig('Synthetic instruction.');
    assert.equal(config.systemInstruction, 'Synthetic instruction.');
    assert.deepEqual(config.realtimeInputConfig, LIVE_DEFAULTS.realtimeInputConfig);
    assert.equal('model' in config, false);
    assert.equal(JSON.stringify(LIVE_DEFAULTS), before);
    assert.throws(() => geminiConfig(' '), /missing backend instruction/);
    assert.throws(() => createGeminiConnector({ apiKey: '', systemInstruction: 'test' }), /GEMINI_API_KEY/);
});

test('audio sends actual rate and tool responses carry original ID and function name', async () => {
    const r = rig();
    const transport = await r.ready();
    assert.equal(r.params.model, LIVE_MODEL);
    transport.sendAudio({ data: new Uint8Array([0, 0, 1, 0]), encoding: 'pcm_s16le', sampleRate: 8000 });
    assert.deepEqual(r.audio, [{ audio: { data: 'AAABAA==', mimeType: 'audio/pcm;rate=8000' } }]);
    r.emit(tool);
    transport.sendToolResult('one', { known: true, say: 'Synthetic fact.' });
    assert.deepEqual(r.results, [{ functionResponses: [{ id: 'one', name: 'lookup_booking_fact', response: { known: true, say: 'Synthetic fact.' } }] }]);
    assert.throws(() => transport.sendToolResult('one', {}), /no active request/);
    transport.close();
    transport.close();
    assert.equal(r.closeCount, 1);
});

test('SDK callback arriving before connect resolves is delivered only after LiveSession is ready', async () => {
    const r = rig([tool]);
    const seen: SessionEvent[] = [];
    const session = new LiveSession(r.connector, { audio() {}, clear() {}, event: (event) => seen.push(event) });
    const pending = session.connect();
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(seen, []);
    r.resolve();
    await pending;
    assert.equal(session.state, 'ready');
    await tick();
    assert.deepEqual(seen, [{ kind: 'tool_call', id: 'one', name: 'lookup_booking_fact', args: { topic: 'arrival_time' } }]);
    session.close();
});

test('cancelled tool cannot receive a late SDK response', async () => {
    const r = rig();
    const transport = await r.ready();
    r.emit(tool);
    r.emit({ toolCallCancellation: { ids: ['one'] } });
    assert.throws(() => transport.sendToolResult('one', {}), /no active request/);
    transport.close();
});

test('CONTROL — malformed message ends connection without forwarding raw payload', async () => {
    const r = rig();
    const transport = await r.ready();
    r.emit({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/wav', data: 'secret' } }] } } });
    assert.deepEqual(r.events, [{ kind: 'error' }]);
    assert.equal(r.closeCount, 1);
    r.emit(tool);
    assert.equal(r.events.length, 1);
    assert.throws(() => transport.sendAudio({ data: new Uint8Array([0, 0]), sampleRate: 8000, encoding: 'pcm_s16le' }), /closed/);
});

test('abort rejects promptly during setup and closes any late-resolving SDK session', async () => {
    const r = rig();
    const pending = r.connector(r.controller.signal, (event) => r.events.push(event));
    const rejected = assert.rejects(pending, /^Error: Gemini connection ended before ready$/);
    await Promise.resolve();
    r.controller.abort();
    await rejected;
    r.resolve();
    await tick();
    assert.equal(r.closeCount, 1);
    assert.deepEqual(r.events, []);
});

test('already-aborted signal never invokes SDK connect', async () => {
    const r = rig();
    r.controller.abort();
    await assert.rejects(r.connector(r.controller.signal, () => {}), /ended before ready/);
    assert.equal(r.params, undefined);
});

test('SDK rejection is sanitized and never exposes its raw error', async () => {
    const r = rig();
    const pending = r.connector(r.controller.signal, () => {});
    await Promise.resolve();
    r.reject();
    await assert.rejects(pending, /^Error: Gemini connection ended before ready$/);
});

test('CONTROL — bounded pre-ready queue refuses excessive SDK callbacks', async () => {
    const r = rig(Array.from({ length: 33 }, () => tool));
    await assert.rejects(r.connector(r.controller.signal, () => {}), /ended before ready/);
    r.resolve();
    await tick();
    assert.equal(r.closeCount, 1);
});

test('go-away closes once and drops remaining messages', async () => {
    const r = rig();
    await r.ready();
    r.emit({ goAway: { timeLeft: '1s' } });
    r.emit(tool);
    assert.deepEqual(r.events, [{ kind: 'closed' }]);
    assert.equal(r.closeCount, 1);
});
