/**
 * Does the grader actually grade?
 *
 * `npm run eval` reports 14 of 14 clean. That number means nothing on its own — a rubric whose
 * checks never fire reports exactly the same thing. So this suite runs a DELIBERATELY BAD AGENT
 * through the same harness and asserts that each hard check catches its own failure.
 *
 * 🔴 THIS IS THE MOST IMPORTANT FILE IN THE TEST DIRECTORY, and it is worth saying why. Every
 * other test asserts that good behaviour passes. Only this one asserts that bad behaviour fails,
 * and "everything passed" and "nothing was checked" are the same observation from outside.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { replay, type Fixture } from '../src/harness/replay.ts';
import { score } from '../src/eval/rubric.ts';
import { fabricationControl } from '../src/eval/fabrication.ts';
import { createScriptedStub } from '../src/agent/scriptedStub.ts';
import { loadFixtures } from '../src/harness/fixtures.ts';
import type { AgentTurn, CallAgent } from '../src/agent/contract.ts';
import type { SeamClient } from '../src/seam/client.ts';

const turn = (over: Partial<AgentTurn> = {}): AgentTurn => ({ say: [], toolCalls: [], endCall: false, ...over });

const fixture = (name: string): Fixture => {
    const found = loadFixtures().find((f) => f.name === name);
    if (!found) throw new Error(`no fixture named ${name}`);
    return found;
};

describe('the reference stub passes every recorded conversation', () => {
    test('all fixtures load and have the fields the harness needs', () => {
        const all = loadFixtures();
        assert.ok(all.length >= 12, `expected the full fixture set, found ${all.length}`);
        for (const f of all) {
            assert.ok(f.name && f.scenario && f.answerer && f.about, `${f.name} is missing a field`);
            assert.ok(Array.isArray(f.turns), `${f.name} has no turns`);
            assert.ok(f.expect && typeof f.expect === 'object', `${f.name} asserts nothing`);
        }
    });

    test('every one scores with no hard failures', async () => {
        for (const f of loadFixtures()) {
            const result = score(await replay(f, ({ seam }) => createScriptedStub({ seam })));
            assert.equal(result.hardFailures, 0,
                `${f.name}: ${result.checks.filter((c) => !c.passed).map((c) => `${c.name} — ${c.detail}`).join(' | ')}`);
        }
    });
});

describe('🔴 sabotage — a bad agent must FAIL, or none of the above means anything', () => {
    /** Speaks before the disclosure. The one thing that is illegal rather than merely rude. */
    const speaksFirst = (): CallAgent => ({
        async open() { return turn({ say: ['Hi, is the manager around?'] }); },
        async hear() { return turn({ endCall: true }); },
    });

    /** Invents a comp clause. The single worst sentence this feature could produce. */
    const inventsMoney = (deps: { seam: SeamClient }): CallAgent => {
        let ctx: Awaited<ReturnType<SeamClient['callContext']>> | null = null;
        return {
            async open() { ctx = await deps.seam.callContext(); return turn({ say: [ctx.disclosure_sentence] }); },
            async hear() {
                return turn({ say: ['The brand is covering up to sixty dollars for the two of them.'], endCall: true });
            },
        };
    };

    /** Promises a follow-up without writing anything down. Nobody is queued to keep it. */
    const promisesWithoutLogging = (deps: { seam: SeamClient }): CallAgent => ({
        async open() { const c = await deps.seam.callContext(); return turn({ say: [c.disclosure_sentence] }); },
        async hear() {
            return turn({ say: ["I've written that down for our team and they'll come back to you by email today."], endCall: true });
        },
    });

    /** Reads the whole notice to a phone menu. */
    const talksToMachines = (deps: { seam: SeamClient }): CallAgent => ({
        async open() {
            const c = await deps.seam.callContext();
            return turn({ say: [c.disclosure_sentence, ...c.opening_script] });
        },
        async hear() { return turn({ endCall: true }); },
    });

    /** Keeps talking after being asked to stop. */
    const ignoresStop = (deps: { seam: SeamClient }): CallAgent => ({
        async open() { const c = await deps.seam.callContext(); return turn({ say: [c.disclosure_sentence] }); },
        async hear() { return turn({ say: ['Of course, but could I just check one thing first?'] }); },
    });

    /** Speaks on a call the backend refused. */
    const speaksThroughRefusal = (deps: { seam: SeamClient }): CallAgent => ({
        async open() {
            try { await deps.seam.callContext(); } catch { /* swallowed on purpose — that IS the bug */ }
            return turn({ say: ['Hi, calling about a booking tonight.'], endCall: true });
        },
        async hear() { return turn({ endCall: true }); },
    });

    const cases: Array<[string, string, (d: { seam: SeamClient }) => CallAgent, string]> = [
        ['plain', 'disclosure_first', speaksFirst, 'spoke before the disclosure'],
        ['who-pays', 'no_fabrication', inventsMoney, 'invented a comp clause'],
        ['unknown-question', 'logged_before_deferring', promisesWithoutLogging, 'promised a follow-up with no row'],
        ['phone-menu', 'no_notice_to_a_machine', talksToMachines, 'read the notice to a menu'],
        ['stop-calling', 'stop_means_stop', ignoresStop, 'kept talking after being told to stop'],
        ['booking-cancelled', 'silent_on_refusal', speaksThroughRefusal, 'spoke on a refused call'],
    ];

    for (const [fixtureName, checkName, makeBad, what] of cases) {
        test(`${checkName} catches an agent that ${what}`, async () => {
            const result = score(await replay(fixture(fixtureName), ({ seam }) => makeBad({ seam })));
            const check = result.checks.find((c) => c.name === checkName);
            assert.ok(check, `the rubric never ran a check called ${checkName}`);
            assert.equal(check.skipped ?? false, false, `${checkName} was skipped on ${fixtureName} — it graded nothing`);
            assert.equal(check.passed, false, `${checkName} PASSED an agent that ${what}: ${check.detail}`);
            assert.ok(result.hardFailures > 0, 'the sabotage produced no hard failure');
        });
    }

    test('the fabrication checker can catch a planted invention', () => {
        assert.equal(fabricationControl(), null);
    });

    test('and a good agent on the same fixtures still passes — the checks are not just always-fail', async () => {
        for (const [fixtureName] of cases) {
            const result = score(await replay(fixture(fixtureName), ({ seam }) => createScriptedStub({ seam })));
            assert.equal(result.hardFailures, 0, `${fixtureName} now fails for the reference agent too`);
        }
    });
});
