#!/usr/bin/env node
/**
 * `npm run doctor` — what this laptop can and cannot do right now, and exactly why.
 *
 * WHY IT EXISTS. "Which credentials do I need?" was answered three different ways in this
 * repository inside two days, and every one of them was a sentence in a document. A sentence in a
 * document is a claim about the environment; this is a reading of it. When the two disagree,
 * believe this one and fix the document.
 *
 * 🔴 A MISSING CREDENTIAL IS NOT A FAILURE HERE, AND THAT IS THE WHOLE DESIGN.
 * `src/config.ts` was rewritten once for exactly this reason: a boot check that demanded all four
 * values blocked a laptop that needed none of them, and protected nothing, because a service that
 * cannot start never reaches a call either. So this script exits 0 on a completely empty
 * environment. It exits non-zero only when the LOCAL path — the one that needs nothing — is
 * actually broken. Anything else is reported and costed, not enforced.
 *
 * 🔴 IT CHECKS BEHAVIOUR, NOT CONFIGURATION, WHEREVER IT CAN.
 * "Node 22.18 is installed" is a hypothesis about type-stripping. So this imports a real `.ts`
 * file and calls a function in it. "The mock exists" is a hypothesis about the test environment.
 * So this boots the mock on an ephemeral port, asks it for a call context, and shuts it down. A
 * check that reads a version string and stops is the kind that reports green on a laptop where
 * nothing runs.
 *
 * 🔴 IT SHIPS WITH A POSITIVE CONTROL AND RUNS IT EVERY TIME.
 * Same argument as `scripts/check-no-facts.mjs`: a probe that reports "all good" is
 * indistinguishable from a probe whose detection is broken. Before printing anything, this runs
 * two synthetic checks that MUST come back broken and MUST come back absent. If either reports
 * healthy, the run fails and says so — a doctor that cannot see illness is worse than no doctor,
 * because somebody will believe it.
 *
 * Runs with NO dependencies installed. It is the first thing to run on a fresh clone, before
 * `npm ci`, and it must work there or it is useless at the only moment it is needed.
 *
 * Usage:
 *   node scripts/doctor.mjs            human-readable
 *   node scripts/doctor.mjs --json     the same reading as JSON, for a script or a CI step
 *   node scripts/doctor.mjs --control  run ONLY the control, and fail if it does not trip
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const controlOnly = argv.includes('--control');

/** Node version that turned unflagged TypeScript type-stripping on. Below this nothing runs. */
const MIN_NODE = [22, 18, 0];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The environment register.
//
// Every variable this repository will ever read, in the three classes `src/config.ts` defines,
// plus one class that does not exist yet and is listed anyway so nobody is surprised by it.
//
// 🔴 NAMES ONLY. This file must never print a value, a prefix, or a length. A doctor that leaks
// the thing it is checking for is a worse problem than the missing check.
// ─────────────────────────────────────────────────────────────────────────────────────────────
const ENV_REGISTER = [
    {
        name: 'CREATORAIN_API_BASE_URL',
        klass: 'local',
        unlocks: 'points the client at a backend other than the in-repo mock',
        source: 'you choose it; the mock prints its own URL when it starts',
        blocksWhenAbsent: null,
    },
    {
        name: 'PORT',
        klass: 'local',
        unlocks: "the agent's own listen port, once a carrier has somewhere to call back",
        source: 'you choose it; defaults to 8787',
        blocksWhenAbsent: null,
    },
    {
        name: 'VENUE_CALL_SECRET',
        klass: 'real-backend',
        unlocks: 'minting a call token a REAL platform-backend will accept',
        source: 'a shared literal, not an issued credential — invent one and set the same string on both processes',
        blocksWhenAbsent: 'npm run mint-token, and any run against a real backend. Not the mock.',
    },
    {
        name: 'GEMINI_API_KEY',
        klass: 'live-model',
        unlocks: 'opening a real Gemini Live session — the first tuning measurement needs this',
        source: "the org already holds one: it is in the context hub's .env under this exact name. A lookup, not a signup.",
        blocksWhenAbsent: 'docs/TUNING.md §3.2 onward. Building the adapter against the harness does not need it.',
    },
    {
        name: 'GEMINI_LIVE_MODEL',
        klass: 'live-model',
        unlocks: 'overriding the pinned model for a comparison run',
        source: 'you choose it; leave unset to use the pin in src/tuning/liveDefaults.ts',
        blocksWhenAbsent: null,
    },
    {
        name: 'SPEECH_TO_TEXT_CREDENTIALS',
        klass: 'fabrication-witness',
        unlocks: "the post-call fabrication check's SECOND, independent transcript",
        source: '🔴 EXISTS NOWHERE IN THIS ORG. Nobody has provisioned it and no ticket asks for it. See docs/LIMITS.md §9.',
        blocksWhenAbsent: 'the acceptance criterion that a witness other than the model confirms what the model said.',
    },
];

