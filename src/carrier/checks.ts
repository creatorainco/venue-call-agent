/**
 * WHAT AN AUDIO CALL IS GRADED ON, over and above what the transcript is graded on.
 *
 * `src/eval/rubric.ts` asks whether the agent said and did the right things. These ask whether a
 * person on a telephone would have been able to bear it. They are separate on purpose: a call can
 * pass every hard check in the rubric and still be four seconds of silence followed by the agent
 * talking over the manager, and neither of those is visible in a transcript.
 *
 * 🔴 THE BUDGETS BELOW ARE CHOSEN, NOT MEASURED, AND THEY SAY SO.
 * Nobody has timed a real call on this feature. The numbers are the ones a person would defend in
 * a review — a second and a half of silence is noticeable, four is a call somebody thinks has
 * dropped — and they are the thing a real measurement should replace first. They are deliberately
 * NOT derived from what the current implementation happens to score, because a budget fitted to
 * today's behaviour can only ever be met.
 *
 * 🔴 AND THEY SHIP WITH A CONTROL. `audioControl()` builds a report with a planted fault for
 * every hard check and fails if any check reports clean. Same argument as everywhere else in
 * this repository: a grader that cannot catch a planted fault marks every call as fine.
 */

import type { AudioReport } from './call.ts';
import type { Severity } from '../eval/rubric.ts';

export interface AudioCheck {
    id: string;
    severity: Severity;
    passed: boolean;
    detail: string;
}

/**
 * Dead air a restaurant will tolerate without thinking the line has gone.
 *
 * The floor is not zero and cannot be: it is `silenceDurationMs` plus however long the model
 * takes, so 800 ms of it is the detector doing its job. The budget is about the rest.
 */
export const DEAD_AIR_SOFT_MS = 2_000;
export const DEAD_AIR_HARD_MS = 4_000;

/**
 * How much of our own speech may overlap theirs before it is rudeness rather than a race.
 *
 * A barge-in cannot be instant — the detector needs `startRun` frames to be sure somebody is
 * talking, and those frames are audio we had already committed to. Six frames is 120 ms, which is
 * shorter than a syllable.
 */
export const TALK_OVER_GRACE_FRAMES = 6;

