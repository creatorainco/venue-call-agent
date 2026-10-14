#!/usr/bin/env node
/**
 * Has the backend moved underneath us?
 *
 * `contract/seam4.json` is a SNAPSHOT of shapes that live in another repository on another deploy
 * cadence. Nothing in this repo can see that repository, so the snapshot cannot notice when it
 * goes stale — a renamed field over there stays green over here, right up until a call is on the
 * line. This script is the thing that notices. It reads the backend's own source and diffs:
 *
 *   - the vocabularies the contract depends on (refusal words, topics, events, fields, routes,
 *     script and token versions);
 *   - the campaign rule (which campaign statuses keep a booking's call, and whether case matters);
 *   - the SENTENCES the mock speaks, against the backend's own constants (the disclosure, the
 *     operations facts, the event sentences) and against the backend's own builders, run on the
 *     mock's inputs (the opening, the voicemail, the system instruction, every fact answer).
 *
 *     npm run contract:derive -- ../platform-backend
 *     npm run contract:derive -- ../platform-backend origin/master
 *     npm run contract:derive -- ../platform-backend origin/master --no-exec
 *     npm run contract:derive -- --control
 *
 * The sentences matter as much as the shapes. On 2026-10-14 three of the mock's sentences were
 * found nicer than the backend's (the voicemail among them), and the nicer voicemail had been
 * hiding a false positive in the eval's own machine check. A fixture that says something nicer
 * than the real backend is a test that passes on a call that would have gone differently.
 *
 * 🔴 IT IS A PERSON'S JOB, NOT CI'S, and that is deliberate rather than lazy. CI here has no
 * checkout of the backend and should not be given credentials to fetch one. Run it whenever you
 * touch this feature; a diff is a conversation with whoever owns that file, not a merge conflict
 * to resolve locally.
 *
 * 🔴 RUNNING THE BUILDERS EXECUTES BACKEND CODE ON THIS MACHINE. Two files, pure string functions,
 * copied out with `git show` into a temporary directory and imported there; their only imports
 * are type-only and are erased. If either file ever gains a real import it will not load, and that
 * is reported as COULD NOT EXTRACT, never as clean. `--no-exec` skips this part and says so.
 *
 * 🔴 IT SHIPS WITH A POSITIVE CONTROL AND RUNS IT FIRST. A source-scanning extractor that finds
 * nothing looks exactly like a source-scanning extractor whose regexes stopped matching — and this
 * one reports "no drift" in both cases, which is the more dangerous of the two. So before reading
 * anything real, every extractor runs against a synthetic fragment with known contents and must
 * return them. If it does not, the run fails and reports nothing about the backend at all.
 * `--control` runs only that, with no backend needed.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CONTRACT_PATH = fileURLToPath(new URL('../contract/seam4.json', import.meta.url));
const FIXTURES_PATH = fileURLToPath(new URL('../src/mock/fixtures/scenarios.json', import.meta.url));
const contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'));
const fixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf8'));

const SOURCES = {
    service: 'src/infrastructure/services/venueCall.service.ts',
    kb: 'src/helpers/emails/venueOperationsKb.ts',
    script: 'src/helpers/location/venueCallScript.ts',
    routes: 'src/infrastructure/routes/reservations.routes.ts',
    token: 'src/helpers/location/venueCallToken.ts',
    record: 'src/helpers/location/venueCallRecord.ts',
    enum: 'src/shared/enum.ts',
};

// ── the extractors ────────────────────────────────────────────────────────────
// Each takes source text and returns a sorted list (or a value), or null when it cannot find what
// it was looking for. Kept dumb on purpose: a clever parser that half-works is worse here than a
// blunt one that fails loudly.

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

/** Every `'word'` of the named array literal (`NAME ... = [ ... ];`), IN SOURCE ORDER. */
const orderedMembers = (text, constName) => {
    const start = text.indexOf(constName);
    if (start < 0) return null;
    const open = text.indexOf('= [', start);
    const close = text.indexOf('];', open);
    if (open < 0 || close < 0) return null;
    const out = [...text.slice(open, close).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    return out.length ? out : null;
};

const stringConst = (text, name) => {
    const m = new RegExp(`${name}\\s*=\\s*'([^']+)'`).exec(text);
    return m ? m[1] : null;
};

/**
 * One JS string literal starting at `from` (after any whitespace): single- or double-quoted, with
 * backslash escapes. Returns { value, end } or null. A template literal is NOT accepted — a
 * sentence with `${}` in it is a builder, and the builders are run, not read.
 */
const literalAt = (text, from) => {
    let i = from;
    while (i < text.length && /\s/.test(text[i])) i++;
    const quote = text[i];
    if (quote !== '\'' && quote !== '"') return null;
    let value = '';
    for (i++; i < text.length; i++) {
        const ch = text[i];
        if (ch === '\\') { value += text[++i]; continue; }
        if (ch === quote) return { value, end: i + 1 };
        if (ch === '\n') return null;
        value += ch;
    }
    return null;
};

/** `export const NAME =` followed by one string literal, possibly on the next line. */
const constSentence = (text, name) => {
    const m = new RegExp(`\\b${name}\\s*(?::[^=]+)?=`).exec(text);
    return m ? literalAt(text, m.index + m[0].length)?.value ?? null : null;
};

/** `{ id: 'x', ..., fact: '...' }` entries of the named array, as { id: fact }. */
const factsById = (text, arrayName) => {
    const start = text.indexOf(`${arrayName}`);
    if (start < 0) return null;
    const open = text.indexOf('= [', start);
    const close = text.indexOf('\n];', open);
    if (open < 0 || close < 0) return null;
    const body = text.slice(open, close);
    const out = {};
    for (const m of body.matchAll(/\bid:\s*'([a-z-]+)'/g)) {
        const factAt = body.indexOf('fact:', m.index);
        const nextId = body.indexOf('id:', m.index + m[0].length);
        if (factAt < 0 || (nextId >= 0 && factAt > nextId)) return null;
        const lit = literalAt(body, factAt + 'fact:'.length);
        if (!lit) return null;
        out[m[1]] = lit.value;
    }
    return Object.keys(out).length ? out : null;
};

/** Every `return '<literal>';` in the named function's body, in source order. */
const functionReturns = (text, fnName) => {
    const start = text.indexOf(`function ${fnName}(`);
    if (start < 0) return null;
    const end = text.indexOf('\n}', start);
    if (end < 0) return null;
    const body = text.slice(start, end);
    const out = [];
    for (const m of body.matchAll(/\breturn\s+/g)) {
        const lit = literalAt(body, m.index + m[0].length);
        if (!lit) return null;
        out.push(lit.value);
    }
    return out.length ? out : null;
};

/**
 * The campaign rule: the members of the allow-list array, each either a literal or
 * `ENUM_NAME.KEY` resolved through `export const ENUM_NAME = Object.freeze({ KEY: 'value' })`.
 * Anything it cannot resolve makes the whole answer null rather than a shorter list.
 */
const campaignRule = (serviceText, enumText, listName, enumName) => {
    const start = serviceText.indexOf(`const ${listName}`);
    if (start < 0) return null;
    const open = serviceText.indexOf('= [', start);
    const close = serviceText.indexOf('];', open);
    if (open < 0 || close < 0) return null;
    const enumValues = enumObject(enumText, enumName);
    if (!enumValues) return null;
    const allowed = [];
    for (const raw of serviceText.slice(open + 3, close).split(',').map((s) => s.trim()).filter(Boolean)) {
        const lit = /^'([a-z_]+)'$/.exec(raw);
        const ref = new RegExp(`^${enumName}\\.([A-Z_]+)$`).exec(raw);
        if (lit) allowed.push(lit[1]);
        else if (ref && enumValues[ref[1]]) allowed.push(enumValues[ref[1]]);
        else return null;
    }
    const caseInsensitive = new RegExp(`${listName}\\.includes\\([^;]*\\.toLowerCase\\(\\)`).test(serviceText);
    return { allowed: allowed.sort(), caseInsensitive, known: Object.values(enumValues).sort() };
};

const enumObject = (text, name) => {
    const start = text.indexOf(`export const ${name} = Object.freeze({`);
    if (start < 0) return null;
    const close = text.indexOf('})', start);
    if (close < 0) return null;
    const out = {};
    for (const m of text.slice(start, close).matchAll(/\b([A-Z_]+):\s*'([a-z_]+)'/g)) out[m[1]] = m[2];
    return Object.keys(out).length ? out : null;
};

/**
 * Copy TypeScript files out of git into a fresh temporary directory and import them. Node erases
 * the types; a type-only import is erased with them. Returns the modules keyed as given, or a
 * string saying why it could not — never a partial set.
 */
const loadTs = async (files) => {
    const dir = mkdtempSync(join(tmpdir(), 'derive-contract-'));
    try {
        writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
        for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, `${name}.ts`), text);
        const out = {};
        for (const name of Object.keys(files)) out[name] = await import(pathToFileURL(join(dir, `${name}.ts`)).href);
        return out;
    } catch (error) {
        return String(error?.message ?? error).split('\n')[0];
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
};

