/**
 * The public edge, driven by a fake Twilio over a real socket on 127.0.0.1.
 *
 * 🔴 TWO SABOTAGES ARE RUN BY HAND AND PASTED IN THE PR (TASK-3748 step 2):
 *
 *   (a) delete the pre-auth deadline in `createStreamServer` (the `setTimeout` on upgrade). A
 *       socket that never sends `start` then stays open, and "a socket that never sends start is
 *       closed" goes red.
 *   (b) open the call session before `call-context` resolves (call `startCall` ahead of
 *       `seam.callContext()`). "no session opens before the backend accepts" goes red, and so do
 *       the refusal tests, because a refused token would already have opened one.
 *
 * Plus two more: (c) compare the upgrade path with `startsWith('/stream')`, and the query-string
 * test goes red; (d) drop the pre-auth socket cap, and the third socket is let in.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createStreamServer } from '../src/server/streamServer.ts';
import type { AuthorizedCall, StreamServer, StreamServerOptions } from '../src/server/streamServer.ts';
import { noAgentSession } from '../src/server/main.ts';
import { startMockSeam } from '../src/mock/server.ts';
import type { MockSeam } from '../src/mock/server.ts';
import type { CallContext } from '../src/seam/types.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Placeholders, not sentences: the edge never reads them, it only passes the context on. */
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

interface Rig {
    stream: StreamServer;
    port: number;
    logs: string[];
    sessions: AuthorizedCall[];
    url: (path?: string) => string;
    close: () => Promise<void>;
}

const open: Rig[] = [];
after(async () => { for (const r of open) await r.close(); });

async function rig(overrides: Partial<StreamServerOptions> = {}): Promise<Rig> {
    const logs: string[] = [];
    const sessions: AuthorizedCall[] = [];
    const stream = createStreamServer({
        apiBaseUrl: 'http://127.0.0.1:9',
        startCall: async (call) => { sessions.push(call); await noAgentSession(call); },
        log: (line) => { logs.push(line); },
        ...overrides,
    });
    const port = await stream.listen(0, '127.0.0.1');
    let closed = false;
    const r: Rig = {
        stream,
        port,
        logs,
        sessions,
        url: (path = '/stream') => `ws://127.0.0.1:${port}${path}`,
        close: async () => {
            if (closed) return;
            closed = true;
            await stream.drain(0);
        },
    };
    open.push(r);
    return r;
}

interface FakeTwilio {
    ws: WebSocket;
    received: Array<{ event: string }>;
    /** Resolves with the close code, or with an HTTP status if the upgrade was refused. */
    ended: Promise<{ code?: number; status?: number }>;
    opened: Promise<boolean>;
    connected(): void;
    start(token: string): void;
}

function twilio(url: string): FakeTwilio {
    const ws = new WebSocket(url);
    const received: Array<{ event: string }> = [];
    ws.on('message', (data) => { received.push(JSON.parse(String(data)) as { event: string }); });
    const ended = new Promise<{ code?: number; status?: number }>((resolve) => {
        ws.on('close', (code) => resolve({ code }));
        ws.on('unexpected-response', (_req, res) => { resolve({ status: res.statusCode ?? 0 }); ws.terminate(); });
        ws.on('error', () => { /* surfaced through close / unexpected-response */ });
    });
    const opened = new Promise<boolean>((resolve) => {
        ws.on('open', () => resolve(true));
        void ended.then(() => resolve(false));
    });
    return {
        ws,
        received,
        ended,
        opened,
        connected: () => ws.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' })),
        start: (token: string) => ws.send(JSON.stringify({
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
        })),
    };
}

/** Resolves with what `p` resolved to, or with 'timeout'. */
function within<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
    return Promise.race([p, new Promise<'timeout'>((r) => { setTimeout(() => r('timeout'), ms).unref(); })]);
}

const sleep = (ms: number) => new Promise((r) => { setTimeout(r, ms); });