export function audioChecks(report: AudioReport): AudioCheck[] {
    const checks: AudioCheck[] = [];

    // ── hard: things a call must never do ────────────────────────────────────────────────────
    checks.push({
        id: 'no_audio_after_hangup',
        severity: 'hard',
        passed: report.writtenAfterHangup === 0,
        detail: report.writtenAfterHangup === 0
            ? 'nothing was written after the leg closed'
            : `${report.writtenAfterHangup} frame(s) generated after the far end hung up — `
              + 'audio nobody hears, on a call somebody is billed for, from a loop that did not stop',
    });

    checks.push({
        id: 'dead_air_within_hard_budget',
        severity: 'hard',
        passed: report.maxDeadAirMs <= DEAD_AIR_HARD_MS,
        detail: `longest silence after they stopped: ${report.maxDeadAirMs}ms `
            + `(hard budget ${DEAD_AIR_HARD_MS}ms — past this a person thinks the call dropped)`,
    });

    checks.push({
        id: 'stopped_when_interrupted',
        severity: 'hard',
        passed: report.talkOverFrames <= TALK_OVER_GRACE_FRAMES,
        detail: report.talkOverFrames <= TALK_OVER_GRACE_FRAMES
            ? `${report.talkOverFrames} frame(s) of overlap, within the ${TALK_OVER_GRACE_FRAMES}-frame grace`
            : `${report.talkOverFrames} frames — ${report.talkOverFrames * 20}ms — of talking over the far end. `
              + 'Either the barge-in never fired or the queue was never cleared.',
    });

    checks.push({
        id: 'no_turn_lost',
        severity: 'hard',
        passed: report.missedTurns === 0,
        detail: report.missedTurns === 0
            ? `every turn the far end finished was detected (${report.detectedTurns})`
            : `${report.missedTurns} turn(s) the far end really spoke were never detected. The agent `
              + 'did not hear a question that was asked, which is worse than answering it badly — '
              + 'nothing in the transcript shows it happened at all.',
    });

    // ── soft: judgements, printed and not merge-blocking ─────────────────────────────────────
    checks.push({
        id: 'every_turn_answered',
        severity: 'soft',
        passed: report.unansweredTurns === 0,
        detail: report.unansweredTurns === 0
            ? 'every detected turn got a reply'
            : `${report.unansweredTurns} turn(s) ended and we never spoke again. The dead air for `
              + 'those is charged to the end of the call rather than to zero.',
    });

    checks.push({
        id: 'dead_air_comfortable',
        severity: 'soft',
        passed: report.maxDeadAirMs <= DEAD_AIR_SOFT_MS,
        detail: `longest silence ${report.maxDeadAirMs}ms against a comfort budget of ${DEAD_AIR_SOFT_MS}ms`,
    });

    checks.push({
        id: 'turns_segmented_as_scripted',
        severity: 'soft',
        passed: report.overSegmented === 0,
        detail: report.overSegmented === 0
            ? `${report.detectedTurns} turn(s) detected against ${report.scriptedTurns} scripted`
            : `${report.overSegmented} turn(s) found that the script has no line for — the audio was `
              + 'split differently than the fixture assumed, usually a silenceDurationMs short enough '
              + 'to cut one utterance in two',
    });

    checks.push({
        id: 'transcript_matches_what_was_heard',
        severity: 'soft',
        passed: report.unheardSentences === 0,
        detail: report.unheardSentences === 0
            ? report.cutShortSentences === 0
                ? 'every sentence the transcript records was played in full'
                : `${report.cutShortSentences} sentence(s) cut short by an interrupt, none lost entirely`
            : `${report.unheardSentences} sentence(s) recorded as spoken never played at all, and `
              + `${report.cutShortSentences} were cut short. The transcript over-reports what the `
              + 'restaurant heard: hand the bridge ONE sentence at a time. See src/carrier/bridge.ts.',
    });

    checks.push({
        id: 'opening_prompt',
        severity: 'soft',
        passed: report.openingDelayMs <= DEAD_AIR_SOFT_MS,
        detail: `first audio ${report.openingDelayMs}ms after the line was answered`,
    });

    return checks;
}

/**
 * The positive control. Plants a fault at the BOUNDARY of every check and demands each be caught.
 *
 * 🔴 THREE THINGS THIS GOT WRONG AT FIRST, ALL FOUND BY AN ADVERSARIAL PASS, ALL KEPT AS
 * COMMENTS BECAUSE THEY ARE THE INTERESTING PART:
 *
 *   1. It planted 7 where the failing boundary is 1. Widening `no_audio_after_hangup` to
 *      `<= 6` left this returning null and the whole suite green — 120 ms of audio into a dead
 *      socket would then have graded clean. A control must plant the SMALLEST failing value.
 *   2. It asserted nothing about `severity`. Demoting a hard check to soft left it green, and
 *      the demotion is exactly how a check stops blocking a merge while still printing.
 *   3. It ignored the soft checks entirely, so half the grader was unguarded.
 *
 * And the fourth, which cannot be fixed here at all: this exercises the COMPARISONS in
 * `audioChecks` over a hand-written report. It says nothing about whether `measure()` puts a
 * truthful number into those fields. That half lives in `test/carrier.test.ts`, which drives
 * real legs through real calls — a collapse, a silence, a hangup at every instant of every
 * fixture — and asserts on what `measure()` reports. Neither half is sufficient alone.
 *
 * Returns null when the grader works, or a sentence naming what it failed to notice.
 */
