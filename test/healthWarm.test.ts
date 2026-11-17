/**
 * /health holds the CPU for the warm-up, and the warm-up renders the backend's disclosure (soak
 * 2026-11-16, TASK-3749).
 *
 * platform-backend pings `GET /health` on the stream host before it dials. On Cloud Run the CPU is
 * throttled once a request has been answered, so a /health that answered at once left the warm-up
 * crawling (6-10 s on dev against ~2.2 s locally), and the first call then synthesised the disclosure
 * itself (1.1-1.7 s) before the first word.
 *
 *   1. With `onHealth`, the 200 waits for it; GET and HEAD alike.
 *   2. The wait is bounded: a warm-up that never ends still gets a 200 at the bound.
 *   3. A warm-up that throws or rejects still gets a 200: health never fails on the warm-up.
 *   4. Through `selectSession`: a cold /health runs the warm-up (disclosure included) before its
 *      200; a warm one answers at once and renders nothing.
 *   5. The bound sits under the backend's ping timeout (3000 ms).
 *   6. The mirrored disclosure is the mock's disclosure, which `contract:derive` checks against the
 *      backend, and nothing but the warm-up imports it: it is a cache key, never spoken.
 *
 * CONTROL: without `onHealth` the 200 comes before a pending warm-up ends; so case 1 can tell the
 * two apart.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStreamServer } from '../src/server/streamServer.ts';
import type { StreamServer, StreamServerOptions } from '../src/server/streamServer.ts';
import { HEALTH_WARM_WAIT_MS, WARM_PHRASES, noAgentSession, selectSession } from '../src/server/main.ts';
import type { CascadeRuntime } from '../src/agent/cascade.ts';
import { FIXED_PHRASES } from '../src/agent/phrases.ts';
import { BACKEND_FIRST_SENTENCES, DISCLOSURE_CACHE_KEY } from '../src/agent/warmSentences.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const servers: StreamServer[] = [];
after(async () => { for (const s of servers) await s.drain(0, 0); });

async function serve(overrides: Partial<StreamServerOptions>): Promise<number> {
    const stream = createStreamServer({
        apiBaseUrl: 'http://127.0.0.1:9',
        startCall: noAgentSession,
        log: () => {},
        ...overrides,
    });
    servers.push(stream);
    return stream.listen(0, '127.0.0.1');
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    return { promise, resolve };
}

/** Resolves with the status, or 'pending' if the response has not arrived within `ms`. */
async function statusWithin(p: Promise<Response>, ms: number): Promise<number | 'pending'> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<'pending'>((r) => { timer = setTimeout(() => r('pending'), ms); });
    try {
        const res = await Promise.race([p, late]);
        return res === 'pending' ? res : res.status;
    } finally {
        clearTimeout(timer);
    }
}

describe('/health waits on the warm-up', () => {
    for (const method of ['GET', 'HEAD']) {
        it(`${method} /health: the 200 waits for onHealth`, async () => {
            const gate = deferred();
            const port = await serve({ onHealth: () => gate.promise, healthWaitMs: 5000 });
            const res = fetch(`http://127.0.0.1:${port}/health`, { method });
            assert.equal(await statusWithin(res, 150), 'pending', 'answered before the warm-up ended');
            gate.resolve();
            const done = await res;
            assert.equal(done.status, 200);
            assert.equal(await done.text(), '');
        });
    }

    it('CONTROL: without onHealth the 200 does not wait for a pending warm-up', async () => {
        const gate = deferred();
        void gate.promise;
        const port = await serve({});
        assert.equal(await statusWithin(fetch(`http://127.0.0.1:${port}/health`), 1000), 200);
        gate.resolve();
    });

    it('a warm-up that never ends: 200 at the bound', async () => {
        const port = await serve({ onHealth: () => new Promise<void>(() => {}), healthWaitMs: 100 });
        const startedAt = Date.now();
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        const took = Date.now() - startedAt;
        assert.equal(res.status, 200);
        assert.ok(took >= 90 && took < 1500, `took ${took} ms`);
    });

    it('a warm-up that rejects or throws: still 200', async () => {
        const rejecting = await serve({ onHealth: () => Promise.reject(new Error('TtsUnavailable')), healthWaitMs: 1000 });
        assert.equal((await fetch(`http://127.0.0.1:${rejecting}/health`)).status, 200);
        const throwing = await serve({ onHealth: () => { throw new Error('sync'); }, healthWaitMs: 1000 });
        assert.equal((await fetch(`http://127.0.0.1:${throwing}/health`)).status, 200);
    });

    it('the bound is under platform-backend\'s warm-ping timeout (3000 ms)', () => {
        assert.ok(HEALTH_WARM_WAIT_MS > 0 && HEALTH_WARM_WAIT_MS < 3000, String(HEALTH_WARM_WAIT_MS));
    });
});

