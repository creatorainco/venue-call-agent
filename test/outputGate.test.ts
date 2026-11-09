/**
 * The output gate: the state machine, enforced on the wire.
 *
 * 🔴 TWO SABOTAGES ARE RUN AGAINST THIS FILE BY HAND AND PASTED IN THE PR, and each test below
 * names the one it answers to:
 *
 *   1. Revert the protected range — make `OutputGate.clear()` a plain `leg.clear()`. The
 *      `talks-over-disclosure-200ms` fixture must go red on `disclosure_heard_in_full`, and the
 *      unit test of a barge-in over the disclosure must go red with it. So must
 *      `talks-over-disclosure-then-hangs-up-late`: there the far end hangs up after the cleared
 *      disclosure has stopped playing, and that later hangup must not excuse it.
 *   2. Plant a write after `ended` — let `OutputGate.write()` pass a frame to the leg once the
 *      call is over. The "nothing after the end" tests must go red.
 *
 * Everything runs on the fake leg's virtual clock: one `advance()` is one 20 ms frame.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FakeCallLeg, isSilent, speechFrame } from '../src/carrier/fakeLeg.ts';
import { silentCarrierFrame } from '../src/audio/format.ts';
import type { TimelineTurn } from '../src/carrier/fakeLeg.ts';
import { spokenFrame } from '../src/carrier/bridge.ts';
import { OutputGate } from '../src/carrier/outputGate.ts';
import { audioCall, nextState } from '../src/carrier/call.ts';
import { audioChecks } from '../src/carrier/checks.ts';
import { loadFixtures } from '../src/harness/fixtures.ts';
import { agentFactory } from '../src/eval/run.ts';
import type { AgentTurn } from '../src/agent/contract.ts';

/** A leg with nobody speaking for a minute, unless a turn says otherwise. */
function quietLeg(turns: readonly TimelineTurn[] = []): FakeCallLeg {
    return new FakeCallLeg({ turns, trailingSilenceMs: 60_000 });
}

function gateOn(leg: FakeCallLeg, logs: string[] = []): OutputGate {
    return new OutputGate(leg, { isSpeech: (f) => !isSilent(f), log: (line) => { logs.push(line); } });
}

/** Open the gate and put `frames` of disclosure audio on the wire as the protected range. */
function disclose(gate: OutputGate, frames: number): void {
    gate.connect();
    gate.beginDisclosure();
    for (let i = 0; i < frames; i += 1) gate.write(spokenFrame(i));
    gate.endDisclosure();
}

function run(leg: FakeCallLeg, frames: number): void {
    for (let i = 0; i < frames && leg.advance(); i += 1) { /* call time passes */ }
}

const turn = (over: Partial<AgentTurn> = {}): AgentTurn => ({ say: [], toolCalls: [], endCall: false, ...over });

describe('the carrier mark on the fake leg', () => {
    it('fires in the frame the audio before it finishes playing, and not before', () => {
        const leg = quietLeg();
        const marks: string[] = [];
        leg.on('marked', (name) => { marks.push(name); });
        for (let i = 0; i < 5; i += 1) leg.write(spokenFrame(i));
        leg.mark('m');
        run(leg, 4);
        assert.deepEqual(marks, [], 'the mark fired with audio still queued in front of it');
        run(leg, 1);
        assert.deepEqual(marks, ['m']);
        assert.deepEqual(leg.marksReached, [{ name: 'm', at: 4 }]);
    });

    it('a mark thrown away by clear() never fires — a cleared disclosure was not heard', () => {
        const leg = quietLeg();
        const marks: string[] = [];
        leg.on('marked', (name) => { marks.push(name); });
        for (let i = 0; i < 5; i += 1) leg.write(spokenFrame(i));
        leg.mark('m');
        run(leg, 2);
        leg.clear();
        run(leg, 20);
        assert.deepEqual(marks, []);
        assert.deepEqual(leg.marksCleared, ['m']);
    });

    it('a mark pending when the far end hangs up never fires', () => {
        const leg = new FakeCallLeg({ turns: [], trailingSilenceMs: 60_000, hangUpAtMs: 60 });
        const marks: string[] = [];
        leg.on('marked', (name) => { marks.push(name); });
        for (let i = 0; i < 10; i += 1) leg.write(spokenFrame(i));
        leg.mark('m');
        run(leg, 20);
        assert.ok(leg.ended);
        assert.deepEqual(marks, []);
    });

    it('a mark on an empty queue fires on the next frame', () => {
        const leg = quietLeg();
        const marks: string[] = [];
        leg.on('marked', (name) => { marks.push(name); });
        leg.mark('now');
        run(leg, 1);
        assert.deepEqual(marks, ['now']);
    });
});

