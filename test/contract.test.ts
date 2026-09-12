/**
 * Does this repository still agree with itself about what the backend looks like?
 *
 * There are three copies of the Seam 4 shapes in here — `contract/seam4.json` (the snapshot),
 * `src/seam/types.ts` (what the code compiles against) and `src/mock/fixtures/scenarios.json`
 * (what the tests run against). Three copies drift. This suite makes them drift LOUDLY.
 *
 * ⚠️ WHAT IT CANNOT DO, stated plainly so nobody reads a green run as more than it is: it cannot
 * see platform-backend. If the backend renames a field tomorrow, all three copies here will still
 * agree with each other and this suite will still pass. Catching THAT is `npm run contract:derive`,
 * pointed at a checkout of the backend, and it is a thing a person runs — not a thing CI knows.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
    ANSWERER_KINDS,
    CALLBACK_REASONS,
    EVENT_KINDS,
    FACT_TOPICS,
    SEAM_REFUSAL_REASONS,
} from '../src/seam/types.ts';
import { startMockSeam } from '../src/mock/server.ts';
import { createSeamClient } from '../src/seam/client.ts';

const read = (rel: string) =>
    JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8'));

const contract = read('../contract/seam4.json');
const fixtures = read('../src/mock/fixtures/scenarios.json');

describe('the snapshot and the types', () => {
    test('the eleven refusal reasons match, in the same set', () => {
        assert.deepEqual([...SEAM_REFUSAL_REASONS].sort(), [...contract.refusal.reasons].sort());
    });

    test('the eight fact topics match', () => {
        assert.deepEqual([...FACT_TOPICS].sort(), [...contract.fact_topics].sort());
    });

    test('the event vocabulary matches', () => {
        assert.deepEqual([...EVENT_KINDS].sort(), [...contract.event_kinds].sort());
        assert.deepEqual([...CALLBACK_REASONS].sort(), [...contract.callback_reasons].sort());
        assert.deepEqual([...ANSWERER_KINDS].sort(), [...contract.answerer_kinds].sort());
    });

    test('the snapshot says which backend commit it was read from', () => {
        // A contract with no provenance is folklore. If this ever goes blank, the file has stopped
        // being evidence and become a guess somebody wrote down.
        assert.match(contract.derived_from.commit, /^[0-9a-f]{7,40}$/);
        assert.match(contract.derived_from.read_on, /^\d{4}-\d{2}-\d{2}$/);
        assert.ok(contract.derived_from.files.length >= 3);
    });
});

describe('the mock and the snapshot', () => {
    test('the mock can answer every topic in the contract', () => {
        for (const topic of contract.fact_topics) {
            assert.ok(fixtures.default_facts[topic], `the mock has no answer for ${topic}`);
        }
    });

    test('every refusal reason in the contract is reachable through some scenario', () => {
        const reachable = new Set<string>();
        for (const scenario of Object.values(fixtures.scenarios) as Array<{ refuse?: Record<string, string> }>) {
            for (const reason of Object.values(scenario.refuse ?? {})) reachable.add(reason);
        }
        // unknown_topic is produced by the route rather than by a scenario, and the two token
        // scope failures need a real signing key to reproduce — named here rather than skipped
        // silently, because a quiet exclusion is how coverage claims stop being true.
        reachable.add('unknown_topic');
        const unreachable = (contract.refusal.reasons as string[])
            .filter((r) => !reachable.has(r))
            .filter((r) => r !== 'token_scope_mismatch' && r !== 'disclosure_unavailable');
        assert.deepEqual(unreachable, [], `no scenario produces: ${unreachable.join(', ')}`);
    });

    test('the mock context carries every field the contract lists, and no extra ones', async () => {
        const mock = await startMockSeam({ port: 0 });
        try {
            const ctx = await createSeamClient({ baseUrl: mock.baseUrl, token: 'mock:happy' }).callContext();
            assert.deepEqual(
                Object.keys(ctx).sort(),
                [...contract.routes[0].response_fields].sort(),
                'an extra field here is a field the agent might start depending on that the backend does not send',
            );
            for (const [parent, children] of Object.entries(contract.routes[0].nested_fields as Record<string, string[]>)) {
                assert.deepEqual(
                    Object.keys((ctx as unknown as Record<string, object>)[parent] ?? {}).sort(),
                    [...children].sort(),
                    `${parent} does not match the contract`,
                );
            }
        } finally {
            await mock.close();
        }
    });

    test('the script version the mock serves is the one the contract names', async () => {
        const mock = await startMockSeam({ port: 0 });
        try {
            const ctx = await createSeamClient({ baseUrl: mock.baseUrl, token: 'mock:happy' }).callContext();
            assert.equal(ctx.script_version, contract.script_version);
        } finally {
            await mock.close();
        }
    });
});

describe('the known divergences are written down, not remembered', () => {
    test('both live divergences from the deployed backend are declared', () => {
        const ids = (contract.known_divergences as Array<{ id: string }>).map((d) => d.id).sort();
        assert.deepEqual(ids, ['TASK-968', 'TASK-972']);
    });

    test('the paused-campaign bug is reachable by name, and is not the default', async () => {
        // The default must be the FIXED backend, because every remaining ticket is specified
        // against it. The bug still needs somewhere to live, so it is a scenario you ask for.
        const mock = await startMockSeam({ port: 0 });
        try {
            await assert.rejects(
                () => createSeamClient({ baseUrl: mock.baseUrl, token: 'mock:campaign-paused' }).callContext(),
                (e: unknown) => (e as { reason?: string }).reason === 'campaign_not_active',
            );
            const today = await createSeamClient({ baseUrl: mock.baseUrl, token: 'mock:campaign-paused-today' }).callContext();
            assert.ok(today.disclosure_sentence, 'the deployed backend lets a paused campaign through — that is TASK-968');
        } finally {
            await mock.close();
        }
    });
});
