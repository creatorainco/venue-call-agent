/**
 * NO TRANSCRIPT IN THE LOGS (TASK-3750 slice 1a, the venue-call-agent half of the log guard).
 *
 * Cloud Run keeps stdout and stderr in Cloud Logging for 30 days, readable by anyone with the
 * project's log viewer role, and nothing purges a line early. The transcript has a home with a
 * 90-day expiry in platform-backend (`reservation_call_transcripts`, TASK-3753) and that is the
 * ONLY home it may have. So a log line here carries event words, ids, counts and class names, and
 * never a word anybody said: not the venue's, not the agent's, not a sentence the backend handed
 * over to be spoken (those carry the creator's name and the booking).
 *
 * Two layers:
 *  1. Dynamic. Every fixture is run as an audio call with both agents, and every sink a line can
 *     reach (the `log` option, process.stdout, process.stderr, console) is captured. No captured
 *     line may contain any venue turn, any spoken sentence, or any sentence the seam allowed.
 *  2. Static. No `log(...)` call in the runtime source interpolates a variable whose name says it
 *     holds speech. The dynamic layer only sees the paths the fixtures walk; this sees the rest.
 *
 * `src/carrier/run.ts` (the `npm run call --verbose` developer report) prints transcripts on
 * purpose and never runs in the service, so it is outside both layers. So are `src/mock`,
 * `src/eval` and `src/harness`, which are test tooling.
 *
 * Sabotage controls, recorded in the PR, one per layer, both in the intent line of
 * `src/agent/cascadeAgent.ts`: append `${utterance}` and the static layer goes red; append it
 * through an innocently named alias (`const u = utterance`) and the dynamic layer goes red.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCascadeAgent } from '../src/agent/cascadeAgent.ts';
import { createKeywordClassifier } from '../src/agent/intent.ts';
import { createScriptedStub } from '../src/agent/scriptedStub.ts';
import { audioCall } from '../src/carrier/call.ts';
import { loadFixtures } from '../src/harness/fixtures.ts';
import type { AgentFactory } from '../src/harness/replay.ts';

/** Shorter strings ("yes", "no", "hello") are words, not utterances; they collide with event names. */
const MIN_UTTERANCE_CHARS = 12;

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * The agents with their own `log` wired to the same sink, as `src/agent/cascade.ts` wires it in
 * the service. The eval factories leave it a no-op, which would hide the agent's lines from this
 * test (measured: a planted utterance in the intent line passed until this was wired).
 */
const AGENTS: Record<'stub' | 'cascade', (log: (line: string) => void) => AgentFactory> = {
    stub: () => ({ seam }) => createScriptedStub({ seam }),
    cascade: (log) => ({ seam }) => createCascadeAgent({ seam, intents: createKeywordClassifier(), log }),
};

/**
 * Run `body` with every log sink captured. Writes still pass through, so the test reporter (which
 * shares stdout with the code under test) keeps working.
 */
async function capturing<T>(body: (log: (line: string) => void) => Promise<T>): Promise<{ result: T; lines: string[] }> {
    const lines: string[] = [];
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    const saved = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
    const grab = (chunk: unknown) => { lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8')); };
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => { grab(chunk); return (out as (...a: unknown[]) => boolean)(chunk, ...rest); }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => { grab(chunk); return (err as (...a: unknown[]) => boolean)(chunk, ...rest); }) as typeof process.stderr.write;
    for (const k of Object.keys(saved) as Array<keyof typeof saved>) {
        console[k] = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    }
    try {
        const result = await body((line) => { lines.push(line); });
        return { result, lines };
    } finally {
        process.stdout.write = out as typeof process.stdout.write;
        process.stderr.write = err as typeof process.stderr.write;
        Object.assign(console, saved);
    }
}

describe('no transcript in the logs: every fixture, both agents, every sink', () => {
    const fixtures = loadFixtures();

    for (const agent of ['stub', 'cascade'] as const) {
        it(`🔴 ${agent}: no log line carries anything anybody said`, async () => {
            let checkedUtterances = 0;
            let capturedLines = 0;
            for (const fixture of fixtures) {
                const { result, lines } = await capturing((log) => audioCall(fixture, AGENTS[agent](log), { log }));
                const said = new Set<string>();
                for (const s of [...fixture.turns, ...result.replay.transcript.spoken, ...result.replay.allowedSentences]) {
                    if (s.trim().length >= MIN_UTTERANCE_CHARS) said.add(norm(s));
                }
                checkedUtterances += said.size;
                capturedLines += lines.length;
                const logged = lines.map(norm);
                for (const s of said) {
                    const hit = logged.find((l) => l.includes(s));
                    assert.equal(hit, undefined, `${fixture.name}: a log line carries what was said:\n  said:   ${s}\n  logged: ${hit}`);
                }
            }
            // A guard that captured nothing, or checked nothing, passes while proving nothing.
            assert.ok(checkedUtterances >= fixtures.length * 2, `only ${checkedUtterances} utterances checked`);
            assert.ok(capturedLines > 0, 'no log line was captured at all: the capture is not wired');
        });
    }

    it('the capture is live: a planted line with a venue turn is caught', async () => {
        const turn = loadFixtures().flatMap((f) => f.turns).find((t) => t.length >= MIN_UTTERANCE_CHARS);
        assert.ok(turn, 'no fixture turn long enough to plant');
        const { lines } = await capturing(async () => { console.error(`planted ${turn}`); });
        assert.ok(lines.map(norm).some((l) => l.includes(norm(turn))), 'the capture missed a console.error line');
    });
});

const RUNTIME_DIRS = ['src/agent', 'src/audio', 'src/carrier', 'src/google', 'src/seam', 'src/server', 'src/speech'];
const NOT_RUNTIME = new Set(['src/carrier/run.ts']);
/** An interpolated expression whose name says it holds speech. */
const SPEECH_NAME = /\b(text|texts|utterance|utterances|sentence|sentences|spoken|transcript|transcripts|said|heard|words|turn\.text|line\.text|reply|replies|answer\.sentence|prompt)\b/i;
/** A log sink: `log(`, `this.log(`, `console.x(`, `process.stdout/stderr.write(`. */
const LOG_CALL = /(?:\blog|console\.(?:log|error|warn|info|debug)|process\.std(?:out|err)\.write)\(\s*`([^`]*)`/g;

function* tsFiles(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) yield* tsFiles(p);
        else if (p.endsWith('.ts')) yield p;
    }
}

describe('no transcript in the logs: the log call sites', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));

    it('🔴 no runtime log call interpolates a variable named for speech', () => {
        const offenders: string[] = [];
        let sites = 0;
        for (const dir of RUNTIME_DIRS) {
            for (const file of tsFiles(join(root, dir))) {
                const rel = relative(root, file).replaceAll('\\', '/');
                if (NOT_RUNTIME.has(rel)) continue;
                const src = readFileSync(file, 'utf8');
                for (const m of src.matchAll(LOG_CALL)) {
                    sites += 1;
                    const template = m[1] ?? '';
                    for (const expr of template.matchAll(/\$\{([^}]*)\}/g)) {
                        if (SPEECH_NAME.test(expr[1] ?? '')) offenders.push(`${rel}: \`${template}\``);
                    }
                }
            }
        }
        assert.ok(sites >= 10, `only ${sites} log call sites found: the scan is not reading the source`);
        assert.deepEqual(offenders, [], 'a log line interpolates speech');
    });
});