// ── positive control, BEFORE anything real ───────────────────────────────────
// Placeholder words only: this file is outside check-no-facts' reach, and a real sentence pasted
// here as a sample would be a second copy nobody diffs.
const positiveControl = async () => {
    const SAMPLE = `
        export type FakeReason = 'alpha' | 'beta';
        export const FAKE_TOPICS: readonly string[] = [ 'gamma', 'delta' ];
        export const FAKE_RANK: readonly Fake[] = [
            'zeta',
            'eta',
            'theta',
        ];
        router.post('/thing', handler);
        export interface FakeShape { one: string; two: { nested: string }; three: number; }
        export const FAKE_VERSION = 'v/9';
        export const FAKE_SENTENCE =
            'Zip — zap, it\\'s zop.';
        export const FAKE_FACTS: Fact[] = [
            {
                id: 'first-one',
                topic: 'ignored',
                fact: "Qux's quux, \\"quoted\\".",
            },
            {
                id: 'second-one',
                fact: 'Corge.',
            },
        ];
        function fakeSentence(input: In): string {
            if (input.kind === 'a') {
                return "Grault's.";
            }
            return '';
        }
        const FAKE_KEEPERS: readonly string[] = [
            FAKE_ENUM.ON,
            'idle',
        ];
        function keeps(s) { return FAKE_KEEPERS.includes((s ?? '').trim().toLowerCase()); }
    `.replace(/^ {8}/gm, ''); // top-level declarations close at column 0, as they do in the backend
    const ENUM_SAMPLE = `
        export const FAKE_ENUM = Object.freeze({
            ON: 'on',
            OFF: 'off',
        });
    `;
    const loaded = await loadTs({
        sample: 'import type { Nothing } from \'@nowhere/at-all\';\nexport const answer = (n: number): string => `n=${n}`;\n',
    });
    const checks = [
        ['unionMembers', unionMembers(SAMPLE, 'FakeReason'), ['alpha', 'beta']],
        ['arrayMembers', arrayMembers(SAMPLE, 'FAKE_TOPICS'), ['delta', 'gamma']],
        ['routePaths', routePaths(SAMPLE), ['/thing']],
        ['interfaceFields', interfaceFields(SAMPLE, 'FakeShape'), ['one', 'three', 'two']],
        ['stringConst', [stringConst(SAMPLE, 'FAKE_VERSION')], ['v/9']],
        ['orderedMembers', orderedMembers(SAMPLE, 'FAKE_RANK'), ['zeta', 'eta', 'theta']],
        ['constSentence', constSentence(SAMPLE, 'FAKE_SENTENCE'), 'Zip — zap, it\'s zop.'],
        ['factsById', factsById(SAMPLE, 'FAKE_FACTS'), { 'first-one': 'Qux\'s quux, "quoted".', 'second-one': 'Corge.' }],
        ['functionReturns', functionReturns(SAMPLE, 'fakeSentence'), ['Grault\'s.', '']],
        ['campaignRule', campaignRule(SAMPLE, ENUM_SAMPLE, 'FAKE_KEEPERS', 'FAKE_ENUM'),
            { allowed: ['idle', 'on'], caseInsensitive: true, known: ['off', 'on'] }],
        ['campaignRule (case-sensitive)',
            campaignRule(SAMPLE.replace('.trim().toLowerCase()', ''), ENUM_SAMPLE, 'FAKE_KEEPERS', 'FAKE_ENUM')?.caseInsensitive, false],
        ['campaignRule (unresolvable member)',
            campaignRule(SAMPLE.replace('FAKE_ENUM.ON', 'FAKE_ENUM.GONE'), ENUM_SAMPLE, 'FAKE_KEEPERS', 'FAKE_ENUM'), null],
        ['loadTs (type-only import erased)', typeof loaded === 'string' ? loaded : loaded.sample.answer(7), 'n=7'],
    ];
    return checks.filter(([, got, want]) => JSON.stringify(got) !== JSON.stringify(want));
};

