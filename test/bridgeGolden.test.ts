/**
 * The async speech bridge changed the interface, not the call. This file is the proof.
 *
 * `test/fixtures/golden/audio-calls.json` was captured on the commit BEFORE the bridge went async
 * (f52f9ba, TASK-3745 step 3's head), by running every recorded conversation as an audio call
 * three ways: at the pinned settings, with 900 ms of model latency, and with the far end hanging
 * up 7 s in. Each entry is the whole `ReplayResult` the rubric reads (less `elapsedMs`, which is
 * wall-clock time; the journal and the allowed sentences as digests) and the whole `AudioReport`.
 * The test re-runs the same calls and compares.
 *
 * 🔴 ITS SABOTAGE IS RUN BY HAND AND PASTED IN THE PR: drop one sentence id where call.ts hands a
 * turn to the bridge. This file must go red, because a sentence the bridge was never given is a
 * sentence the restaurant never heard, and every number downstream of it moves.
 *
 * REGENERATING IT IS A BEHAVIOUR CHANGE, and the commit that does it must say which call changed
 * and why: `WRITE_GOLDEN=1 node --test test/bridgeGolden.test.ts`. A golden refreshed to make a
 * red test green is a guard switched off.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { audioCall } from '../src/carrier/call.ts';
import type { AudioCallOptions } from '../src/carrier/call.ts';
import { loadFixtures } from '../src/harness/fixtures.ts';
import { agentFactory } from '../src/eval/run.ts';

const GOLDEN = fileURLToPath(new URL('./fixtures/golden/audio-calls.json', import.meta.url));

const VARIANTS: Array<{ name: string; options: AudioCallOptions }> = [
    { name: 'pinned', options: {} },
    { name: 'latency-900', options: { modelLatencyMs: 900 } },
    { name: 'hangup-7000', options: { hangUpAtMs: 7_000 } },
];

/** Every call, as the rubric and the audio grader see it. Keyed `<fixture>@<variant>`. */
async function capture(): Promise<Record<string, unknown>> {
    const make = agentFactory('stub');
    const out: Record<string, unknown> = {};
    for (const fixture of loadFixtures()) {
        for (const variant of VARIANTS) {
            const { replay, audio } = await audioCall(fixture, make, { ...variant.options, log: () => {} });
            out[`${fixture.name}@${variant.name}`] = {
                replay: {
                    fixture: fixture.name,
                    transcript: replay.transcript,
                    // Digests, not copies: the two are three quarters of the bytes and the same
                    // backend responses on every variant. A digest still fails on one changed byte.
                    allowedSentences: digest(replay.allowedSentences),
                    journal: digest(replay.journal),
                },
                audio,
            };
        }
    }
    // Through JSON, so `undefined` and key order compare the way the file stores them.
    return JSON.parse(JSON.stringify(out)) as Record<string, unknown>;
}

function digest(value: unknown): string {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

describe('the async bridge left every call byte-identical', () => {
    it('every recorded conversation, three ways, matches the golden captured before the change', async () => {
        const now = await capture();
        if (process.env.WRITE_GOLDEN === '1') {
            writeFileSync(GOLDEN, `${JSON.stringify(now, null, 1)}\n`);
            return;
        }
        const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, unknown>;
        assert.deepEqual(Object.keys(now).sort(), Object.keys(golden).sort(), 'a fixture or variant appeared or vanished');
        for (const key of Object.keys(golden)) {
            assert.deepEqual(now[key], golden[key], `${key} changed`);
        }
    });

    it('the golden covers the fifteen original conversations', () => {
        const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, unknown>;
        const names = new Set(Object.keys(golden).map((k) => k.split('@')[0]));
        for (const original of [
            'booking-cancelled', 'campaign-closed', 'credential-expires', 'phone-menu', 'plain',
            'stop-calling', 'they-hang-up', 'they-interrupt', 'two-questions-then-close',
            'unknown-question', 'voicemail', 'wants-to-cancel', 'who-pays-after-comp-clause',
            'who-pays', 'wrong-number',
        ]) {
            assert.ok(names.has(original), `${original} is not in the golden`);
        }
    });
});
