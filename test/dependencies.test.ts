/**
 * The runtime dependency set is closed, pinned exactly, and the lockfile agrees with it.
 *
 * WHY THIS EXISTS, WITH THE DATE. Until 2026-11-09 this repository had no runtime dependencies at
 * all, and the rule saying so was a sentence in `CLAUDE.md`. The phone runtime (TASK-3748) needs
 * three, each for a reason `node:` built-ins cannot cover:
 *
 *   - `ws`                   Node 22 ships a WebSocket client and no server, and Twilio Media
 *                            Streams connects to us.
 *   - `@google-cloud/speech` bidirectional streaming recognition is gRPC only.
 *   - `google-auth-library`  Application Default Credentials for the REST calls (speech synthesis,
 *                            the intent model), which go over `fetch` with no SDK.
 *
 * A sentence cannot stop a fourth from arriving in a convenience commit, and a caret cannot stop a
 * transitive bump from arriving on a deploy nobody reviewed. So both are assertions.
 *
 * 🔴 WITH A CONTROL, because a checker that finds every pin exact and a checker whose pattern
 * accepts anything are the same observation from outside.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const readJson = (rel: string) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));

/**
 * The whole permitted runtime set. Adding to it is a conversation, held in the pull request that
 * edits this line and `CLAUDE.md` together, with the reason a built-in cannot do the job.
 */
const RUNTIME_DEPENDENCIES = ['@google-cloud/speech', 'google-auth-library', 'ws'];

/** `1.2.3`, nothing else: no range, no tag, no URL, no prerelease. */
const EXACT = /^\d+\.\d+\.\d+$/;

type Manifest = { dependencies?: Record<string, string> };
type Lockfile = { packages: Record<string, { version?: string; dependencies?: Record<string, string>; dev?: boolean }> };

/** Every way the manifest and lockfile can disagree with the rule, as readable lines. */
function findings(manifest: Manifest, lock: Lockfile): string[] {
    const wrong: string[] = [];
    const deps = manifest.dependencies ?? {};
    const names = Object.keys(deps).sort();
    for (const name of names) {
        if (!RUNTIME_DEPENDENCIES.includes(name)) wrong.push(`${name}: not in the permitted runtime set`);
        if (!EXACT.test(deps[name]!)) wrong.push(`${name}: "${deps[name]}" is not an exact version`);
    }
    for (const name of RUNTIME_DEPENDENCIES) {
        if (!(name in deps)) wrong.push(`${name}: permitted but missing — the set and the manifest disagree`);
    }
    const root = lock.packages[''];
    if (!root) return [...wrong, 'package-lock.json has no root package entry'];
    if (JSON.stringify(root.dependencies ?? {}) !== JSON.stringify(deps)) {
        wrong.push('package-lock.json root dependencies differ from package.json — run `npm install`');
    }
    for (const name of names) {
        const locked = lock.packages[`node_modules/${name}`];
        if (!locked) wrong.push(`${name}: not in package-lock.json`);
        else if (locked.version !== deps[name]) wrong.push(`${name}: locked ${locked.version}, pinned ${deps[name]}`);
        else if (locked.dev) wrong.push(`${name}: locked as a dev dependency`);
    }
    return wrong;
}

describe('the runtime dependencies', () => {
    const manifest = readJson('package.json') as Manifest;
    const lock = readJson('package-lock.json') as Lockfile;

    it('are exactly the permitted set, each pinned exactly, and the lockfile agrees', () => {
        const wrong = findings(manifest, lock);
        assert.deepEqual(wrong, [], wrong.join('\n'));
    });

    it('CONTROL — a caret, a tag, an unlisted package and a stale lock are each caught', () => {
        const deps = { ...manifest.dependencies };
        const planted: Manifest = {
            dependencies: { ...deps, ws: `^${deps.ws}`, 'google-auth-library': 'latest', 'left-pad': '1.3.0' },
        };
        const wrong = findings(planted, lock);
        assert.ok(wrong.some((w) => w.startsWith('ws: "^')), `caret not caught:\n${wrong.join('\n')}`);
        assert.ok(wrong.some((w) => w.startsWith('google-auth-library: "latest"')), `tag not caught:\n${wrong.join('\n')}`);
        assert.ok(wrong.some((w) => w.startsWith('left-pad: not in the permitted')), `extra not caught:\n${wrong.join('\n')}`);
        assert.ok(wrong.some((w) => w.startsWith('package-lock.json root')), `stale lock not caught:\n${wrong.join('\n')}`);

        const missing: Manifest = { dependencies: { ws: deps.ws! } };
        assert.ok(findings(missing, lock).some((w) => w.includes('permitted but missing')), 'a dropped dependency not caught');
    });
});