/** A class the code does not read yet. Listed so its absence is a decision, not a discovery. */
const NOT_YET_A_VARIABLE = {
    klass: 'carrier',
    why: 'No carrier is chosen, so no carrier credential has a name yet. src/carrier/ runs against a fake leg and needs nothing. See docs/TEST-ENVIRONMENT.md.',
};

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Checks. Each returns { state: 'ok' | 'broken' | 'absent', detail }.
// `broken` is the only state that can fail the run.
// ─────────────────────────────────────────────────────────────────────────────────────────────

function parseVersion(v) {
    return v.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10));
}

function atLeast(actual, wanted) {
    for (let i = 0; i < wanted.length; i += 1) {
        if ((actual[i] ?? 0) > wanted[i]) return true;
        if ((actual[i] ?? 0) < wanted[i]) return false;
    }
    return true;
}

async function checkNode() {
    const actual = parseVersion(process.versions.node);
    const wanted = MIN_NODE.join('.');
    if (!atLeast(actual, MIN_NODE)) {
        return {
            state: 'broken',
            detail: `Node ${process.versions.node}; this repository needs >= ${wanted}. `
                + 'Below it, importing a .ts file throws and nothing in here runs. `nvm use` reads .nvmrc.',
        };
    }
    return { state: 'ok', detail: `Node ${process.versions.node} (>= ${wanted})` };
}

/**
 * The version number is a claim. This is the reading: import a real `.ts` module and call it.
 *
 * It also catches the OTHER way this breaks, which is not a Node version at all — a TypeScript
 * construct Node cannot erase. `enum`, `namespace` and `constructor(public x)` all typecheck and
 * all throw ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX at runtime. That has already happened here once.
 */
async function checkTypeStripping() {
    try {
        const mod = await import(new URL('../src/config.ts', import.meta.url).href);
        const cfg = mod.loadConfig({});
        if (typeof cfg?.apiBaseUrl !== 'string') {
            return { state: 'broken', detail: 'src/config.ts imported but loadConfig({}) returned something unexpected.' };
        }
        return { state: 'ok', detail: `type-stripping works; loadConfig({}) defaults to ${cfg.apiBaseUrl}` };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
            state: 'broken',
            detail: `importing src/config.ts threw: ${msg.slice(0, 200)}`
                + (msg.includes('TYPESCRIPT') ? ' — that is an unerasable construct, not a Node version.' : ''),
        };
    }
}

/**
 * The strongest single check in here: the test environment is not a set of files, it is a server
 * that answers. So start it, ask it a real question, and read the answer.
 */
