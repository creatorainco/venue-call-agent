/**
 * The async `SpeechBridge`: turns are events, a `speak()` resolves once what was heard is known,
 * and a bridge that fails ends the call through the supervisor.
 *
 * 🔴 TWO SABOTAGES ARE RUN BY HAND AND PASTED IN THE PR, on top of the in-file controls:
 *   - delete `throwIfBridgeFailed()` from the loop in src/carrier/call.ts: "a bridge that fails
 *     mid-call" must go red (the call runs on with a dead recogniser and ends agent_ended);
 *   - make `ScriptedBridge.payOwed` report every sentence as heard in full: "a SpokenResult and the
 *     report agree" must go red on they-interrupt, and so must test/bridgeGolden.test.ts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FakeCallLeg } from '../src/carrier/fakeLeg.ts';
import { ScriptedBridge, sentenceDurationMs } from '../src/carrier/bridge.ts';
import type { CallerTurn, ScriptedBridgeOptions, SpokenResult } from '../src/carrier/bridge.ts';
import type { CallLeg } from '../src/carrier/leg.ts';
import { audioCall } from '../src/carrier/call.ts';
import { audioChecks } from '../src/carrier/checks.ts';
import { CARRIER_AUDIO } from '../src/audio/format.ts';
import { VAD } from '../src/tuning/liveDefaults.ts';
import { loadFixtures } from '../src/harness/fixtures.ts';
import { agentFactory } from '../src/eval/run.ts';

const LONG = 'This is a deliberately long sentence so that the outbound queue is deep enough for an interruption to matter at all.';
const SHORT = 'A short one.';

/** Full length of a sentence as the scripted bridge renders it, in whole frames. */
const fullMs = (text: string) => Math.ceil(sentenceDurationMs(text) / CARRIER_AUDIO.frameMs) * CARRIER_AUDIO.frameMs;

/** A leg and a bridge wired the way the call loop wires them, with every turn recorded. */
function rig(options: { interrupt?: boolean; hangUpAtMs?: number; turnAtMs?: number } = {}) {
    const leg = new FakeCallLeg({
        turns: [{
            text: 'no wait',
            segmentsMs: [800],
            ...(options.interrupt ? { startWhen: 'interrupt' as const, gapMs: 400 } : {}),
            ...(options.turnAtMs === undefined ? {} : { startWhen: { atMs: options.turnAtMs } }),
        }],
        trailingSilenceMs: 2_000,
        ...(options.hangUpAtMs === undefined ? {} : { hangUpAtMs: options.hangUpAtMs }),
    });
    const bridge = new ScriptedBridge(leg, { vad: VAD, script: ['no wait'] });
    const turns: CallerTurn[] = [];
    bridge.on('callerTurn', (turn) => { turns.push(turn); });
    leg.on('inbound', (frame) => { bridge.sendAudio(frame); });
    return { leg, bridge, turns };
}

describe('SpeechBridge, the scripted implementation', () => {
    it('a turn arrives as a callerTurn event, not as a return value', () => {
        const { leg, turns } = rig({ turnAtMs: 200 });
        while (leg.advance()) { /* run it out */ }
        assert.equal(turns.length, 1);
        assert.equal(turns[0]!.text, 'no wait');
        assert.ok(turns[0]!.detectedFrame >= turns[0]!.lastAudibleFrame);
    });

    it('speak() resolves once the audio has played, naming every sentence in order, in full', async () => {
        const { leg, bridge } = rig({ turnAtMs: 60_000 });
        let result: SpokenResult | null = null;
        void bridge.speak([{ id: 'a', text: SHORT }, { id: 'b', text: LONG }]).then((r) => { result = r; });
        await Promise.resolve();
        assert.equal(result, null, 'resolved before a single frame played');
        while (leg.advance() && result === null) await Promise.resolve();
        assert.ok(result, 'never resolved although nothing interrupted it');
        const r = result as SpokenResult;
        assert.deepEqual(r.sentences.map((s) => s.id), ['a', 'b']);
        assert.deepEqual(r.sentences.map((s) => s.heardMs), [fullMs(SHORT), fullMs(LONG)]);
        assert.equal(r.complete, true);
    });

    it('an interrupt resolves the sentence it cut, short, and agrees with heard()', async () => {
        const { leg, bridge } = rig({ interrupt: true });
        const pending = bridge.speak([{ id: 'long', text: LONG }, { id: 'never', text: SHORT }]);
        while (leg.advance()) { /* run it out */ }
        await bridge.hangup();
        const r = await pending;
        assert.equal(r.complete, false);
        const [cut, never] = r.sentences;
        assert.equal(cut!.id, 'long');
        assert.ok(cut!.heardMs > 0 && cut!.heardMs < cut!.fullMs, `heard ${cut!.heardMs} of ${cut!.fullMs}`);
        assert.equal(never!.heardMs, 0, 'a sentence queued behind the cut one played anyway');
        assert.deepEqual(
            r.sentences.map((s) => [s.text, s.heardMs, s.fullMs]),
            bridge.heard().map((h) => [h.sentence, h.heardMs, h.fullMs]),
        );
    });

    it('hangup() settles what was still owed, is idempotent, and nothing speaks after it', async () => {
        const { leg, bridge } = rig({ turnAtMs: 60_000 });
        const pending = bridge.speak([{ id: 'a', text: LONG }]);
        for (let i = 0; i < 10; i += 1) leg.advance();
        await bridge.hangup();
        await bridge.hangup();
        const r = await pending;
        assert.equal(r.sentences[0]!.heardMs, 10 * CARRIER_AUDIO.frameMs, 'ten frames played, ten were credited');

        const queued = leg.queuedFrames();
        const after = await bridge.speak([{ id: 'b', text: SHORT }]);
        assert.equal(leg.queuedFrames(), queued, 'a speak() after hangup() reached the leg');
        assert.deepEqual(after.sentences.map((s) => s.heardMs), [0]);
        assert.equal(after.complete, false);
    });

    it('hangup() flushes an open turn while the line is up, and never into a closed line', async () => {
        // They are mid-turn when we stop: the line is up, so the recogniser's last word is emitted.
        const up = rig({ turnAtMs: 200 });
        for (let i = 0; i < 40; i += 1) up.leg.advance();
        assert.equal(up.turns.length, 0, 'the turn ended before the test stopped it');
        await up.bridge.hangup();
        assert.equal(up.turns.length, 1);
        assert.equal(up.bridge.detectedTurns, 1);

        // Control: the far end hangs up mid-turn. Nobody is left to answer, so nothing is emitted.
        const down = rig({ turnAtMs: 200, hangUpAtMs: 800 });
        while (down.leg.advance()) { /* until they hang up */ }
        await down.bridge.hangup();
        assert.equal(down.turns.length, 0, 'a turn was flushed into a line the far end had left');
        assert.equal(down.bridge.detectedTurns, 0);
    });

    it('speak() refuses a sentence with no id, or a used one, before any audio is queued', () => {
        const { leg, bridge } = rig();
        void bridge.speak([{ id: 'a', text: SHORT }]);
        const queued = leg.queuedFrames();
        assert.throws(() => bridge.speak([{ id: '', text: SHORT }]), /sentence id "" is empty or already used/);
        assert.throws(() => bridge.speak([{ id: 'b', text: SHORT }, { id: 'a', text: SHORT }]), /"a" is empty or already used/);
        assert.equal(leg.queuedFrames(), queued);
    });

    it('an error with a listener is delivered; with none it is thrown, not swallowed', () => {
        class Breaks extends ScriptedBridge {
            fail(error: Error): void { this.emit('error', error); }
        }
        const leg = new FakeCallLeg({ turns: [] });
        const unheard = new Breaks(leg, { vad: VAD, script: [] });
        assert.throws(() => unheard.fail(new Error('stt closed')), /stt closed/);

        const heard = new Breaks(leg, { vad: VAD, script: [] });
        const got: Error[] = [];
        heard.on('error', (error) => { got.push(error); });
        heard.fail(new Error('stt closed'));
        assert.equal(got.length, 1);
    });
});