export function audioControl(): string | null {
    const clean: AudioReport = {
        deadAirMs: [900],
        percentiles: { p50: 900, p90: 900, p99: 900 },
        maxDeadAirMs: 900,
        openingDelayMs: 200,
        talkOverFrames: 0,
        clearedFrames: 0,
        writtenAfterHangup: 0,
        framesIn: 100,
        framesOut: 100,
        audibleOutFrames: 40,
        detectedTurns: 2,
        scriptedTurns: 2,
        overSegmented: 0,
        missedTurns: 0,
        unansweredTurns: 0,
        cutShortSentences: 0,
        unheardSentences: 0,
        callMs: 2_000,
        endedBecause: 'agent_ended',
        vad: 'control',
        modelLatencyMs: 0,
    };

    // The control must first confirm a CLEAN report passes. A checker wired to fail always would
    // otherwise look like a working one from the failure side.
    for (const check of audioChecks(clean)) {
        if (!check.passed && check.severity === 'hard') {
            return `a clean report failed the hard check "${check.id}" — the grader fails everything, `
                + 'which is as useless as passing everything';
        }
    }

    /**
     * One planted fault per check, each at the smallest value that must fail, with the severity
     * the check is supposed to carry. Every check in `audioChecks` must appear here — the last
     * assertion in this function is that none has been added without a control.
     */
    const planted: Array<{ id: string; severity: Severity; report: AudioReport }> = [
        { id: 'no_audio_after_hangup', severity: 'hard', report: { ...clean, writtenAfterHangup: 1 } },
        { id: 'dead_air_within_hard_budget', severity: 'hard', report: { ...clean, maxDeadAirMs: DEAD_AIR_HARD_MS + 1 } },
        { id: 'stopped_when_interrupted', severity: 'hard', report: { ...clean, talkOverFrames: TALK_OVER_GRACE_FRAMES + 1 } },
        { id: 'no_turn_lost', severity: 'hard', report: { ...clean, missedTurns: 1 } },
        { id: 'dead_air_comfortable', severity: 'soft', report: { ...clean, maxDeadAirMs: DEAD_AIR_SOFT_MS + 1 } },
        { id: 'turns_segmented_as_scripted', severity: 'soft', report: { ...clean, overSegmented: 1 } },
        { id: 'every_turn_answered', severity: 'soft', report: { ...clean, unansweredTurns: 1 } },
        { id: 'transcript_matches_what_was_heard', severity: 'soft', report: { ...clean, unheardSentences: 1 } },
        { id: 'opening_prompt', severity: 'soft', report: { ...clean, openingDelayMs: DEAD_AIR_SOFT_MS + 1 } },
    ];

    for (const { id, severity, report } of planted) {
        const check = audioChecks(report).find((c) => c.id === id);
        if (!check) return `the check "${id}" is gone; the control still names it`;
        if (check.passed) return `a planted fault did not trip "${id}"`;
        if (check.severity !== severity) {
            return `"${id}" is ${check.severity} and the control expects ${severity}. `
                + 'Demoting a hard check to soft is how one stops blocking a merge while still printing.';
        }
    }

    // Boundaries, because an off-by-one silently widens a budget and nothing else would notice.
    const atBudget = audioChecks({ ...clean, maxDeadAirMs: DEAD_AIR_HARD_MS })
        .find((c) => c.id === 'dead_air_within_hard_budget');
    if (!atBudget?.passed) return 'exactly at the hard dead-air budget was treated as over it';

    const atGrace = audioChecks({ ...clean, talkOverFrames: TALK_OVER_GRACE_FRAMES })
        .find((c) => c.id === 'stopped_when_interrupted');
    if (!atGrace?.passed) return 'exactly at the talk-over grace was treated as over it';

    // ✅ And the completeness assertion: a check with no planted fault is a check nobody has
    // ever seen fail, which is the thing this file exists to prevent.
    const covered = new Set(planted.map((x) => x.id));
    const uncovered = audioChecks(clean).map((c) => c.id).filter((id) => !covered.has(id));
    if (uncovered.length) {
        return `no planted fault for: ${uncovered.join(', ')}. Add one, at the boundary, `
            + 'or the check has never been observed failing.';
    }

    return null;
}
