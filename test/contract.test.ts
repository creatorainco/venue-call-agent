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
    test('the twelve refusal reasons match, in the same set', () => {
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
    test('the one live divergence from the deployed backend is declared', () => {
        // TASK-968 left this list when the campaign rule shipped (2026-09-18) — it is a rule now,
        // `campaign_rule`, checked against the backend by `npm run contract:derive`.
        const ids = (contract.known_divergences as Array<{ id: string }>).map((d) => d.id).sort();
        assert.deepEqual(ids, ['TASK-972']);
    });
});

describe('the campaign rule: the mock does what the snapshot says the backend does', () => {
    // The backend keeps calls for an ALLOW-LIST of campaign statuses and refuses everything else.
    // These read the allow-list from the snapshot, not from a literal here, so the mock and the
    // contract cannot quietly disagree: flip `paused` out of `allowed` and the first test goes red.
    const rule = contract.campaign_rule as { allowed: string[]; case_insensitive: boolean; refusal: string };

    const outcome = async (scenario: string): Promise<'proceeds' | string> => {
        const mock = await startMockSeam({ port: 0 });
        try {
            const ctx = await createSeamClient({ baseUrl: mock.baseUrl, token: `mock:${scenario}` }).callContext();
            assert.ok(ctx.disclosure_sentence);
            return 'proceeds';
        } catch (e) {
            return String((e as { reason?: string }).reason ?? e);
        } finally {
            await mock.close();
        }
    };

    test('a paused campaign proceeds exactly when the snapshot allows paused', async () => {
        const expected = rule.allowed.includes('paused') ? 'proceeds' : rule.refusal;
        assert.equal(await outcome('campaign-paused'), expected,
            'a paused campaign\'s bookings still stand; refusing here would leave a venue unwarned about a guest who arrives anyway');
    });

    test('a closed campaign refuses exactly when the snapshot does not allow closed', async () => {
        const expected = rule.allowed.includes('closed') ? 'proceeds' : rule.refusal;
        assert.equal(await outcome('campaign-closed'), expected);
    });

    test('the rule itself: active and paused keep calls, case-insensitively, and the refusal is campaign_not_active', () => {
        assert.deepEqual([...rule.allowed].sort(), ['active', 'paused']);
        assert.equal(rule.case_insensitive, true);
        assert.equal(rule.refusal, 'campaign_not_active');
    });
});

describe('🔴 the fixture holds the same sentence three times, and nothing checked the copies agree', () => {
    // Found by a sabotage run against this repo: editing `disclosure_sentence` alone, and leaving
    // its two other verbatim copies inside `system_instruction` and `voicemail_script` untouched,
    // produced a COMPLETELY GREEN suite — 118/118 and 14/14. The harness reads whichever copy the
    // agent happens to speak, so one edited copy and two stale ones look like agreement.
    //
    // That is the hardcoded-literal failure this repository's own guard exists to prevent, arriving
    // through the data door: `src/mock/fixtures/` is skipped by check-no-facts by design, so
    // nothing else in the build is looking at these strings at all.
    const ctx = fixtures.default_context as {
        disclosure_sentence: string;
        opening_script: string[];
        voicemail_script: string;
        system_instruction: string;
    };

    test('the system instruction quotes the disclosure verbatim', () => {
        assert.ok(
            ctx.system_instruction.includes(ctx.disclosure_sentence),
            'the instruction lists the exact lines the model may say — an edited disclosure that is not ' +
            'also edited here means the model is told one thing while the harness grades another',
        );
    });

    test('the system instruction quotes all four opening beats verbatim', () => {
        assert.equal(ctx.opening_script.length, 4);
        for (const beat of ctx.opening_script) {
            assert.ok(
                ctx.system_instruction.includes(beat),
                `beat missing from the instruction: ${JSON.stringify(beat.slice(0, 60))}`,
            );
        }
    });

    test('the voicemail carries the same disclosure clause — a machine is told what a person is told', () => {
        // Not verbatim: the voicemail names the venue. So this pins the CLAUSE, not the sentence.
        const clause = 'this is an automated call from CreatoRain';
        assert.ok(ctx.disclosure_sentence.includes(clause));
        assert.ok(ctx.voicemail_script.includes(clause));
    });

    test('SABOTAGE CONTROL — a one-copy edit really would be caught now', () => {
        const edited = 'Hi, quick call from us about a booking.';
        assert.notEqual(edited, ctx.disclosure_sentence);
        assert.equal(
            ctx.system_instruction.includes(edited),
            false,
            'if this is true the three assertions above are vacuous',
        );
    });
});
