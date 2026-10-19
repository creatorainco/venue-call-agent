import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRouter } from '../src/live/tools.ts';
import type { ToolFailure } from '../src/live/tools.ts';
import { SeamRefusal, SeamUnavailable } from '../src/seam/client.ts';
import type { SeamClient } from '../src/seam/client.ts';
import type { CallEventResult, FactAnswer } from '../src/seam/types.ts';
import type { SessionEvent } from '../src/live/session.ts';

type Request = Extract<SessionEvent, { kind: 'tool_call' }>;
const request = (id = 'a'): Request => ({ kind: 'tool_call', id, name: 'lookup_booking_fact', args: { topic: 'arrival_time' } });
const eventResult = (): CallEventResult => ({ recorded: true, say: 'Synthetic backend reply.', do_not_call: false });
function rig(limit?: number) {
    const calls: unknown[] = [];
    const replies: unknown[] = [];
    const failures: ToolFailure[] = [];
    let stops = 0;
    const seam: SeamClient = {
        callContext: async () => { throw new Error('router must not load context'); },
        callFact: async (topic) => {
            calls.push({ topic });
            return { known: true, topic, say: 'Synthetic backend fact.' };
        },
        callEvent: async (input) => { calls.push(input); return eventResult(); },
    };
    const router = new ToolRouter(seam, {
        result: (id, response) => { replies.push({ id, response }); },
        stopped: () => { stops++; },
        failed: (failure) => { failures.push(failure); },
    }, limit);
    return { router, seam, calls, replies, failures, get stops() { return stops; } };
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

test('all four tools map to the existing seam and preserve question text', async () => {
    const r = rig();
    await r.router.dispatch(request());
    await r.router.dispatch({ kind: 'tool_call', id: 'b', name: 'log_unanswered_question', args: { question_verbatim: '  A synthetic question?  ' } });
    await r.router.dispatch({ kind: 'tool_call', id: 'c', name: 'request_human_callback', args: { reason: 'other' } });
    await r.router.dispatch({ kind: 'tool_call', id: 'd', name: 'report_answerer', args: { answerer: 'human' } });
    assert.deepEqual(r.calls, [
        { topic: 'arrival_time' },
        { kind: 'unanswered_question', question_verbatim: '  A synthetic question?  ' },
        { kind: 'human_callback', reason: 'other' },
        { kind: 'answerer_reported', answerer: 'human' },
    ]);
    assert.equal(r.replies.length, 4);
    assert.deepEqual(r.failures, []);
});

test('CONTROL — invalid names, missing/extra arguments and unknown enum values never reach backend', async () => {
    for (const bad of [
        { ...request(), id: '' }, { ...request(), name: 'invented' },
        { ...request(), args: null }, { ...request(), args: [] },
        { ...request(), args: {} }, { ...request(), args: { topic: 'invented' } },
        { ...request(), args: { topic: 'arrival_time', extra: true } },
        { ...request(), name: 'request_human_callback', args: { reason: 'invented' } },
        { ...request(), name: 'report_answerer', args: { answerer: 'invented' } },
        { ...request(), name: 'log_unanswered_question', args: { question_verbatim: ' ' } },
    ]) {
        const r = rig();
        await r.router.dispatch(bad);
        await r.router.dispatch(request('later'));
        assert.deepEqual(r.calls, []);
        assert.deepEqual(r.replies, []);
        assert.deepEqual(r.failures, [{ kind: 'invalid_request' }]);
    }
});

test('in-flight and completed duplicate IDs cause one write and one response', async () => {
    const r = rig();
    const wait = deferred<CallEventResult>();
    let writes = 0;
    r.seam.callEvent = () => { writes++; return wait.promise; };
    const req: Request = { kind: 'tool_call', id: 'write', name: 'log_unanswered_question', args: { question_verbatim: 'Synthetic?' } };
    const a = r.router.dispatch(req);
    const b = r.router.dispatch(req);
    assert.equal(a, b);
    await Promise.resolve();
    assert.equal(writes, 1);
    assert.equal(r.replies.length, 0, 'no result before backend acknowledges');
    wait.resolve(eventResult());
    await a;
    await r.router.dispatch(req);
    assert.equal(writes, 1);
    assert.equal(r.replies.length, 1);
});

test('CONTROL — reusing an ID for different content closes routing', async () => {
    const r = rig();
    await r.router.dispatch(request());
    await r.router.dispatch({ ...request(), args: { topic: 'party_size' } });
    assert.equal(r.calls.length, 1);
    assert.deepEqual(r.failures, [{ kind: 'invalid_request' }]);
});

test('cancellation before dispatch or while queued prevents requests', async () => {
    const r = rig();
    r.router.cancel(['early']);
    await r.router.dispatch(request('early'));
    const pending = r.router.dispatch(request('queued'));
    r.router.cancel(['queued']);
    await pending;
    assert.deepEqual(r.calls, []);
    assert.deepEqual(r.replies, []);
});

test('in-flight cancellation suppresses delivery but cannot undo the backend write', async () => {
    const r = rig();
    const wait = deferred<FactAnswer>();
    r.seam.callFact = () => wait.promise;
    const pending = r.router.dispatch(request());
    await Promise.resolve();
    r.router.cancel(['a']);
    wait.resolve({ topic: 'arrival_time', known: true, say: 'Synthetic fact.' });
    await pending;
    assert.equal(r.replies.length, 0);
    assert.deepEqual(r.failures, []);
});

test('backend stop survives cancellation and blocks subsequent queued work', async () => {
    const r = rig();
    const wait = deferred<CallEventResult>();
    r.seam.callEvent = () => wait.promise;
    const pending = r.router.dispatch({ kind: 'tool_call', id: 'stop', name: 'request_human_callback', args: { reason: 'asked_to_stop_calling' } });
    await Promise.resolve();
    const later = r.router.dispatch(request('later'));
    r.router.cancel(['stop']);
    wait.resolve({ ...eventResult(), do_not_call: true });
    await Promise.all([pending, later]);
    assert.equal(r.stops, 1);
    assert.equal(r.calls.length, 0);
    assert.equal(r.replies.length, 0);
});

test('refusal and timeout remain distinct, stop queued work, and never retry', async () => {
    for (const [error, expected] of [
        [new SeamRefusal('token_expired', 'test'), { kind: 'refused', reason: 'token_expired' }],
        [new SeamUnavailable('test', 'private detail'), { kind: 'unavailable' }],
    ] as const) {
        const r = rig();
        let attempts = 0;
        r.seam.callFact = async () => { attempts++; throw error; };
        await Promise.all([r.router.dispatch(request()), r.router.dispatch(request('later'))]);
        assert.equal(attempts, 1);
        assert.deepEqual(r.failures, [expected]);
        assert.equal(r.replies.length, 0);
    }
});

test('close suppresses a late result; failed callback exceptions do not leak', async () => {
    const r = rig();
    const wait = deferred<FactAnswer>();
    r.seam.callFact = () => wait.promise;
    const pending = r.router.dispatch(request());
    await Promise.resolve();
    r.router.close();
    wait.resolve({ topic: 'arrival_time', known: true, say: 'Synthetic fact.' });
    await pending;
    assert.equal(r.replies.length, 0);
    const router = new ToolRouter(r.seam, { result() {}, stopped() {}, failed() { throw new Error('fault'); } });
    await assert.doesNotReject(router.dispatch({ ...request(), args: {} }));
});

test('CONTROL — malformed backend responses fail closed', async () => {
    for (const bad of [null, { say: '' }, { say: 'Synthetic.', known: true, topic: 'party_size' }]) {
        const r = rig();
        r.seam.callFact = async () => bad as FactAnswer;
        await r.router.dispatch(request());
        assert.deepEqual(r.failures, [{ kind: 'unavailable' }]);
        assert.equal(r.replies.length, 0);
    }
    const r = rig();
    r.seam.callEvent = async () => ({ recorded: true, say: '', do_not_call: false });
    await r.router.dispatch({ kind: 'tool_call', id: 'e', name: 'log_unanswered_question', args: { question_verbatim: 'Synthetic?' } });
    assert.deepEqual(r.failures, [{ kind: 'unavailable' }]);
});

test('bounded session history fails closed rather than forgetting deduplication', async () => {
    const r = rig(1);
    await r.router.dispatch(request());
    await r.router.dispatch(request('second'));
    assert.equal(r.calls.length, 1);
    assert.deepEqual(r.failures, [{ kind: 'limit_exceeded' }]);
    const cancelled = rig(1);
    cancelled.router.cancel(['one', 'two']);
    assert.deepEqual(cancelled.failures, [{ kind: 'limit_exceeded' }]);
});

test('delivery errors terminate routing without exposing callback error text', async () => {
    const r = rig();
    const failures: ToolFailure[] = [];
    const router = new ToolRouter(r.seam, {
        result() { throw new Error('private detail'); }, stopped() {},
        failed(failure) { failures.push(failure); },
    });
    await router.dispatch(request());
    await router.dispatch(request('later'));
    assert.equal(r.calls.length, 1);
    assert.deepEqual(failures, [{ kind: 'delivery_failed' }]);
});

test('real SeamClient sends the expected route and body before returning a result', async () => {
    const { createSeamClient } = await import('../src/seam/client.ts');
    const seen: Array<{ url: string; body: unknown }> = [];
    const replies: unknown[] = [];
    const failures: ToolFailure[] = [];
    const seam = createSeamClient({
        baseUrl: 'http://127.0.0.1:8788', token: 'mock:happy',
        fetchImpl: async (url, init) => {
            seen.push({ url: String(url), body: JSON.parse(String(init?.body)) });
            assert.equal(replies.length, 0);
            return new Response(JSON.stringify(eventResult()), { status: 200 });
        },
    });
    const router = new ToolRouter(seam, {
        result: (id, response) => { replies.push({ id, response }); }, stopped() {},
        failed: (failure) => { failures.push(failure); },
    });
    await router.dispatch({ kind: 'tool_call', id: 'http', name: 'log_unanswered_question', args: { question_verbatim: 'Synthetic?' } });
    assert.deepEqual(seen, [{ url: 'http://127.0.0.1:8788/reservations/call-event', body: { kind: 'unanswered_question', question_verbatim: 'Synthetic?' } }]);
    assert.deepEqual(replies, [{ id: 'http', response: eventResult() }]);
    assert.deepEqual(failures, []);
});