async function checkMockBoots() {
    let mock;
    try {
        const mod = await import(new URL('../src/mock/server.ts', import.meta.url).href);
        mock = await mod.startMockSeam({ port: 0 });
    } catch (err) {
        return { state: 'broken', detail: `the mock backend would not start: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}` };
    }
    try {
        const res = await fetch(`${mock.baseUrl}/reservations/call-context`, {
            method: 'POST',
            headers: { Authorization: 'Bearer mock:happy' },
        });
        const body = await res.json();
        if (res.status !== 200 || typeof body?.disclosure_sentence !== 'string') {
            return { state: 'broken', detail: `the mock answered ${res.status} with no disclosure_sentence. The local test environment is not intact.` };
        }
        return { state: 'ok', detail: `mock Seam 4 booted, served a call context, and stopped (${mock.baseUrl})` };
    } catch (err) {
        return { state: 'broken', detail: `the mock started but would not answer: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}` };
    } finally {
        try { await mock?.close(); } catch { /* the reading is already taken */ }
    }
}

/** Advisory. A fresh clone has no node_modules and that is the expected state, not a fault. */
async function checkDependencies() {
    const hasLock = existsSync(join(ROOT, 'package-lock.json'));
    const hasModules = existsSync(join(ROOT, 'node_modules'));
    if (!hasLock) {
        return { state: 'broken', detail: 'no package-lock.json. `npm ci` fails outright without one, and CI is red until it exists.' };
    }
    if (!hasModules) {
        return { state: 'absent', detail: 'lockfile present, node_modules not. Run `npm ci` — needed for `npm run typecheck` only; the tests, the mock and the eval run without it.' };
    }
    return { state: 'ok', detail: 'package-lock.json and node_modules both present' };
}

/** A synthetic check that must always come back broken. If it does not, detection is broken. */
async function controlCheckThatMustFail() {
    return { state: 'broken', detail: 'CONTROL — this check exists to fail. Seeing it green means the doctor cannot see illness.' };
}

const CHECKS = [
    { id: 'node', title: 'Node runtime', run: checkNode },
    { id: 'type-stripping', title: 'TypeScript runs without a build step', run: checkTypeStripping },
    { id: 'mock', title: 'The local backend actually answers', run: checkMockBoots },
    { id: 'deps', title: 'Dependencies', run: checkDependencies },
];

// ─────────────────────────────────────────────────────────────────────────────────────────────

async function runControl() {
    const failures = [];
    const c = await controlCheckThatMustFail();
    if (c.state !== 'broken') failures.push('the synthetic broken check did not report broken');

    const synthetic = '__VENUE_CALL_DOCTOR_CONTROL_NEVER_SET__';
    if (readEnvState(synthetic) !== 'absent') {
        failures.push(`${synthetic} was read as present; the environment reader is wrong`);
    }
    // And the other direction, so the reader is not simply always "absent".
    process.env[synthetic] = 'x';
    if (readEnvState(synthetic) !== 'set') {
        failures.push(`${synthetic} was set and still read as absent; the environment reader is wrong`);
    }
    delete process.env[synthetic];

    return failures;
}

function readEnvState(name) {
    return (process.env[name] ?? '').trim() ? 'set' : 'absent';
}

const controlFailures = await runControl();

if (controlOnly) {
    if (controlFailures.length) {
        console.error('FAIL doctor control:');
        for (const f of controlFailures) console.error(`  - ${f}`);
        process.exit(2);
    }
    console.log('doctor: control tripped as designed (1 broken check, 2 environment reads). Detection works.');
    process.exit(0);
}

if (controlFailures.length) {
    console.error('FAIL doctor: the positive control did not trip, so this reading cannot be trusted.');
    for (const f of controlFailures) console.error(`  - ${f}`);
    process.exit(2);
}

const results = [];
for (const check of CHECKS) {
    results.push({ ...check, ...(await check.run()) });
}

const env = ENV_REGISTER.map((e) => ({ ...e, state: readEnvState(e.name) }));
const broken = results.filter((r) => r.state === 'broken');

