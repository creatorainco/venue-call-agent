/**
 * TASK-3748 V2b: the stream server and the seam client hold up when their own code fails.
 *
 * Findings covered (audit 2026-11-09, gaps.md): VCA-1 a throwing leg handler, VCA-2 a rejected
 * authorize, VCA-3 a flood of refused upgrades, VCA-6 the armed call cap, VCA-9 the Cloud Run
 * base-URL check, CORE-A6 a stalled body, CORE-A7 one seam timeout, CORE-A8 the stop-calling retry.
 *
 * 🔴 SABOTAGES, RUN BY HAND AND PASTED IN THE PR:
 *   (a) drop the `guarded(...)` wrapper around `leg.receive` in streamServer.ts: the throwing
 *       inbound handler escapes a socket event and this file dies with an uncaught exception.
 *   (b) log every preauth_full (skip `windowedLog`): the 200-refusal test sees 200 lines.
 *   (c) drop the cap timer from `CallSupervisor.run`: the never-resolving body test times out.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { WebSocket } from 'ws';

import { createStreamServer } from '../src/server/streamServer.ts';
import type { AuthorizedCall, StreamServer, StreamServerOptions } from '../src/server/streamServer.ts';
import { assertDeployableBaseUrl, startServer } from '../src/server/main.ts';
import { CallSupervisor } from '../src/carrier/supervisor.ts';
import type { Hangable } from '../src/carrier/supervisor.ts';
import type { HangupReason } from '../src/carrier/leg.ts';
import { CARRIER_AUDIO } from '../src/audio/format.ts';
import {
    createSeamClient,
    SeamRefusal,
    SeamUnavailable,
    STOP_CALLING_UNRECORDED_ALERT,
} from '../src/seam/client.ts';
import { SEAM_REFUSAL_REASONS } from '../src/seam/types.ts';
import type { CallContext } from '../src/seam/types.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const CONTEXT: CallContext = {
    reservation_id: 'r-1',
    attempt_id: 'a-1',
    still_active: true,
    venue: { name: null, city_state: null },
    brand: { name: null },
    creator: { spoken_name: 'placeholder' },
    when: { spoken_time: 'placeholder', local_date: null },
    disclosure_sentence: 'placeholder disclosure from the backend',
    opening_script: ['placeholder opening from the backend'],
    voicemail_script: 'placeholder',
    system_instruction: 'placeholder',
    answerable_topics: [],
    script_version: 'test',
};

const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const acceptingFetch = (async () => json(200, CONTEXT)) as typeof fetch;

const sleep = (ms: number) => new Promise((r) => { setTimeout(r, ms); });

async function until(cond: () => boolean, ms = 3000): Promise<void> {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end) throw new Error('condition not met in time');
        await sleep(5);
    }
}

const opened: StreamServer[] = [];
after(async () => { for (const s of opened) await s.drain(0); });

async function rig(overrides: Partial<StreamServerOptions>) {
    const logs: string[] = [];
    const sessions: AuthorizedCall[] = [];
    const stream = createStreamServer({
        apiBaseUrl: 'http://127.0.0.1:9',
        fetchImpl: acceptingFetch,
        startCall: async () => {},
        log: (line) => { logs.push(line); },
        ...overrides,
    });
    const port = await stream.listen(0, '127.0.0.1');
    opened.push(stream);
    return { stream, logs, sessions, url: `ws://127.0.0.1:${port}/stream` };
}

function twilio(url: string) {
    const ws = new WebSocket(url);
    const received: Array<{ event: string; mark?: { name: string } }> = [];
    ws.on('message', (data) => { received.push(JSON.parse(String(data))); });
    const ended = new Promise<number | 'refused'>((resolve) => {
        ws.on('close', (code) => resolve(code));
        ws.on('unexpected-response', () => { resolve('refused'); ws.terminate(); });
        ws.on('error', () => { /* surfaced through close */ });
    });
    const opened = new Promise<boolean>((resolve) => {
        ws.on('open', () => resolve(true));
        void ended.then(() => resolve(false));
    });
    const send = (m: object) => ws.send(JSON.stringify(m));
    return {
        ws,
        received,
        ended,
        opened,
        start: () => send({
            event: 'start',
            streamSid: 'MZstream',
            start: {
                streamSid: 'MZstream',
                callSid: 'CAcall',
                tracks: ['inbound'],
                mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
                customParameters: { token: 'opaque-token' },
            },
        }),
        media: () => send({
            event: 'media',
            streamSid: 'MZstream',
            media: { track: 'inbound', payload: Buffer.alloc(CARRIER_AUDIO.bytesPerFrame, 0xff).toString('base64') },
        }),
        echoMark: (name: string) => send({ event: 'mark', streamSid: 'MZstream', mark: { name } }),
        stop: () => send({ event: 'stop', streamSid: 'MZstream' }),
    };
}

