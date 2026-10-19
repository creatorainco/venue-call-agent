import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveSession } from '../src/live/session.ts';
import type { PcmChunk, SessionEvent, SessionTransport } from '../src/live/session.ts';

const pcm = (): PcmChunk => ({ data: new Uint8Array([1, 0, 2, 0]), sampleRate: 24000, encoding: 'pcm_s16le' });

function rig(fault: 'none' | 'ignore_clear' = 'none') {
    let receive!: (event: SessionEvent) => void;
    let resolve!: (transport: SessionTransport) => void;
    let reject!: (error: Error) => void;
    let expire!: () => void;
    let signal!: AbortSignal;
    let closes = 0;
    let timerCancelled = false;
    const queue: PcmChunk[] = [];
    const sent: PcmChunk[] = [];
    const tools: unknown[] = [];
    const events: SessionEvent[] = [];
    const transport: SessionTransport = {
        sendAudio: (chunk) => { sent.push(chunk); },
        sendToolResult: (id, result) => { tools.push({ id, result }); },
        close: () => { closes++; },
    };
    const session = new LiveSession((abort, callback) => {
        signal = abort;
        receive = callback;
        return new Promise((yes, no) => { resolve = yes; reject = no; });
    }, {
        audio: (chunk) => { queue.push(chunk); },
        clear: () => { if (fault !== 'ignore_clear') queue.length = 0; },
        event: (event) => { events.push(event); },
    }, { clock: { after: (_ms, callback) => {
        expire = callback;
        return () => { timerCancelled = true; };
    } } });
    return {
        session, queue, sent, tools, events, transport,
        emit: (event: SessionEvent) => receive(event),
        expire: () => expire(),
        resolve: () => resolve(transport),
        reject: () => reject(new Error('private transport detail')),
        get closes() { return closes; },
        get aborted() { return signal.aborted; },
        get timerCancelled() { return timerCancelled; },
        async start() {
            const pending = session.connect();
            await Promise.resolve();
            return { pending };
        },
        async ready() {
            const { pending } = await this.start();
            resolve(transport);
            await pending;
        },
    };
}

test('ready gates sends; audio is copied and tool IDs are preserved', async () => {
    const r = rig();
    assert.throws(() => r.session.sendAudio(pcm()), /not ready/);
    const { pending } = await r.start();
    assert.throws(() => r.session.sendToolResult('a', {}), /not ready/);
    r.resolve();
    await pending;
    assert.equal(r.timerCancelled, true);
    const chunk = pcm();
    r.session.sendAudio(chunk);
    chunk.data[0] = 99;
    assert.equal(r.sent[0]?.data[0], 1);
    r.session.sendToolResult('tool-1', { recorded: true });
    assert.deepEqual(r.tools, [{ id: 'tool-1', result: { recorded: true } }]);
    await assert.rejects(r.session.connect(), /already started/);
    r.session.close();
});

test('CONTROL — malformed PCM and blank tool IDs cannot reach transport', async () => {
    const r = rig();
    await r.ready();
    for (const chunk of [
        { ...pcm(), data: new Uint8Array(1) },
        { ...pcm(), data: new Uint8Array() },
        { ...pcm(), sampleRate: NaN },
        { ...pcm(), sampleRate: 0 },
        { ...pcm(), encoding: 'mulaw' as 'pcm_s16le' },
    ]) assert.throws(() => r.session.sendAudio(chunk), /invalid PCM/);
    assert.throws(() => r.session.sendToolResult(' ', {}), /requires an id/);
    assert.equal(r.sent.length, 0);
    assert.equal(r.tools.length, 0);
    r.session.close();
});

async function assertInterruptClears(r: ReturnType<typeof rig>) {
    await r.ready();
    r.emit({ kind: 'audio', audio: pcm() });
    assert.equal(r.queue.length, 1);
    r.emit({ kind: 'interrupted' });
    assert.equal(r.queue.length, 0, 'interruption must empty playback');
}

test('interrupt clears playback, discards interrupted tail and permits next turn', async () => {
    const r = rig();
    await assertInterruptClears(r);
    r.emit({ kind: 'audio', audio: pcm() });
    assert.equal(r.queue.length, 0);
    r.emit({ kind: 'turn_complete' });
    r.emit({ kind: 'audio', audio: pcm() });
    assert.equal(r.queue.length, 1);
    r.session.close();
});

