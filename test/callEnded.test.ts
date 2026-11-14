/**
 * VCA-5 + VCA-7: every way a call ends posts exactly one `call_ended`, after the one hangup, and a
 * SIGTERM drain waits for it inside Cloud Run's ten seconds.
 *
 * 🔴 SABOTAGE, RUN BY HAND AND PASTED IN THE PR: delete `await this.reportEnded()` from
 * `CallSupervisor.run()`'s `finally`. Every end-path test below must go red, and so must the two
 * stream-server tests, because the backend's journal then holds no `call_ended`.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

import { CallSupervisor, CALL_ENDED_SEQ, endReasonFor } from '../src/carrier/supervisor.ts';
import type { CallEndedSink, Hangable } from '../src/carrier/supervisor.ts';
import type { HangupReason } from '../src/carrier/leg.ts';
import type { CallEventInput } from '../src/seam/types.ts';
import { MAX_TURN_CHARS, MAX_TURNS } from '../src/seam/types.ts';
import { SEAM_TIMEOUT_MS } from '../src/tuning/liveDefaults.ts';
import { createStreamServer, DRAIN_BUDGET_MS, DRAIN_MARGIN_MS, DRAIN_SETTLE_MS } from '../src/server/streamServer.ts';
import type { AuthorizedCall, StreamServer } from '../src/server/streamServer.ts';
import { DRAIN_GRACE_MS, noAgentSession } from '../src/server/main.ts';
import { startMockSeam } from '../src/mock/server.ts';
import type { MockSeam } from '../src/mock/server.ts';

/** A leg that records every hangup sent to it and lets a test end it from the far side. */
function recordingLeg(): Hangable & { sent: HangupReason[]; farEndHangsUp(): void } {
    const handlers: Array<(reason: HangupReason) => void> = [];
    let over = false;
    const end = (reason: HangupReason) => {
        if (over) return;
        over = true;
        for (const h of handlers) h(reason);
    };
    const sent: HangupReason[] = [];
    return {
        id: 'call-under-test',
        sent,
        on: (_event, handler) => { handlers.push(handler); },
        hangup: async (reason) => { sent.push(reason); end(reason); },
        farEndHangsUp: () => { end('far_end_hung_up'); },
    };
}

/** A seam that records every event, and how many hangups had been sent when each arrived. */
function recordingSeam(leg: { sent: HangupReason[] }, behave: () => Promise<unknown> = async () => ({ recorded: true })) {
    const events: Array<{ input: CallEventInput; hangupsBefore: number }> = [];
    const sink: CallEndedSink = {
        callEvent: async (input) => {
            events.push({ input, hangupsBefore: leg.sent.length });
            return behave();
        },
    };
    return { sink, events };
}

const never = () => new Promise<void>(() => {});
const UTTERANCE = 'my cell is 555 0100, call me back';

/** Run one call through the supervisor and return what reached the seam. */
async function endPath(
    body: (sup: CallSupervisor, leg: ReturnType<typeof recordingLeg>, signal: AbortSignal) => Promise<void>,
    extra: { shutdown?: AbortSignal; capFiresAt?: 'now' } = {},
) {
    const leg = recordingLeg();
    const seam = recordingSeam(leg);
    const logs: string[] = [];
    const sup = new CallSupervisor(leg, {
        clock: () => 0,
        log: (line) => { logs.push(line); },
        report: seam.sink,
        ...(extra.capFiresAt ? { capTimer: (fire) => { setImmediate(fire); return () => {}; } } : { capTimer: null }),
        ...(extra.shutdown ? { shutdown: extra.shutdown } : {}),
    });
    await sup.run((signal) => body(sup, leg, signal));
    return { leg, events: seam.events, logs, sup };
}

