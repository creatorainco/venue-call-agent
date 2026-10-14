/**
 * Numbers printed in the documentation must be numbers this repository still produces.
 *
 * WHY THIS EXISTS, WITH THE DATE. On 2026-09-12 an adversarial review ran the commands the docs
 * print and compared the output to the tables beside them. Three findings, all the same shape:
 *
 *   - `docs/TUNING.md` published a sweep reading taken with fourteen fixtures, in the commit that
 *     added the fifteenth. Eight of its twelve cells did not reproduce, including the zeros the
 *     surrounding paragraph draws its conclusion from.
 *   - Four places said "144 tests" while the suite ran 146, bumped in the same commit whose
 *     message said 146.
 *   - Eleven places still said "fourteen conversations".
 *
 * Every one was written by somebody who had just run the command. The number was true when it was
 * typed and false by the time it was committed, and nothing anywhere could tell.
 *
 * 🔴 THE RULE THIS ENCODES. A number in a document is a claim about the software, so either a
 * machine checks it or it does not go in. Two ways to satisfy that, both used here:
 *
 *   COUNT IT   — the conversation count, the sweep table and the prose drawn from it, the
 *                `--latency=900` expected output, the refusal and scenario counts, the token and
 *                call lifetimes, and the Gemini model ids and shutdown date are recomputed or
 *                read from the source and compared.
 *   DROP IT    — the test count is not published anywhere any more. It changes on every
 *                contribution, it tells a reader nothing they cannot get from `npm test`, and
 *                the line that actually matters — `# fail 0` — never rots.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { loadFixtures } from '../src/harness/fixtures.ts';
import { runCalls, summarise } from '../src/carrier/run.ts';
import { DEAD_AIR_HARD_MS } from '../src/carrier/checks.ts';
import { SEAM_REFUSAL_REASONS } from '../src/seam/types.ts';
import {
    LIVE_MODEL,
    LIVE_MODEL_REPLACEMENT,
    LIVE_MODEL_SHUTDOWN,
    LIVE_MODEL_UNDER_SUSPICION,
    MAX_CALL_SECONDS,
    VAD,
} from '../src/tuning/liveDefaults.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Every page a person reads. Not the source; comments are prose and are allowed to be prose. */
const PAGES = ['README.md', 'ONBOARDING.md', 'CONTRIBUTING.md', 'CLAUDE.md',
    'docs/TUNING.md', 'docs/LIMITS.md', 'docs/WHAT-CANNOT-BE-TESTED.md',
    'docs/TEST-ENVIRONMENT.md', 'docs/DEPLOY.md', 'test/fixtures/README.md'];

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const SPELLED: Record<number, string> = {
    12: 'twelve', 13: 'thirteen', 14: 'fourteen', 15: 'fifteen', 16: 'sixteen',
    17: 'seventeen', 18: 'eighteen', 19: 'nineteen', 20: 'twenty',
};

/** Every small number a page might spell out, word -> value. */
const WORDS: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
    eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, sixty: 60,
};
const NUMBER = `(\\d[\\d,]*|${Object.keys(WORDS).join('|')})`;
/** A matched number, digits or spelled; a group that did not match reads as NaN and so never agrees. */
const valueOf = (token: string | undefined): number =>
    token === undefined ? NaN : WORDS[token.toLowerCase()] ?? Number(token.replace(/,/g, ''));

