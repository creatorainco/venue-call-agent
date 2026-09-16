/**
 * The telephone layer.
 *
 * 🔴 EVERY GUARD IN HERE SHIPS WITH ITS OWN SABOTAGE. The pattern this repository uses
 * everywhere: after asserting that a check passes on good input, plant the fault it exists to
 * catch and assert it FAILS. A check that has only ever been seen passing is indistinguishable
 * from a check that cannot fail, and this file adds three of them to a repository whose whole
 * argument is that its graders work.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CARRIER_AUDIO, MULAW_SILENCE, silentCarrierFrame } from '../src/audio/format.ts';
import { assertFrame, framesToMs, msToFrames } from '../src/carrier/leg.ts';
import { FakeCallLeg, isSilent, speechFrame, DEFAULT_INTERNAL_PAUSE_MS } from '../src/carrier/fakeLeg.ts';
import type { TimelineTurn } from '../src/carrier/fakeLeg.ts';
import { TurnDetector, frameEnergy } from '../src/carrier/vad.ts';
import type { VadSettings } from '../src/carrier/vad.ts';
import { ScriptedBridge, sentenceDurationMs, spokenFrame } from '../src/carrier/bridge.ts';
import { audioCall, measure, segmentsOf, timelineFrom, percentiles } from '../src/carrier/call.ts';
import { audioChecks, audioControl, TALK_OVER_GRACE_FRAMES, DEAD_AIR_HARD_MS } from '../src/carrier/checks.ts';
import { VAD } from '../src/tuning/liveDefaults.ts';
import { loadFixtures } from '../src/harness/fixtures.ts';
import { replay } from '../src/harness/replay.ts';
import { agentFactory } from '../src/eval/run.ts';

const vadWith = (silenceDurationMs: number): VadSettings => ({ ...VAD, silenceDurationMs });

describe('frames', () => {
    it('a carrier frame is exactly one frame long, and a short one is refused', () => {
        assert.equal(silentCarrierFrame().length, CARRIER_AUDIO.bytesPerFrame);
        assert.equal(speechFrame(0).length, CARRIER_AUDIO.bytesPerFrame);
        assert.equal(spokenFrame(0).length, CARRIER_AUDIO.bytesPerFrame);

        // The sabotage: a carrier paces playback per frame, so a short frame is a click.
        assert.throws(
            () => assertFrame(new Uint8Array(120), 'test'),
            /must be exactly 160/,
        );
    });

    it('silence is 0xff, and a zero-filled buffer is NOT silence', () => {
        assert.ok(isSilent(silentCarrierFrame()));
        // 🔴 The one-character bug that deafens somebody. A zero-filled μ-law buffer is
        // full-scale negative; if `isSilent` ever accepts it, every "quiet" measurement in this
        // suite is measuring a roar.
        assert.equal(isSilent(new Uint8Array(CARRIER_AUDIO.bytesPerFrame)), false);
        assert.ok(frameEnergy(new Uint8Array(CARRIER_AUDIO.bytesPerFrame)) > 30_000);
        assert.ok(frameEnergy(silentCarrierFrame()) < 10);
        assert.equal(MULAW_SILENCE, 0xff);
    });

    it('frames and milliseconds convert one way only, and round up', () => {
        assert.equal(framesToMs(50), 1_000);
        assert.equal(msToFrames(1_000), 50);
        assert.equal(msToFrames(1), 1, 'you cannot send part of a frame');
        assert.equal(msToFrames(21), 2);
    });
});

describe('the turn detector', () => {
    /** Drive a detector over an envelope of [speech, silence, speech, ...] runs, in frames. */
    function run(vad: VadSettings, runs: Array<{ speech: number } | { silence: number }>) {
        const detector = new TurnDetector(vad);
        const events: Array<{ kind: string; at: number; latencyMs?: number }> = [];
        let frame = 0;
        for (const r of runs) {
            const n = 'speech' in r ? r.speech : r.silence;
            for (let i = 0; i < n; i += 1) {
                const event = detector.push('speech' in r ? speechFrame(frame) : silentCarrierFrame());
                frame += 1;
                if (event) events.push({ kind: event.kind, at: event.at, ...(event.latencyMs === undefined ? {} : { latencyMs: event.latencyMs }) });
            }
        }
        return events;
    }

    it('finds one turn per utterance and fires silenceDurationMs after the last sound', () => {
        const events = run(vadWith(800), [
            { silence: 25 },
            { speech: 50 },
            { silence: 60 },
        ]);
        const ends = events.filter((e) => e.kind === 'turn_ended');
        assert.equal(ends.length, 1);
        // 800 ms is 40 frames; the fire lands on the 40th silent frame, so one frame of slack.
        assert.ok(
            Math.abs(ends[0]!.latencyMs! - 800) <= CARRIER_AUDIO.frameMs,
            `end-of-turn latency was ${ends[0]!.latencyMs}ms, expected ~800ms`,
        );
    });

    it('survives a thinking pause it is longer than, and cuts through one it is not', () => {
        const envelope = [
            { silence: 20 },
            { speech: 30 },
            { silence: msToFrames(DEFAULT_INTERNAL_PAUSE_MS) },  // 500ms mid-utterance pause
            { speech: 30 },
            { silence: 80 },
        ];

        const patient = run(vadWith(800), envelope).filter((e) => e.kind === 'turn_ended');
        assert.equal(patient.length, 1, '800ms must ride over a 500ms thinking pause');

        // 🔴 THE SABOTAGE, and the whole reason the sweep in `npm run call -- --sweep` is worth
        // running: a setting shorter than the pause splits one question into two, and the agent
        // answers half of it. If this ever comes back 1, the sweep's "over-segmented" column can
        // never be non-zero and the instrument is arguing for the cheapest setting.
        const hasty = run(vadWith(400), envelope).filter((e) => e.kind === 'turn_ended');
        assert.equal(hasty.length, 2, '400ms must cut a 500ms pause in two');
    });

    it('closes an open turn when the far end stops sending', () => {
        const detector = new TurnDetector(vadWith(800));
        for (let i = 0; i < 30; i += 1) detector.push(speechFrame(i));
        const flushed = detector.flush();
        assert.equal(flushed?.kind, 'turn_ended');
        assert.equal(detector.flush(), null, 'flushing twice must not invent a second turn');
    });
});

