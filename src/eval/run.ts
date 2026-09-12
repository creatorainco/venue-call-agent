/**
 * `npm run eval` — run every recorded conversation and grade it.
 *
 * No phone, no cloud account, no booking, no audio. Fourteen calls in about a second.
 *
 *     npm run eval                    every fixture, against the reference stub
 *     npm run eval -- --only=who      just the fixtures whose name contains "who"
 *     npm run eval -- --verbose       print the full transcript of each call
 *     npm run eval -- --agent=live    against the real agent, once TASK-970 builds one
 *
 * 🔴 IT REFUSES TO REPORT A SCORE IT CANNOT VOUCH FOR. Before grading anything it runs the
 * rubric's own control, and if the fabrication checker cannot catch a planted invention — or if
 * every check turned out to be skipped — the run fails and prints no score at all. A number from
 * a broken grader is worse than no number, because somebody will quote it.
 */

import { replay, type AgentFactory } from '../harness/replay.ts';
import { isEntryPoint, loadFixtures } from '../harness/fixtures.ts';
import { score, rubricControl, type FixtureScore } from './rubric.ts';
import { createScriptedStub } from '../agent/scriptedStub.ts';

function arg(name: string): string | undefined {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit?.slice(name.length + 3);
}
const has = (name: string) => process.argv.includes(`--${name}`);

/**
 * Which brain to grade.
 *
 * `stub` is the keyword matcher in `src/agent/scriptedStub.ts` — no model, no audio, and the
 * baseline the real agent has to beat. `live` is TASK-970 and does not exist yet; it fails loudly
 * rather than silently falling back, because a silent fallback would report the stub's score under
 * the real agent's name.
 */
export function agentFactory(kind: string): AgentFactory {
    if (kind === 'stub') return ({ seam }) => createScriptedStub({ seam });
    throw new Error(
        `no agent named "${kind}". Only "stub" exists today; "live" is TASK-970. ` +
        'Wire it in src/eval/run.ts when it lands, and keep the stub so the two can be compared.',
    );
}

export async function runEval(options: { agent?: string; only?: string; verbose?: boolean } = {}) {
    const fixtures = loadFixtures(options.only);
    const make = agentFactory(options.agent ?? 'stub');

    const scores: FixtureScore[] = [];
    for (const fixture of fixtures) {
        scores.push(score(await replay(fixture, make)));
    }
    return { fixtures, scores };
}

// ── the report ───────────────────────────────────────────────────────────────

// ⚠️ `isEntryPoint`, not a string test on argv[1]. The first version of this check ended
// `|| argv[1].endsWith('run.ts')`, and there are TWO files called run.ts in this repo — so
// `npm run harness` printed the whole eval instead of one transcript.
if (isEntryPoint(import.meta.url)) {
    const agentKind = arg('agent') ?? 'stub';
    const verbose = has('verbose');
    const only = arg('only');

    const { scores } = await runEval({ agent: agentKind, ...(only ? { only } : {}), verbose });

    // 🔴 The control, before any verdict.
    const broken = rubricControl(scores);
    if (broken) {
        console.error('FAIL eval — THE GRADER IS BROKEN, so no score is reported.');
        console.error(`  ${broken}`);
        console.error('\n  A checker that cannot catch a planted fault reports every call as clean.');
        console.error('  Fix src/eval/fabrication.ts or src/eval/rubric.ts before trusting a number.');
        process.exit(2);
    }

    console.log(`venue-call-agent eval — agent: ${agentKind}, ${scores.length} conversation(s)\n`);

    let hard = 0;
    let soft = 0;
    for (const s of scores) {
        const mark = s.hardFailures ? '✗' : s.softFailures ? '~' : '✓';
        console.log(`${mark} ${s.fixture}  (${s.elapsedMs.toFixed(0)}ms)`);
        console.log(`    ${s.about}`);
        for (const c of s.checks) {
            if (c.skipped) continue;
            if (c.passed && !verbose) continue;
            const tag = c.passed ? 'ok  ' : c.severity === 'hard' ? 'HARD' : 'soft';
            console.log(`    [${tag}] ${c.name} — ${c.detail}`);
        }
        if (verbose) {
            console.log(`    quoted ${s.fabrication.quoted}/${s.fabrication.spoken}, glue ${s.fabrication.glue.length}`);
        }
        hard += s.hardFailures;
        soft += s.softFailures;
        console.log('');
    }

    const clean = scores.filter((s) => !s.hardFailures && !s.softFailures).length;
    console.log('─'.repeat(72));
    console.log(`${clean}/${scores.length} conversations clean · ${hard} hard failure(s) · ${soft} soft failure(s)`);
    console.log('');
    console.log('A hard failure is a defect: the call did something it must never do.');
    console.log('A soft failure is a judgement: the call was worse than we want it to be.');
    console.log('CI fails on hard only. Do not average the two into one number.');

    process.exit(hard ? 1 : 0);
}
