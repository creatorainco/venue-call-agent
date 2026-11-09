/**
 * The call supervisor: every way out of a call hangs up, exactly once.
 *
 * 🔴 ONE SABOTAGE IS RUN AGAINST THIS FILE BY HAND AND PASTED IN THE PR: delete the hangup in
 * `CallSupervisor.run()`'s `finally`. The three whole-call tests the ticket names must go red —
 * an agent that throws on turn 2, a seam refusal on turn 2, and a call that reaches the cap — and
 * so must the sweep over every recorded conversation, because a call the far end ended is still
 * one our side has to hang up.
 *
 * "Turn 2" is the agent's second turn: `open()` is turn 1, the first `hear()` is turn 2.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CallSupervisor } from '../src/carrier/supervisor.ts';
import type { Hangable } from '../src/carrier/supervisor.ts';
import type { HangupReason } from '../src/carrier/leg.ts';
import { audioCall } from '../src/carrier/call.ts';
import { audioChecks } from '../src/carrier/checks.ts';
import { loadFixtures } from '../src/harness/fixtures.ts';
import { agentFactory } from '../src/eval/run.ts';
import type { AgentFactory } from '../src/harness/replay.ts';
import { SeamRefusal } from '../src/seam/client.ts';
import { MAX_CALL_SECONDS } from '../src/tuning/liveDefaults.ts';

/** A leg that records every hangup sent to it and lets a test end it from the far side. */
function recordingLeg(): Hangable & { sent: HangupReason[]; farEndHangsUp(): void } {
    const handlers: Array<(reason: HangupReason) => void> = [];
    let over = false;
    const end = (reason: HangupReason) => {
        if (over) return;
        over = true;
        for (const h of handlers) h(reason);
    };
    const sent: HangupReason[] = [];
    return {
        id: 'call-under-test',
        sent,
        on: (_event, handler) => { handlers.push(handler); },
        hangup: async (reason) => { sent.push(reason); end(reason); },
        farEndHangsUp: () => { end('far_end_hung_up'); },
    };
}

/** Something a restaurant said, planted in an error message. It must never reach a log line. */
const UTTERANCE = 'my cell is 555 0100, call me back';

/** The stub agent, failing on its second turn in the way `fail` says. */
function failsOnTurnTwo(fail: () => never): AgentFactory {
    const stub = agentFactory('stub');
    return (deps) => {
        const agent = stub(deps);
        return {
            open: () => agent.open(),
            hear: async () => fail(),
        };
    };
}

/** The stub's opening, then silence for ever: an agent that never ends the call. */
const neverEnds: AgentFactory = (deps) => {
    const agent = agentFactory('stub')(deps);
    return {
        open: () => agent.open(),
        hear: async () => ({ say: [], toolCalls: [], endCall: false }),
    };
};

const hardFailures = (audio: Parameters<typeof audioChecks>[0]) =>
    audioChecks(audio).filter((c) => c.severity === 'hard' && !c.passed).map((c) => c.id);

describe('CallSupervisor on its own', () => {
    it('an exception in the body is caught, logged redacted, and the line is hung up once', async () => {
        const leg = recordingLeg();
        const logs: string[] = [];
        const sup = new CallSupervisor(leg, { clock: () => 0, log: (line) => { logs.push(line); } });
        await sup.run(async () => { throw new TypeError(UTTERANCE); });
        assert.deepEqual(leg.sent, ['internal_error']);
        assert.equal(sup.failed, true);
        assert.deepEqual(logs, ['call-supervisor call-under-test internal_error TypeError']);
    });

    it('a body that stops and returns is hung up with its reason, once', async () => {
        const leg = recordingLeg();
        const sup = new CallSupervisor(leg, { clock: () => 0, log: () => {} });
        await sup.run(async () => { sup.stop('seam_stopped'); sup.stop('call_too_long'); });
        assert.deepEqual(leg.sent, ['seam_stopped'], 'the first reason wins');
        assert.equal(sup.failed, false);
    });

    it('a body that hangs up itself gets no second hangup from the finally', async () => {
        const leg = recordingLeg();
        const sup = new CallSupervisor(leg, { clock: () => 0, log: () => {} });
        await sup.run(async () => { await sup.hangup('agent_ended'); await sup.hangup('agent_ended'); });
        assert.deepEqual(leg.sent, ['agent_ended']);
    });

    it('a far-end hangup is still answered with one hangup of our own, under their reason', async () => {
        const leg = recordingLeg();
        const sup = new CallSupervisor(leg, { clock: () => 0, log: () => {} });
        await sup.run(async () => { leg.farEndHangsUp(); });
        assert.deepEqual(leg.sent, ['far_end_hung_up']);
    });

    it('a body that leaves a live line with no reason is closed anyway, and logged as the bug it is', async () => {
        const leg = recordingLeg();
        const logs: string[] = [];
        const sup = new CallSupervisor(leg, { clock: () => 0, log: (line) => { logs.push(line); } });
        await sup.run(async () => {});
        assert.deepEqual(leg.sent, ['internal_error']);
        assert.deepEqual(logs, ['call-supervisor call-under-test exited_without_reason']);
    });

    it('a 361 s clock is over the cap; the cap itself is too, and a millisecond under it is not', () => {
        let now = 361_000;
        const sup = new CallSupervisor(recordingLeg(), { clock: () => now, log: () => {} });
        assert.equal(MAX_CALL_SECONDS, 360, 'the cap moved; re-read these boundaries');
        assert.equal(sup.overCap(), true);
        now = MAX_CALL_SECONDS * 1000;
        assert.equal(sup.overCap(), true);
        now = MAX_CALL_SECONDS * 1000 - 1;
        assert.equal(sup.overCap(), false);
    });

    it('an error whose name is not an identifier is logged as Error, not copied', async () => {
        const leg = recordingLeg();
        const logs: string[] = [];
        const sup = new CallSupervisor(leg, { clock: () => 0, log: (line) => { logs.push(line); } });
        const error = new Error('x');
        error.name = UTTERANCE;
        await sup.run(async () => { throw error; });
        assert.deepEqual(logs, ['call-supervisor call-under-test internal_error Error']);
    });
});