describe('the fake leg', () => {
    const oneTurn: TimelineTurn[] = [{ text: 'Hello?', segmentsMs: [400] }];

    it('records what was really on the wire, in call time', () => {
        const leg = new FakeCallLeg({ turns: oneTurn, trailingSilenceMs: 1_000 });
        while (leg.advance()) { /* run the call out */ }
        assert.equal(leg.truth.length, 1);
        assert.ok(leg.truth[0]!.endFrame > leg.truth[0]!.startFrame);
        assert.equal(leg.inbound.length, leg.elapsedFrames);
        assert.equal(leg.writtenAfterHangup, 0);
    });

    /**
     * Two turns, the first forced to start at once, and an agent that never says a word.
     * `patienceMs` decides whether the second one happens; nothing else may.
     */
    const silentRun = (patienceMs: number) => {
        const turns: TimelineTurn[] = [
            { text: 'one', segmentsMs: [300], startWhen: { atMs: 0 } },
            { text: 'anyone there?', segmentsMs: [600] },
        ];
        const leg = new FakeCallLeg({ turns, trailingSilenceMs: 500, patienceMs, maxMs: 5_000 });
        const detector = new TurnDetector(VAD);
        let ends = 0;
        leg.on('inbound', (f) => { if (detector.push(f)?.kind === 'turn_ended') ends += 1; });
        while (leg.advance()) { /* say nothing at all */ }
        return { turnsSpoken: leg.truth.length, ends };
    };

    it('the far end waits for an ANSWER, not merely for silence', () => {
        // The bug this pins: with a 400ms politeness gap and an 800ms detector, a far end that
        // waits only for silence starts its second sentence before the first has even been
        // noticed, and every turn in a fixture collapses into one. The run still looks plausible,
        // which is what makes it dangerous — 1 detected turn out of 3, and a dead-air figure.
        const patient = silentRun(30_000);
        assert.equal(patient.turnsSpoken, 1, 'the far end spoke again without ever being answered');
        assert.equal(patient.ends, 1);
    });

    it('an unanswered far end eventually gives up and speaks again', () => {
        // The other direction, on the same rig: only the patience number differs. Without this
        // pair, "waits for an answer" could be implemented as "never speaks twice" and pass.
        const impatient = silentRun(1_500);
        assert.equal(impatient.turnsSpoken, 2, 'patience never expired, so a silent agent hangs the run');
    });

    it('counts audio written after the far end hung up rather than throwing', () => {
        const leg = new FakeCallLeg({ turns: oneTurn, hangUpAtMs: 200 });
        while (leg.advance()) { /* until they hang up */ }
        assert.ok(leg.ended);
        leg.write(spokenFrame(0));
        leg.write(spokenFrame(1));
        assert.equal(leg.writtenAfterHangup, 2);
    });
});