describe('nothing before the disclosure', () => {
    it('a write while idle or connected throws, and nothing reaches the leg', () => {
        const leg = quietLeg();
        const gate = gateOn(leg);
        assert.throws(() => gate.write(spokenFrame(0)), /no audio may leave before the disclosure/);
        gate.connect();
        assert.throws(() => gate.write(spokenFrame(0)), /no audio may leave before the disclosure/);
        assert.equal(leg.queuedFrames(), 0);
    });

    it('the gate refuses every move the machine refuses', () => {
        const gate = gateOn(quietLeg());
        assert.throws(() => gate.enter('notice'), /idle -> notice is not a legal move/);
        gate.connect();
        assert.throws(() => gate.enter('notice'), /connected -> notice is not a legal move/);
        assert.throws(() => gate.enter('disclosing'), /beginDisclosure/);
        gate.beginDisclosure();
        gate.endDisclosure();
        gate.enter('voicemail');
        assert.throws(() => gate.enter('notice'), /voicemail -> notice is not a legal move/);
    });

    it('a hangup ends the call from ANY state, including one that never spoke', () => {
        const gate = gateOn(quietLeg());
        gate.connect();
        gate.end();
        assert.equal(gate.state, 'ended');
    });
});

describe('nothing after the end (sabotage 2)', () => {
    it('a write after ended is dropped, counted and logged — and never reaches the leg', () => {
        const leg = quietLeg();
        const logs: string[] = [];
        const gate = gateOn(leg, logs);
        disclose(gate, 3);
        run(leg, 4);
        gate.end();
        // The leg is still up; only the gate knows the call is over. Exactly the case a leg's
        // own after-hangup counter cannot see.
        assert.equal(leg.ended, false);
        assert.doesNotThrow(() => gate.write(spokenFrame(9)));
        gate.write(spokenFrame(10));
        assert.equal(leg.queuedFrames(), 0, 'a frame written after the end reached the leg');
        assert.equal(gate.disclosure().droppedAfterEnd, 2);
        assert.deepEqual(logs, ['output-gate fake-leg write_after_end'], 'logged once per call, id and kind only');
    });

    it('a far-end hangup ends the gate, so the next write is dropped too', () => {
        const leg = new FakeCallLeg({ turns: [], trailingSilenceMs: 60_000, hangUpAtMs: 40 });
        const gate = gateOn(leg);
        disclose(gate, 5);
        run(leg, 10);
        assert.equal(gate.state, 'ended');
        gate.write(spokenFrame(0));
        assert.equal(gate.disclosure().droppedAfterEnd, 1);
        assert.equal(leg.writtenAfterHangup, 0, 'the frame got past the gate to the dead leg');
    });
});

