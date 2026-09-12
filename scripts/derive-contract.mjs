#!/usr/bin/env node
/**
 * Has the backend moved underneath us?
 *
 * `contract/seam4.json` is a SNAPSHOT of shapes that live in another repository on another deploy
 * cadence. Nothing in this repo can see that repository, so the snapshot cannot notice when it
 * goes stale — a renamed field over there stays green over here, right up until a call is on the
 * line. This script is the thing that notices. It reads the backend's own source and diffs the
 * five vocabularies the contract depends on.
 *
 *     npm run contract:derive -- ../platform-backend
 *     npm run contract:derive -- ../platform-backend origin/master
 *
 * 🔴 IT IS A PERSON'S JOB, NOT CI'S, and that is deliberate rather than lazy. CI here has no
 * checkout of the backend and should not be given credentials to fetch one. Run it whenever you
 * touch this feature; a diff is a conversation with whoever owns that file, not a merge conflict
 * to resolve locally.
 *
 * 🔴 IT SHIPS WITH A POSITIVE CONTROL AND RUNS IT FIRST. A source-scanning extractor that finds
 * nothing looks exactly like a source-scanning extractor whose regexes stopped matching — and this
 * one reports "no drift" in both cases, which is the more dangerous of the two. So before reading
 * anything real, every extractor runs against a synthetic fragment with known contents and must
 * return them. If it does not, the run fails and reports nothing about the backend at all.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CONTRACT_PATH = fileURLToPath(new URL('../contract/seam4.json', import.meta.url));
const contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'));

const SOURCES = {
    service: 'src/infrastructure/services/venueCall.service.ts',
    kb: 'src/helpers/emails/venueOperationsKb.ts',
    script: 'src/helpers/location/venueCallScript.ts',
    routes: 'src/infrastructure/routes/reservations.routes.ts',
    token: 'src/helpers/location/venueCallToken.ts',
};

// ── the extractors ────────────────────────────────────────────────────────────
// Each takes source text and returns a sorted list. Kept dumb on purpose: a clever parser that
// half-works is worse here than a blunt one that fails loudly.

/** Every `| 'word'` in the named type alias. */
const unionMembers = (text, typeName) => {
    const start = text.indexOf(`type ${typeName}`);
    if (start < 0) return null;
    const end = text.indexOf(';', start);
    if (end < 0) return null;
    return [...text.slice(start, end).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
};

/** Every `'word'` inside the named array literal. */
const arrayMembers = (text, constName) => {
    const start = text.indexOf(constName);
    if (start < 0) return null;
    const open = text.indexOf('[', start);
    const close = text.indexOf('];', open);
    if (open < 0 || close < 0) return null;
    return [...text.slice(open, close).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
};

/** Every `router.post('/path'` in a routes file. */
const routePaths = (text) =>
    [...text.matchAll(/router\.post\('(\/[a-z-]+)'/g)].map((m) => m[1]).sort();

/**
 * The TOP-LEVEL field names of an exported interface.
 *
 * ⚠️ The first version of this walked line by line and tracked brace depth, which is correct for
 * a multi-line interface and silently wrong for a one-line one — it returned the first field and
 * stopped. The positive control below caught it on the first run, which is the entire argument for
 * having one: the broken version reported "no drift" against the real backend just as cheerfully.
 *
 * This version collapses every nested brace group to a placeholder first, so nesting cannot hide a
 * sibling, and then reads keys wherever they fall.
 */
const interfaceFields = (text, name) => {
    const start = text.indexOf(`interface ${name}`);
    if (start < 0) return null;
    const open = text.indexOf('{', start);
    if (open < 0) return null;
    let depth = 0;
    let i = open;
    for (; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') { depth--; if (depth === 0) break; }
    }
    let body = text.slice(open + 1, i);

    // Collapse innermost brace groups until none are left. `venue: { name: string }` becomes
    // `venue: <nested>`, so `venue` is a field and `name` is not.
    for (let guard = 0; guard < 50 && body.includes('{'); guard++) {
        const next = body.replace(/\{[^{}]*\}/g, '<nested>');
        if (next === body) break;
        body = next;
    }

    const fields = [...body.matchAll(/(?:^|[;\n])\s*([a-z_][a-z0-9_]*)\s*\??\s*:/gi)].map((m) => m[1]);
    return [...new Set(fields)].sort();
};

const stringConst = (text, name) => {
    const m = new RegExp(`${name}\\s*=\\s*'([^']+)'`).exec(text);
    return m ? m[1] : null;
};

// ── positive control, BEFORE anything real ───────────────────────────────────
{
    const SAMPLE = `
        export type FakeReason = 'alpha' | 'beta';
        export const FAKE_TOPICS: readonly string[] = [ 'gamma', 'delta' ];
        router.post('/thing', handler);
        export interface FakeShape { one: string; two: { nested: string }; three: number; }
        export const FAKE_VERSION = 'v/9';
    `;
    const checks = [
        ['unionMembers', unionMembers(SAMPLE, 'FakeReason'), ['alpha', 'beta']],
        ['arrayMembers', arrayMembers(SAMPLE, 'FAKE_TOPICS'), ['delta', 'gamma']],
        ['routePaths', routePaths(SAMPLE), ['/thing']],
        ['interfaceFields', interfaceFields(SAMPLE, 'FakeShape'), ['one', 'three', 'two']],
        ['stringConst', [stringConst(SAMPLE, 'FAKE_VERSION')], ['v/9']],
    ];
    const broken = checks.filter(([, got, want]) => JSON.stringify(got) !== JSON.stringify(want));
    if (broken.length) {
        console.error('FAIL contract:derive — the POSITIVE CONTROL did not pass.');
        for (const [name, got, want] of broken) {
            console.error(`  ${name}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
        }
        console.error('\n  The extractors cannot read a fragment whose contents are known, so a');
        console.error('  "no drift" verdict from them would mean nothing. Fix these before trusting');
        console.error('  any comparison against the backend.');
        process.exit(2);
    }
}

// ── read the backend ─────────────────────────────────────────────────────────
//
// ⚠️ Flags are parsed SEPARATELY from positionals, and that is a bug fix rather than tidiness:
// the first version took argv[3] as the git ref unconditionally, so
// `derive-contract.mjs <repo> --check` handed `--check` to `git show --check:<path>` and died with
// a git usage error — a flag that looks like it worked and reported nothing.
const positionals = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));

const repoPath = positionals[0];
const ref = positionals[1] || contract.derived_from.ref || 'origin/dev';
const quiet = flags.has('--quiet');

if (!repoPath) {
    console.error('usage: npm run contract:derive -- <path-to-platform-backend> [ref] [--quiet]');
    console.error('');
    console.error('Reads the backend with `git show <ref>:<file>`, which does not touch its working');
    console.error('tree — that checkout may belong to somebody else and must not be switched.');
    console.error('');
    console.error('Exit codes: 0 no drift · 1 drift (the diff is printed) · 2 the script is broken');
    process.exit(64);
}

const show = (file) => {
    try {
        return execFileSync('git', ['-C', repoPath, 'show', `${ref}:${file}`], { encoding: 'utf8' });
    } catch (error) {
        console.error(`FAIL contract:derive — could not read ${ref}:${file} from ${repoPath}`);
        console.error(`  ${String(error.message).split('\n')[0]}`);
        console.error('  Fetch first (git -C <path> fetch origin) and check the ref exists.');
        process.exit(2);
    }
};

const service = show(SOURCES.service);
const kb = show(SOURCES.kb);
const scriptSrc = show(SOURCES.script);
const routes = show(SOURCES.routes);
const tokenSrc = show(SOURCES.token);

/** `20 * 60 * 1000` in the source, evaluated. Kept blunt: only this exact shape is accepted. */
const ttlMs = (() => {
    const m = /VENUE_CALL_TTL_MS\s*=\s*([\d\s*]+);/.exec(tokenSrc);
    if (!m) return null;
    const parts = m[1].split('*').map((p) => Number(p.trim()));
    return parts.every((n) => Number.isFinite(n)) ? parts.reduce((a, b) => a * b, 1) : null;
})();

const commit = execFileSync('git', ['-C', repoPath, 'rev-parse', '--short', ref], { encoding: 'utf8' }).trim();

const observed = {
    'refusal reasons': unionMembers(service, 'VenueCallRefusalReason'),
    'fact topics': arrayMembers(kb, 'VENUE_FACT_TOPICS'),
    'event kinds': unionMembers(service, 'VenueCallEventKind'),
    'callback reasons': unionMembers(service, 'CallbackReason'),
    'answerer kinds': unionMembers(service, 'AnswererKind'),
    'context fields': interfaceFields(service, 'VenueCallContext'),
    'seam routes': routePaths(routes).filter((r) => r.startsWith('/call-')),
    'script version': [stringConst(scriptSrc, 'VENUE_CALL_SCRIPT_VERSION')],
    'token version prefix': [stringConst(tokenSrc, 'const VERSION')],
    'token ttl (ms)': ttlMs === null ? null : [String(ttlMs)],
};

const expected = {
    'refusal reasons': [...contract.refusal.reasons].sort(),
    'fact topics': [...contract.fact_topics].sort(),
    'event kinds': [...contract.event_kinds].sort(),
    'callback reasons': [...contract.callback_reasons].sort(),
    'answerer kinds': [...contract.answerer_kinds].sort(),
    'context fields': [...contract.routes[0].response_fields].sort(),
    'seam routes': contract.routes.map((r) => r.path.replace('/reservations', '')).sort(),
    'script version': [contract.script_version],
    'token version prefix': [contract.token.version_prefix],
    'token ttl (ms)': [String(contract.token.ttl_ms)],
};

console.log(`contract:derive — ${repoPath} at ${ref} (${commit})`);
console.log(`snapshot was taken from ${contract.derived_from.commit} on ${contract.derived_from.read_on}\n`);

let drifted = 0;
for (const [name, want] of Object.entries(expected)) {
    const got = observed[name];
    if (got === null || got === undefined) {
        console.error(`  ✗ ${name}: COULD NOT EXTRACT from the backend source.`);
        console.error('      Not the same as "unchanged" — the source moved somewhere this script');
        console.error('      cannot follow, and the snapshot is now unverified rather than verified.');
        drifted++;
        continue;
    }
    if (JSON.stringify(got) === JSON.stringify(want)) {
        console.log(`  ✓ ${name} (${got.length})`);
        continue;
    }
    drifted++;
    const added = got.filter((x) => !want.includes(x));
    const removed = want.filter((x) => !got.includes(x));
    console.error(`  ✗ ${name} DRIFTED`);
    if (added.length) console.error(`      backend has, snapshot does not: ${added.join(', ')}`);
    if (removed.length) console.error(`      snapshot has, backend does not: ${removed.join(', ')}`);
}

if (drifted) {
    console.error(`\n${drifted} vocabulary(ies) drifted.`);
    console.error('Update contract/seam4.json AND src/seam/types.ts AND the mock fixtures together —');
    console.error('the point of three copies is that they disagree loudly, not that one wins quietly.');
    console.error(`Set derived_from.commit to ${commit} once you have.`);
    process.exit(1);
}

console.log('\nNo drift. The snapshot still describes the backend.');
if (commit !== contract.derived_from.commit) {
    console.log(`Backend has moved to ${commit} with no shape change — safe to bump derived_from.commit.`);
}