describe('barge-in', () => {
    it('an interruption clears the queue, and the overlap stays inside the grace', () => {
        const leg = new FakeCallLeg({
            turns: [{ text: 'no wait', segmentsMs: [800], startWhen: 'interrupt', gapMs: 400 }],
            trailingSilenceMs: 2_000,
        });
        const bridge = new ScriptedBridge(leg, { vad: VAD, script: ['no wait'] });
        leg.on('inbound', (f) => { bridge.push(f); });
        // A long answer, so there is plenty queued to throw away.
        bridge.speak(['This is a deliberately long sentence so that the outbound queue is deep enough for an interruption to matter at all.']);
        const queuedBefore = leg.queuedFrames();
        while (leg.advance()) { /* run it out */ }

        assert.ok(queuedBefore > 100, 'the test needs a deep queue to be meaningful');
        assert.ok(leg.cleared > 0, 'the interruption never cleared anything');

        let overlap = 0;
        const audibleIn = new Set(leg.inbound.filter((f) => f.audible).map((f) => f.at));
        for (const f of leg.outbound) if (f.audible && audibleIn.has(f.at)) overlap += 1;
        assert.ok(
            overlap <= TALK_OVER_GRACE_FRAMES,
            `talked over the far end for ${overlap} frames, grace is ${TALK_OVER_GRACE_FRAMES}`,
        );
    });

    it('SABOTAGE — a bridge that never clears talks over the far end, and the check catches it', () => {
        const leg = new FakeCallLeg({
            turns: [{ text: 'no wait', segmentsMs: [800], startWhen: 'interrupt', gapMs: 400 }],
            trailingSilenceMs: 2_000,
        });
        const bridge = new ScriptedBridge(leg, { vad: VAD, script: ['no wait'] });
        // The planted fault: barge-in is disabled. Everything else is identical.
        bridge.bargeIn = () => { /* deliberately deaf */ };
        leg.on('inbound', (f) => { bridge.push(f); });
        bridge.speak(['This is a deliberately long sentence so that the outbound queue is deep enough for an interruption to matter at all.']);
        while (leg.advance()) { /* run it out */ }

        assert.equal(leg.cleared, 0);
        let overlap = 0;
        const audibleIn = new Set(leg.inbound.filter((f) => f.audible).map((f) => f.at));
        for (const f of leg.outbound) if (f.audible && audibleIn.has(f.at)) overlap += 1;
        assert.ok(overlap > TALK_OVER_GRACE_FRAMES, 'the planted fault produced no overlap at all');

        const check = audioChecks({
            deadAirMs: [], percentiles: {}, maxDeadAirMs: 0, openingDelayMs: 0,
            talkOverFrames: overlap, clearedFrames: 0, writtenAfterHangup: 0,
            framesIn: leg.inbound.length, framesOut: leg.outbound.length, audibleOutFrames: 0,
            detectedTurns: 1, scriptedTurns: 1, overSegmented: 0,
            missedTurns: 0, unansweredTurns: 0,
            cutShortSentences: 0, unheardSentences: 0, callMs: leg.elapsedMs,
            endedBecause: 'timeline_exhausted', vad: 'test', modelLatencyMs: 0,
        }).find((c) => c.id === 'stopped_when_interrupted');
        assert.equal(check?.passed, false, 'the grader did not notice us talking over somebody');
    });
});

