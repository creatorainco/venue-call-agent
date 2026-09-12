/**
 * Loading the recorded conversations.
 *
 * Its own module rather than a helper hanging off the eval runner, and that is a bug fix. When it
 * lived in `src/eval/run.ts`, importing it from the harness pulled in that file's "am I the
 * entry point?" check — which was written as `argv[1].endsWith('run.ts')` and matched the
 * harness's own `run.ts`. Running the harness printed the entire eval instead. A module that does
 * one thing cannot do that.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import type { Fixture } from './replay.ts';

const FIXTURE_DIR = fileURLToPath(new URL('../../test/fixtures/conversations/', import.meta.url));

/** Every recorded conversation, sorted by name, optionally filtered by substring. */
export function loadFixtures(filter?: string): Fixture[] {
    return readdirSync(FIXTURE_DIR)
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(readFileSync(join(FIXTURE_DIR, f), 'utf8')) as Fixture)
        .filter((f) => !filter || f.name.includes(filter))
        .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Is THIS module the process entry point?
 *
 * Compared as resolved URLs. The string form (`argv[1].endsWith('run.ts')`) is what caused the bug
 * above: two files in this repo are called `run.ts`, and there was no reason to assume otherwise.
 */
export function isEntryPoint(moduleUrl: string): boolean {
    const entry = process.argv[1];
    if (!entry) return false;
    const normalise = (p: string) => p.replace(/\\/g, '/').replace(/^file:\/\/\/?/, '').toLowerCase();
    return normalise(moduleUrl) === normalise(entry);
}
