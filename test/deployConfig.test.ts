/**
 * The dev deploy, as written in the files that actually deploy it.
 *
 * WHY THIS EXISTS, WITH THE DATE. Until 2026-11-14 the service definition lived only as a block of
 * prose in `docs/DEPLOY.md` (held by `test/docs.test.ts`). TASK-3748 step 4 added the files that
 * run it: `Dockerfile`, `cloudbuild.yaml` and `.github/workflows/deploy-dev.yml`. Each flag below
 * has a reason in DEPLOY.md section 2, and each is the kind a later reader "fixes":
 *
 *   - concurrency 1     one call per instance; Google's WebSocket page recommends the opposite.
 *   - max-instances 5   the ceiling on simultaneous calls, and the blast radius of a loop.
 *   - min-instances 0   a warm instance is a monthly cost that waits for Peter's yes (5c Q1).
 *   - timeout 600       a WebSocket is an HTTP request; it must outlive the call cap, not by an hour.
 *   - one env variable  the backend's address. No secret, no key and no venue-call switch lives on
 *                       this service; the switches are the backend's and the operator's.
 *   - no auth flag      the build identity holds run.developer and cannot set IAM, so
 *                       `--allow-unauthenticated` on every deploy would fail it; the public
 *                       binding is set once by an owner.
 *
 * The repository has no YAML parser and must not grow one for a test, so the deploy step is read
 * as the flat `--flag=value` list it is written as. A rewrite into another shape fails the parse
 * loudly rather than passing quietly.
 *
 * 🔴 WITH A CONTROL, because a checker that finds every flag right and a checker that reads nothing
 * are the same observation from outside.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

const SERVICE = 'venue-call-agent-dev';
const PROJECT = 'creatorain-27e9e';
const RUNTIME_SA = 'venue-call-runtime@creatorain-27e9e.iam.gserviceaccount.com';
const BUILD_SA = 'venue-call-build@creatorain-27e9e.iam.gserviceaccount.com';
/** The pb dev base (context/api-usage.md: datadev serves the `dev` branch); the seam paths hang off its root. */
const API_BASE_URL = 'https://datadev.creatorain.com';

/** The `gcloud run deploy` step's arguments, as `{ flag: value }` (a bare flag maps to `true`). */
export function deployFlags(cloudbuild: string): Map<string, string | true> {
    const step = cloudbuild.match(/- id: deploy\n([\s\S]*?)(?=\n {2}- id: |\n?$)/)?.[1];
    if (step === undefined) throw new Error('cloudbuild.yaml has no `- id: deploy` step');
    if (!/entrypoint: gcloud\n/.test(step)) throw new Error('the deploy step is not `gcloud`');
    const args = [...step.matchAll(/^ {6}- (\S.*)$/gm)].map((m) => (m[1] ?? '').trim());
    if (args.slice(0, 3).join(' ') !== `run deploy ${SERVICE}`) {
        throw new Error(`the deploy step does not start \`run deploy ${SERVICE}\`: ${args.slice(0, 3).join(' ')}`);
    }
    const flags = new Map<string, string | true>();
    for (const a of args.slice(3)) {
        const m = a.match(/^(--[a-z-]+)(?:=(.*))?$/);
        if (!m) throw new Error(`unreadable deploy argument: ${a}`);
        if (flags.has(m[1] ?? '')) throw new Error(`${m[1]} appears twice`);
        flags.set(m[1] ?? '', m[2] ?? true);
    }
    return flags;
}