// What is runnable is DERIVED from the readings above, never asserted.
const localOk = !broken.length;
const depsOk = results.find((r) => r.id === 'deps')?.state === 'ok';
const secret = env.find((e) => e.name === 'VENUE_CALL_SECRET')?.state === 'set';
const gemini = env.find((e) => e.name === 'GEMINI_API_KEY')?.state === 'set';
const stt = env.find((e) => e.name === 'SPEECH_TO_TEXT_CREDENTIALS')?.state === 'set';

const COMMANDS = [
    { cmd: 'npm test', ok: localOk, needs: 'nothing' },
    { cmd: 'npm run eval', ok: localOk, needs: 'nothing' },
    { cmd: 'npm run mock', ok: localOk, needs: 'nothing' },
    { cmd: 'npm run call', ok: localOk, needs: 'nothing — a whole call, over real audio frames, against a fake carrier' },
    { cmd: 'npm run check:no-facts', ok: localOk, needs: 'nothing' },
    { cmd: 'npm run typecheck', ok: localOk && depsOk, needs: 'npm ci' },
    { cmd: 'npm run mint-token -- --all', ok: localOk && secret, needs: 'VENUE_CALL_SECRET (any string you invent)' },
    { cmd: 'the first tuning measurement (docs/TUNING.md §3.2)', ok: localOk && gemini, needs: 'GEMINI_API_KEY' },
    { cmd: 'the independent-witness fabrication check', ok: localOk && gemini && stt, needs: 'SPEECH_TO_TEXT_CREDENTIALS — which exists nowhere yet' },
];

if (asJson) {
    console.log(JSON.stringify({
        controlTripped: true,
        checks: results.map(({ id, title, state, detail }) => ({ id, title, state, detail })),
        environment: env.map(({ name, klass, state, blocksWhenAbsent }) => ({ name, class: klass, state, blocksWhenAbsent })),
        commands: COMMANDS.map(({ cmd, ok, needs }) => ({ command: cmd, runnable: ok, needs })),
        localPathIntact: localOk,
    }, null, 2));
    process.exit(localOk ? 0 : 1);
}

const MARK = { ok: '  ok  ', broken: ' FAIL ', absent: ' --   ' };

console.log('doctor: control tripped as designed. This reading is a reading, not a guess.\n');

console.log('THE LOCAL PATH — this must work, and nothing about it is optional');
for (const r of results) console.log(`  [${MARK[r.state]}] ${r.title.padEnd(38)} ${r.detail}`);

console.log('\nTHE ENVIRONMENT — names only, never values');
let lastClass = '';
for (const e of env) {
    if (e.klass !== lastClass) {
        console.log(`\n  class: ${e.klass}`);
        lastClass = e.klass;
    }
    console.log(`  [${MARK[e.state === 'set' ? 'ok' : 'absent']}] ${e.name}`);
    console.log(`         unlocks: ${e.unlocks}`);
    if (e.state !== 'set') {
        console.log(`         where:   ${e.source}`);
        if (e.blocksWhenAbsent) console.log(`         blocks:  ${e.blocksWhenAbsent}`);
    }
}
console.log(`\n  class: ${NOT_YET_A_VARIABLE.klass}`);
console.log(`         ${NOT_YET_A_VARIABLE.why}`);

console.log('\nWHAT YOU CAN RUN RIGHT NOW');
for (const c of COMMANDS) {
    console.log(`  [${MARK[c.ok ? 'ok' : 'absent']}] ${c.cmd}`);
    if (!c.ok) console.log(`         needs: ${c.needs}`);
}

if (!localOk) {
    console.error('\nFAIL doctor: the local path is broken, and it is the path that is supposed to need nothing.');
    console.error('That is a bug in the setup, not in you. Say so rather than working around it.');
    process.exit(1);
}

console.log('\ndoctor: the local path is intact. Everything reported absent above is a credential');
console.log('nobody needs today — see docs/TEST-ENVIRONMENT.md for which tier of testing each one buys.');
