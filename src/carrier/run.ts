/**
 * `npm run call` — every recorded conversation, run as a telephone call, against nobody.
 *
 * No phone, no carrier, no cloud account, no credential. The clock is virtual, so every recorded
 * conversation, each several minutes long, finishes in about a second and comes out
 * bit-identical on every machine.
 *
 *     npm run call                          every fixture, with the pinned turn-detector settings
 *     npm run call -- --only=who            just the fixtures whose name contains "who"
 *     npm run call -- --latency=900         assume the model takes 900ms to produce its first byte
 *     npm run call -- --sweep=400,600,800,1000,1200
 *                                           docs/TUNING.md §3.3, as a command instead of a plan
 *     npm run call -- --verbose             the turn-by-turn timeline of each call
 *
 * 🔴 WHAT THIS IS AND IS NOT. It measures turn-taking and transport: how long the restaurant
 * waits, whether we talk over an interruption, whether the audio stops when the line does. It
 * does NOT measure the model — there isn't one — and it does not contain a carrier, jitter, or a
 * kitchen. A number from here is a floor and a way to compare two settings. Reporting one as
 * "our latency" would be the sort of claim `docs/WHAT-CANNOT-BE-TESTED.md` exists to prevent.
 */

import { isEntryPoint, loadFixtures } from '../harness/fixtures.ts';
import { score, rubricControl } from '../eval/rubric.ts';
import { agentFactory } from '../eval/run.ts';
import { VAD } from '../tuning/liveDefaults.ts';
import { audioCall, percentiles } from './call.ts';
import type { AudioReport } from './call.ts';
import { audioChecks, audioControl } from './checks.ts';
import type { VadSettings } from './vad.ts';

function arg(name: string): string | undefined {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit?.slice(name.length + 3);
}
const has = (name: string) => process.argv.includes(`--${name}`);

export interface CallRunOptions {
    agent?: string;
    only?: string;
    latencyMs?: number;
    vad?: VadSettings;
}

export async function runCalls(options: CallRunOptions = {}) {
    const fixtures = loadFixtures(options.only);
    const make = agentFactory(options.agent ?? 'stub');
    const rows = [];
    for (const fixture of fixtures) {
        const result = await audioCall(fixture, make, {
            ...(options.vad ? { vad: options.vad } : {}),
            ...(options.latencyMs === undefined ? {} : { modelLatencyMs: options.latencyMs }),
        });
        rows.push({
            fixture,
            audio: result.audio,
            score: score(result.replay),
            checks: audioChecks(result.audio),
            transcript: result.replay.transcript,
        });
    }
    return rows;
}

