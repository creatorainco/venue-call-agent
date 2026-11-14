/**
 * THE KILL PATH, seen from this side of the seam (TASK-3750 slice 1a).
 *
 * The platform kill lives in platform-backend (TASK-3746: the `platform_feature_controls` kill
 * row, set by any staff login, cleared only by the operator). This service cannot read that row
 * and must not try to. What it sees is the consequence: once the kill is ON, every seam operation
 * refuses. So the property this file pins is narrow and absolute:
 *
 *   the moment the seam refuses, the agent stops talking, hangs up exactly once, writes nothing
 *   down a closed line, and asks the seam for nothing more.
 *
 * It is forced at every instant a call touches the seam, for every fixture, with both agents: a
 * kill that lands before the first word (no sentence is spoken at all) and a kill that lands in
 * the middle of a conversation (nothing is spoken after it).
 *
 * The refusal word is `seam_disabled` because that is what pb answers today when the seam is off
 * (`venueCall.service.ts` refuses `seam_disabled` when `VENUE_CALL_SECRET` is absent); the
 * property is checked for every refusal word, so whichever one the kill row maps to is covered.
 *
 * The stream-server edge (a refused token opens no session and sends no audio) is pinned in
 * `test/server.test.ts` § "the edge: the token and the backend". RUNBOOK.md § Kill points here.
 *
 * Sabotage control, recorded in the PR: make the `SeamRefusal` branch of `guard()` in
 * `src/carrier/call.ts` swallow the refusal and carry on (`return true` without ending), and
 * every case below goes red.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { audioCall } from '../src/carrier/call.ts';
import { agentFactory } from '../src/eval/run.ts';
import { loadFixtures } from '../src/harness/fixtures.ts';
import type { AgentFactory } from '../src/harness/replay.ts';
import { SeamRefusal, type SeamClient } from '../src/seam/client.ts';
import { SEAM_REFUSAL_REASONS, type SeamRefusalReason } from '../src/seam/types.ts';

interface KillSwitch {
    /** Seam operations that went through before the kill. */
    passed: number;
    /** Seam operations attempted after the kill landed. One is the refused call itself. */
    afterKill: number;
}

/**
 * A seam that answers normally for `killAfter` operations and then refuses every one, the way
 * pb behaves the instant somebody presses Kill mid-call.
 */
function killedAfter(make: AgentFactory, killAfter: number, reason: SeamRefusalReason, state: KillSwitch): AgentFactory {
    return ({ seam, fixture }) => {
        const gate = <T>(route: string, run: () => Promise<T>): Promise<T> => {
            if (state.passed < killAfter) {
                state.passed += 1;
                return run();
            }
            state.afterKill += 1;
            return Promise.reject(new SeamRefusal(reason, route));
        };
        const killable: SeamClient = {
            callContext: () => gate('/reservations/call-context', () => seam.callContext()),
            callFact: (topic) => gate('/reservations/call-fact', () => seam.callFact(topic)),
            callEvent: (input) => gate('/reservations/call-event', () => seam.callEvent(input)),
        };
        return make({ seam: killable, fixture });
    };
}

/** How many seam operations a fixture makes when nobody kills it. */
async function seamOpsOf(fixture: ReturnType<typeof loadFixtures>[number], make: AgentFactory): Promise<number> {
    const state: KillSwitch = { passed: 0, afterKill: 0 };
    await audioCall(fixture, killedAfter(make, Number.MAX_SAFE_INTEGER, 'seam_disabled', state));
    return state.passed;
}

async function assertKilledCleanly(
    fixture: ReturnType<typeof loadFixtures>[number],
    make: AgentFactory,
    killAfter: number,
    reason: SeamRefusalReason,
): Promise<void> {
    const state: KillSwitch = { passed: 0, afterKill: 0 };
    const { replay, audio } = await audioCall(fixture, killedAfter(make, killAfter, reason, state));
    const at = `${fixture.name}, kill after ${killAfter} seam op(s), ${reason}`;
    const t = replay.transcript;

    assert.equal(t.endedBecause, 'seam_refusal', `${at}: the call did not end on the refusal (${t.endedBecause})`);
    assert.equal(t.refusalReason, reason, `${at}: the refusal word was lost`);
    assert.equal(state.afterKill, 1, `${at}: ${state.afterKill} seam operations after the kill, expected only the refused one`);
    assert.equal(audio.hangupsSent, 1, `${at}: ${audio.hangupsSent} hangups sent, expected exactly one`);
    // Hung up BECAUSE of the kill, not later by some other way out (the far end, the cap).
    assert.equal(audio.endedBecause, 'seam_stopped', `${at}: the line closed as ${audio.endedBecause}, not on the kill`);
    assert.equal(audio.writtenAfterHangup, 0, `${at}: ${audio.writtenAfterHangup} frames written down a closed line`);

    const killLine = t.lines.findIndex((l) => l.who === 'system' && l.text === `seam refused: ${reason}`);
    assert.ok(killLine >= 0, `${at}: no refusal line in the transcript`);
    const spokenAfter = t.lines.slice(killLine + 1).filter((l) => l.who === 'agent');
    assert.deepEqual(spokenAfter, [], `${at}: the agent kept talking after the kill`);

    if (killAfter === 0) {
        assert.deepEqual(t.spoken, [], `${at}: a call killed before it started spoke`);
        assert.equal(audio.disclosureStarted, false, `${at}: a call killed before it started began the disclosure`);
        assert.equal(audio.audibleOutFrames, 0, `${at}: a call killed before it started sent audible audio`);
    }
}

const FIXTURES = loadFixtures();

describe('the kill path: a seam that starts refusing ends the call at once', () => {
    for (const agent of ['stub', 'cascade'] as const) {
        const make = agentFactory(agent);

        it(`🔴 ${agent}: killed before the first word, nothing is said, one hangup`, async () => {
            for (const fixture of FIXTURES) {
                await assertKilledCleanly(fixture, make, 0, 'seam_disabled');
            }
        });

        it(`🔴 ${agent}: killed at every seam operation of every fixture, nothing after it`, async () => {
            let midCallKills = 0;
            for (const fixture of FIXTURES) {
                const ops = await seamOpsOf(fixture, make);
                for (let k = 1; k < ops; k += 1) {
                    await assertKilledCleanly(fixture, make, k, 'seam_disabled');
                    midCallKills += 1;
                }
            }
            // A sweep that found no mid-call seam operation would pass while testing nothing.
            assert.ok(midCallKills >= 5, `only ${midCallKills} mid-call kill points across the fixtures`);
        });
    }

    it('every refusal word stops the call the same way, so the kill is covered whichever word pb maps it to', async () => {
        const make = agentFactory('stub');
        const fixture = FIXTURES.find((f) => f.expect.must_not_speak_at_all !== true);
        assert.ok(fixture, 'no fixture that speaks');
        const ops = await seamOpsOf(fixture, make);
        assert.ok(ops >= 2, `${fixture.name} makes ${ops} seam operation(s); pick a longer fixture`);
        for (const reason of SEAM_REFUSAL_REASONS) {
            await assertKilledCleanly(fixture, make, 1, reason);
        }
    });
});