describe('the conversation count', () => {
    const actual = readdirSync(join(ROOT, 'test/fixtures/conversations')).filter((f) => f.endsWith('.json')).length;

    it('is what the loader loads', () => {
        assert.equal(loadFixtures().length, actual);
        assert.ok(actual >= 15, `only ${actual} conversations; the set has shrunk`);
    });

    it('is what every page says it is', () => {
        const wrong: string[] = [];
        for (const page of PAGES) {
            const text = read(page);
            // "15 conversations", "15 recorded conversations", and `across 15 call(s)` — the
            // runner's own line, which pages quote as expected output.
            //
            // Deliberately NOT a bare `\d+ calls`: "thirty five-minute calls a day" in a cost
            // estimate is not a claim about the fixture set, and a guard that fires on ordinary
            // prose is a guard somebody switches off.
            for (const m of text.matchAll(/(\d+)\s+(?:recorded\s+|whole\s+|scored\s+)?conversations?\b|across\s+(\d+)\s+calls?\b/gi)) {
                const n = Number(m[1] ?? m[2]);
                if (n !== actual) wrong.push(`${page}: "${m[0]}" — there are ${actual}`);
            }
            // "15/15 conversations clean"
            for (const m of text.matchAll(/(\d+)\/(\d+)\s+conversations/gi)) {
                if (Number(m[1]) !== actual || Number(m[2]) !== actual) {
                    wrong.push(`${page}: "${m[0]}" — there are ${actual}`);
                }
            }
            // "fourteen conversations", spelled out
            for (const [n, word] of Object.entries(SPELLED)) {
                if (Number(n) === actual) continue;
                const re = new RegExp(`\\b${word}\\s+(?:conversations?|calls?)\\b`, 'gi');
                for (const m of text.matchAll(re)) {
                    wrong.push(`${page}: "${m[0]}" — there are ${actual} (${SPELLED[actual] ?? actual})`);
                }
            }
        }
        assert.deepEqual(wrong, [], `stale conversation counts:\n  ${wrong.join('\n  ')}`);
    });

    it('CONTROL — the scanner can see a stale count', () => {
        const planted = `We run ${actual + 1} conversations, all fourteen of them, across ${actual + 3} calls, `
            + `${actual + 2}/${actual + 2} conversations clean.`;
        let caught = 0;
        for (const m of planted.matchAll(/(\d+)\s+(?:recorded\s+|whole\s+|scored\s+)?conversations?\b|across\s+(\d+)\s+calls?\b/gi)) {
            if (Number(m[1] ?? m[2]) !== actual) caught += 1;
        }
        // And the false-positive direction, which is the one that gets a guard deleted: an
        // ordinary sentence about cost must NOT be read as a claim about the fixture set.
        for (const _ of 'thirty five-minute calls a day, 30 calls a month'
            .matchAll(/(\d+)\s+(?:recorded\s+|whole\s+|scored\s+)?conversations?\b|across\s+(\d+)\s+calls?\b/gi)) {
            assert.fail('the scanner read a cost estimate as a fixture count');
        }
        for (const m of planted.matchAll(/(\d+)\/(\d+)\s+conversations/gi)) {
            if (Number(m[1]) !== actual) caught += 1;
        }
        if (actual !== 14) {
            for (const _ of planted.matchAll(/\bfourteen\s+(?:conversations?|calls?)\b/gi)) caught += 1;
        }
        assert.ok(caught >= 4, `the scanner found only ${caught} of 4 planted stale counts`);
    });
});