{
    const broken = await positiveControl();
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

if (flags.has('--control')) {
    console.log('contract:derive --control — every extractor read its synthetic sample correctly,');
    console.log('and a .ts file with a type-only import loaded. Nothing about the backend was read.');
    process.exit(0);
}

const repoPath = positionals[0];
const ref = positionals[1] || contract.derived_from.ref || 'origin/dev';
const noExec = flags.has('--no-exec');

if (!repoPath) {
    console.error('usage: npm run contract:derive -- <path-to-platform-backend> [ref] [--no-exec]');
    console.error('       npm run contract:derive -- --control');
    console.error('');
    console.error('Reads the backend with `git show <ref>:<file>`, which does not touch its working');
    console.error('tree — that checkout may belong to somebody else and must not be switched.');
    console.error('--no-exec reads source only and does not run the backend\'s sentence builders.');
    console.error('--control runs the positive control alone; no backend needed.');
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
const recordSrc = show(SOURCES.record);
const enumSrc = show(SOURCES.enum);

/** `20 * 60 * 1000` in the source, evaluated. Kept blunt: only this exact shape is accepted. */
const ttlMs = (() => {
    const m = /VENUE_CALL_TTL_MS\s*=\s*([\d\s*]+);/.exec(tokenSrc);
    if (!m) return null;
    const parts = m[1].split('*').map((p) => Number(p.trim()));
    return parts.every((n) => Number.isFinite(n)) ? parts.reduce((a, b) => a * b, 1) : null;
})();

const commit = execFileSync('git', ['-C', repoPath, 'rev-parse', '--short', ref], { encoding: 'utf8' }).trim();

const rule = campaignRule(service, enumSrc, 'CALL_KEEPING_CAMPAIGN_STATUSES', 'CAMPAIGN_STATUS_ENUM');
const facts = factsById(kb, 'VENUE_OPERATIONS_FACTS');
const eventReturns = functionReturns(service, 'eventSentence');
// The backend's eventSentence branches, in source order, and the mock key that answers each one.
// Compared in this order and never sorted: a set comparison would pass a mock that gave one
// kind's sentence to another (say, the call-back promise for an unanswered question).
const EVENT_SENTENCE_KEYS = ['human_callback:asked_to_stop_calling', 'human_callback', 'answerer_reported', 'unanswered_question'];

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
    'ledger: disposition rank, weakest first (VENUE_CALL_DISPOSITION_RANK)': orderedMembers(recordSrc, 'VENUE_CALL_DISPOSITION_RANK'),
    'campaign rule: statuses that keep calls': rule && rule.allowed,
    'campaign rule: case-insensitive': rule && [String(rule.caseInsensitive)],
    'campaign rule: every status the backend knows': rule && rule.known,
    'sentence: disclosure (VENUE_CALL_DISCLOSURE)': wrap(constSentence(scriptSrc, 'VENUE_CALL_DISCLOSURE')),
    'sentence: who_we_are (VENUE_OPERATIONS_FACTS)': wrap(facts?.['who-we-are']),
    'sentence: what_the_creator_will_do (VENUE_OPERATIONS_FACTS)': wrap(facts?.['what-the-creator-will-do']),
    'sentences: call-event replies, branch by branch (eventSentence)': eventReturns,
    'call-event: a report that says nothing (eventSentence returns \'\')': eventReturns && [String(eventReturns.includes(''))],
};

const ctx = fixtures.default_context;
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
    'ledger: disposition rank, weakest first (VENUE_CALL_DISPOSITION_RANK)': contract.routes.find((r) => r.ledger)?.ledger.disposition_rank ?? [],
    'campaign rule: statuses that keep calls': [...contract.campaign_rule.allowed].sort(),
    'campaign rule: case-insensitive': [String(contract.campaign_rule.case_insensitive)],
    'campaign rule: every status the backend knows': [...contract.campaign_rule.known_statuses].sort(),
    'sentence: disclosure (VENUE_CALL_DISCLOSURE)': [ctx.disclosure_sentence],
    'sentence: who_we_are (VENUE_OPERATIONS_FACTS)': [fixtures.default_facts.who_we_are.say],
    'sentence: what_the_creator_will_do (VENUE_OPERATIONS_FACTS)': [fixtures.default_facts.what_the_creator_will_do.say],
    'sentences: call-event replies, branch by branch (eventSentence)': EVENT_SENTENCE_KEYS.map((k) => fixtures.event_sentences[k] ?? `(no mock key ${k})`),
    'call-event: a report that says nothing (eventSentence returns \'\')': [String(Object.values(fixtures.event_sentences).includes(''))],
};