function pad(s: string, n: number): string {
    return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

export function summarise(reports: readonly AudioReport[]) {
    const all = reports.flatMap((r) => r.deadAirMs);
    return {
        calls: reports.length,
        turns: all.length,
        pct: percentiles(all),
        max: all.length ? Math.max(...all) : 0,
        talkOver: reports.reduce((n, r) => n + r.talkOverFrames, 0),
        overSegmented: reports.reduce((n, r) => n + r.overSegmented, 0),
        afterHangup: reports.reduce((n, r) => n + r.writtenAfterHangup, 0),
    };
}

if (isEntryPoint(import.meta.url)) {
    // 🔴 The control, before any number is printed. Same law as the eval: a grader that cannot
    // catch a planted fault reports every call as fine, and somebody quotes it.
    const brokenAudio = audioControl();
    if (brokenAudio) {
        console.error('FAIL call — THE AUDIO GRADER IS BROKEN, so no measurement is reported.');
        console.error(`  ${brokenAudio}`);
        process.exit(2);
    }

    const only = arg('only');
    const agentKind = arg('agent') ?? 'stub';
    const latencyMs = arg('latency') ? Number.parseInt(arg('latency')!, 10) : 0;
    const sweep = arg('sweep');
    const verbose = has('verbose');

    if (sweep) {
        const values = sweep.split(',').map((v) => Number.parseInt(v.trim(), 10)).filter((n) => Number.isFinite(n));
        if (!values.length) {
            console.error('--sweep needs a comma-separated list of milliseconds, e.g. --sweep=400,800,1200');
            process.exit(64);
        }

        console.log('Turn-detector sweep — docs/TUNING.md §3.3.\n');
        console.log(`Model latency assumed: ${latencyMs}ms. Dead air below is what the far end waits`);
        console.log('from their last audible sound to our next one: the detector plus that latency');
        console.log('plus the seam round trip. It is NOT a prediction of a real call.\n');
        console.log(`  ${pad('silence', 9)}${pad('p50', 8)}${pad('p90', 8)}${pad('p99', 8)}${pad('max', 8)}${pad('talk-over', 11)}over-segmented`);

        for (const silenceDurationMs of values) {
            const vad: VadSettings = { ...VAD, silenceDurationMs };
            const rows = await runCalls({ agent: agentKind, ...(only ? { only } : {}), latencyMs, vad });
            const s = summarise(rows.map((r) => r.audio));
            console.log(
                `  ${pad(`${silenceDurationMs}ms`, 9)}${pad(`${s.pct.p50 ?? 0}`, 8)}${pad(`${s.pct.p90 ?? 0}`, 8)}`
                + `${pad(`${s.pct.p99 ?? 0}`, 8)}${pad(`${s.max}`, 8)}${pad(`${s.talkOver}f`, 11)}${s.overSegmented}`,
            );
        }

        console.log('\nHow to read it. Dead air rises roughly one-for-one with the setting, because the');
        console.log('detector waits that long before it believes the turn is over. Over-segmentation is');
        console.log('the cost of going lower: an utterance cut in two, answered twice. The right value is');
        console.log('the smallest one whose over-segmented column is still zero — and then a REAL');
        console.log('measurement, because Google\'s detector is not this one. See src/carrier/vad.ts.');
        process.exit(0);
    }

    const rows = await runCalls({
        agent: agentKind,
        ...(only ? { only } : {}),
        latencyMs,
    });

    const brokenRubric = rubricControl(rows.map((r) => r.score));
    if (brokenRubric) {
        console.error('FAIL call — THE TRANSCRIPT GRADER IS BROKEN, so no score is reported.');
        console.error(`  ${brokenRubric}`);
        process.exit(2);
    }

    console.log(`venue-call-agent audio calls — agent: ${agentKind}, ${rows.length} call(s), model latency ${latencyMs}ms\n`);
    console.log(`  ${pad('fixture', 26)}${pad('turns', 8)}${pad('dead air p50/max', 19)}${pad('talk-over', 11)}verdict`);

    let hard = 0;
    let soft = 0;
    for (const row of rows) {
        const a = row.audio;
        const failedHard = [
            ...row.checks.filter((c) => c.severity === 'hard' && !c.passed).map((c) => c.id),
            ...row.score.checks.filter((c) => c.severity === 'hard' && !c.passed && !c.skipped).map((c) => c.name),
        ];
        const failedSoft = [
            ...row.checks.filter((c) => c.severity === 'soft' && !c.passed).map((c) => c.id),
            ...row.score.checks.filter((c) => c.severity === 'soft' && !c.passed && !c.skipped).map((c) => c.name),
        ];
        hard += failedHard.length;
        soft += failedSoft.length;

        const p50 = a.percentiles.p50 ?? 0;
        console.log(
            `  ${pad(row.fixture.name, 26)}${pad(`${a.detectedTurns}/${a.scriptedTurns}`, 8)}`
            + `${pad(`${p50}ms / ${a.maxDeadAirMs}ms`, 19)}${pad(`${a.talkOverFrames}f`, 11)}`
            + (failedHard.length ? `HARD: ${failedHard.join(', ')}` : failedSoft.length ? `soft: ${failedSoft.join(', ')}` : 'clean'),
        );

        if (verbose) {
            console.log(`      ${row.fixture.about}`);
            console.log(`      vad: ${a.vad}`);
            console.log(`      call ${a.callMs}ms · ended ${a.endedBecause} · opening ${a.openingDelayMs}ms `
                + `· ${a.audibleOutFrames}/${a.framesOut} outbound frames audible · ${a.clearedFrames} cleared`);
            for (const line of row.transcript.lines) console.log(`      ${pad(line.who, 7)} ${line.text}`);
            console.log('');
        }
    }

    const s = summarise(rows.map((r) => r.audio));
    console.log(`\n  across ${s.calls} call(s), ${s.turns} answered turn(s):`);
    console.log(`  dead air  p50 ${s.pct.p50 ?? 0}ms · p90 ${s.pct.p90 ?? 0}ms · p99 ${s.pct.p99 ?? 0}ms · max ${s.max}ms   (no mean, on purpose)`);
    console.log(`  talk-over ${s.talkOver} frame(s) · over-segmented ${s.overSegmented} · after hangup ${s.afterHangup}`);
    console.log(`\n${hard} hard failure(s) · ${soft} soft failure(s)`);

    if (hard) {
        console.error('\nA hard failure is something a call must never do. See src/carrier/checks.ts');
        console.error('and src/eval/rubric.ts for what each id means.');
        process.exit(1);
    }
}