describe('the supervisor inside a whole call', () => {
    it('an agent that throws on turn 2: one hangup, internal_error, and the error text is in no log', async () => {
        const fixture = loadFixtures('plain')[0];
        assert.ok(fixture);
        const logs: string[] = [];
        const { audio, replay } = await audioCall(
            fixture,
            failsOnTurnTwo(() => { throw new RangeError(UTTERANCE); }),
            { log: (line) => { logs.push(line); } },
        );
        assert.equal(audio.hangupsSent, 1, 'exactly one hangup');
        assert.equal(audio.endedBecause, 'internal_error');
        assert.equal(replay.transcript.endedBecause, 'internal_error');
        assert.equal(audio.writtenAfterHangup, 0);
        assert.deepEqual(hardFailures(audio), ['no_internal_error'], 'an internal error must grade as one');
        assert.deepEqual(logs, ['call-supervisor fake:plain internal_error RangeError']);
        for (const line of [...logs, ...replay.transcript.lines.map((l) => l.text)]) {
            assert.ok(!line.includes(UTTERANCE), `the error message leaked: ${line}`);
        }
    });

    it('a seam refusal on turn 2: one hangup, and the line does not stay open behind the break', async () => {
        const fixture = loadFixtures('plain')[0];
        assert.ok(fixture);
        const { audio, replay } = await audioCall(
            fixture,
            failsOnTurnTwo(() => { throw new SeamRefusal('venue_stopped', '/reservations/call-event'); }),
            { log: () => {} },
        );
        assert.equal(audio.hangupsSent, 1, 'exactly one hangup');
        assert.equal(audio.endedBecause, 'seam_stopped');
        assert.equal(replay.transcript.endedBecause, 'seam_refusal');
        assert.equal(replay.transcript.refusalReason, 'venue_stopped');
        assert.deepEqual(hardFailures(audio), []);
    });

    it('credential-expires, the recorded mid-call refusal, hangs up once', async () => {
        const fixture = loadFixtures('credential-expires')[0];
        assert.ok(fixture, 'the fixture is gone; no recorded call refuses mid-conversation');
        const { audio, replay } = await audioCall(fixture, agentFactory('stub'), { log: () => {} });
        assert.equal(replay.transcript.endedBecause, 'seam_refusal', 'the fixture no longer refuses');
        assert.equal(audio.hangupsSent, 1);
        assert.equal(audio.endedBecause, 'seam_stopped');
    });

    it('a call that reaches the cap: the supervisor hangs up at it, once, before the leg would', async () => {
        const fixture = loadFixtures('plain')[0];
        assert.ok(fixture);
        const { audio } = await audioCall(fixture, neverEnds, {
            // Far past the cap, so nothing but the cap can end this call.
            trailingSilenceMs: (MAX_CALL_SECONDS + 120) * 1000,
            log: () => {},
        });
        assert.equal(audio.endedBecause, 'call_too_long');
        assert.equal(audio.hangupsSent, 1, 'exactly one hangup');
        assert.equal(audio.callMs, MAX_CALL_SECONDS * 1000, 'stopped at the cap, not at the fake leg backstop');
        assert.equal(audio.writtenAfterHangup, 0);
    });

    it('every recorded conversation hangs up exactly once, however it ends', async () => {
        const make = agentFactory('stub');
        const fixtures = loadFixtures();
        assert.ok(fixtures.length >= 15);
        for (const fixture of fixtures) {
            const { audio } = await audioCall(fixture, make, { log: () => {} });
            assert.equal(audio.hangupsSent, 1, `${fixture.name}: ${audio.hangupsSent} hangup(s), ended ${audio.endedBecause}`);
            assert.notEqual(audio.endedBecause, 'internal_error', fixture.name);
        }
    });
});