describe('what was SENT versus what was HEARD', () => {
    it('an interrupted call reports fewer sentences heard than the transcript claims', async () => {
        const fixture = loadFixtures('they-interrupt')[0]!;
        assert.ok(fixture, 'the they-interrupt fixture is gone; the barge-in path is ungraded again');
        assert.deepEqual(fixture.audio?.interruptTurns, [1]);

        const { replay: r, audio } = await audioCall(fixture, agentFactory('stub'));
        assert.ok(r.transcript.spoken.length >= 4, 'the fixture needs a multi-sentence turn to matter');
        assert.ok(
            audio.cutShortSentences > 0,
            'nobody was interrupted, so this fixture is no longer testing an interruption',
        );
        // The finding this exists to surface: the transcript credits the agent with sentences the
        // far end never heard a word of.
        assert.ok(audio.unheardSentences > 0);
        assert.ok(audio.unheardSentences <= r.transcript.spoken.length);
    });

    it('a call nobody interrupts credits every sentence in full', async () => {
        const { audio } = await audioCall(loadFixtures('plain')[0]!, agentFactory('stub'));
        assert.equal(audio.cutShortSentences, 0);
        assert.equal(audio.unheardSentences, 0);
    });
});

describe('the line closing', () => {
    /**
     * 🔴 THE TEST THAT FOUND 85 LEAKS, kept because it is the only shape that could.
     *
     * `no_audio_after_hangup` existed from the first commit and had never been observed acting:
     * no fixture hung up, so `writtenAfterHangup` was 0 on every graded run and the check was
     * decoration. Sweeping a hang-up across every instant of every call found 85 points at
     * which the agent went on generating audio into a closed socket — up to 1,239 frames, most
     * of them through the post-loop flush, which called the agent and spoke the reply to nobody.
     *
     * A single hang-up fixture would not have found it: the leak is a WINDOW, and whether you
     * land in it depends on where the hangup falls relative to a turn boundary.
     */
    it('never generates audio after the far end has gone, at ANY instant of ANY call', async () => {
        const make = agentFactory('stub');
        const leaks: string[] = [];
        for (const fixture of loadFixtures()) {
            for (let ms = 500; ms <= 20_000; ms += 500) {
                const { audio } = await audioCall(fixture, make, { hangUpAtMs: ms });
                if (audio.writtenAfterHangup > 0) {
                    leaks.push(`${fixture.name} @${ms}ms → ${audio.writtenAfterHangup} frame(s)`);
                }
            }
        }
        assert.deepEqual(
            leaks.slice(0, 10),
            [],
            `${leaks.length} instant(s) generate audio into a dead line. First few:\n  `
            + leaks.slice(0, 10).join('\n  '),
        );
    });

    it('CONTROL — the sweep can see a leak, so a clean result means something', () => {
        // The leak is counted by the leg itself, so plant one there: write after it has ended.
        const leg = new FakeCallLeg({ turns: [{ text: 'x', segmentsMs: [200] }], hangUpAtMs: 100 });
        while (leg.advance()) { /* until they hang up */ }
        assert.ok(leg.ended);
        assert.equal(leg.writtenAfterHangup, 0);
        leg.write(spokenFrame(0));
        assert.equal(leg.writtenAfterHangup, 1, 'the leg cannot count a write into a dead line');
    });

    it('a transcript never claims a sentence that the closed line swallowed', async () => {
        const fixture = loadFixtures('they-hang-up')[0]!;
        assert.equal(fixture.audio?.hangUpAtMs, 12_000, 'they-hang-up no longer hangs up');
        const { replay: r } = await audioCall(fixture, agentFactory('stub'));
        const notSpoken = r.transcript.lines.filter((l) => l.text.startsWith('not spoken'));
        for (const line of notSpoken) {
            for (const said of r.transcript.spoken) {
                assert.ok(!line.text.includes(said), `"${said}" is recorded as both spoken and not`);
            }
        }
    });
});