/** Every way the deploy step can drift from DEPLOY.md section 2; empty when it is right. */
export function deployFindings(cloudbuild: string): string[] {
    let flags: Map<string, string | true>;
    try {
        flags = deployFlags(cloudbuild);
    } catch (e) {
        return [(e as Error).message];
    }
    const wrong: string[] = [];
    const want: Record<string, string | true> = {
        '--project': PROJECT,
        '--region': 'us-central1',
        '--service-account': RUNTIME_SA,
        '--timeout': '600',
        '--concurrency': '1',
        '--max-instances': '5',
        '--min-instances': '0',
        '--cpu-boost': true,
        '--cpu-throttling': true,
        '--set-env-vars': `CREATORAIN_API_BASE_URL=${API_BASE_URL}`,
    };
    for (const [flag, value] of Object.entries(want)) {
        if (flags.get(flag) !== value) wrong.push(`${flag} is ${String(flags.get(flag) ?? 'absent')}, want ${String(value)}`);
    }
    const allowed = new Set([...Object.keys(want), '--image', '--quiet']);
    for (const flag of flags.keys()) {
        if (!allowed.has(flag)) wrong.push(`${flag} is not part of the dev service definition (env, secrets, auth and IAM are not set here)`);
    }
    const env = flags.get('--set-env-vars');
    if (typeof env === 'string' && env.includes(',')) wrong.push('--set-env-vars carries more than one variable');
    if (flags.get('--image') !== '${_IMAGE}:${_COMMIT_SHA}') wrong.push('--image is not the image this build pushed');
    if (!cloudbuild.includes(`serviceAccount: projects/${PROJECT}/serviceAccounts/${BUILD_SA}`)) {
        wrong.push('the build does not name venue-call-build@ (the default compute account is disabled)');
    }
    if (!/logging: CLOUD_LOGGING_ONLY/.test(cloudbuild)) wrong.push('the build does not log to Cloud Logging only');
    return wrong;
}

/** The Dockerfile's base must be Node 22.18 by digest, run as a non-root user, and start the server. */
export function dockerfileFindings(dockerfile: string, nvmrc: string): string[] {
    const wrong: string[] = [];
    const from = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]);
    if (from.length !== 1) wrong.push(`want exactly one FROM, found ${from.length}`);
    const base = from[0] ?? '';
    const m = base.match(/^node:(\d+\.\d+)\.\d+-slim@sha256:[0-9a-f]{64}$/);
    if (!m) wrong.push(`the base ${base || '(none)'} is not node:<x.y.z>-slim pinned by a sha256 digest`);
    else if (m[1] !== nvmrc.trim()) wrong.push(`the base is Node ${m[1]}, .nvmrc says ${nvmrc.trim()}`);
    const users = [...dockerfile.matchAll(/^USER\s+(\S+)/gm)].map((u) => u[1]);
    if (users.length === 0 || ['root', '0'].includes(users[users.length - 1] ?? 'root')) wrong.push('the image runs as root');
    if (!/^RUN npm ci --omit=dev\b/m.test(dockerfile)) wrong.push('dependencies are not installed with `npm ci --omit=dev`');
    if (!dockerfile.includes('CMD ["node", "src/server/main.ts"]')) wrong.push('the image does not start src/server/main.ts');
    return wrong;
}

/** The workflow: dev pushes only, keyless, every action pinned to a commit SHA. */
export function workflowFindings(workflow: string): string[] {
    const wrong: string[] = [];
    const on = workflow.match(/^on:\n([\s\S]*?)\n(?=\S)/m)?.[1] ?? '';
    if (!/^ {2}push:\n {4}branches: \[dev\]$/m.test(on)) wrong.push('the workflow is not triggered by a push to dev');
    if (/pull_request/.test(on)) wrong.push('a pull request must never deploy');
    if (!/^ {2}id-token: write$/m.test(workflow)) wrong.push('no id-token: write, so federation cannot work');
    if (/credentials_json|GOOGLE_CREDENTIALS|service_account_key/.test(workflow)) wrong.push('a service-account key is referenced');
    for (const [, ref] of workflow.matchAll(/uses:\s*(\S+)/g)) {
        if (!/@[0-9a-f]{40}$/.test(ref ?? '')) wrong.push(`${ref} is not pinned to a full commit SHA`);
    }
    if (!workflow.includes('service_account: ci-dispatch-vca@creatorain-27e9e.iam.gserviceaccount.com')) {
        wrong.push('the workflow does not act as ci-dispatch-vca@');
    }
    if (!/gcloud builds submit --no-source/.test(workflow)) wrong.push('the workflow does not start the build with `gcloud builds submit --no-source`');
    return wrong;
}