function assertOneCallEnded(
    result: Awaited<ReturnType<typeof endPath>>,
    endReason: string,
    hangup: HangupReason,
): void {
    assert.deepEqual(result.leg.sent, [hangup], 'exactly one hangup');
    const ended = result.events.filter((e) => e.input.kind === 'call_ended');
    assert.equal(ended.length, 1, 'exactly one call_ended');
    const [only] = ended;
    assert.equal(only!.input.end_reason, endReason);
    assert.equal(only!.input.seq, CALL_ENDED_SEQ);
    assert.equal(only!.hangupsBefore, 1, 'posted after the hangup, not before it');
    assert.equal(typeof only!.input.disclosure_heard, 'boolean');
    assert.ok(Array.isArray(only!.input.turns));
}

describe('call_ended: every end path posts exactly one, after the hangup (VCA-5)', () => {
    it('the agent said goodbye: completed', async () => {
        const r = await endPath(async (sup) => { await sup.hangup('agent_ended'); });
        assertOneCallEnded(r, 'completed', 'agent_ended');
    });

    it('the far end hung up: venue_hung_up', async () => {
        const r = await endPath(async (_sup, leg) => { leg.farEndHangsUp(); });
        // The leg was already down; the supervisor still sends its one hangup with their reason.
        assertOneCallEnded(r, 'venue_hung_up', 'far_end_hung_up');
    });

    it('the polled cap was reached: max_duration', async () => {
        const r = await endPath(async (sup) => { sup.stop('call_too_long'); });
        assertOneCallEnded(r, 'max_duration', 'call_too_long');
    });

    it('the armed cap fired on a body that never returns: max_duration', async () => {
        const r = await endPath(async () => { await never(); }, { capFiresAt: 'now' });
        assertOneCallEnded(r, 'max_duration', 'call_too_long');
    });

    it('a seam refusal mid-call: refused', async () => {
        const r = await endPath(async (sup) => { sup.stop('seam_stopped'); });
        assertOneCallEnded(r, 'refused', 'seam_stopped');
    });

    it('the body threw: stream_error, and the log carries no message', async () => {
        const r = await endPath(async () => { throw new Error(UTTERANCE); });
        assertOneCallEnded(r, 'stream_error', 'internal_error');
        assert.ok(r.logs.every((l) => !l.includes('555')));
    });

    it('a body that hung up early and then threw still reports once, as the hangup it sent', async () => {
        const r = await endPath(async (sup) => { await sup.hangup('agent_ended'); throw new Error('late'); });
        assertOneCallEnded(r, 'completed', 'agent_ended');
    });

    it('the drain aborted a call whose body never returns: shutdown', async () => {
        const controller = new AbortController();
        setImmediate(() => controller.abort());
        const r = await endPath(async () => { await never(); }, { shutdown: controller.signal });
        assertOneCallEnded(r, 'shutdown', 'internal_error');
        assert.ok(r.logs.some((l) => l.endsWith('shutdown')));
    });

    it('a drain that arrives after the call already ended does not relabel it', async () => {
        const controller = new AbortController();
        const r = await endPath(async (sup) => { await sup.hangup('agent_ended'); controller.abort(); },
            { shutdown: controller.signal });
        assertOneCallEnded(r, 'completed', 'agent_ended');
    });

    it('every hangup reason maps to a contract end_reason', () => {
        const reasons: HangupReason[] = ['agent_ended', 'far_end_hung_up', 'timeline_exhausted', 'call_too_long', 'transport_failed', 'seam_stopped', 'internal_error'];
        for (const reason of reasons) assert.ok(typeof endReasonFor(reason) === 'string', reason);
        assert.equal(endReasonFor('agent_ended', true), 'shutdown');
    });
});