/** A fetch the test answers by hand, recording what it was asked. */
function heldFetch() {
    const asked: Array<{ url: string; auth: string | null }> = [];
    let answer: ((r: Response) => void) | null = null;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        asked.push({ url: String(input), auth: headers.get('authorization') });
        return new Promise<Response>((resolve) => { answer = resolve; });
    }) as typeof fetch;
    return {
        fetchImpl,
        asked,
        respond: (status: number, body: unknown) => {
            answer?.(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
        },
    };
}

let mock: MockSeam | null = null;
async function mockSeam(): Promise<MockSeam> {
    mock ??= await startMockSeam({ port: 0 });
    return mock;
}
after(async () => { await mock?.close(); });

describe('the entrypoint `npm start` and the container run', () => {
    it('`node src/server/main.ts` listens on PORT on every interface and answers /healthz', async () => {
        const probe = createServer();
        await new Promise<void>((r) => { probe.listen(0, '127.0.0.1', () => r()); });
        const port = (probe.address() as { port: number }).port;
        await new Promise<void>((r) => { probe.close(() => r()); });

        const child = spawn(process.execPath, ['src/server/main.ts'], {
            cwd: ROOT,
            env: { ...process.env, PORT: String(port), CREATORAIN_API_BASE_URL: 'http://127.0.0.1:9' },
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        try {
            let stderr = '';
            const listening = new Promise<boolean>((resolve) => {
                child.stderr.on('data', (chunk) => {
                    stderr += String(chunk);
                    if (stderr.includes(`listening on ${port}`)) resolve(true);
                });
                child.on('exit', () => resolve(false));
            });
            assert.equal(await within(listening, 20_000), true, `it never listened.\nstderr: ${stderr}`);
            const res = await fetch(`http://127.0.0.1:${port}/healthz`);
            assert.equal(res.status, 200);
        } finally {
            child.kill();
        }
    });
});

describe('the edge: paths', () => {
    it('GET /healthz is 200 with no body; anything else is a 404', async () => {
        const r = await rig();
        const health = await fetch(`http://127.0.0.1:${r.port}/healthz`);
        assert.equal(health.status, 200);
        assert.equal(await health.text(), '');
        for (const path of ['/', '/stream', '/healthz?x=1', '/__mock/journal']) {
            const res = await fetch(`http://127.0.0.1:${r.port}${path}`);
            assert.equal(res.status, 404, path);
        }
    });

    it('🔴 a WebSocket upgrade anywhere but exactly /stream is refused, a query string included', async () => {
        const r = await rig();
        for (const path of ['/stream?token=abc', '/stream/', '/streams', '/', '/healthz']) {
            const t = twilio(r.url(path));
            assert.deepEqual(await within(t.ended, 2000), { status: 404 }, path);
        }
        assert.equal(r.stream.stats().preAuth, 0);
    });
});

describe('the edge: pre-auth limits', () => {
    it('🔴 a socket that never sends start is closed at the deadline', async () => {
        const r = await rig({ preAuthMs: 200 });
        const t = twilio(r.url());
        assert.equal(await t.opened, true);
        const startedAt = Date.now();
        const end = await within(t.ended, 1500);
        assert.notEqual(end, 'timeout', 'a socket with no start stayed open past the deadline');
        assert.ok(Date.now() - startedAt < 1000);
        assert.equal(r.sessions.length, 0);
        assert.ok(r.logs.some((l) => l.endsWith('preauth_deadline')));
        assert.equal(r.stream.stats().preAuth, 0);
    });

    it('a backend that does not answer inside the deadline closes the line, and no session opens', async () => {
        const held = heldFetch();
        const r = await rig({ preAuthMs: 200, fetchImpl: held.fetchImpl, seamTimeoutMs: 5000 });
        const t = twilio(r.url());
        await t.opened;
        t.connected();
        t.start('tok-slow');
        assert.notEqual(await within(t.ended, 1500), 'timeout');
        held.respond(200, CONTEXT);
        await sleep(50);
        assert.equal(r.sessions.length, 0, 'a late yes opened a session on a closed line');
    });

    it('🔴 at most two sockets per instance wait for the backend; a third is refused', async () => {
        const r = await rig({ preAuthMs: 5000 });
        const a = twilio(r.url());
        const b = twilio(r.url());
        assert.equal(await a.opened, true);
        assert.equal(await b.opened, true);
        const c = twilio(r.url());
        assert.deepEqual(await within(c.ended, 2000), { status: 503 });
        assert.ok(r.logs.includes('stream-server preauth_full'));
        a.ws.close();
        await a.ended;
        await sleep(50);
        const d = twilio(r.url());
        assert.equal(await d.opened, true, 'a freed slot was not given back');
        b.ws.close();
        d.ws.close();
    });

    it('a frame over 64 KB closes the socket before anything reads it', async () => {
        const held = heldFetch();
        const r = await rig({ fetchImpl: held.fetchImpl });
        const t = twilio(r.url());
        await t.opened;
        t.ws.send('x'.repeat(64 * 1024 + 1));
        const end = await within(t.ended, 2000);
        assert.deepEqual(end, { code: 1009 });
        assert.equal(held.asked.length, 0);
        assert.equal(r.sessions.length, 0);
    });
});

describe('the edge: the token and the backend', () => {
    it('🔴 no session opens before the backend accepts, and the token travels only in the header', async () => {
        const held = heldFetch();
        const r = await rig({ fetchImpl: held.fetchImpl, apiBaseUrl: 'http://seam.test' });
        const t = twilio(r.url());
        await t.opened;
        t.connected();
        t.start('tok-held');
        await sleep(150);
        assert.equal(r.sessions.length, 0, 'a session opened while call-context was still pending');
        assert.deepEqual(held.asked, [{ url: 'http://seam.test/reservations/call-context', auth: 'Bearer tok-held' }]);
        held.respond(200, CONTEXT);
        await within(t.ended, 2000);
        assert.equal(r.sessions.length, 1);
        assert.deepEqual(r.sessions[0]!.context, CONTEXT);
        assert.ok(r.logs.every((l) => !l.includes('tok-held')), 'the token reached a log line');
    });

    for (const [token, reason] of [['mock:seam-disabled', 'seam_disabled'], ['not-a-mock-token', 'token_invalid'], ['mock:venue-stopped', 'venue_stopped'], ['mock:outside-opening-hours', 'outside_opening_hours']] as const) {
        it(`🔴 a refusal (${reason}) closes the line with no session and no audio`, async () => {
            const seam = await mockSeam();
            const r = await rig({ apiBaseUrl: seam.baseUrl });
            const t = twilio(r.url());
            await t.opened;
            t.connected();
            t.start(token);
            assert.notEqual(await within(t.ended, 3000), 'timeout');
            assert.equal(r.sessions.length, 0);
            assert.deepEqual(t.received, [], 'something was sent down a refused line');
            assert.ok(r.logs.some((l) => l.endsWith(`seam_refused ${reason}`)), r.logs.join('\n'));
            assert.ok(r.logs.every((l) => !l.includes(token)), 'the token reached a log line');
            assert.equal(r.stream.stats().accepted, 0);
        });
    }

    it('an answer that is not a refusal and not a context closes the line too', async () => {
        for (const [status, body] of [[500, { ok: false }], [409, { reason: 'a_word_not_in_the_contract' }], [200, { ok: true }]] as const) {
            const held = heldFetch();
            const r = await rig({ fetchImpl: held.fetchImpl });
            const t = twilio(r.url());
            await t.opened;
            t.start('tok');
            await sleep(30);
            held.respond(status, body);
            assert.notEqual(await within(t.ended, 2000), 'timeout');
            assert.equal(r.sessions.length, 0, `${status} ${JSON.stringify(body)}`);
            assert.ok(r.logs.some((l) => l.endsWith('seam_unavailable')));
        }
    });

    it('an accepted call with no agent wired is hung up once, having sent no audio', async () => {
        const seam = await mockSeam();
        const r = await rig({ apiBaseUrl: seam.baseUrl });
        const t = twilio(r.url());
        await t.opened;
        t.connected();
        t.start('mock:happy');
        assert.deepEqual(await within(t.ended, 3000), { code: 1000 });
        assert.equal(r.sessions.length, 1);
        assert.deepEqual(r.sessions[0]!.leg.hangupsSent, ['internal_error']);
        assert.equal(r.sessions[0]!.leg.framesSent, 0);
        assert.deepEqual(t.received, []);
        assert.ok(r.logs.some((l) => l.endsWith('no_call_agent')));
        assert.equal(r.stream.stats().accepted, 1);
    });
});

describe('the edge: one call per instance, and every way out hangs up', () => {
    it('a second accepted call while one is live is closed without a session', async () => {
        let release: () => void = () => {};
        const holding = new Promise<void>((r) => { release = r; });
        const seam = await mockSeam();
        const r = await rig({
            apiBaseUrl: seam.baseUrl,
            startCall: async (call) => { r.sessions.push(call); await holding; await call.leg.hangup('agent_ended'); },
        });
        const first = twilio(r.url());
        await first.opened;
        first.start('mock:happy');
        await sleep(200);
        assert.equal(r.stream.stats().calls, 1);
        const second = twilio(r.url());
        await second.opened;
        second.start('mock:happy');
        assert.notEqual(await within(second.ended, 2000), 'timeout');
        assert.equal(r.sessions.length, 1);
        assert.ok(r.logs.some((l) => l.endsWith('busy')));
        release();
        assert.deepEqual(await within(first.ended, 2000), { code: 1000 });
        assert.equal(r.stream.stats().calls, 0);
    });

    it('a session that throws is hung up, and the log carries the class name only', async () => {
        const seam = await mockSeam();
        const r = await rig({
            apiBaseUrl: seam.baseUrl,
            startCall: async () => { throw new TypeError('they said 555 0100'); },
        });
        const t = twilio(r.url());
        await t.opened;
        t.start('mock:happy');
        assert.notEqual(await within(t.ended, 2000), 'timeout');
        assert.ok(r.logs.some((l) => l.endsWith('call_failed TypeError')));
        assert.ok(r.logs.every((l) => !l.includes('555')));
    });

    it('a session that returns with the line up is hung up by the server', async () => {
        const seam = await mockSeam();
        const r = await rig({ apiBaseUrl: seam.baseUrl, startCall: async () => {} });
        const t = twilio(r.url());
        await t.opened;
        t.start('mock:happy');
        assert.notEqual(await within(t.ended, 2000), 'timeout');
        assert.ok(r.logs.some((l) => l.endsWith('session_left_line_up')));
    });

    it('drain closes unaccepted sockets at once and hangs up a live call after the grace', async () => {
        const seam = await mockSeam();
        const r = await rig({
            apiBaseUrl: seam.baseUrl,
            preAuthMs: 5000,
            startCall: async (call) => { r.sessions.push(call); await new Promise(() => {}); },
        });
        const live = twilio(r.url());
        await live.opened;
        live.start('mock:happy');
        await sleep(200);
        const waiting = twilio(r.url());
        await waiting.opened;
        const drained = r.stream.drain(100);
        assert.notEqual(await within(waiting.ended, 1000), 'timeout');
        await drained;
        assert.notEqual(await within(live.ended, 1000), 'timeout');
        assert.deepEqual(r.sessions[0]!.leg.hangupsSent, ['internal_error']);
        assert.ok(r.logs.some((l) => l.endsWith('drain_forced_hangup')));
    });
});
