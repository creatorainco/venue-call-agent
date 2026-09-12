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

    // ── soft: judgements, printed and not merge-blocking ─────────────────────────────────────
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
 * The positive control. Plants one fault per hard check and demands every one be caught.
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

    const planted: Array<{ id: string; report: AudioReport }> = [
        { id: 'no_audio_after_hangup', report: { ...clean, writtenAfterHangup: 7 } },
        { id: 'dead_air_within_hard_budget', report: { ...clean, maxDeadAirMs: DEAD_AIR_HARD_MS + 1 } },
        { id: 'stopped_when_interrupted', report: { ...clean, talkOverFrames: TALK_OVER_GRACE_FRAMES + 1 } },
    ];

    for (const { id, report } of planted) {
        const check = audioChecks(report).find((c) => c.id === id);
        if (!check) return `the check "${id}" is gone; the control still names it`;
        if (check.passed) return `a planted fault did not trip "${id}"`;
    }

    // And one boundary, because an off-by-one here silently widens a budget.
    const atBudget = audioChecks({ ...clean, maxDeadAirMs: DEAD_AIR_HARD_MS })
        .find((c) => c.id === 'dead_air_within_hard_budget');
    if (!atBudget?.passed) return 'exactly at the hard dead-air budget was treated as over it';

    return null;
}
