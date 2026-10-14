/**
 * "Am I the entry point?", on all three operating systems, from any one of them.
 *
 * WHY THIS EXISTS. `npm run eval` and `npm run call` decide whether to run by comparing their own
 * module URL with `process.argv[1]`. The comparison used to strip `file:///` and lower-case both
 * sides, which lines up on Windows and never lines up on macOS or Linux — the URL lost its leading
 * slash, argv[1] kept it. Both commands printed nothing and exited 0 there, and CI (Linux) ran them
 * as green no-ops from the day the steps were added. Everybody who checked was on Windows.
 *
 * So the platform is a parameter, and every shape below runs on every machine. The second half
 * spawns the real commands and demands their summary line, because a runner that quietly does
 * nothing is exactly what the first half alone could miss if the call sites stopped using the guard.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isEntryPoint } from '../src/harness/fixtures.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('isEntryPoint, by operating system', () => {
    const cases: Array<{ os: string; platform: string; url: string; same: string; other: string }> = [
        {
            os: 'Linux (CI)',
            platform: 'linux',
            url: 'file:///home/runner/work/venue-call-agent/src/eval/run.ts',
            same: '/home/runner/work/venue-call-agent/src/eval/run.ts',
            other: '/home/runner/work/venue-call-agent/src/carrier/run.ts',
        },
        {
            os: 'macOS',
            platform: 'darwin',
            url: 'file:///Users/someone/code/venue-call-agent/src/carrier/run.ts',
            same: '/Users/someone/code/venue-call-agent/src/carrier/run.ts',
            other: '/Users/someone/code/venue-call-agent/src/harness/run.ts',
        },
        {
            os: 'Windows',
            platform: 'win32',
            url: 'file:///C:/dev/venue-call-agent/src/eval/run.ts',
            same: 'C:\\dev\\venue-call-agent\\src\\eval\\run.ts',
            other: 'C:\\dev\\venue-call-agent\\src\\harness\\run.ts',
        },
    ];

    for (const c of cases) {
        test(`${c.os}: the module run directly is the entry point`, () => {
            assert.equal(isEntryPoint(c.url, c.same, c.platform), true,
                'false here means the runner prints nothing and exits 0 on this OS');
        });

        test(`${c.os}: a different file with the same basename is not`, () => {
            assert.equal(isEntryPoint(c.url, c.other, c.platform), false,
                'two files in this repo are called run.ts; one must not run the other');
        });
    }

    test('Windows: drive-letter case and slash direction do not matter', () => {
        assert.equal(
            isEntryPoint('file:///C:/dev/venue-call-agent/src/eval/run.ts', 'c:/DEV/venue-call-agent/src/eval/run.ts', 'win32'),
            true,
        );
    });

    test('Linux and macOS: case DOES matter, because the file system says it does', () => {
        assert.equal(isEntryPoint('file:///home/x/Run.ts', '/home/x/run.ts', 'linux'), false);
        assert.equal(isEntryPoint('file:///home/x/run.ts', '/home/x/run.ts', 'linux'), true);
    });

    test('no argv[1] (a REPL, `node -e`) is never the entry point', () => {
        assert.equal(isEntryPoint('file:///home/x/run.ts', undefined, 'linux'), false);
        assert.equal(isEntryPoint('file:///home/x/run.ts', '', 'linux'), false);
    });

    test('this machine, real paths: a module is its own entry point and not its neighbour\'s', () => {
        const self = fileURLToPath(import.meta.url);
        assert.equal(isEntryPoint(import.meta.url, self), true);
        assert.equal(isEntryPoint(pathToFileURL(`${ROOT}src/eval/run.ts`).href, self), false);
    });
});

describe('🔴 the runners actually run (a silent no-op must fail here)', () => {
    // Spawned exactly as `npm run eval` / `npm run call` spawn them (package.json "scripts"), with
    // a narrow --only so the suite stays fast. The assertion is on the SUMMARY LINE, not the exit
    // code: the bug this guards against exited 0.
    const run = (script: string, ...args: string[]) =>
        spawnSync(process.execPath, [script, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });

    test('`node src/eval/run.ts` prints a conversation count above zero', () => {
        const r = run('src/eval/run.ts', '--only=plain');
        const m = /agent: stub, (\d+) conversation\(s\)/.exec(r.stdout);
        assert.ok(m, `no conversation count printed — the eval did not run.\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
        assert.ok(Number(m[1]) > 0, 'it ran and graded nothing');
        assert.equal(r.status, 0, r.stderr);
    });

    test('`node src/carrier/run.ts` prints a call count above zero', () => {
        const r = run('src/carrier/run.ts', '--only=plain');
        const m = /agent: stub, (\d+) call\(s\)/.exec(r.stdout);
        assert.ok(m, `no call count printed — the calls did not run.\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
        assert.ok(Number(m[1]) > 0, 'it ran and placed no simulated call');
        assert.equal(r.status, 0, r.stderr);
    });
});