describe('the dev deploy files', () => {
    it('cloudbuild.yaml deploys with concurrency 1, max 5, min 0, timeout 600 and only CREATORAIN_API_BASE_URL', () => {
        const wrong = deployFindings(read('cloudbuild.yaml'));
        assert.deepEqual(wrong, [], wrong.join('\n'));
        const flags = deployFlags(read('cloudbuild.yaml'));
        assert.equal(flags.get('--concurrency'), '1');
        assert.equal(flags.get('--max-instances'), '5');
        assert.equal(flags.get('--min-instances'), '0');
        assert.equal(flags.get('--timeout'), '600');
        assert.equal(flags.get('--set-env-vars'), `CREATORAIN_API_BASE_URL=${API_BASE_URL}`);
    });

    it('the Dockerfile pins Node by digest to the .nvmrc line and runs as non-root', () => {
        const wrong = dockerfileFindings(read('Dockerfile'), read('.nvmrc'));
        assert.deepEqual(wrong, [], wrong.join('\n'));
    });

    it('.github/workflows/deploy-dev.yml deploys on dev pushes only, keyless, SHA-pinned', () => {
        const wrong = workflowFindings(read('.github/workflows/deploy-dev.yml'));
        assert.deepEqual(wrong, [], wrong.join('\n'));
    });

    it('CONTROL: every planted drift is caught', () => {
        const good = read('cloudbuild.yaml');
        const plants: Array<[string, string, RegExp]> = [
            ['--concurrency=1', '--concurrency=80', /--concurrency/],
            ['--max-instances=5', '--max-instances=50', /--max-instances/],
            ['--min-instances=0', '--min-instances=1', /--min-instances/],
            ['--timeout=600', '--timeout=3600', /--timeout/],
            ['CREATORAIN_API_BASE_URL=https://datadev.creatorain.com', 'CREATORAIN_API_BASE_URL=https://datadev.creatorain.com,VENUE_CALL_X=1', /more than one variable/],
            ['      - --quiet', '      - --quiet\n      - --allow-unauthenticated', /--allow-unauthenticated is not part/],
            ['      - --quiet', '      - --quiet\n      - --set-secrets=K=k:latest', /--set-secrets is not part/],
            [`serviceAccount: projects/${PROJECT}`, '# serviceAccount: none', /venue-call-build/],
        ];
        for (const [from, to, expect] of plants) {
            assert.ok(good.includes(from), `the control's anchor ${from} is gone from cloudbuild.yaml`);
            const findings = deployFindings(good.replace(from, to));
            assert.ok(findings.some((f) => expect.test(f)), `planting ${to} was not caught: ${findings.join('; ')}`);
        }
        assert.match(deployFindings('steps: []\n').join(), /no `- id: deploy` step/);

        const docker = read('Dockerfile');
        const nvmrc = read('.nvmrc');
        assert.ok(dockerfileFindings(docker.replace(/@sha256:[0-9a-f]{64}/, ''), nvmrc).some((f) => /digest/.test(f)));
        assert.ok(dockerfileFindings(docker, '24.1\n').some((f) => /\.nvmrc says/.test(f)));
        assert.ok(dockerfileFindings(docker.replace('USER node', 'USER root'), nvmrc).some((f) => /root/.test(f)));

        const wf = read('.github/workflows/deploy-dev.yml');
        assert.ok(workflowFindings(wf.replace(/(google-github-actions\/auth)@[0-9a-f]{40}/, '$1@v3')).some((f) => /full commit SHA/.test(f)));
        assert.ok(workflowFindings(wf.replace('  push:\n    branches: [dev]', '  pull_request:\n    branches: [dev]')).some((f) => /push to dev|pull request/.test(f)));
        assert.ok(workflowFindings(wf.replace('  id-token: write', '  id-token: none')).some((f) => /id-token/.test(f)));
    });
});