describe('the disclosure cannot be interrupted (sabotage 1)', () => {
    it('a barge-in during the disclosure drops only what follows it', () => {
        const leg = quietLeg();
        const gate = gateOn(leg);
        disclose(gate, 50);
        for (let i = 0; i < 30; i += 1) gate.write(spokenFrame(100 + i));   // the reply, held
        assert.equal(leg.queuedFrames(), 50, 'audio behind an unacknowledged disclosure reached the leg');
        assert.equal(gate.queuedFrames(), 80);

        run(leg, 10);
        gate.clear();   // somebody said "hello?"

        assert.equal(gate.queuedFrames(), 40, 'the barge-in threw away disclosure audio');
        assert.equal(gate.disclosure().heldCleared, 30);
        run(leg, 60);
        const d = gate.disclosure();
        assert.equal(d.heard, true, 'the disclosure did not play to its mark');
        assert.equal(leg.cleared, 0, 'the leg was cleared while the disclosure was on it');
        assert.equal(leg.outbound.filter((f) => f.audible).length, 50, 'exactly the disclosure played');
    });

    it('once the mark is back, a barge-in is the ordinary clear again', () => {
        const leg = quietLeg();
        const gate = gateOn(leg);
        disclose(gate, 5);
        run(leg, 5);
        assert.equal(gate.disclosure().heard, true);
        for (let i = 0; i < 30; i += 1) gate.write(spokenFrame(i));
        run(leg, 3);
        gate.clear();
        assert.equal(gate.queuedFrames(), 0);
        assert.equal(leg.cleared, 27);
    });

    it('held audio is released at the mark and plays straight after the disclosure, no gap', () => {
        const leg = quietLeg();
        const gate = gateOn(leg);
        disclose(gate, 20);
        for (let i = 0; i < 10; i += 1) gate.write(spokenFrame(100 + i));
        run(leg, 40);
        const audibleAt = leg.outbound.filter((f) => f.audible).map((f) => f.at);
        assert.deepEqual(audibleAt, Array.from({ length: 30 }, (_, i) => i));
    });

    it('the far end hanging up mid-disclosure leaves it NOT heard — reported, not assumed', () => {
        const leg = new FakeCallLeg({ turns: [], trailingSilenceMs: 60_000, hangUpAtMs: 200 });
        const gate = gateOn(leg);
        disclose(gate, 50);
        run(leg, 100);
        const d = gate.disclosure();
        assert.equal(d.started, true);
        assert.equal(d.heard, false);
        assert.equal(d.cutByHangup, true, 'the hangup came while the disclosure was still playing');
    });

    it('a hangup after the disclosure stopped playing excuses nothing', () => {
        // Something below the gate threw the disclosure away (a bug, or a carrier clear). The gate
        // fails closed, the line goes quiet, and the far end hangs up into the silence.
        const leg = new FakeCallLeg({ turns: [], trailingSilenceMs: 60_000, hangUpAtMs: 600 });
        const gate = gateOn(leg);
        disclose(gate, 10);
        gate.write(spokenFrame(99));
        run(leg, 3);
        leg.clear();
        run(leg, 100);
        assert.ok(leg.ended);
        const d = gate.disclosure();
        assert.equal(d.heard, false);
        assert.equal(gate.disclosurePending, true, 'the cleared mark fired, so this tests nothing');
        assert.equal(d.cutByHangup, false, 'a late hangup excused a disclosure that had stopped playing');
    });

    it('a hangup after the disclosure was heard is not a cut', () => {
        const leg = new FakeCallLeg({ turns: [], trailingSilenceMs: 60_000, hangUpAtMs: 600 });
        const gate = gateOn(leg);
        disclose(gate, 10);
        run(leg, 100);
        assert.equal(gate.disclosure().heard, true);
        assert.equal(gate.disclosure().cutByHangup, false);
    });

    it('a mark held behind the disclosure is thrown away with the audio it marks', () => {
        const leg = quietLeg();
        const gate = gateOn(leg);
        const fired: string[] = [];
        leg.on('marked', (name) => { fired.push(name); });
        disclose(gate, 10);
        for (let i = 0; i < 5; i += 1) gate.write(spokenFrame(100 + i));
        gate.mark('reply');
        run(leg, 3);
        gate.clear();
        run(leg, 50);
        assert.equal(gate.disclosure().heard, true);
        assert.deepEqual(fired, ['disclosure:1'], 'a mark whose audio was cleared fired on release');
    });

    it('only the latest range\'s own mark releases it', () => {
        const leg = quietLeg();
        const gate = gateOn(leg);
        const fired: string[] = [];
        leg.on('marked', (name) => { fired.push(name); });
        // A stranger's mark on the empty queue, ahead of the disclosure: it fires on frame 0,
        // while the disclosure is still playing, and must not release it.
        leg.mark('disclosure:0');
        disclose(gate, 10);
        gate.write(spokenFrame(99));
        run(leg, 5);
        assert.deepEqual(fired, ['disclosure:0'], 'the foreign mark never fired, so this tests nothing');
        assert.equal(gate.disclosurePending, true, 'a foreign mark released the disclosure');
        run(leg, 10);
        assert.equal(gate.disclosurePending, false);
    });
});