/** A session that plants a throwing handler, then stays on the line until the leg ends. */
function sessionThat(plant: (call: AuthorizedCall) => void, sessions: AuthorizedCall[]) {
    return async (call: AuthorizedCall): Promise<void> => {
        sessions.push(call);
        const over = new Promise<void>((r) => { call.leg.on('hangup', () => r()); });
        plant(call);
        await over;
    };
}

const boom = (): never => { throw new TypeError('handler bug: my cell is 555 0100'); };

describe('VCA-1: a throwing leg handler ends that call, once, and the process stays up', () => {
    const cases: Array<{ name: string; plant: (c: AuthorizedCall) => void; provoke: (t: ReturnType<typeof twilio>) => Promise<void> }> = [
        {
            name: 'an inbound handler',
            plant: (c) => { c.leg.on('inbound', boom); },
            provoke: async (t) => { t.media(); },
        },
        {
            name: 'a marked handler',
            plant: (c) => {
                c.leg.on('marked', boom);
                c.leg.write(new Uint8Array(CARRIER_AUDIO.bytesPerFrame));
                c.leg.mark('m1');
            },
            provoke: async (t) => {
                await until(() => t.received.some((m) => m.event === 'mark'));
                t.echoMark('m1');
            },
        },
        {
            name: 'a hangup handler',
            plant: (c) => { c.leg.on('hangup', boom); },
            provoke: async (t) => { t.stop(); },
        },
    ];

    for (const c of cases) {
        it(`${c.name} that throws gives exactly one hangup('internal_error')`, async () => {
            const sessions: AuthorizedCall[] = [];
            const r = await rig({ startCall: sessionThat(c.plant, sessions) });
            const t = twilio(r.url);
            assert.equal(await t.opened, true);
            t.start();
            await until(() => sessions.length === 1);
            await c.provoke(t);
            await t.ended;
            await until(() => r.stream.stats().calls === 0);

            const leg = sessions[0]!.leg;
            assert.deepEqual(leg.hangupsSent.filter((x) => x === 'internal_error'), ['internal_error']);
            assert.equal(r.logs.filter((l) => l.includes('handler_failed')).length, 1);
            assert.ok(r.logs.some((l) => l === `stream ${leg.id} handler_failed TypeError`));
            assert.ok(!r.logs.join('\n').includes('555'), 'an error message never reaches a log line');

            // The process is up and the call slot is free: the next call is accepted.
            const next = twilio(r.url);
            assert.equal(await next.opened, true);
            next.start();
            await until(() => r.stream.stats().accepted === 2);
            next.ws.close();
        });
    }
});

describe('VCA-2: a rejection inside authorize is caught, logged and ends the call', () => {
    it('a failure while handling a seam refusal: one hangup, the slot released, one authorize_failed', async () => {
        const reason = SEAM_REFUSAL_REASONS[0];
        const logs: string[] = [];
        const r = await rig({
            fetchImpl: (async () => json(409, { reason })) as typeof fetch,
            log: (line) => {
                if (line.includes('seam_refused')) throw new RangeError('log sink failed');
                logs.push(line);
            },
            startCall: async () => { assert.fail('no session opens on a refusal'); },
        });
        const t = twilio(r.url);
        assert.equal(await t.opened, true);
        t.start();
        assert.equal(typeof await t.ended, 'number');
        await until(() => r.stream.stats().preAuth === 0);
        assert.equal(logs.filter((l) => l.includes('authorize_failed RangeError')).length, 1);
        assert.equal(r.stream.stats().closedBeforeAccept, 1);
        assert.equal(r.stream.stats().accepted, 0);
    });
});

