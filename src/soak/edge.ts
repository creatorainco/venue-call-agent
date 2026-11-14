/**
 * `npm run soak:edge` — the safety soak at the edge (TASK-3749 step 3, the 3-call soak, and VCA-12).
 *
 *     SOAK_TOKEN=<token> npm run soak:edge -- --url=https://<service> --legs=3 --expect=refused --bogus
 *     SOAK_TOKEN=mock:happy npm run soak:edge -- --url=http://127.0.0.1:8080 --legs=3 --expect=accepted-silent
 *
 * Runs `--legs` Twilio-shaped legs with the token in `SOAK_TOKEN` (an env var, so it is never in a
 * shell history or a process list), then, with `--bogus`, the five sockets a stranger might send.
 * Legs run one after another: the service takes one call per instance, and a soak that opened them
 * together would be measuring the autoscaler. After every leg it asks `GET /health`, so "the
 * process stayed up" is a reading, not an inference. Prints one JSON document and exits 1 if any
 * leg failed its expectation or a health read was not 200.
 *
 * It places no call: no carrier is involved, only a WebSocket to the URL given.
 */

import { BOGUS_KINDS, judge, runLeg } from './driver.ts';
import type { LegKind, LegOutcome } from './driver.ts';
import { isEntryPoint } from '../harness/fixtures.ts';

export interface EdgeSoakOptions {
    baseUrl: string;
    token?: string;
    legs: number;
    bogus: boolean;
    expect: 'refused' | 'accepted-silent';
    mediaMs?: number;
    timeoutMs?: number;
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
        const healthAfter = await health(healthUrl.toString());
        if (healthAfter !== 200) verdict.why.push(`health after the leg answered ${healthAfter}`);
        const pass = verdict.why.length === 0;
        report.rows.push({ leg: step.leg, expect: step.expect, outcome, pass, why: verdict.why, healthAfter });
        if (!pass) report.pass = false;
    }
    return report;
}

async function health(url: string): Promise<number> {
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        return res.status;
    } catch {
        return 0;
    }
}

function flag(name: string): string | undefined {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    if (hit) return hit.slice(name.length + 3);
    return process.argv.includes(`--${name}`) ? 'true' : undefined;
}

if (isEntryPoint(import.meta.url)) {
    const url = flag('url');
    const expect = flag('expect') ?? 'refused';
    if (!url || (expect !== 'refused' && expect !== 'accepted-silent')) {
        process.stderr.write('usage: SOAK_TOKEN=<token> npm run soak:edge -- --url=<base> [--legs=3] [--expect=refused|accepted-silent] [--bogus] [--media-ms=3000]\n');
        process.exit(2);
    }
    const legs = Number.parseInt(flag('legs') ?? '3', 10);
    const token = process.env.SOAK_TOKEN?.trim();
    if (legs > 0 && !token) {
        process.stderr.write('SOAK_TOKEN is not set; a Twilio-shaped leg needs a token.\n');
        process.exit(2);
    }
    const mediaMs = flag('media-ms');
    const report = await runEdgeSoak({
        baseUrl: url,
        ...(token ? { token } : {}),
        legs,
        bogus: flag('bogus') === 'true',
        expect,
        ...(mediaMs ? { mediaMs: Number.parseInt(mediaMs, 10) } : {}),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(report.pass ? 0 : 1);
}