describe('one replay when the disclosure was talked over', () => {
    /** The far end talks from the first frame for `ms`, over a 50-frame (1 s) disclosure. */
    function talkedOver(ms: number) {
        const leg = quietLeg([{ text: 'hello?', segmentsMs: [ms], startWhen: { atMs: 0 } }]);
        const gate = gateOn(leg);
        const replays: number[] = [];
        gate.onReplay((frames) => { replays.push(frames); });
        disclose(gate, 50);
        for (let i = 0; i < 10; i += 1) gate.write(spokenFrame(200 + i));
        run(leg, 200);
        return { leg, gate, replays };
    }

    it('more than half talked over: the range plays once more, then the held reply', () => {
        const { leg, gate, replays } = talkedOver(800);
        assert.deepEqual(replays, [50]);
        assert.equal(gate.disclosure().replays, 1);
        assert.equal(gate.disclosure().heard, true);
        assert.equal(leg.marksReached.map((m) => m.name).join(','), 'disclosure:1,disclosure:2');
        assert.equal(leg.outbound.filter((f) => f.audible).length, 110, 'disclosure twice, then the reply');
    });

    it('less than half talked over: no replay', () => {
        const { replays, gate } = talkedOver(300);
        assert.deepEqual(replays, []);
        assert.equal(gate.disclosure().heard, true);
    });

    it('never more than once, however long they talk', () => {
        const { replays, gate } = talkedOver(3_000);
        assert.deepEqual(replays, [50]);
        assert.equal(gate.disclosure().replays, 1);
    });

    it('leading silence (model latency) is not the disclosure: not replayed, not counted', () => {
        // They talk for 400 ms (20 frames) during 20 frames of leading silence, then stop. Of the
        // 30-frame disclosure itself nothing is talked over. Counting the silence into the range
        // made that 20 of 50 talked over, and replayed audio nobody had talked over.
        const leg = quietLeg([{ text: 'hello?', segmentsMs: [400], startWhen: { atMs: 0 } }]);
        const gate = gateOn(leg);
        const replays: number[] = [];
        gate.onReplay((frames) => { replays.push(frames); });
        gate.connect();
        gate.beginDisclosure();
        for (let i = 0; i < 20; i += 1) gate.write(silentCarrierFrame());
        for (let i = 0; i < 30; i += 1) gate.write(spokenFrame(i));
        gate.endDisclosure();
        run(leg, 100);
        const d = gate.disclosure();
        assert.deepEqual(replays, [], 'talk over the leading silence replayed the disclosure');
        assert.equal(d.heard, true);
        assert.deepEqual([...d.protectedFrames], Array.from({ length: 30 }, (_, i) => 20 + i));
    });

    it('a replay after leading silence plays the disclosure only, not the silence again', () => {
        const leg = quietLeg([{ text: 'hello?', segmentsMs: [1_200], startWhen: { atMs: 400 } }]);
        const gate = gateOn(leg);
        const replays: number[] = [];
        gate.onReplay((frames) => { replays.push(frames); });
        gate.connect();
        gate.beginDisclosure();
        for (let i = 0; i < 20; i += 1) gate.write(silentCarrierFrame());
        for (let i = 0; i < 30; i += 1) gate.write(spokenFrame(i));
        gate.endDisclosure();
        run(leg, 200);
        assert.deepEqual(replays, [30]);
        // 20 silent, 30 disclosure, then the 30-frame replay straight after: no second silence.
        const audibleAt = leg.outbound.filter((f) => f.audible).map((f) => f.at);
        assert.deepEqual(audibleAt, Array.from({ length: 60 }, (_, i) => 20 + i));
    });
});