describe('VCA-3: refused upgrades are counted, but logged at most twice per window', () => {
    it('200 refused upgrades give at most 2 log lines, one carrying the suppressed count', async () => {
        const r = await rig({ maxPreAuthSockets: 0, logWindowMs: 60_000 });
        const all = Array.from({ length: 200 }, () => twilio(r.url));
        const outcomes = await Promise.all(all.map((t) => t.ended));
        assert.ok(outcomes.every((o) => o === 'refused'));
        assert.equal(r.stream.stats().refusedFull, 200);

        await r.stream.drain(0); // closes the window
        const lines = r.logs.filter((l) => l.includes('preauth_full'));
        assert.ok(lines.length <= 2, `got ${lines.length} lines`);
        assert.deepEqual(lines, ['stream-server preauth_full', 'stream-server preauth_full suppressed=199']);
    });

    it('a new window logs its first refusal again', async () => {
        const r = await rig({ maxPreAuthSockets: 0, logWindowMs: 30 });
        await twilio(r.url).ended;
        await sleep(80);
        await twilio(r.url).ended;
        assert.equal(r.logs.filter((l) => l === 'stream-server preauth_full').length, 2);
        assert.equal(r.stream.stats().refusedFull, 2);
    });
});

function recordingLeg(): Hangable & { sent: HangupReason[] } {
    const handlers: Array<(reason: HangupReason) => void> = [];
    const sent: HangupReason[] = [];
    let over = false;
    return {
        id: 'call-under-test',
        sent,
        on: (_event, handler) => { handlers.push(handler); },
        hangup: async (reason) => {
            sent.push(reason);
            if (over) return;
            over = true;
            for (const h of handlers) h(reason);
        },
    };
}

describe('VCA-6: the call cap is armed, not only polled', () => {
    it('a body awaiting a promise that never resolves is hung up at the cap, exactly once', async () => {
        const leg = recordingLeg();
        let fire: (() => void) | null = null;
        let armedFor = -1;
        const supervisor = new CallSupervisor(leg, {
            clock: () => 1000,
            maxCallMs: 5000,
            log: () => {},
            capTimer: (f, ms) => { fire = f; armedFor = ms; return () => {}; },
        });
        let signal: AbortSignal | null = null;
        const done = supervisor.run(async (s) => { signal = s; await new Promise(() => {}); });
        await sleep(5);
        assert.equal(armedFor, 4000, 'armed for what is left of the cap');
        assert.deepEqual(leg.sent, [], 'nothing before the cap');
        fire!();
        await done;
        assert.deepEqual(leg.sent, ['call_too_long']);
        assert.equal(signal!.aborted, true, "the body's signal aborts");
    });

    it('the default timer is a real one, and a body that ends first cancels it', async () => {
        const capped = recordingLeg();
        await new CallSupervisor(capped, { clock: () => 0, maxCallMs: 30, log: () => {} })
            .run(async () => { await new Promise(() => {}); });
        assert.deepEqual(capped.sent, ['call_too_long']);

        const leg = recordingLeg();
        let cancelled = false;
        const supervisor = new CallSupervisor(leg, {
            clock: () => 0,
            log: () => {},
            capTimer: () => () => { cancelled = true; },
        });
        await supervisor.run(async () => { supervisor.stop('agent_ended'); });
        assert.deepEqual(leg.sent, ['agent_ended']);
        assert.equal(cancelled, true);
    });
});

describe('VCA-9: on Cloud Run the backend must be named, over https', () => {
    it('refuses with no base URL and with an http one; https starts', async () => {
        await assert.rejects(startServer({ K_SERVICE: 'x', PORT: '8080' }), /not set/);
        await assert.rejects(startServer({ K_SERVICE: 'x', PORT: '8080', CREATORAIN_API_BASE_URL: 'http://datadev.creatorain.com' }), /https/);
        assert.throws(() => assertDeployableBaseUrl({ K_SERVICE: 'x', CREATORAIN_API_BASE_URL: 'not a url' }), /not a URL/);

        const probe = createServer();
        await new Promise<void>((r) => { probe.listen(0, '127.0.0.1', () => r()); });
        const port = (probe.address() as { port: number }).port;
        await new Promise<void>((r) => { probe.close(() => r()); });
        const { stream, port: bound } = await startServer({
            K_SERVICE: 'x',
            PORT: String(port),
            CREATORAIN_API_BASE_URL: 'https://datadev.creatorain.com',
        });
        assert.equal(bound, port);
        await stream.drain(0);
    });

    it('off Cloud Run nothing changes: the local default still applies', () => {
        assert.doesNotThrow(() => assertDeployableBaseUrl({}));
    });
});