describe('the session main.ts picks: /health runs the warm-up, disclosure included', () => {
    it('cold: /health answers after the warm-up; warm: at once, rendering nothing', async () => {
        const rendered: string[][] = [];
        let failBoot = true;
        const rt = {
            tts: {
                requests: 0,
                synthesize: async () => Buffer.alloc(1),
                prerender: async (texts: readonly string[]) => {
                    rendered.push([...texts]);
                    // The boot warm-up dies (Cloud Run throttled it); the one /health asks for works, slowly.
                    if (failBoot) throw Object.assign(new Error('x'), { name: 'TtsUnavailable' });
                    await new Promise((r) => setTimeout(r, 200));
                },
            },
            preconnect: async () => {},
            agentFor: () => { throw new Error('unused'); },
        } as unknown as CascadeRuntime;
        const session = selectSession(
            { CREATORAIN_API_BASE_URL: 'https://datadev.creatorain.com' },
            { cascade: async () => rt, log: () => {} },
        );
        assert.ok(session.onHealth);
        await new Promise((r) => setTimeout(r, 20));
        failBoot = false;
        const before = rendered.length;
        const port = await serve({ onHealth: session.onHealth, healthWaitMs: HEALTH_WARM_WAIT_MS });

        let startedAt = Date.now();
        assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
        assert.ok(Date.now() - startedAt >= 180, 'the cold 200 came after the warm-up');
        assert.equal(rendered.length, before + 1);
        assert.deepEqual(rendered.at(-1), [...WARM_PHRASES]);
        assert.ok(rendered.at(-1)!.includes(DISCLOSURE_CACHE_KEY), 'the disclosure is rendered at warm-up');

        startedAt = Date.now();
        assert.equal((await fetch(`http://127.0.0.1:${port}/health`, { method: 'HEAD' })).status, 200);
        assert.ok(Date.now() - startedAt < 150, 'warm: no wait');
        assert.equal(rendered.length, before + 1, 'warm: nothing rendered');
    });

    it('no backend named: no health hook, nothing started', () => {
        const session = selectSession({}, { cascade: async () => { throw new Error('must not start'); } });
        assert.equal(session.onHealth, undefined);
    });
});

describe('the mirrored disclosure', () => {
    it('is the mock\'s disclosure, which contract:derive checks against the backend', () => {
        const fixtures = JSON.parse(readFileSync(join(ROOT, 'src/mock/fixtures/scenarios.json'), 'utf8'));
        assert.equal(DISCLOSURE_CACHE_KEY, fixtures.default_context.disclosure_sentence);
        assert.deepEqual([...BACKEND_FIRST_SENTENCES], [DISCLOSURE_CACHE_KEY]);
        assert.deepEqual([...WARM_PHRASES], [DISCLOSURE_CACHE_KEY, ...FIXED_PHRASES]);
    });

    it('nothing in src/ but the warm-up imports it: a cache key, never spoken', () => {
        const importers: string[] = [];
        const walk = (dir: string): void => {
            for (const name of readdirSync(dir)) {
                const path = join(dir, name);
                if (statSync(path).isDirectory()) walk(path);
                else if (path.endsWith('.ts') && readFileSync(path, 'utf8').includes('warmSentences.ts')) {
                    importers.push(relative(ROOT, path).replaceAll('\\', '/'));
                }
            }
        };
        walk(join(ROOT, 'src'));
        assert.deepEqual(importers, ['src/server/main.ts']);
    });
});
