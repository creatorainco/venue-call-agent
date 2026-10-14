/**
 * The drift detector's own positive control, run where CI can see it.
 *
 * `npm run contract:derive` needs a checkout of platform-backend, so CI never runs it against the
 * backend and never will. What CI CAN do is run its positive control: every extractor against a
 * synthetic fragment with known contents, plus one .ts file with a type-only import loaded the
 * way the backend's builders are loaded. If an extractor stops matching, the next person who runs
 * the real thing gets "COULD NOT EXTRACT" at best and a quiet "no drift" at worst; this makes it
 * red here first.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const derive = (...args: string[]) =>
    spawnSync(process.execPath, ['scripts/derive-contract.mjs', ...args], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });

test('contract:derive --control passes with no backend anywhere near it', () => {
    const r = derive('--control');
    assert.equal(r.status, 0, `the positive control failed:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /every extractor read its synthetic sample correctly/);
});

test('contract:derive with no arguments prints usage and exits 64, not 0', () => {
    // 0 here would read as "no drift" to anything that only checks the exit code.
    const r = derive();
    assert.equal(r.status, 64, r.stderr);
    assert.match(r.stderr, /usage: npm run contract:derive/);
});