describe('the gate inside a whole call', () => {
    it('talks-over-disclosure-200ms: they talk over it, it plays in full, the call is clean', async () => {
        const fixture = loadFixtures('talks-over-disclosure-200ms')[0];
        assert.ok(fixture, 'the fixture is gone; a barge-in over the disclosure is ungraded again');
        assert.deepEqual(fixture.audio?.interruptTurns, [0]);
        assert.equal(fixture.audio?.gapMs, 200);

        const { audio, replay } = await audioCall(fixture, agentFactory('stub'));
        assert.ok(audio.disclosureTalkOverFrames > 0, 'nobody talked over the disclosure; the fixture tests nothing');
        assert.equal(audio.disclosureHeard, true, 'disclosure heard in full');
        const check = audioChecks(audio).find((c) => c.id === 'disclosure_heard_in_full');
        assert.equal(check?.passed, true, check?.detail);
        assert.deepEqual(audioChecks(audio).filter((c) => c.severity === 'hard' && !c.passed).map((c) => c.id), []);
        assert.equal(audio.writtenAfterHangup, 0);
        assert.equal(replay.transcript.spoken[0], replay.allowedSentences[0], 'the disclosure was not said first');
    });

    it('hangs-up-mid-disclosure: disclosure_heard=false, and that is not a hard failure', async () => {
        const fixture = loadFixtures('hangs-up-mid-disclosure')[0];
        assert.ok(fixture);
        const { audio } = await audioCall(fixture, agentFactory('stub'));
        assert.equal(audio.endedBecause, 'far_end_hung_up');
        assert.equal(audio.disclosureStarted, true);
        assert.equal(audio.disclosureHeard, false);
        const check = audioChecks(audio).find((c) => c.id === 'disclosure_heard_in_full');
        assert.equal(audio.disclosureCutByHangup, true);
        assert.equal(check?.passed, true);
        assert.match(check?.detail ?? '', /disclosure_heard=false/);
    });

    it('talks-over-disclosure-then-hangs-up-late: heard in full, and the late hangup is no excuse', async () => {
        const fixture = loadFixtures('talks-over-disclosure-then-hangs-up-late')[0];
        assert.ok(fixture, 'the fixture is gone; a late hangup can excuse a cleared disclosure again');
        const { audio } = await audioCall(fixture, agentFactory('stub'));
        assert.equal(audio.endedBecause, 'far_end_hung_up', 'the far end did not hang up; the fixture tests nothing');
        assert.ok(audio.disclosureTalkOverFrames > 0, 'nobody talked over the disclosure');
        assert.equal(audio.disclosureHeard, true);
        assert.equal(audio.disclosureCutByHangup, false, 'the hangup landed inside the disclosure, not after it');
        assert.deepEqual(audioChecks(audio).filter((c) => c.severity === 'hard' && !c.passed).map((c) => c.id), []);
    });

    it('talks-over-most-of-disclosure: replayed once in a whole call, and the transcript still holds', async () => {
        const fixture = loadFixtures('talks-over-most-of-disclosure')[0];
        assert.ok(fixture, 'the fixture is gone; no whole call exercises the replay');
        const { audio, replay } = await audioCall(fixture, agentFactory('stub'));
        assert.equal(audio.disclosureReplays, 1);
        assert.equal(audio.disclosureHeard, true);
        assert.equal(audio.unheardSentences, 0, 'the replay threw the bridge accounting off (bridge.delay)');
        assert.equal(audio.cutShortSentences, 0);
        assert.deepEqual(audioChecks(audio).filter((c) => !c.passed).map((c) => c.id), []);
        assert.equal(replay.transcript.spoken.filter((s) => s === replay.allowedSentences[0]).length, 1,
            'the replay was filed as a second thing the agent said');
    });

    it('the latency pad stays out of the protected range', async () => {
        const fixture = loadFixtures('talks-over-disclosure-200ms')[0];
        assert.ok(fixture);
        const bare = (await audioCall(fixture, agentFactory('stub'))).audio;
        const slow = (await audioCall(fixture, agentFactory('stub'), { modelLatencyMs: 900 })).audio;
        assert.equal(slow.disclosureReplays, 0);
        assert.equal(slow.disclosureHeard, true);
        assert.equal(slow.disclosureTalkOverFrames, bare.disclosureTalkOverFrames);
    });

    it('every recorded conversation hears its disclosure in full, unless they hang up during it', async () => {
        const make = agentFactory('stub');
        for (const fixture of loadFixtures()) {
            const { audio } = await audioCall(fixture, make);
            if (!audio.disclosureStarted) continue;   // refused before it spoke
            assert.ok(
                audio.disclosureHeard || audio.disclosureCutByHangup,
                `${fixture.name}: the disclosure was not heard and the far end did not leave during it`,
            );
        }
    });
});

describe('the state the call loop asks the gate for', () => {
    it('is read off what a turn did, never off its words', () => {
        const report = (answerer: 'voicemail' | 'phone_menu' | 'wrong_number') =>
            turn({ say: ['x'], toolCalls: [{ name: 'report_answerer', args: { answerer } }] });
        assert.equal(nextState('disclosing', report('voicemail')), 'voicemail');
        assert.equal(nextState('disclosing', report('phone_menu')), 'menu');
        assert.equal(nextState('disclosing', report('wrong_number')), 'disclosing');
        assert.equal(nextState('disclosing', turn({ say: ['x'] })), 'notice');
        assert.equal(nextState('notice', turn({ say: ['x'] })), 'qa');
        assert.equal(nextState('qa', turn({ say: ['x'], endCall: true })), 'closing');
        assert.equal(nextState('menu', turn({ say: ['x'] })), 'menu');
    });

    it('never asks for a move the machine forbids', () => {
        // A voicemail reported after the notice is a misreading; the call stays where it is.
        const late = turn({ toolCalls: [{ name: 'report_answerer', args: { answerer: 'voicemail' } }] });
        assert.equal(nextState('notice', late), 'notice');
        assert.equal(nextState('ended', turn({ say: ['x'] })), 'ended');
        assert.equal(nextState('connected', turn({ say: ['x'] })), 'connected');
    });
});
