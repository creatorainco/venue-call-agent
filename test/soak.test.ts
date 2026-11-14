/**
 * The soak driver (TASK-3749 step 1) against the real stream server on 127.0.0.1, with the mock
 * seam behind it. Needs `ws`, like `test/server.test.ts`.
 *
 * 🔴 CONTROLS (CONTRIBUTING.md: a guard ships with a control that must fail):
 *   - a far side that sends one audible `media` frame must fail `judge` (the "said nothing" check);
 *   - a far side that never closes must fail `judge` as `timeout`, not pass as refused;
 *   - a far side that refuses nothing (a bogus socket left open) must fail the same way.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';

import { createStreamServer } from '../src/server/streamServer.ts';
import type { StreamServer } from '../src/server/streamServer.ts';
import { noAgentSession } from '../src/server/main.ts';
import { startMockSeam } from '../src/mock/server.ts';
import type { MockSeam } from '../src/mock/server.ts';
import { BOGUS_KINDS, judge, runLeg, isSilentPayload } from '../src/soak/driver.ts';
import { runEdgeSoak } from '../src/soak/edge.ts';
import { speechFrame } from '../src/carrier/fakeLeg.ts';
import { silentCarrierFrame } from '../src/audio/format.ts';

const cleanups: Array<() => Promise<void>> = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });

let mock: MockSeam | null = null;
async function mockSeam(): Promise<MockSeam> {
    if (!mock) {
        mock = await startMockSeam({ port: 0 });
        const m = mock;
        cleanups.push(async () => { await m.close(); });
    }
    return mock;
}

async function edge(): Promise<{ stream: StreamServer; base: string; logs: string[] }> {
    const seam = await mockSeam();
    const logs: string[] = [];
    const stream = createStreamServer({
        apiBaseUrl: seam.baseUrl,
        startCall: noAgentSession,
        log: (line) => { logs.push(line); },
        preAuthMs: 600,
    });
    const port = await stream.listen(0, '127.0.0.1');
    cleanups.push(async () => { await stream.drain(0, 0); });
    return { stream, base: `http://127.0.0.1:${port}`, logs };
}

/** A far side the test scripts: on `start` it does `behaviour`. */
async function fakeFarSide(behaviour: 'audible-then-close' | 'never-close'): Promise<string> {
    const server = createServer();
    const wss = new WebSocketServer({ server });
    wss.on('connection', (ws) => {
        ws.on('message', (data) => {
            const msg = JSON.parse(String(data)) as { event: string };
            if (msg.event !== 'start') return;
            if (behaviour === 'audible-then-close') {
                ws.send(JSON.stringify({ event: 'media', streamSid: 'x', media: { payload: Buffer.from(speechFrame(0)).toString('base64') } }));
                setTimeout(() => ws.close(1000), 50);
            }
        });
    });
    await new Promise<void>((r) => { server.listen(0, '127.0.0.1', () => r()); });
    cleanups.push(async () => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        await new Promise<void>((r) => { server.close(() => r()); });
    });
    return `ws://127.0.0.1:${(server.address() as { port: number }).port}/stream`;
}

describe('the soak driver against the stream server', () => {
    it('a Twilio-shaped leg with a token the backend accepts is taken, hung up by the server, and silent', async () => {
        const { stream, base, logs } = await edge();
        const outcome = await runLeg(`${base.replace('http', 'ws')}/stream`, { kind: 'twilio', token: 'mock:happy', mediaMs: 2000, timeoutMs: 5000 });
        assert.equal(outcome.upgraded, true);
        assert.equal(outcome.closedBy, 'server');
        assert.equal(outcome.audibleFrames, 0);
        assert.ok(outcome.msToClose < 2000, `the server should end an unwired call before the caller's audio runs out (${outcome.msToClose} ms)`);
        assert.deepEqual(judge(outcome, 'accepted-silent'), { pass: true, why: [] });
        assert.equal(stream.stats().accepted, 1);
        assert.ok(logs.some((l) => l.endsWith(' accepted')));
        assert.ok(logs.some((l) => l.endsWith(' no_call_agent')));
    });

    it('a forged token is refused before the session opens, with no audio', async () => {
        const { stream, base, logs } = await edge();
        const outcome = await runLeg(`${base.replace('http', 'ws')}/stream`, { kind: 'bad-token', mediaMs: 2000, timeoutMs: 5000 });
        assert.equal(judge(outcome, 'refused').pass, true, JSON.stringify(outcome));
        assert.equal(stream.stats().accepted, 0);
        assert.ok(logs.some((l) => l.includes('seam_refused token_invalid')), logs.join('\n'));
    });

    it('runEdgeSoak: 3 calls and the 5 bogus sockets, each judged, health 200 after every one, the process up', async () => {
        const { stream, base, logs } = await edge();
        const report = await runEdgeSoak({ baseUrl: base, token: 'mock:happy', legs: 3, bogus: true, expect: 'accepted-silent', mediaMs: 600, timeoutMs: 5000, health: async (u) => (await fetch(u)).status });
        assert.equal(report.rows.length, 3 + BOGUS_KINDS.length);
        for (const row of report.rows) assert.equal(row.pass, true, `${row.leg}: ${row.why.join('; ')}`);
        assert.equal(report.pass, true);
        assert.equal(stream.stats().accepted, 3);
        assert.equal(stream.stats().preAuth, 0, 'every refused socket gave its pre-auth slot back');
        // Bounded: a handful of lines per leg, never one per frame.
        assert.ok(logs.length <= 8 * report.rows.length, `${logs.length} log lines for ${report.rows.length} legs`);
    });
});

describe('the driver controls (each must FAIL judge)', () => {
    it('control: a far side that speaks one audible frame fails "said nothing"', async () => {
        const url = await fakeFarSide('audible-then-close');
        const outcome = await runLeg(url, { kind: 'twilio', token: 't', mediaMs: 2000, timeoutMs: 3000 });
        assert.equal(outcome.audibleFrames, 1);
        const verdict = judge(outcome, 'refused');
        assert.equal(verdict.pass, false);
        assert.match(verdict.why.join(';'), /audible/);
    });

    it('control: a far side that never closes a bogus socket fails as a timeout', async () => {
        const url = await fakeFarSide('never-close');
        const outcome = await runLeg(url, { kind: 'no-token', timeoutMs: 400 });
        assert.equal(outcome.closedBy, 'timeout');
        assert.equal(judge(outcome, 'refused').pass, false);
    });

    it('a silence payload reads as silent and a tone does not', () => {
        assert.equal(isSilentPayload(silentCarrierFrame(1).toString('base64')), true);
        assert.equal(isSilentPayload(Buffer.from(speechFrame(3)).toString('base64')), false);
    });
});
