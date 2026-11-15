/**
 * The warm-up runs, and is retried, inside a request (PERF-A, I3P-04).
 *
 * On Cloud Run the CPU is throttled outside requests, so a boot warm-up can die
 * (`cascade_warm_failed TtsUnavailable`, dev log 2026-11-14). `createWarmer` retries on the next ask;
 * `selectSession` asks at boot, and its `onUpgrade` asks on every stream upgrade.
 *
 *   1. A failed warm-up is tried again on the next ask; once warm, an ask costs nothing.
 *   2. One warm-up at a time: asks while one runs share it.
 *   3. The upgrade hook asks the warmer; the silent default has no hook and starts nothing.
 *   4. `preconnect` sends one HEAD per googleapis.com origin, no token, and never throws.
 *
 * CONTROL: a warmer that never succeeds keeps logging failures and never reports warm.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createWarmer, noAgentSession, selectSession } from '../src/server/main.ts';
import type { CascadeRuntime } from '../src/agent/cascade.ts';
import { PRECONNECT_ORIGINS } from '../src/agent/cascade.ts';
import { preconnect } from '../src/speech/tts.ts';

function runtime(failures: number) {
    let calls = 0;
    let preconnects = 0;
    const rt = {
        tts: {
            requests: 0,
            synthesize: async () => Buffer.alloc(1),
            prerender: async () => {
                calls += 1;
                if (calls <= failures) throw Object.assign(new Error('x'), { name: 'TtsUnavailable' });
            },
        },
        speech: { recognizer: 'r', open: () => { throw new Error('unused'); } },
        intents: { classify: async () => ({ intent: 'unclear' as const, source: 'fallback' as const }) },
        preconnect: async () => { preconnects += 1; },
        agentFor: () => { throw new Error('unused'); },
    } as unknown as CascadeRuntime;
    return { rt, calls: () => calls, preconnects: () => preconnects };
}

describe('the warmer', () => {
    it('a failed boot warm-up is retried on the next ask, then asks are free', async () => {
        const fake = runtime(2);
        const lines: string[] = [];
        const warmer = createWarmer(Promise.resolve(fake.rt), (l) => lines.push(l), 1);
        await warmer.ensure();
        assert.equal(warmer.warm, false);
        await warmer.ensure();
        assert.equal(warmer.warm, false);
        await warmer.ensure();
        assert.equal(warmer.warm, true);
        await warmer.ensure();
        assert.equal(fake.calls(), 3, 'no warm-up once warm');
        assert.equal(fake.preconnects(), 3);
        assert.deepEqual(lines.map((l) => l.split(' ')[0]), ['cascade_warm_failed', 'cascade_warm_failed', 'cascade_warm']);
    });

    it('one ask tries WARM_ATTEMPTS times; concurrent asks share one run', async () => {
        const fake = runtime(1);
        const warmer = createWarmer(Promise.resolve(fake.rt), () => {}, 2);
        const a = warmer.ensure();
        const b = warmer.ensure();
        assert.equal(a, b);
        await a;
        assert.equal(warmer.warm, true);
        assert.equal(fake.calls(), 2);
    });

    it('a cascade that never starts: ensure resolves, nothing is warm, nothing throws', async () => {
        const failing = Promise.reject(new Error('no ADC'));
        failing.catch(() => {});
        const warmer = createWarmer(failing, () => {});
        await warmer.ensure();
        assert.equal(warmer.warm, false);
    });

    it('CONTROL: a warm-up that always fails never reports warm', async () => {
        const fake = runtime(Infinity);
        const warmer = createWarmer(Promise.resolve(fake.rt), () => {}, 2);
        for (let i = 0; i < 3; i++) await warmer.ensure();
        assert.equal(warmer.warm, false);
        assert.equal(fake.calls(), 6);
    });
});

describe('the session main.ts picks carries the upgrade hook', () => {
    it('a backend named: every upgrade asks the warmer, which retries a failed boot warm-up', async () => {
        const fake = runtime(2);
        const session = selectSession(
            { CREATORAIN_API_BASE_URL: 'https://datadev.creatorain.com' },
            { cascade: async () => fake.rt, log: () => {} },
        );
        assert.ok(session.onUpgrade);
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(fake.calls(), 2, 'the boot ask tried twice');
        session.onUpgrade!();
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(fake.calls(), 3, 'the upgrade asked again, inside the request');
        session.onUpgrade!();
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(fake.calls(), 3, 'warm now: the upgrade costs nothing');
    });

    it('no backend named: the silent default, no hook, nothing started', () => {
        let started = 0;
        const session = selectSession({}, { cascade: async () => { started += 1; throw new Error('must not start'); } });
        assert.equal(session.startCall, noAgentSession);
        assert.equal(session.onUpgrade, undefined);
        assert.equal(started, 0);
    });
});

describe('preconnect', () => {
    it('one HEAD per googleapis.com origin, no Authorization header, and it never throws', async () => {
        const seen: Array<{ url: string; method: string | undefined; auth: boolean }> = [];
        const fetchImpl = (async (url: string, init?: RequestInit) => {
            seen.push({ url, method: init?.method, auth: new Headers(init?.headers).has('authorization') });
            if (url.includes('aiplatform')) throw new Error('reset');
            return new Response(null, { status: 404 });
        }) as unknown as typeof fetch;
        await preconnect([...PRECONNECT_ORIGINS, 'https://example.com/'], fetchImpl);
        assert.deepEqual(seen.map((s) => s.url).sort(), [...PRECONNECT_ORIGINS].sort(), 'a foreign origin is never contacted');
        assert.ok(seen.every((s) => s.method === 'HEAD' && !s.auth));
    });
});