describe('call_ended is best-effort and bounded', () => {
    it('a seam that rejects costs one redacted log line, and run still resolves', async () => {
        const leg = recordingLeg();
        const seam = recordingSeam(leg, async () => { throw new Error(UTTERANCE); });
        const logs: string[] = [];
        const sup = new CallSupervisor(leg, { clock: () => 0, capTimer: null, log: (l) => { logs.push(l); }, report: seam.sink });
        await sup.run(async () => { sup.stop('agent_ended'); });
        assert.equal(seam.events.length, 1, 'no retry');
        assert.deepEqual(leg.sent, ['agent_ended']);
        assert.ok(logs.some((l) => l.endsWith('call_ended_unrecorded Error')));
        assert.ok(logs.every((l) => !l.includes('555')));
    });

    it('a seam that never answers is abandoned at the bound', async () => {
        const leg = recordingLeg();
        const seam = recordingSeam(leg, () => new Promise(() => {}));
        const logs: string[] = [];
        const sup = new CallSupervisor(leg, {
            clock: () => 0, capTimer: null, log: (l) => { logs.push(l); }, report: seam.sink, reportTimeoutMs: 50,
        });
        const startedAt = Date.now();
        await sup.run(async () => { sup.stop('agent_ended'); });
        assert.ok(Date.now() - startedAt < 1000);
        assert.ok(logs.some((l) => l.endsWith('call_ended_unrecorded timeout')));
    });

    it('the bound defaults to SEAM_TIMEOUT_MS', () => {
        assert.equal(SEAM_TIMEOUT_MS, 2500);
    });

    it('turns and the disclosure are carried, trimmed to the backend caps', async () => {
        const leg = recordingLeg();
        const seam = recordingSeam(leg);
        const turns = Array.from({ length: MAX_TURNS + 5 }, (_, i) => ({ speaker: 'agent' as const, text: 'x'.repeat(i === 0 ? MAX_TURN_CHARS + 10 : 3) }));
        const sup = new CallSupervisor(leg, {
            clock: () => 0, capTimer: null, log: () => {}, report: seam.sink,
            record: () => ({ turns, disclosureHeard: true }),
        });
        await sup.run(async () => { sup.stop('agent_ended'); });
        const sent = seam.events[0]!.input;
        assert.equal(sent.disclosure_heard, true);
        assert.equal(sent.turns!.length, MAX_TURNS);
        assert.equal(sent.turns![0]!.text.length, MAX_TURN_CHARS);
    });

    it('a record that throws still reports, as a silent call', async () => {
        const leg = recordingLeg();
        const seam = recordingSeam(leg);
        const sup = new CallSupervisor(leg, {
            clock: () => 0, capTimer: null, log: () => {}, report: seam.sink,
            record: () => { throw new Error(UTTERANCE); },
        });
        await sup.run(async () => { sup.stop('agent_ended'); });
        assert.equal(seam.events.length, 1);
        assert.deepEqual(seam.events[0]!.input.turns, []);
        assert.equal(seam.events[0]!.input.disclosure_heard, false);
    });

    it('without a report sink nothing is posted (the fake-call runner)', async () => {
        const leg = recordingLeg();
        const sup = new CallSupervisor(leg, { clock: () => 0, capTimer: null, log: () => {} });
        await sup.run(async () => { sup.stop('agent_ended'); });
        assert.equal(sup.endReported, false);
    });
});

describe('the SIGTERM drain budget (VCA-7)', () => {
    it('grace + SEAM_TIMEOUT_MS + margin is at most 9.5 s, inside Cloud Run\'s 10 s', () => {
        assert.equal(DRAIN_BUDGET_MS, 9500);
        assert.equal(DRAIN_SETTLE_MS, SEAM_TIMEOUT_MS + DRAIN_MARGIN_MS);
        assert.ok(DRAIN_GRACE_MS + SEAM_TIMEOUT_MS + DRAIN_MARGIN_MS <= DRAIN_BUDGET_MS,
            `${DRAIN_GRACE_MS} + ${SEAM_TIMEOUT_MS} + ${DRAIN_MARGIN_MS} > ${DRAIN_BUDGET_MS}`);
    });
});

// ── through the stream server, against the mock backend ──────────────────────────────────────────