/** Something a restaurant said, planted in a bridge error. It must never reach a log or a line. */
const UTTERANCE = 'my cell is 555 0100, call me back';

/** A scripted bridge whose recogniser dies on the given inbound frame. */
function failsAtFrame(at: number, emitted: { count: number }) {
    return (leg: CallLeg, options: ScriptedBridgeOptions): ScriptedBridge => {
        let frames = 0;
        class DiesMidCall extends ScriptedBridge {
            override sendAudio(frame: Uint8Array): void {
                super.sendAudio(frame);
                frames += 1;
                if (frames === at) {
                    emitted.count += 1;
                    this.emit('error', new Error(UTTERANCE));
                }
            }
        }
        return new DiesMidCall(leg, options);
    };
}

describe('the async bridge inside a whole call', () => {
    it('a bridge that fails mid-call: one hangup, internal_error, and its message in no log', async () => {
        const fixture = loadFixtures('plain')[0];
        assert.ok(fixture);
        const emitted = { count: 0 };
        const logs: string[] = [];
        const { audio, replay } = await audioCall(fixture, agentFactory('stub'), {
            bridge: failsAtFrame(1_000, emitted),
            log: (line) => { logs.push(line); },
        });
        assert.equal(emitted.count, 1, 'the planted failure never fired; this test proves nothing');
        assert.equal(audio.hangupsSent, 1, 'exactly one hangup');
        assert.equal(audio.endedBecause, 'internal_error');
        assert.equal(replay.transcript.endedBecause, 'internal_error');
        assert.equal(audio.callMs, 1_000 * CARRIER_AUDIO.frameMs, 'the call ran on past the failure');
        assert.equal(audio.writtenAfterHangup, 0);
        assert.deepEqual(logs, ['call-supervisor fake:plain internal_error Error']);
        const failed = audioChecks(audio).filter((c) => c.severity === 'hard' && !c.passed).map((c) => c.id);
        assert.deepEqual(failed, ['no_internal_error']);
        for (const line of [...logs, ...replay.transcript.lines.map((l) => l.text)]) {
            assert.ok(!line.includes(UTTERANCE), `the error message leaked: ${line}`);
        }
    });

    it('a SpokenResult and the report agree, sentence for sentence, on every recorded call', async () => {
        const make = agentFactory('stub');
        let interrupted = 0;
        for (const fixture of loadFixtures()) {
            let bridge: ScriptedBridge | null = null;
            const { audio } = await audioCall(fixture, make, {
                bridge: (leg, options) => { bridge = new ScriptedBridge(leg, options); return bridge; },
                log: () => {},
            });
            const heard = (bridge as ScriptedBridge | null)?.heard() ?? [];
            const cut = heard.filter((h) => h.heardMs < h.fullMs).length;
            assert.equal(audio.cutShortSentences, cut, `${fixture.name}: the SpokenResults and heard() disagree`);
            assert.equal(audio.unheardSentences, heard.filter((h) => h.heardMs === 0).length, fixture.name);
            if (cut > 0) interrupted += 1;
        }
        // Control: agreement on calls where nothing was cut would hold for a bridge that never
        // reports a cut at all.
        assert.ok(interrupted > 0, 'no recorded call cut a sentence, so agreement proves nothing');
    });
});