describe('CORE-A6: the seam timeout covers the body read', () => {
    it('headers on time and a body that stalls is a SeamUnavailable at the timeout', async () => {
        const fetchImpl = (async () => new Response(new ReadableStream({
            start(controller) { controller.enqueue(new TextEncoder().encode('{"disclosure_sentence":')); },
        }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
        const client = createSeamClient({ baseUrl: 'http://seam', token: 't', timeoutMs: 100, fetchImpl });
        const began = Date.now();
        await assert.rejects(client.callContext(), (e: unknown) => e instanceof SeamUnavailable && /no whole body in 100ms/.test(e.detail));
        assert.ok(Date.now() - began < 2000);
    });
});

describe('CORE-A7: one seam timeout', () => {
    it('only src/tuning/liveDefaults.ts declares a numeric seam timeout', () => {
        const hits: string[] = [];
        const walk = (dir: string): void => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                const path = join(dir, entry.name);
                if (entry.isDirectory()) walk(path);
                else if (path.endsWith('.ts') && /const\s+\w*TIMEOUT\w*\s*=\s*\d/.test(readFileSync(path, 'utf8'))) hits.push(path);
            }
        };
        walk(join(ROOT, 'src', 'seam'));
        walk(join(ROOT, 'src', 'server'));
        assert.deepEqual(hits, []);
        assert.match(readFileSync(join(ROOT, 'src', 'seam', 'client.ts'), 'utf8'), /options\.timeoutMs \?\? SEAM_TIMEOUT_MS/);
    });
});

describe('CORE-A8: the stop-calling event gets one bounded retry', () => {
    const STOP = { kind: 'human_callback', reason: 'asked_to_stop_calling' } as const;
    const recorded = { recorded: true, say: 'Understood.', do_not_call: true };

    function scripted(...answers: Array<Response | 'throw'>) {
        let calls = 0;
        const fetchImpl = (async () => {
            const a = answers[Math.min(calls++, answers.length - 1)]!;
            if (a === 'throw') throw new TypeError('fetch failed');
            return a;
        }) as typeof fetch;
        return { fetchImpl, calls: () => calls };
    }

    it('an unanswered first try is retried once and the event is recorded', async () => {
        const logs: string[] = [];
        const s = scripted('throw', json(200, recorded));
        const client = createSeamClient({ baseUrl: 'http://seam', token: 't', fetchImpl: s.fetchImpl, log: (l) => logs.push(l) });
        assert.deepEqual(await client.callEvent(STOP), recorded);
        assert.equal(s.calls(), 2);
        assert.deepEqual(logs, ['seam-client stop_calling_retry /reservations/call-event']);
    });

    it('two failures stop there, with an ERROR line carrying the alert token', async () => {
        const logs: string[] = [];
        const s = scripted(json(503, {}));
        const client = createSeamClient({ baseUrl: 'http://seam', token: 't', fetchImpl: s.fetchImpl, log: (l) => logs.push(l) });
        await assert.rejects(client.callEvent(STOP), SeamUnavailable);
        assert.equal(s.calls(), 2, 'bounded: one retry, no more');
        assert.equal(logs.filter((l) => l.includes(`ERROR ${STOP_CALLING_UNRECORDED_ALERT}`)).length, 1);
    });

    it('a refusal is a decision and is not retried; other events are not retried', async () => {
        const refused = scripted(json(409, { reason: SEAM_REFUSAL_REASONS[0] }));
        const c1 = createSeamClient({ baseUrl: 'http://seam', token: 't', fetchImpl: refused.fetchImpl, log: () => {} });
        await assert.rejects(c1.callEvent(STOP), SeamRefusal);
        assert.equal(refused.calls(), 1);

        const other = scripted('throw');
        const c2 = createSeamClient({ baseUrl: 'http://seam', token: 't', fetchImpl: other.fetchImpl, log: () => {} });
        await assert.rejects(c2.callEvent({ kind: 'human_callback', reason: 'wants_to_cancel' }), SeamUnavailable);
        assert.equal(other.calls(), 1);
    });
});