describe('the turn detector, after the hysteresis fix', () => {
    it('keeps its end threshold below its start threshold in ALL FOUR sensitivity pairs', () => {
        // The invariant was documented and enforced in exactly one of the four legal
        // combinations. It is now derived rather than tabulated, so it cannot come apart —
        // and it throws if it ever does, which is what this asserts by not throwing.
        for (const start of ['START_SENSITIVITY_LOW', 'START_SENSITIVITY_HIGH'] as const) {
            for (const end of ['END_SENSITIVITY_LOW', 'END_SENSITIVITY_HIGH'] as const) {
                assert.doesNotThrow(
                    () => new TurnDetector({ ...VAD, startOfSpeechSensitivity: start, endOfSpeechSensitivity: end }),
                    `${start} + ${end} breaks the hysteresis invariant`,
                );
            }
        }
    });

    it('the pinned pair is numerically unchanged by the fix', () => {
        // 1200 x 0.5 = 600, which is exactly what the old hand-written table said for LOW/LOW.
        // If this moves, every measurement taken before today is no longer comparable.
        const detector = new TurnDetector(VAD);
        assert.match(detector.describe, /silence=800ms/);
        const envelope = [{ silence: 20 }, { speech: 30 }, { silence: 80 }];
        let ends = 0;
        let frame = 0;
        for (const r of envelope) {
            const n = 'speech' in r ? r.speech : r.silence;
            for (let i = 0; i < n; i += 1) {
                const e = detector.push('speech' in r ? speechFrame(frame) : silentCarrierFrame());
                frame += 1;
                if (e?.kind === 'turn_ended') ends += 1;
            }
        }
        assert.equal(ends, 1);
    });
});

describe('turn COLLAPSE, the direction that used to be unmeasurable', () => {
    /**
     * Two utterances 600 ms apart, and a detector that waits 800 ms. It cannot tell them apart,
     * so it reports ONE turn where the far end spoke TWO — and the agent answers half of what
     * was asked with no sign anywhere that the other half happened.
     *
     * 🔴 `overSegmented` is structurally incapable of reporting this. It is
     * `detected - consumed`, and `consumed` is only ever incremented where `detected` is, so
     * the difference cannot go negative: a deficit is unrepresentable. That was the exact bug
     * this whole rig was built to catch, and the rig could not catch it.
     */
    function collapsed(silenceDurationMs: number) {
        const leg = new FakeCallLeg({
            turns: [
                { text: 'first', segmentsMs: [400], startWhen: { atMs: 500 } },
                { text: 'second', segmentsMs: [400], startWhen: { atMs: 1_500 } },  // 600ms apart
            ],
            trailingSilenceMs: 4_000,
        });
        const bridge = new ScriptedBridge(leg, { vad: vadWith(silenceDurationMs), script: ['first', 'second'] });
        leg.on('inbound', (f) => { bridge.push(f); });
        while (leg.advance()) { /* run it out */ }
        return measure(leg, bridge, {
            answeredAfterFrame: [],
            silenceDurationMs,
            scriptedTurns: 2,
            endedBecause: 'timeline_exhausted',
            vad: 'test',
            modelLatencyMs: 0,
        });
    }

    it('a detector slower than the gap merges two turns into one, and it is REPORTED', () => {
        const merged = collapsed(800);
        assert.equal(merged.detectedTurns, 1, 'the setup no longer collapses; the gap or the window moved');
        assert.equal(merged.overSegmented, 0, 'over-segmentation cannot express a deficit — that is the point');
        assert.equal(merged.missedTurns, 1);

        const failed = audioChecks(merged).filter((c) => c.severity === 'hard' && !c.passed);
        assert.ok(
            failed.some((c) => c.id === 'no_turn_lost'),
            'the agent heard one of two questions and every hard check passed',
        );
    });

    it('CONTROL — the same rig with a fast enough detector reports no loss', () => {
        // Without this the test above could be passing because the rig is broken rather than
        // because the detector is. 400 ms is shorter than the 600 ms gap, so both turns land.
        const fine = collapsed(400);
        assert.equal(fine.detectedTurns, 2);
        assert.equal(fine.missedTurns, 0);
        assert.deepEqual(audioChecks(fine).filter((c) => c.severity === 'hard' && !c.passed), []);
    });

    it('a turn the LINE closed on is not charged to the agent', () => {
        // The other direction, and it was a real false positive: a turn that finishes inside the
        // last silenceDurationMs of the call was never detectable, and charging it made a
        // hang-up look like deafness.
        const leg = new FakeCallLeg({
            turns: [{ text: 'wait—', segmentsMs: [400], startWhen: { atMs: 200 } }],
            trailingSilenceMs: 10_000,
            hangUpAtMs: 900,   // 300ms after they stop, well inside an 800ms window
        });
        const bridge = new ScriptedBridge(leg, { vad: VAD, script: ['wait—'] });
        leg.on('inbound', (f) => { bridge.push(f); });
        while (leg.advance()) { /* until they hang up */ }
        const r = measure(leg, bridge, {
            answeredAfterFrame: [], silenceDurationMs: VAD.silenceDurationMs, scriptedTurns: 1,
            endedBecause: 'far_end_hung_up', vad: 'test', modelLatencyMs: 0,
        });
        assert.equal(r.detectedTurns, 0, 'the detector should not have had time');
        assert.equal(r.missedTurns, 0, 'a hangup inside the detector window was charged as deafness');
    });
});

