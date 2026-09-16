/**
 * Every file this repository points at must exist.
 *
 * WHY THIS IS A TEST AND NOT A HABIT. The documentation here is unusually dense in pointers —
 * "see `src/carrier/vad.ts`", "read `docs/LIMITS.md` §9" — because that is how a page stays short
 * and still tells the truth. The cost of that style is a class of failure nothing else catches: a
 * file gets renamed, or a page promises a document somebody meant to write, and the pointer rots.
 * Nothing goes red. The person who finds it is the new one, on their first morning, deciding this
 * repository cannot be trusted.
 *
 * Two real instances on 2026-09-12: `src/seam/client.ts` sent readers to `src/tuning/defaults.ts`,
 * which has never existed under that name, and a docs page referenced a deploy checklist that was
 * still an intention. Both were written by somebody who knew what they meant.
 *
 * 🔴 WITH A POSITIVE CONTROL, because a scanner that finds no bad references and a scanner whose
 * pattern stopped matching are the same observation from outside.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Directories that are not ours to check. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage']);

/** Files whose prose we scan. */
const SCAN_EXTS = new Set(['.md', '.ts', '.mts', '.mjs', '.js', '.yml', '.yaml', '.json']);

/**
 * Prefixes that belong to ANOTHER repository, with the repository named.
 *
 * Declared rather than inferred: a reference to a file we do not have is either a cross-repo
 * pointer, which is useful and should stay, or a broken one, and only a person knows which.
 * Keep this list short — it is the exemption, and an exemption list that grows is no guard.
 */
const OTHER_REPOS: Array<{ prefix: string; repo: string }> = [
    { prefix: 'src/helpers/', repo: 'platform-backend' },
    { prefix: 'src/index.ts', repo: 'platform-backend' },
    { prefix: 'src/infrastructure/', repo: 'platform-backend' },
];

/**
 * A repo-relative path mentioned in prose or in code.
 *
 * Anchored on the directories this repository actually has, so ordinary English and third-party
 * package paths do not match. Two narrowings, each for a false positive this found on itself:
 *
 *   - the lookbehind rejects a match inside a URL. `ai.google.dev/gemini-api/docs/live-guide`
 *     contains `docs/live-guide`, which is not a file here and never will be.
 *   - a segment must begin with a letter or digit. `contract/.test(` in a regex is not a path.
 *
 * Trailing punctuation is trimmed by the caller.
 */
const REFERENCE = /(?<![\w/.-])(?:src|scripts|test|docs|contract|\.github)\/[A-Za-z0-9_][A-Za-z0-9_./-]*/g;

/** Bare top-level documents, which are referenced by name rather than by path. */
const TOP_LEVEL = /\b(?:README|ONBOARDING|CONTRIBUTING|CLAUDE|MEMORY)\.md\b/g;

/**
 * This file itself, which is exempt and is the only exemption.
 *
 * It has to contain broken references — its positive control is two of them — so scanning it
 * would fail the guard by design. Same argument as the `NO-FACTS-EXEMPT` declarations in
 * `scripts/check-no-facts.mjs`: a detector necessarily holds the thing it detects. The exemption
 * is one file, named here, and the test below asserts the count has not grown.
 */
const EXEMPT_FILES = ['test/references.test.ts'];

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        if (SKIP_DIRS.has(entry)) continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (SCAN_EXTS.has(entry.slice(entry.lastIndexOf('.')))) {
            if (EXEMPT_FILES.includes(relative(ROOT, full).replace(/\\/g, '/'))) continue;
            out.push(full);
        }
    }
    return out;
}

/** Every reference in one file's text, cleaned of trailing punctuation and backticks. */
export function referencesIn(text: string): string[] {
    const hits = [...(text.match(REFERENCE) ?? []), ...(text.match(TOP_LEVEL) ?? [])];
    return [...new Set(hits.map((h) => h.replace(/[.,;:)`'"*]+$/, '')))];
}

function isCrossRepo(ref: string): string | null {
    for (const { prefix, repo } of OTHER_REPOS) if (ref.startsWith(prefix)) return repo;
    return null;
}

describe('every file this repository points at', () => {
    const files = walk(ROOT);

    it('scanned something, or the walk is broken', () => {
        // A scan of zero files reports a clean repository. It has happened in this estate.
        assert.ok(files.length > 25, `only ${files.length} file(s) scanned; the walk found nothing`);
    });

    it('CONTROL — the scanner can see a broken reference', () => {
        const planted = 'See docs/THIS-DOES-NOT-EXIST.md and src/carrier/nowhere.ts for details.';
        const found = referencesIn(planted);
        assert.ok(found.includes('docs/THIS-DOES-NOT-EXIST.md'), 'the pattern missed a bad docs path');
        assert.ok(found.includes('src/carrier/nowhere.ts'), 'the pattern missed a bad source path');
        for (const ref of found) {
            assert.equal(existsSync(join(ROOT, ref)), false, `${ref} exists, so it is a poor control`);
        }
        // And the other direction: a real path must be recognised, or the guard passes by blindness.
        assert.ok(referencesIn('read src/carrier/vad.ts first').includes('src/carrier/vad.ts'));
        assert.ok(existsSync(join(ROOT, 'src/carrier/vad.ts')));
    });

    it('exists', () => {
        const broken: string[] = [];
        for (const file of files) {
            const text = readFileSync(file, 'utf8');
            for (const ref of referencesIn(text)) {
                if (isCrossRepo(ref)) continue;
                if (existsSync(join(ROOT, ref))) continue;
                broken.push(`${relative(ROOT, file).replace(/\\/g, '/')}  ->  ${ref}`);
            }
        }
        assert.deepEqual(
            broken,
            [],
            'these pointers go nowhere. Either the file was renamed, or it was never written:\n  '
            + broken.join('\n  '),
        );
    });

    it('the cross-repo exemptions are still cross-repo, and still few', () => {
        // If one of these ever resolves locally, the exemption is hiding a real path and should go.
        for (const { prefix } of OTHER_REPOS) {
            assert.equal(
                existsSync(join(ROOT, prefix)),
                false,
                `${prefix} now exists here, so exempting it silences a check on our own files`,
            );
        }
        assert.ok(OTHER_REPOS.length <= 4, 'the exemption list has become the rule');
        assert.equal(EXEMPT_FILES.length, 1, 'only the scanner itself may be exempt from the scanner');
    });

    it('the exempt file is actually excluded, so the control cannot fail the run', () => {
        const scanned = files.map((f) => relative(ROOT, f).replace(/\\/g, '/'));
        for (const exempt of EXEMPT_FILES) {
            assert.ok(!scanned.includes(exempt), `${exempt} was scanned despite being exempt`);
        }
    });
});
