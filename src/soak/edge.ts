/**
 * The safety soak at the edge (TASK-3749 step 3, the 3-call soak, and VCA-12). The command is
 * `npm run soak:edge` (`scripts/soak-edge.mjs`), which supplies the health reader: `src/` makes no
 * network request outside the three adapters (test/importBoundary.test.ts), so this file is handed
 * one.
 *
 * Runs `legs` Twilio-shaped legs with the token given, then, with `bogus`, the five sockets a
 * stranger might send. Legs run one after another: the service takes one call per instance, and a
 * soak that opened them together would be measuring the autoscaler. After every leg it reads the
 * health endpoint, so "the process stayed up" is a reading, not an inference.
 *
 * It places no call: no carrier is involved, only a WebSocket to the URL given.
 */

import { BOGUS_KINDS, judge, runLeg } from './driver.ts';
import type { LegKind, LegOutcome } from './driver.ts';

export interface EdgeSoakOptions {
    baseUrl: string;
    token?: string;
    legs: number;
    bogus: boolean;
    expect: 'refused' | 'accepted-silent';
    mediaMs?: number;
    timeoutMs?: number;
    /** Reads the health endpoint and answers its HTTP status, or 0 if it could not be reached. */
    health: (url: string) => Promise<number>;
}

export interface EdgeSoakRow {
    leg: string;
    expect: 'refused' | 'accepted-silent';
    outcome: LegOutcome;
    pass: boolean;
    why: string[];
    healthAfter: number;
}

export interface EdgeSoakReport {
    target: string;
    startedAt: string;
    rows: EdgeSoakRow[];
    pass: boolean;
}

export async function runEdgeSoak(options: EdgeSoakOptions): Promise<EdgeSoakReport> {
    const base = new URL(options.baseUrl);
    const wsUrl = new URL('/stream', base);
    wsUrl.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    const healthUrl = new URL('/health', base);
    healthUrl.protocol = base.protocol === 'wss:' ? 'https:' : base.protocol === 'ws:' ? 'http:' : base.protocol;

    const plan: Array<{ leg: string; kind: LegKind; expect: 'refused' | 'accepted-silent' }> = [];
    for (let i = 1; i <= options.legs; i += 1) plan.push({ leg: `call-${i}`, kind: 'twilio', expect: options.expect });
    if (options.bogus) for (const kind of BOGUS_KINDS) plan.push({ leg: `bogus-${kind}`, kind, expect: 'refused' });

    const report: EdgeSoakReport = { target: base.origin, startedAt: new Date().toISOString(), rows: [], pass: true };
    for (const step of plan) {
        const outcome = await runLeg(wsUrl.toString(), {
            kind: step.kind,
            ...(step.kind === 'twilio' && options.token ? { token: options.token } : {}),
            ...(options.mediaMs !== undefined ? { mediaMs: options.mediaMs } : {}),
            ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        });
        const verdict = judge(outcome, step.expect);
        const healthAfter = await options.health(healthUrl.toString());
        if (healthAfter !== 200) verdict.why.push(`health after the leg answered ${healthAfter}`);
        const pass = verdict.why.length === 0;
        report.rows.push({ leg: step.leg, expect: step.expect, outcome, pass, why: verdict.why, healthAfter });
        if (!pass) report.pass = false;
    }
    return report;
}