function wrap(s) {
    return typeof s === 'string' ? [s] : null;
}

// ── run the backend's own builders on the mock's inputs ──────────────────────
if (noExec) {
    console.log('--no-exec: the backend\'s sentence builders were NOT run. The opening, voicemail,');
    console.log('system instruction and fact answers are unverified on this run, not verified.\n');
} else {
    const mods = await loadTs({ venueCallScript: scriptSrc, venueOperationsKb: kb });
    const S = typeof mods === 'string' ? null : mods.venueCallScript;
    const K = typeof mods === 'string' ? null : mods.venueOperationsKb;
    const usable = S && K && typeof S.buildVenueCallScript === 'function'
        && typeof S.buildVenueCallInstruction === 'function'
        && typeof K.venueFactSentence === 'function' && Array.isArray(K.VENUE_FACT_TOPICS);
    if (!usable) {
        observed['builders: could load venueCallScript.ts and venueOperationsKb.ts'] = null;
        expected['builders: could load venueCallScript.ts and venueOperationsKb.ts'] = ['yes'];
        if (typeof mods === 'string') console.error(`  (builders did not load: ${mods})`);
    } else {
        const bi = fixtures.builder_inputs;
        const inputs = {
            venueName: ctx.venue.name,
            brandName: ctx.brand.name,
            creatorSpokenName: ctx.creator.spoken_name,
            spokenTime: ctx.when.spoken_time,
            partySize: bi.party_size,
            compTerms: bi.comp_terms,
            contactEmail: bi.contact_email,
            stillActive: ctx.still_active,
        };
        const sentence = (topic, over = {}) => {
            const f = K.venueFactSentence(topic, { ...inputs, ...over });
            return [JSON.stringify({ known: f.known, reason: f.reason, say: f.say })];
        };
        const asFact = (f) => [JSON.stringify({ known: f.known, reason: f.reason, say: f.say })];
        const script = S.buildVenueCallScript(inputs);
        observed['builder: disclosure'] = wrap(script.disclosure);
        expected['builder: disclosure'] = [ctx.disclosure_sentence];
        observed['builder: opening beats (in order)'] = Array.isArray(script.beats) ? script.beats.map((b, i) => `${i + 1}. ${b}`) : null;
        expected['builder: opening beats (in order)'] = ctx.opening_script.map((b, i) => `${i + 1}. ${b}`);
        observed['builder: voicemail'] = wrap(script.voicemail);
        expected['builder: voicemail'] = [ctx.voicemail_script];
        observed['builder: system instruction'] = wrap(S.buildVenueCallInstruction(script, K.VENUE_FACT_TOPICS));
        expected['builder: system instruction'] = [ctx.system_instruction];
        for (const topic of K.VENUE_FACT_TOPICS) {
            observed[`builder: fact ${topic}`] = sentence(topic);
            expected[`builder: fact ${topic}`] = fixtures.default_facts[topic] ? asFact(fixtures.default_facts[topic]) : ['(the mock has no answer)'];
        }
        const gone = fixtures.scenarios['cancelled-mid-call']?.facts?.still_active;
        if (gone) {
            observed['builder: fact still_active, booking gone (cancelled-mid-call)'] = sentence('still_active', { stillActive: false });
            expected['builder: fact still_active, booking gone (cancelled-mid-call)'] = asFact(gone);
        }
        const comp = fixtures.scenarios['comp-known']?.facts?.comp_terms;
        if (comp) {
            // The authored clause is the campaign's, not the backend's: what is checked is that the
            // backend hands it back verbatim and calls it known.
            observed['builder: fact comp_terms, clause authored (comp-known)'] = sentence('comp_terms', { compTerms: comp.say });
            expected['builder: fact comp_terms, clause authored (comp-known)'] = asFact(comp);
        }
    }
}

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
    if (added.length) console.error(`      backend has, snapshot does not: ${added.join(' | ')}`);
    if (removed.length) console.error(`      snapshot has, backend does not: ${removed.join(' | ')}`);
    if (!added.length && !removed.length) console.error('      same members, different order');
}

if (drifted) {
    console.error(`\n${drifted} check(s) drifted.`);
    console.error('Update contract/seam4.json AND src/seam/types.ts AND the mock fixtures together —');
    console.error('the point of three copies is that they disagree loudly, not that one wins quietly.');
    console.error('A drifted SENTENCE is fixed by copying the backend\'s words into');
    console.error('src/mock/fixtures/scenarios.json, never by editing the backend to match the mock.');
    console.error(`Set derived_from.commit to ${commit} once you have.`);
    process.exit(1);
}

console.log('\nNo drift. The snapshot still describes the backend.');
if (commit !== contract.derived_from.commit) {
    console.log(`Backend has moved to ${commit} with no shape change — safe to bump derived_from.commit.`);
}