describe('silence must not score perfectly', () => {
    it('a turn we never answer is charged to the end of the call, not to zero', () => {
        // Dead air used to be sampled only where a reply existed, so a call in which the agent
        // never spoke produced an EMPTY sample — and an empty sample maxed to 0 ms, the best
        // possible number. Total silence passed every check including the hard dead-air one.
        const leg = new FakeCallLeg({
            turns: [{ text: 'hello?', segmentsMs: [400], startWhen: { atMs: 200 } }],
            trailingSilenceMs: 10_000,
        });
        const bridge = new ScriptedBridge(leg, { vad: VAD, script: ['hello?'] });
        leg.on('inbound', (f) => { bridge.push(f); });
        while (leg.advance()) { /* say absolutely nothing */ }

        const answeredAt = leg.truth[0]!.endFrame;
        const r = measure(leg, bridge, {
            answeredAfterFrame: [answeredAt], silenceDurationMs: VAD.silenceDurationMs,
            scriptedTurns: 1, endedBecause: 'timeline_exhausted', vad: 'test', modelLatencyMs: 0,
        });

        assert.equal(r.audibleOutFrames, 0, 'the rig spoke; it is meant to be silent');
        assert.equal(r.unansweredTurns, 1);
        assert.ok(r.maxDeadAirMs > DEAD_AIR_HARD_MS, `silence measured as only ${r.maxDeadAirMs}ms`);
        assert.ok(
            audioChecks(r).some((c) => c.severity === 'hard' && !c.passed),
            'a call with no audio in it passed every hard check',
        );
    });
});

describe('the audio grader', () => {
    it('catches every fault it is supposed to catch', () => {
        assert.equal(audioControl(), null);
    });
});

