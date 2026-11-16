/**
 * The Cloud Monitoring files in ops/monitoring/ (venue-call plan it-08, TASK-3859).
 *
 * WHY THIS EXISTS. A log-based metric matches log TEXT. If somebody renames `call_failed` in
 * src/server/streamServer.ts, the alert built on it does not fail: it goes quiet forever, and a
 * quiet alert looks exactly like a healthy service. So every event word the metric filters count
 * must still be written by a log call in src/, and this test says which one went missing.
 *
 * It also parses every template, checks the two environments render with nothing left unfilled,
 * and runs apply.sh in its offline dry run, which must touch no cloud at all.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MON = join(ROOT, 'ops', 'monitoring');
const TEMPLATES = join(MON, 'templates');

const templates = readdirSync(TEMPLATES).filter((f) => f.endsWith('.json'));

function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
        else if (p.endsWith('.ts')) out.push(p);
    }
    return out;
}

/** Every line in src/ that writes a log line, i.e. calls something named log. */
const logLines: string[] = sourceFiles(join(ROOT, 'src'))
    .flatMap((f) => readFileSync(f, 'utf8').split('\n'))
    .filter((line) => /\blog\(/.test(line));
const constants = sourceFiles(join(ROOT, 'src')).map((f) => readFileSync(f, 'utf8')).join('\n');

/** The alternation inside the label extractor: the words the metric counts. */
function tokens(file: string): string[] {
    const metric = JSON.parse(readFileSync(join(TEMPLATES, file), 'utf8')) as { labelExtractors: { token: string } };
    const m = /\(([a-zA-Z_|]+)\)/.exec(metric.labelExtractors.token);
    assert.ok(m?.[1], `${file}: no (a|b|c) group in the token extractor`);
    return m[1].split('|');
}

describe('ops/monitoring templates', () => {
    it('every template is valid JSON', () => {
        assert.ok(templates.length >= 8, `expected the metric and policy templates, found ${templates.length}`);
        for (const f of templates) JSON.parse(readFileSync(join(TEMPLATES, f), 'utf8'));
    });

    for (const file of ['metric-call-failed.json', 'metric-cascade-warm.json']) {
        it(`${file}: every counted word is still written by a log line in src/`, () => {
            const words = tokens(file);
            assert.ok(words.length > 0);
            const missing = words.filter((w) => {
                if (logLines.some((line) => line.includes(w))) return false;
                // ALERT_STOP_CALLING_UNRECORDED is logged through its constant.
                const constant = new RegExp(`export const (\\w+) = '${w}'`).exec(constants);
                return !(constant && logLines.some((line) => line.includes(constant[1] as string)));
            });
            assert.deepEqual(missing, [], `no log call in src/ writes: ${missing.join(', ')}`);
        });
    }

    it('the filter and the extractor count the same words', () => {
        const metric = JSON.parse(readFileSync(join(TEMPLATES, 'metric-call-failed.json'), 'utf8')) as { filter: string };
        for (const w of tokens('metric-call-failed.json')) assert.ok(metric.filter.includes(w), `filter misses ${w}`);
    });

    it('every policy reads a metric that exists here or is a Cloud Run / uptime built-in', () => {
        const ours = new Set(templates.filter((f) => f.startsWith('metric-'))
            .map((f) => (JSON.parse(readFileSync(join(TEMPLATES, f), 'utf8')) as { name: string }).name));
        for (const f of templates.filter((t) => t.startsWith('policy-'))) {
            const text = readFileSync(join(TEMPLATES, f), 'utf8');
            for (const m of text.matchAll(/logging\.googleapis\.com\/user\/([\w@]+)/g)) {
                assert.ok(ours.has(m[1] as string), `${f} reads ${m[1]}, which no metric template defines`);
            }
        }
    });
});

describe('ops/monitoring/apply.sh', () => {
    const bash = spawnSync('bash', ['--version'], { encoding: 'utf8' });

    it('the offline dry run renders both environments and changes nothing', { skip: bash.status !== 0 && 'no bash' }, () => {
        const dir = mkdtempSync(join(tmpdir(), 'vca-mon-'));
        try {
            const env = { ...process.env, OFFLINE: '1', RENDER_DIR: dir, APPLY: '' };
            const r = spawnSync('bash', [join(MON, 'apply.sh'), 'all'], { encoding: 'utf8', env, timeout: 50_000 });
            assert.equal(r.status, 0, `${String(r.error ?? '')} ${r.signal ?? ''} ${r.stderr}`);
            assert.match(r.stdout, /DRY RUN: nothing was created or changed/);
            assert.doesNotMatch(r.stdout, /APPLY done/);
            for (const envName of ['dev', 'prod']) {
                const rendered = readdirSync(join(dir, envName)).filter((f) => f.endsWith('.json'));
                assert.equal(rendered.length, templates.length, `${envName}: rendered ${rendered.length} of ${templates.length}`);
                for (const f of rendered) {
                    const text = readFileSync(join(dir, envName, f), 'utf8');
                    JSON.parse(text);
                    assert.doesNotMatch(text, /@[A-Z]+@/, `${envName}/${f} has an unfilled placeholder`);
                }
            }
            assert.match(r.stdout, /service_name|vca_call_failed_prod/);
            assert.match(r.stdout, /--filter-labels=env=prod/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
