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
 *   COUNT IT   — the conversation count and the sweep table are recomputed and compared.
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
import { VAD } from '../src/tuning/liveDefaults.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Every page a person reads. Not the source; comments are prose and are allowed to be prose. */
const PAGES = ['README.md', 'ONBOARDING.md', 'CONTRIBUTING.md', 'CLAUDE.md',
    'docs/TUNING.md', 'docs/LIMITS.md', 'docs/WHAT-CANNOT-BE-TESTED.md',
    'docs/TEST-ENVIRONMENT.md', 'docs/DEPLOY.md'];

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const SPELLED: Record<number, string> = {
    12: 'twelve', 13: 'thirteen', 14: 'fourteen', 15: 'fifteen', 16: 'sixteen',
    17: 'seventeen', 18: 'eighteen', 19: 'nineteen', 20: 'twenty',
};

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
