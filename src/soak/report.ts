/**
 * The loopback soak's arithmetic (TASK-3749, I3P-02): per-call outcomes in, percentiles and the
 * gate verdict out. No I/O: `scripts/soak-corpus.mjs` runs the calls and writes the report.
 *
 * Thresholds are passed in, never written here: they live in `soak/soak.config.json` (plan
 * TASK-3749 step 1, "thresholds live in the soak harness config, not in code").
 *
 * 🔴 AN UNANSWERED TURN IS NOT A MISSING NUMBER. The restaurant did not wait zero; it waited the
 * whole time the venue gave the agent (`replyWaitMs`), and then spoke again into silence. It is
 * charged that wait in the first-audio percentiles, so a deaf agent cannot pass by saying nothing.
 */

import { LATENCY_PERCENTILES } from '../tuning/liveDefaults.ts';
import type { CorpusCallOutcome } from './corpus.ts';
import { rank } from './corpus.ts';

export interface SoakGate {
    p50FirstAudioMs: number;
    p90FirstAudioMs: number;
    /** `start` to the first audible frame of the disclosure, on a cold instance. */
    coldStartMs: number;
}

export interface SoakCall {
    id: string;
    outcome: CorpusCallOutcome;
}

export type Percentiles = Record<'p50' | 'p90' | 'p99', number | null>;

export interface SoakSummary {
    calls: number;
    callsThatSpoke: number;
    turns: number;
    unansweredTurns: number;
    /** Turns the server ended the call on before an answer was due: excluded from first audio. */
    endedByServerTurns: number;
    /** End of the venue's speech to the agent's first audio, unanswered turns charged the wait. */
    firstAudio: Percentiles & { max: number | null };
    /** `start` to the first audible frame (the disclosure), every call that spoke. */
    startToFirstAudio: Percentiles & { max: number | null };
    longestSilence: Percentiles & { max: number | null };
    /** Turns whose first audio was over 2 s, and over 4 s. */
    turnsOver2s: number;
    turnsOver4s: number;
    framesAfterStop: number;
    /** The cold-start reading the gate was held to, or null when none was taken. */
    coldStartMs: number | null;
    gate: { pass: boolean; failures: string[] };
}

export interface SummariseOptions {
    /** The venue's wait for an answer: what an unanswered turn is charged. Default 8000. */
    replyWaitMs?: number;
    /** Start to first audio on a cold instance or process. Absent: the gate says it was not measured. */
    coldStartMs?: number | null;
}

function pct(values: ReadonlyArray<number | null>): Percentiles & { max: number | null } {
    const out = { p50: null, p90: null, p99: null, max: null } as Percentiles & { max: number | null };
    for (const p of LATENCY_PERCENTILES) out[`p${p}` as 'p50' | 'p90' | 'p99'] = rank(values, p);
    const xs = values.filter((v): v is number => v !== null);
    out.max = xs.length ? Math.max(...xs) : null;
    return out;
}

export function summarise(calls: readonly SoakCall[], gate: SoakGate, options: SummariseOptions = {}): SoakSummary {
    const replyWaitMs = options.replyWaitMs ?? 8000;
    const all = calls.flatMap((c) => c.outcome.turns);
    // A turn the server ended the call on is not dead air: the call was over, by design or refusal.
    const turns = all.filter((t) => !t.endedByServer);
    const charged = turns.map((t) => t.firstAudioMs ?? replyWaitMs);
    const firstAudio = pct(charged);
    const spoke = calls.filter((c) => c.outcome.startToFirstAudioMs !== null);
    const coldStartMs = options.coldStartMs ?? null;

    const failures: string[] = [];
    if (!turns.length) failures.push('no venue turn was played: nothing was measured');
    if (firstAudio.p50 !== null && firstAudio.p50 > gate.p50FirstAudioMs) {
        failures.push(`p50 first audio ${firstAudio.p50} ms > ${gate.p50FirstAudioMs} ms`);
    }
    if (firstAudio.p90 !== null && firstAudio.p90 > gate.p90FirstAudioMs) {
        failures.push(`p90 first audio ${firstAudio.p90} ms > ${gate.p90FirstAudioMs} ms`);
    }
    if (coldStartMs === null) failures.push('cold start to the disclosure was not measured');
    else if (coldStartMs > gate.coldStartMs) failures.push(`cold start to the disclosure ${coldStartMs} ms > ${gate.coldStartMs} ms`);
    const after = calls.reduce((n, c) => n + c.outcome.framesAfterStop, 0);
    if (after > 0) failures.push(`${after} audible frame(s) after the venue hung up`);

    return {
        calls: calls.length,
        callsThatSpoke: spoke.length,
        turns: turns.length,
        unansweredTurns: turns.filter((t) => t.firstAudioMs === null).length,
        endedByServerTurns: all.length - turns.length,
        firstAudio,
        startToFirstAudio: pct(spoke.map((c) => c.outcome.startToFirstAudioMs)),
        longestSilence: pct(calls.map((c) => c.outcome.longestSilenceMs)),
        turnsOver2s: charged.filter((v) => v > 2000).length,
        turnsOver4s: charged.filter((v) => v > 4000).length,
        framesAfterStop: after,
        coldStartMs,
        gate: { pass: failures.length === 0, failures },
    };
}

/**
 * How closely a transcript of what the agent said holds the disclosure sentence: the share of the
 * sentence's words heard, in order-free bag terms, case and punctuation folded. 1 is every word.
 */
export function disclosureRecall(expected: string, heard: string): number {
    const words = (s: string): string[] => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
    const want = words(expected);
    if (!want.length) return 0;
    const got = new Map<string, number>();
    for (const w of words(heard)) got.set(w, (got.get(w) ?? 0) + 1);
    let hit = 0;
    for (const w of want) {
        const n = got.get(w) ?? 0;
        if (n > 0) {
            hit += 1;
            got.set(w, n - 1);
        }
    }
    return hit / want.length;
}