const servers: StreamServer[] = [];
const mocks: MockSeam[] = [];
after(async () => {
    for (const s of servers) await s.drain(0, 0);
    for (const m of mocks) await m.close();
});

function within<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
    return Promise.race([p, new Promise<'timeout'>((r) => { setTimeout(() => r('timeout'), ms).unref(); })]);
}

function dial(port: number, token: string): { ws: WebSocket; ended: Promise<void>; opened: Promise<void> } {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/stream`);
    ws.on('error', () => {});
    const ended = new Promise<void>((resolve) => { ws.on('close', () => resolve()); });
    const opened = new Promise<void>((resolve) => { ws.on('open', () => resolve()); });
    void opened.then(() => ws.send(JSON.stringify({
        event: 'start',
        sequenceNumber: '1',
        streamSid: 'MZstream',
        start: {
            streamSid: 'MZstream',
            callSid: 'CAcall',
            accountSid: 'ACaccount',
            tracks: ['inbound'],
            mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
            customParameters: { token },
        },
    })));
    return { ws, ended, opened };
}

const callEndedIn = (mock: MockSeam) =>
    mock.journal.filter((e) => e.route === '/reservations/call-event' && (e.body as { kind?: string }).kind === 'call_ended');

describe('call_ended through the stream server', () => {
    it('the no-agent session posts exactly one call_ended, and the backend records it', async () => {
        const mock = await startMockSeam({ port: 0 });
        mocks.push(mock);
        const stream = createStreamServer({ apiBaseUrl: mock.baseUrl, startCall: noAgentSession, log: () => {} });
        servers.push(stream);
        const port = await stream.listen(0, '127.0.0.1');
        const call = dial(port, 'mock:happy');
        assert.notEqual(await within(call.ended, 3000), 'timeout');
        // The socket closes on the hangup; the report follows it.
        for (let i = 0; i < 50 && callEndedIn(mock).length === 0; i++) await new Promise((r) => setTimeout(r, 20));
        const ended = callEndedIn(mock);
        assert.equal(ended.length, 1);
        assert.equal(ended[0]!.status, 200);
        assert.equal((ended[0]!.body as { end_reason?: string }).end_reason, 'stream_error');
        assert.deepEqual((ended[0]!.body as { turns?: unknown[] }).turns, []);
    });

    it('🔴 drain: a live call whose body never returns posts exactly one call_ended (shutdown) before drain resolves, inside the budget', async () => {
        const mock = await startMockSeam({ port: 0 });
        mocks.push(mock);
        const sessions: AuthorizedCall[] = [];
        const stream = createStreamServer({
            apiBaseUrl: mock.baseUrl,
            preAuthMs: 5000,
            log: () => {},
            startCall: async (call) => {
                sessions.push(call);
                const sup = new CallSupervisor(call.leg, {
                    clock: () => call.leg.elapsedMs, log: () => {}, report: call.seam, shutdown: call.shutdown,
                });
                await sup.run(async () => { await never(); });
            },
        });
        const port = await stream.listen(0, '127.0.0.1');
        const call = dial(port, 'mock:happy');
        await call.opened;
        for (let i = 0; i < 100 && sessions.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
        assert.equal(sessions.length, 1, 'the call was accepted');

        const startedAt = Date.now();
        await stream.drain(100);
        const took = Date.now() - startedAt;
        const ended = callEndedIn(mock);
        assert.equal(ended.length, 1, 'exactly one call_ended, before drain resolved');
        assert.equal((ended[0]!.body as { end_reason?: string }).end_reason, 'shutdown');
        assert.deepEqual(sessions[0]!.leg.hangupsSent, ['internal_error']);
        assert.ok(took <= 100 + DRAIN_SETTLE_MS, `drain took ${took} ms`);
        assert.equal(stream.stats().calls, 0, 'the session returned before drain resolved');
    });
});