describe('a whole call, over audio', () => {
    it('every recorded conversation passes the audio hard checks', async () => {
        const make = agentFactory('stub');
        for (const fixture of loadFixtures()) {
            const { audio } = await audioCall(fixture, make);
            const failed = audioChecks(audio).filter((c) => c.severity === 'hard' && !c.passed);
            assert.deepEqual(failed.map((c) => c.id), [], `${fixture.name}: ${failed.map((c) => c.detail).join('; ')}`);
            assert.equal(audio.writtenAfterHangup, 0, `${fixture.name} generated audio after the leg closed`);
        }
    });

    it('says the same words over audio as it does over text, unless they hang up', async () => {
        const make = agentFactory('stub');
        for (const fixture of loadFixtures()) {
            const overAudio = await audioCall(fixture, make);
            const overText = await replay(fixture, make);

            if (fixture.audio?.hangUpAtMs !== undefined) {
                // 🔴 A DELIBERATE, DOCUMENTED DIVERGENCE, not an exemption of convenience.
                // The text harness feeds every scripted turn regardless; a telephone does not.
                //
                // Two ways a hangup shows up, and the fixture must exhibit at least one, or it
                // is a hangup that cost nothing and is testing nothing:
                //   - fewer sentences REACH the agent, so the audio path says less; or
                //   - the same sentences are said and some never PLAY, which the wire records.
                const audioSpoke = overAudio.replay.transcript.spoken;
                const textSpoke = overText.transcript.spoken;
                assert.ok(audioSpoke.length <= textSpoke.length, `${fixture.name}: the audio path said MORE`);
                assert.deepEqual(
                    audioSpoke,
                    textSpoke.slice(0, audioSpoke.length),
                    `${fixture.name}: what was said before the hangup must be a PREFIX of the `
                    + 'text run, or the two paths diverged on content rather than on length',
                );
                assert.ok(
                    audioSpoke.length < textSpoke.length || overAudio.audio.unheardSentences > 0,
                    `${fixture.name}: the hangup cost nothing — every sentence was both said and `
                    + 'heard, so this fixture is not exercising a hangup at all',
                );
                continue;
            }

            assert.deepEqual(
                overAudio.replay.transcript.spoken,
                overText.transcript.spoken,
                `${fixture.name}: the audio path and the text path disagree about what was said`,
            );
            assert.deepEqual(
                [...overAudio.replay.allowedSentences].sort(),
                [...overText.allowedSentences].sort(),
                `${fixture.name}: the two paths disagree about what the backend allowed`,
            );
        }
    });

    it('dead air tracks the detector setting, and never goes below it', async () => {
        const fixture = loadFixtures('plain')[0]!;
        const make = agentFactory('stub');
        const seen: number[] = [];
        for (const silence of [400, 800, 1200]) {
            const { audio } = await audioCall(fixture, make, { vad: vadWith(silence) });
            const p50 = audio.percentiles.p50 ?? 0;
            assert.ok(p50 >= silence, `dead air ${p50}ms is below the ${silence}ms the detector waits — impossible`);
            seen.push(p50);
        }
        assert.deepEqual([...seen].sort((a, b) => a - b), seen, 'dead air did not rise with the setting');
    });

    it('simulated model latency lands in the dead air, and is not lost', async () => {
        const fixture = loadFixtures('plain')[0]!;
        const make = agentFactory('stub');
        const quick = await audioCall(fixture, make, { modelLatencyMs: 0 });
        const slow = await audioCall(fixture, make, { modelLatencyMs: 900 });
        const delta = (slow.audio.percentiles.p50 ?? 0) - (quick.audio.percentiles.p50 ?? 0);
        assert.ok(
            Math.abs(delta - 900) <= 2 * CARRIER_AUDIO.frameMs,
            `900ms of model latency moved dead air by ${delta}ms; it should move it by 900`,
        );
    });
});

describe('the envelope a fixture turns into', () => {
    it('an utterance with a thinking pause becomes more than one run of sound', () => {
        // 🔴 If this ever returns one segment, the sweep goes flat and silently recommends the
        // lowest setting. That is exactly the bug this file was written after.
        assert.equal(segmentsOf("Hang on - who's paying for this meal?").length, 2);
        assert.equal(segmentsOf('Yes, of course, that is fine').length, 3);
        assert.equal(segmentsOf('Hello?').length, 1);
    });

    it('at least one recorded conversation has an internal pause in it', () => {
        const withPause = loadFixtures()
            .flatMap((f) => timelineFrom(f))
            .filter((t) => t.segmentsMs.length > 1);
        assert.ok(
            withPause.length > 0,
            'no fixture contains a mid-utterance pause, so the sweep cannot show the cost of a low setting',
        );
    });

    it('a sentence takes longer to say than a word', () => {
        assert.ok(sentenceDurationMs('Hello?') < sentenceDurationMs('Hello, this is a much longer sentence indeed.'));
        assert.ok(sentenceDurationMs('') >= CARRIER_AUDIO.frameMs, 'nothing may round to zero frames');
    });
});

describe('percentiles', () => {
    it('are nearest-rank and never a mean', () => {
        const p = percentiles([100, 200, 300, 400, 5_000]);
        assert.equal(p.p50, 300);
        assert.equal(p.p90, 5_000);
        // A mean would be 1200 and would hide the 5000 entirely. See docs/TUNING.md §3.1.
        assert.notEqual(p.p50, 1_200);
    });

    it('an empty sample produces no percentiles rather than a zero', () => {
        assert.deepEqual(percentiles([]), {});
    });
});