describe('the test count', () => {
    it('is published nowhere, because it rots on every contribution', () => {
        const offenders: string[] = [];
        for (const page of PAGES) {
            const text = read(page);
            for (const m of text.matchAll(/(?:#\s*(?:tests|pass)\s+\d+|\b\d+\s+(?:unit\s+)?tests\b)/gi)) {
                offenders.push(`${page}: "${m[0]}"`);
            }
        }
        assert.deepEqual(
            offenders,
            [],
            'a test count in prose is false by the next contribution. Print `# fail 0` instead — '
            + 'that is the line a reader should check and it never goes stale:\n  '
            + offenders.join('\n  '),
        );
    });
});

describe('the turn-detector sweep table in docs/TUNING.md', () => {
    /**
     * The table is fenced by these markers so the check reads the real thing rather than a regex
     * over a whole page. Move them and this fails loudly, which is the intended behaviour.
     */
    const START = '<!-- SWEEP-TABLE:START -->';
    const END = '<!-- SWEEP-TABLE:END -->';

    interface Row { silenceMs: number; p50: number; talkOver: number; overSegmented: number }

    function published(): Row[] {
        const text = read('docs/TUNING.md');
        const from = text.indexOf(START);
        const to = text.indexOf(END);
        assert.ok(from >= 0 && to > from, 'the sweep table markers are gone from docs/TUNING.md');
        return text.slice(from, to)
            .split('\n')
            .map((line) => line.match(/^\|\s*(\d+)\s*ms\s*\|\s*(\d+)\s*ms\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|/))
            .filter((m): m is RegExpMatchArray => m !== null)
            .map((m) => ({
                silenceMs: Number(m[1]), p50: Number(m[2]), talkOver: Number(m[3]), overSegmented: Number(m[4]),
            }));
    }

    it('has rows, or the parser is broken rather than the table clean', () => {
        assert.ok(published().length >= 4, 'fewer than four rows parsed; the check would pass by blindness');
    });

    it('reproduces, cell for cell, from the command printed above it', async () => {
        const wrong: string[] = [];
        for (const row of published()) {
            const rows = await runCalls({ vad: { ...VAD, silenceDurationMs: row.silenceMs } });
            const s = summarise(rows.map((r) => r.audio));
            const got = { p50: s.pct.p50 ?? 0, talkOver: s.talkOver, overSegmented: s.overSegmented };
            if (got.p50 !== row.p50 || got.talkOver !== row.talkOver || got.overSegmented !== row.overSegmented) {
                wrong.push(
                    `${row.silenceMs}ms: published p50=${row.p50} talk-over=${row.talkOver} `
                    + `over-segmented=${row.overSegmented}, actual p50=${got.p50} talk-over=${got.talkOver} `
                    + `over-segmented=${got.overSegmented}`,
                );
            }
        }
        assert.deepEqual(
            wrong,
            [],
            'the published sweep no longer reproduces. Re-run `npm run call -- --sweep=...` and '
            + 'paste the real numbers — and read the paragraph under the table, because its '
            + 'argument may have changed with them:\n  ' + wrong.join('\n  '),
        );
    });

    it('still shows a cost to going low, or the table argues for the cheapest setting', () => {
        // The paragraph beneath the table concludes that below the knee an utterance gets split.
        // If that column is all zeros the conclusion is unsupported, whatever the numbers say.
        const rows = published();
        assert.ok(
            rows.some((r) => r.overSegmented > 0),
            'no published rung over-segments, so the table shows no cost to a low setting and '
            + 'its conclusion does not follow. Check the fixtures still contain internal pauses.',
        );
        assert.ok(
            rows.some((r) => r.overSegmented === 0),
            'every rung over-segments, so the table shows no benefit either',
        );
    });
});

describe('the prose drawn from the sweep table', () => {
    // docs/TUNING.md argues from the table in words: how many times the talk-over column jumps
    // below the knee, and how many residual frames remain above it. Those are numbers too.
    const rowAt = async (silenceMs: number) => {
        const rows = await runCalls({ vad: { ...VAD, silenceDurationMs: silenceMs } });
        return summarise(rows.map((r) => r.audio));
    };

    it('"jumps N-fold" and "the N residual frames" are what the sweep prints', async () => {
        const text = read('docs/TUNING.md');
        const low = await rowAt(400);
        const knee = await rowAt(600);
        const fold = text.match(/talk-over column jumps (\w+)fold/);
        const residual = text.match(/The (\w+) residual talk-over frames at 600 ms and above/);
        assert.ok(fold && residual, 'the sentences this check reads are gone from docs/TUNING.md');
        assert.equal(valueOf(fold[1]), low.talkOver / knee.talkOver, `"${fold[0]}" — the sweep says ${low.talkOver}/${knee.talkOver}`);
        assert.equal(valueOf(residual[1]), knee.talkOver, `"${residual[0]}" — the sweep says ${knee.talkOver}`);
    });
});

describe('the --latency=900 expected output', () => {
    /** One printed result row, in the runner's own format. */
    interface Line { fixture: string; detected: number; scripted: number; p50: number; max: number; talkOver: number; verdict: string }

    const ROW = /^\s+([a-z][a-z0-9-]*)\s+(\d+)\/(\d+)\s+(\d+)ms \/ (\d+)ms\s+(\d+)f\s+((?:HARD|soft): [a-z_, ]+)\s*$/gm;
    // `\s*`, not `\s+`: the runner prints its total at column 0, and a block pasted exactly as
    // printed must still be checked rather than skipped.
    const TOTAL = /^\s*(\d+) hard failure\(s\) · (\d+) soft failure\(s\)\s*$/gm;

    let truth: Promise<{ lines: Map<string, Line>; hard: number; soft: number }> | undefined;
    function actual() {
        truth ??= (async () => {
            const rows = await runCalls({ latencyMs: 900 });
            const lines = new Map<string, Line>();
            let hard = 0;
            let soft = 0;
            for (const row of rows) {
                // The same arithmetic as the runner's own report in src/carrier/run.ts.
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
                const a = row.audio;
                lines.set(row.fixture.name, {
                    fixture: row.fixture.name,
                    detected: a.detectedTurns,
                    scripted: a.scriptedTurns,
                    p50: a.percentiles.p50 ?? 0,
                    max: a.maxDeadAirMs,
                    talkOver: a.talkOverFrames,
                    verdict: failedHard.length ? `HARD: ${failedHard.join(', ')}` : failedSoft.length ? `soft: ${failedSoft.join(', ')}` : 'clean',
                });
            }
            return { lines, hard, soft };
        })();
        return truth;
    }

    /** What is wrong with one page's copy of the block. Pure, so the control can feed it a plant. */
    function stale(page: string, text: string, t: { lines: Map<string, Line>; hard: number; soft: number }): string[] {
        const wrong: string[] = [];
        const printed = new Set<string>();
        for (const m of text.matchAll(ROW)) {
            const name = m[1] ?? '';
            const got = t.lines.get(name);
            printed.add(name);
            const want = got ? `${got.detected}/${got.scripted} ${got.p50}ms / ${got.max}ms ${got.talkOver}f ${got.verdict}` : 'no such fixture';
            const has = `${m[2]}/${m[3]} ${m[4]}ms / ${m[5]}ms ${m[6]}f ${(m[7] ?? '').trim()}`;
            if (has !== want) wrong.push(`${page}: "${m[1]} ${has}" — the command prints "${want}"`);
        }
        for (const [name, line] of t.lines) {
            if (line.verdict.startsWith('HARD') && !printed.has(name)) wrong.push(`${page}: omits the hard failure on ${name}`);
        }
        for (const m of text.matchAll(TOTAL)) {
            if (Number(m[1]) !== t.hard || Number(m[2]) !== t.soft) {
                wrong.push(`${page}: "${m[0].trim()}" — the command prints ${t.hard} hard · ${t.soft} soft`);
            }
        }
        for (const m of text.matchAll(/`(\S+)` — reaches ([\d,]+) ms of dead air/g)) {
            const got = t.lines.get(m[1] ?? '');
            if (!got || got.max !== valueOf(m[2])) wrong.push(`${page}: "${m[0]}" — the command prints ${got?.max}`);
        }
        for (const m of text.matchAll(/the hard budget is ([\d,]+)/g)) {
            if (valueOf(m[1]) !== DEAD_AIR_HARD_MS) wrong.push(`${page}: "${m[0]}" — src/carrier/checks.ts says ${DEAD_AIR_HARD_MS}`);
        }
        return wrong;
    }

    /** Only the part of a page between the `--latency=900` warning and the end of its code block. */
    function blocks(text: string): string {
        const out: string[] = [];
        for (const m of text.matchAll(/`--latency=900` EXITS 1[\s\S]*?```[\s\S]*?```/g)) out.push(m[0]);
        return out.join('\n');
    }

    it('is printed somewhere, or this check is checking nothing', () => {
        const found = PAGES.map((p) => blocks(read(p))).filter((b) => [...b.matchAll(ROW)].length > 0);
        assert.ok(found.length >= 1, 'no page prints the --latency=900 output any more; this check would pass by blindness');
    });

    it('reproduces, line for line, on every page that prints it', async () => {
        const t = await actual();
        const printing = PAGES.filter((p) => blocks(read(p)) !== '');
        const wrong = printing.flatMap((p) => stale(p, blocks(read(p)), t));
        assert.deepEqual(wrong, [], `the --latency=900 block has drifted:\n  ${wrong.join('\n  ')}`);
    });

    it('CONTROL — a planted stale block is caught on every field it checks', async () => {
        const t = await actual();
        const [name, line] = [...t.lines].find(([, l]) => l.verdict.startsWith('HARD')) ?? [];
        assert.ok(name && line, 'nothing fails at 900 ms, so there is no block to plant against');
        const planted = '`--latency=900` EXITS 1\n'
            + `\`${name}\` — reaches ${line.max + 1} ms of dead air, and the hard budget is ${DEAD_AIR_HARD_MS + 1}.\n`
            + '```\n'
            + `  ${name}   ${line.detected}/${line.scripted}   ${line.p50}ms / ${line.max + 1}ms   ${line.talkOver}f   ${line.verdict}\n`
            + `  ${t.hard + 1} hard failure(s) · ${t.soft} soft failure(s)\n`
            + '```\n';
        assert.equal(stale('planted', blocks(planted), t).length, 4, stale('planted', blocks(planted), t).join('\n'));
        const omitted = '`--latency=900` EXITS 1\n```\n'
            + `  ${t.hard} hard failure(s) · ${t.soft} soft failure(s)\n\`\`\`\n`;
        assert.ok(stale('planted', blocks(omitted), t).some((w) => w.includes('omits')), 'a block missing its failing row was not caught');
        const flush = '`--latency=900` EXITS 1\n```\n'
            + `  ${name}   ${line.detected}/${line.scripted}   ${line.p50}ms / ${line.max}ms   ${line.talkOver}f   ${line.verdict}\n`
            + `${t.hard + 1} hard failure(s) · ${t.soft} soft failure(s)\n\`\`\`\n`;
        assert.ok(stale('planted', blocks(flush), t).some((w) => w.includes('hard failure(s)')), 'a wrong total at column 0, as the runner prints it, was not caught');
    });
});

describe('the refusal and scenario counts', () => {
    const scenarios = Object.keys(JSON.parse(read('src/mock/fixtures/scenarios.json')).scenarios).length;
    const refusals = SEAM_REFUSAL_REASONS.length;

    function stale(page: string, text: string): string[] {
        const wrong: string[] = [];
        for (const m of text.matchAll(new RegExp(`\\b${NUMBER}\\s+(?:refusals?|refusal\\s+(?:words?|reasons?|paths?))\\b`, 'gi'))) {
            if (valueOf(m[1]) !== refusals) wrong.push(`${page}: "${m[0]}" — src/seam/types.ts has ${refusals}`);
        }
        for (const m of text.matchAll(new RegExp(`\\b${NUMBER}\\s+(?:mock\\s+)?scenarios\\b`, 'gi'))) {
            if (valueOf(m[1]) !== scenarios) wrong.push(`${page}: "${m[0]}" — the mock has ${scenarios}`);
        }
        return wrong;
    }

    it('is what every page says it is, where a page says it at all', () => {
        const wrong = PAGES.flatMap((p) => stale(p, read(p)));
        assert.deepEqual(wrong, [], `stale counts:\n  ${wrong.join('\n  ')}`);
    });

    it('CONTROL — the scanner sees a stale count, spelled or not', () => {
        const planted = `${scenarios - 5} scenarios, all ${Object.keys(WORDS)[refusals - 2]} refusals, and ${refusals + 1} refusal words.`;
        assert.equal(stale('planted', planted).length, 3, stale('planted', planted).join('\n'));
        assert.deepEqual(stale('planted', `${scenarios} scenarios and ${refusals} refusals`), []);
    });
});

describe('lifetimes printed in prose', () => {
    it('the token lifetime and the call cap are what the code and the contract say', () => {
        const ttlMinutes = Number(JSON.parse(read('contract/seam4.json')).token.ttl_ms) / 60_000;
        const callMinutes = MAX_CALL_SECONDS / 60;
        const wrong: string[] = [];
        for (const page of PAGES) {
            const text = read(page);
            for (const m of text.matchAll(new RegExp(`expires in ${NUMBER} minutes`, 'gi'))) {
                if (valueOf(m[1]) !== ttlMinutes) wrong.push(`${page}: "${m[0]}" — the token lives ${ttlMinutes}`);
            }
            for (const m of text.matchAll(new RegExp(`${NUMBER} minutes of call|calls are capped at ${NUMBER}`, 'gi'))) {
                if (valueOf(m[1] ?? m[2]) !== callMinutes) wrong.push(`${page}: "${m[0]}" — MAX_CALL_SECONDS is ${MAX_CALL_SECONDS}`);
            }
        }
        assert.deepEqual(wrong, [], wrong.join('\n'));
    });
});

describe('the Gemini model ids and the shutdown date', () => {
    function stale(page: string, text: string): string[] {
        const wrong: string[] = [];
        for (const m of text.matchAll(/shutdown on \**(\d{4}-\d{2}-\d{2})/g)) {
            if (m[1] !== LIVE_MODEL_SHUTDOWN) wrong.push(`${page}: "${m[0]}" — LIVE_MODEL_SHUTDOWN is ${LIVE_MODEL_SHUTDOWN}`);
        }
        for (const m of text.matchAll(/gemini-[\d.]+-live\b(?!-)/g)) {
            if (m[0] !== LIVE_MODEL_REPLACEMENT) wrong.push(`${page}: "${m[0]}" — LIVE_MODEL_REPLACEMENT is ${LIVE_MODEL_REPLACEMENT}`);
        }
        for (const m of text.matchAll(/\| model id \|[^|]*\|\s*`([^`]+)`/g)) {
            if (m[1] !== LIVE_MODEL) wrong.push(`${page}: model id "${m[1]}" — LIVE_MODEL is ${LIVE_MODEL}`);
        }
        return wrong;
    }

    it('docs/TUNING.md names the pin, the avoided model, the replacement and the date', () => {
        const text = read('docs/TUNING.md');
        for (const v of [LIVE_MODEL, LIVE_MODEL_UNDER_SUSPICION, LIVE_MODEL_REPLACEMENT, LIVE_MODEL_SHUTDOWN]) {
            assert.ok(text.includes(v), `docs/TUNING.md no longer mentions ${v}`);
        }
    });

    it('every page that names them agrees with src/tuning/liveDefaults.ts', () => {
        const wrong = PAGES.flatMap((p) => stale(p, read(p)));
        assert.deepEqual(wrong, [], wrong.join('\n'));
    });

    it('CONTROL — a wrong date, replacement or pin is caught', () => {
        const planted = 'for shutdown on **2026-12-01**, replaced by `gemini-9.9-live`.\n| model id | x | `gemini-old` | y |';
        assert.equal(stale('planted', planted).length, 3, stale('planted', planted).join('\n'));
    });
});