test('CONTROL — interruption assertion detects a sink that ignores clear', async () => {
    const r = rig('ignore_clear');
    await assert.rejects(assertInterruptClears(r), /interruption must empty playback/);
    r.session.close();
});

test('close aborts, clears and closes once; late callbacks cannot revive playback', async () => {
    const r = rig();
    await r.ready();
    r.emit({ kind: 'audio', audio: pcm() });
    r.session.close();
    r.session.close();
    r.emit({ kind: 'audio', audio: pcm() });
    r.emit({ kind: 'tool_call', id: 'late', name: 'anything', args: {} });
    r.emit({ kind: 'closed' });
    assert.equal(r.queue.length, 0);
    assert.equal(r.closes, 1);
    assert.equal(r.aborted, true);
    assert.deepEqual(r.events, [{ kind: 'closed' }]);
    assert.throws(() => r.session.sendAudio(pcm()), /not ready/);
});

for (const end of ['timeout', 'close', 'reject', 'protocol_error'] as const) {
    test(`${end} during setup rejects promptly and cleans up late connection`, async () => {
        const r = rig();
        const { pending } = await r.start();
        const failed = assert.rejects(pending, /closed before ready/);
        if (end === 'timeout') r.expire();
        if (end === 'close') r.session.close();
        if (end === 'reject') r.reject();
        if (end === 'protocol_error') r.emit({ kind: 'audio', audio: pcm() });
        await failed;
        assert.equal(r.aborted, true);
        assert.equal(r.timerCancelled, true);
        if (end !== 'reject') {
            r.resolve();
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.equal(r.closes, 1);
        }
        assert.equal(r.session.state, 'closed');
        assert.equal(r.queue.length, 0);
    });
}

test('remote errors and malformed incoming PCM terminate the session', async () => {
    for (const event of [
        { kind: 'error' }, { kind: 'closed' },
        { kind: 'audio', audio: { ...pcm(), data: new Uint8Array(3) } },
    ] satisfies SessionEvent[]) {
        const r = rig();
        await r.ready();
        r.emit(event);
        assert.equal(r.session.state, 'closed');
        assert.equal(r.closes, 1);
        assert.equal(r.queue.length, 0);
    }
});

test('send failures close the transport without exposing its error message', async () => {
    const r = rig();
    await r.ready();
    r.transport.sendAudio = () => { throw new Error('private transport detail'); };
    assert.throws(() => r.session.sendAudio(pcm()), /^Error: session send failed$/);
    assert.equal(r.session.state, 'closed');
    assert.equal(r.closes, 1);
});

test('synchronous connector failure rejects and immediate close never starts connector', async () => {
    let starts = 0;
    const connect = () => { starts++; throw new Error('private detail'); };
    const sink = { audio() {}, clear() {}, event() {} };
    const failed = new LiveSession(connect, sink);
    await assert.rejects(failed.connect(), /closed before ready/);
    const cancelled = new LiveSession(connect, sink);
    const pending = cancelled.connect();
    cancelled.close();
    await assert.rejects(pending, /closed before ready/);
    assert.equal(starts, 1);
});

test('cleanup continues when transport close throws', async () => {
    const r = rig();
    await r.ready();
    r.emit({ kind: 'audio', audio: pcm() });
    r.transport.close = () => { throw new Error('cleanup fault'); };
    assert.doesNotThrow(() => r.session.close());
    assert.equal(r.queue.length, 0);
    assert.equal(r.aborted, true);
    assert.deepEqual(r.events, [{ kind: 'closed' }]);
});

test('transcripts and tool events remain separate from playback', async () => {
    const r = rig();
    await r.ready();
    const events: SessionEvent[] = [
        { kind: 'transcript', direction: 'output', text: 'synthetic transcript' },
        { kind: 'tool_call', id: 'a', name: 'lookup_booking_fact', args: { topic: 'arrival_time' } },
        { kind: 'tool_cancel', ids: ['a'] },
    ];
    events.forEach((event) => r.emit(event));
    assert.deepEqual(r.events, events);
    assert.equal(r.queue.length, 0);
    r.session.close();
});
