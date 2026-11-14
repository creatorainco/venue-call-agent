/**
 * Loading the recorded conversations.
 *
 * Its own module rather than a helper hanging off the eval runner, and that is a bug fix. When it
 * lived in `src/eval/run.ts`, importing it from the harness pulled in that file's "am I the
 * entry point?" check — which was written as `argv[1].endsWith('run.ts')` and matched the
 * harness's own `run.ts`. Running the harness printed the entire eval instead. A module that does
 * one thing cannot do that.
 */

import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, posix, win32 } from 'node:path';

import type { Fixture } from './replay.ts';

const FIXTURE_DIR = fileURLToPath(new URL('../../test/fixtures/conversations/', import.meta.url));

/**
 * The red team (TASK-3745 step 5): conversations somebody places ON PURPOSE to make the agent
 * misbehave. Same format, own folder, and the separation is the point: the recorded set is the
 * corpus the turn detector is tuned on and the golden is captured from, and adversarial calls
 * would skew a measure of ordinary ones. They are graded by `test/redTeam.test.ts` (in `npm test`)
 * and by `npm run eval -- --red-team`.
 */
const RED_TEAM_DIR = fileURLToPath(new URL('../../test/fixtures/red-team/', import.meta.url));

function readSet(dir: string, filter?: string): Fixture[] {
    return readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Fixture)
        .filter((f) => !filter || f.name.includes(filter))
        .sort((a, b) => a.name.localeCompare(b.name));
}

/** Every recorded conversation, sorted by name, optionally filtered by substring. */
export function loadFixtures(filter?: string): Fixture[] {
    return readSet(FIXTURE_DIR, filter);
}

/** Every red-team conversation, sorted by name, optionally filtered by substring. */
export function loadRedTeam(filter?: string): Fixture[] {
    return readSet(RED_TEAM_DIR, filter);
}

/**
 * Is THIS module the process entry point?
 *
 * Compared as resolved file paths. The string form (`argv[1].endsWith('run.ts')`) is what caused
 * the bug above: two files in this repo are called `run.ts`, and there was no reason to assume
 * otherwise.
 *
 * 🔴 THE SECOND BUG, AND WHY THE PLATFORM IS A PARAMETER. The version before this one compared
 * strings after stripping `file:///` and every backslash. On Windows that lines up
 * (`C:/x/run.ts` both sides). On macOS and Linux the URL lost its leading slash and argv[1] kept
 * it (`home/x/run.ts` against `/home/x/run.ts`), so it was never equal: `npm run eval` and
 * `npm run call` printed nothing and exited 0, and CI's eval and call steps were green no-ops from
 * the day they were added. Every person who checked it was on Windows. So the platform is injectable
 * and `test/entryPoint.test.ts` runs Windows-, macOS- and Linux-shaped paths on any machine.
 *
 * The path is folded to lower case on Windows only — a case-sensitive file system can hold two
 * files whose names differ only in case. A symlinked entry (`node ./link-to-run.ts`) is followed
 * with realpath when the paths belong to the machine we are running on.
 */
export function isEntryPoint(
    moduleUrl: string,
    entry: string | undefined = process.argv[1],
    platform: string = process.platform,
): boolean {
    if (!entry) return false;
    const windows = platform === 'win32';
    const paths = windows ? win32 : posix;

    let modulePath: string;
    try {
        modulePath = fileURLToPath(moduleUrl, { windows });
    } catch {
        return false;
    }
    let entryPath = paths.resolve(entry);

    if (platform === process.platform) {
        modulePath = realOrSame(modulePath);
        entryPath = realOrSame(entryPath);
    }

    const fold = (p: string) => (windows ? paths.normalize(p).toLowerCase() : paths.normalize(p));
    return fold(modulePath) === fold(entryPath);
}

function realOrSame(p: string): string {
    try {
        return realpathSync(p);
    } catch {
        return p;
    }
}
