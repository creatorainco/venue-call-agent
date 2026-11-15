/**
 * The dev and production deploys, as written in the files that actually deploy them.
 *
 * WHY THIS EXISTS, WITH THE DATE. Until 2026-11-14 the service definition lived only as a block of
 * prose in `docs/DEPLOY.md` (held by `test/docs.test.ts`). TASK-3748 step 4 added the files that
 * run it: `Dockerfile`, `cloudbuild.yaml` and `.github/workflows/deploy-dev.yml`. On 2026-11-15
 * (venue-call plan it-09, Peter's infra yes) the production twin joined them:
 * `cloudbuild-prod.yaml` and `.github/workflows/deploy-main.yml`. Each flag below has a reason in
 * DEPLOY.md section 2, and each is the kind a later reader "fixes":
 *
 *   - concurrency 1     one call per instance; Google's WebSocket page recommends the opposite.
 *   - max-instances 5   the ceiling on simultaneous calls, and the blast radius of a loop.
 *   - min-instances 0   a warm instance is a monthly cost that waits for Peter's yes (5c Q1); the
 *                       free warm ping at dial time comes first (Peter, 2026-11-15).
 *   - timeout 600       a WebSocket is an HTTP request; it must outlive the call cap, not by an hour.
 *   - one env variable  the backend's address. No secret, no key and no venue-call switch lives on
 *                       this service; the switches are the backend's and the operator's.
 *   - no auth flag      the build identity holds run.developer and cannot set IAM, so
 *                       `--allow-unauthenticated` on every deploy would fail it; the public
 *                       binding is set once by an owner.
 *
 * And the one property only a pair of environments can break: production must share NOTHING a
 * `dev` push can reach. Its own service, backend, image repository, build, runtime and dispatch
 * identities. A prod file that still names one dev value deploys dev code to prod, or prod data to
 * a dev identity, and passes every per-file check.
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

const PROJECT = 'creatorain-27e9e';
const sa = (name: string): string => `${name}@${PROJECT}.iam.gserviceaccount.com`;

/** One deployed environment: the files that deploy it and every value that must be its own. */
export interface DeployEnv {
    name: string;
    cloudbuild: string;
    workflow: string;
    branch: string;
    service: string;
    image: string;
    runtimeSa: string;
    buildSa: string;
    dispatchSa: string;
    /** The pb base (context/api-usage.md); the seam paths hang off its root. */
    apiBaseUrl: string;
    /**
     * The deploy job `needs` a `verify` job that calls verify.yml on the same commit. Production
     * only (2026-11-15 review of it-09): `enforce_admins` is off, so branch protection alone lets an
     * owner merge past a red check, and a deploy running beside verify would ship that commit.
     */
    gatedOnVerify: boolean;
}

/** The one local reusable workflow a deploy may call; it is read from the same commit, so no pin. */
const VERIFY_CALL = './.github/workflows/verify.yml';

export const DEV: DeployEnv = {
    name: 'dev',
    cloudbuild: 'cloudbuild.yaml',
    workflow: '.github/workflows/deploy-dev.yml',
    branch: 'dev',
    service: 'venue-call-agent-dev',
    image: `us-central1-docker.pkg.dev/${PROJECT}/venue-call-agent/venue-call-agent`,
    runtimeSa: sa('venue-call-runtime'),
    buildSa: sa('venue-call-build'),
    dispatchSa: sa('ci-dispatch-vca'),
    apiBaseUrl: 'https://datadev.creatorain.com',
    gatedOnVerify: false,
};

export const PROD: DeployEnv = {
    name: 'prod',
    cloudbuild: 'cloudbuild-prod.yaml',
    workflow: '.github/workflows/deploy-main.yml',
    branch: 'main',
    service: 'venue-call-agent',
    image: `us-central1-docker.pkg.dev/${PROJECT}/venue-call-agent-prod/venue-call-agent`,
    runtimeSa: sa('venue-call-runtime-prod'),
    buildSa: sa('venue-call-build-prod'),
    dispatchSa: sa('ci-dispatch-vca-prod'),
    apiBaseUrl: 'https://data.creatorain.com',
    gatedOnVerify: true,
};

/** The `gcloud run deploy` step's arguments, as `{ flag: value }` (a bare flag maps to `true`). */
export function deployFlags(cloudbuild: string, service: string): Map<string, string | true> {
    const step = cloudbuild.match(/- id: deploy\n([\s\S]*?)(?=\n {2}- id: |\n?$)/)?.[1];
    if (step === undefined) throw new Error('the build file has no `- id: deploy` step');
    if (!/entrypoint: gcloud\n/.test(step)) throw new Error('the deploy step is not `gcloud`');
    const args = [...step.matchAll(/^ {6}- (\S.*)$/gm)].map((m) => (m[1] ?? '').trim());
    if (args.slice(0, 3).join(' ') !== `run deploy ${service}`) {
        throw new Error(`the deploy step does not start \`run deploy ${service}\`: ${args.slice(0, 3).join(' ')}`);
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

/** Every way a build file can drift from DEPLOY.md section 2 for its environment; empty when right. */
export function deployFindings(cloudbuild: string, env: DeployEnv): string[] {
    let flags: Map<string, string | true>;
    try {
        flags = deployFlags(cloudbuild, env.service);
    } catch (e) {
        return [(e as Error).message];
    }
    const wrong: string[] = [];
    const want: Record<string, string | true> = {
        '--project': PROJECT,
        '--region': 'us-central1',
        '--service-account': env.runtimeSa,
        '--timeout': '600',
        '--concurrency': '1',
        '--max-instances': '5',
        '--min-instances': '0',
        '--cpu-boost': true,
        '--cpu-throttling': true,
        '--set-env-vars': `CREATORAIN_API_BASE_URL=${env.apiBaseUrl}`,
    };
    for (const [flag, value] of Object.entries(want)) {
        if (flags.get(flag) !== value) wrong.push(`${flag} is ${String(flags.get(flag) ?? 'absent')}, want ${String(value)}`);
    }
    const allowed = new Set([...Object.keys(want), '--image', '--quiet']);
    for (const flag of flags.keys()) {
        if (!allowed.has(flag)) wrong.push(`${flag} is not part of the ${env.name} service definition (env, secrets, auth and IAM are not set here)`);
    }
    const vars = flags.get('--set-env-vars');
    if (typeof vars === 'string' && vars.includes(',')) wrong.push('--set-env-vars carries more than one variable');
    if (flags.get('--image') !== '${_IMAGE}:${_COMMIT_SHA}') wrong.push('--image is not the image this build pushed');
    if (!new RegExp(`^ {2}_IMAGE: ${env.image.replace(/[.]/g, '\\.')}$`, 'm').test(cloudbuild)) {
        wrong.push(`_IMAGE is not ${env.image}`);
    }
    if (!cloudbuild.includes(`serviceAccount: projects/${PROJECT}/serviceAccounts/${env.buildSa}`)) {
        wrong.push(`the build does not name ${env.buildSa} (the default compute account is disabled)`);
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

/** One job's lines under `jobs:`, up to the next line at two spaces or less of indent ('' if none). */
export function jobBlock(workflow: string, name: string): string {
    const lines = workflow.split('\n');
    const start = lines.indexOf(`  ${name}:`);
    if (start < 0) return '';
    const out: string[] = [];
    for (const line of lines.slice(start + 1)) {
        if (/^ {0,2}\S/.test(line)) break;
        out.push(line);
    }
    return out.join('\n');
}

/** The workflow: pushes to its one branch only, keyless, every action pinned, its own build file. */
export function workflowFindings(workflow: string, env: DeployEnv): string[] {
    const wrong: string[] = [];
    const on = workflow.match(/^on:\n([\s\S]*?)\n(?=\S)/m)?.[1] ?? '';
    if (!new RegExp(`^ {2}push:\\n {4}branches: \\[${env.branch}\\]$`, 'm').test(on)) {
        wrong.push(`the workflow is not triggered by a push to ${env.branch}`);
    }
    if ([...on.matchAll(/branches: \[([^\]]*)\]/g)].some((b) => (b[1] ?? '').split(',').map((s) => s.trim()).some((s) => s !== env.branch))) {
        wrong.push(`the workflow names a branch other than ${env.branch}`);
    }
    if (/pull_request/.test(on)) wrong.push('a pull request must never deploy');
    const deployJob = jobBlock(workflow, 'deploy');
    const verifyJob = jobBlock(workflow, 'verify');
    if (!deployJob.includes(`    if: github.ref == 'refs/heads/${env.branch}'`)) wrong.push(`the deploy job does not refuse a run off ${env.branch}`);
    if (!/^ {2}id-token: write$/m.test(workflow)) wrong.push('no id-token: write, so federation cannot work');
    if (/credentials_json|GOOGLE_CREDENTIALS|service_account_key/.test(workflow)) wrong.push('a service-account key is referenced');
    for (const [, ref] of workflow.matchAll(/uses:\s*(\S+)/g)) {
        if (ref === VERIFY_CALL) continue;
        if (!/@[0-9a-f]{40}$/.test(ref ?? '')) wrong.push(`${ref} is not pinned to a full commit SHA`);
    }
    if (env.gatedOnVerify) {
        if (!/^ {4}needs: verify$/m.test(deployJob)) wrong.push('the deploy job does not `needs: verify`');
        if (!new RegExp(`^ {4}uses: ${VERIFY_CALL.replace(/[.]/g, '\\.')}$`, 'm').test(verifyJob)) {
            wrong.push(`the verify job does not call ${VERIFY_CALL}`);
        }
        if (!/^ {4}if: github\.ref == /m.test(verifyJob)) wrong.push('the verify job does not refuse a run off the branch');
    }
    const accounts = [...workflow.matchAll(/^\s*service_account: (\S+)$/gm)].map((m) => m[1]);
    if (accounts.length !== 1 || accounts[0] !== env.dispatchSa) {
        wrong.push(`the workflow does not act as ${env.dispatchSa} alone (found ${accounts.join(', ') || 'none'})`);
    }
    if (!/gcloud builds submit --no-source/.test(workflow)) wrong.push('the workflow does not start the build with `gcloud builds submit --no-source`');
    const configs = [...workflow.matchAll(/--config=(\S+)/g)].map((m) => m[1]);
    if (configs.length !== 1 || configs[0] !== env.cloudbuild) {
        wrong.push(`the workflow does not build from ${env.cloudbuild} alone (found ${configs.join(', ') || 'none'})`);
    }
    return wrong;
}

/**
 * Every value that is the other environment's own and appears in this one's files, comments aside
 * (a comment may say "the same shape as cloudbuild.yaml"; only what runs counts).
 *
 * The service names nest (`venue-call-agent` is inside `venue-call-agent-dev` and inside the image
 * path and the git remote), so a value counts only as a whole token: nothing word-like, a hyphen
 * or a dot on either side, and for a service name no slash either.
 */
export function crossFindings(files: string, env: DeployEnv, other: DeployEnv): string[] {
    const code = files.split('\n').filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/\s+#\s.*$/, '')).join('\n');
    const wrong: string[] = [];
    for (const k of ['service', 'image', 'runtimeSa', 'buildSa', 'dispatchSa', 'apiBaseUrl', 'cloudbuild'] as const) {
        const v = other[k].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
        // An account is written after `serviceAccounts/`; a service name after a slash is a path.
        const before = k === 'service' ? '[\\w/.-]' : '[\\w.-]';
        if (new RegExp(`(?<!${before})${v}(?![\\w/-]|\\.[a-z])`).test(code)) {
            wrong.push(`the ${env.name} deploy names ${other.name}'s ${k} ${other[k]}`);
        }
    }
    return wrong;
}

const filesOf = (env: DeployEnv): string => `${read(env.cloudbuild)}\n${read(env.workflow)}`;

describe('the dev and production deploy files', () => {
    for (const env of [DEV, PROD]) {
        it(`${env.cloudbuild} deploys ${env.service} with concurrency 1, max 5, min 0, timeout 600 and only ${env.apiBaseUrl}`, () => {
            const wrong = deployFindings(read(env.cloudbuild), env);
            assert.deepEqual(wrong, [], wrong.join('\n'));
            const flags = deployFlags(read(env.cloudbuild), env.service);
            assert.equal(flags.get('--concurrency'), '1');
            assert.equal(flags.get('--max-instances'), '5');
            assert.equal(flags.get('--min-instances'), '0');
            assert.equal(flags.get('--timeout'), '600');
            assert.equal(flags.get('--set-env-vars'), `CREATORAIN_API_BASE_URL=${env.apiBaseUrl}`);
        });

        it(`${env.workflow} deploys on ${env.branch} pushes only, keyless, SHA-pinned, from ${env.cloudbuild}`, () => {
            const wrong = workflowFindings(read(env.workflow), env);
            assert.deepEqual(wrong, [], wrong.join('\n'));
        });
    }

    it('production shares no service, backend, image, identity or build file with dev, and the reverse', () => {
        const wrong = [...crossFindings(filesOf(PROD), PROD, DEV), ...crossFindings(filesOf(DEV), DEV, PROD)];
        assert.deepEqual(wrong, [], wrong.join('\n'));
    });

    it('the two build files differ only in the values that are each environment\'s own', () => {
        const strip = (text: string, env: DeployEnv): string => {
            const steps = text.slice(text.indexOf('\nserviceAccount:'));
            let out = steps.replace(/^\s*#.*\n/gm, '');
            for (const k of ['image', 'runtimeSa', 'buildSa', 'apiBaseUrl'] as const) out = out.split(env[k]).join(`<${k}>`);
            return out.replace(`run\n      - deploy\n      - ${env.service}\n`, 'run\n      - deploy\n      - <service>\n');
        };
        assert.equal(strip(read(PROD.cloudbuild), PROD), strip(read(DEV.cloudbuild), DEV));
    });

    it('verify.yml can be called by the prod deploy and lints the workflows with a checked binary', () => {
        const verify = read('.github/workflows/verify.yml');
        const on = verify.match(/^on:\n([\s\S]*?)\n(?=\S)/m)?.[1] ?? '';
        assert.match(on, /^ {2}workflow_call:$/m, 'verify.yml has no workflow_call trigger, so deploy-main cannot need it');
        assert.match(verify, /sha256sum -c -/, 'actionlint is run without checking its SHA-256');
        assert.match(verify, /^ {10}"\$RUNNER_TEMP\/actionlint"/m, 'verify.yml no longer runs actionlint');
    });

    it('the Dockerfile pins Node by digest to the .nvmrc line and runs as non-root', () => {
        const wrong = dockerfileFindings(read('Dockerfile'), read('.nvmrc'));
        assert.deepEqual(wrong, [], wrong.join('\n'));
    });

    it('CONTROL: every planted drift is caught', () => {
        for (const env of [DEV, PROD]) {
            const good = read(env.cloudbuild);
            const base = `CREATORAIN_API_BASE_URL=${env.apiBaseUrl}`;
            const plants: Array<[string, string, RegExp]> = [
                ['--concurrency=1', '--concurrency=80', /--concurrency/],
                ['--max-instances=5', '--max-instances=50', /--max-instances/],
                ['--min-instances=0', '--min-instances=1', /--min-instances/],
                ['--timeout=600', '--timeout=3600', /--timeout/],
                [base, `${base},VENUE_CALL_X=1`, /more than one variable/],
                ['      - --quiet', '      - --quiet\n      - --allow-unauthenticated', /--allow-unauthenticated is not part/],
                ['      - --quiet', '      - --quiet\n      - --set-secrets=K=k:latest', /--set-secrets is not part/],
                [`serviceAccount: projects/${PROJECT}`, '# serviceAccount: none', /does not name/],
            ];
            for (const [from, to, expect] of plants) {
                assert.ok(good.includes(from), `the control's anchor ${from} is gone from ${env.cloudbuild}`);
                const findings = deployFindings(good.replace(from, to), env);
                assert.ok(findings.some((f) => expect.test(f)), `${env.name}: planting ${to} was not caught: ${findings.join('; ')}`);
            }

            const wf = read(env.workflow);
            assert.ok(workflowFindings(wf.replace(/(google-github-actions\/auth)@[0-9a-f]{40}/, '$1@v3'), env).some((f) => /full commit SHA/.test(f)));
            const push = `  push:\n    branches: [${env.branch}]`;
            assert.ok(wf.includes(push), `the control's anchor ${push} is gone from ${env.workflow}`);
            assert.ok(workflowFindings(wf.replace(push, `  pull_request:\n    branches: [${env.branch}]`), env).some((f) => /push to|pull request/.test(f)));
            assert.ok(workflowFindings(wf.replace(push, `  push:\n    branches: [${env.branch}, feature]`), env).some((f) => /push to|other than/.test(f)));
            assert.ok(workflowFindings(wf.replace('  id-token: write', '  id-token: none'), env).some((f) => /id-token/.test(f)));
            // The LAST `if:` is the deploy job's (prod's verify job comes first and has its own plant).
            const at = wf.lastIndexOf(`refs/heads/${env.branch}'`);
            const offBranch = `${wf.slice(0, at)}refs/heads/x'${wf.slice(at + `refs/heads/${env.branch}'`.length)}`;
            assert.ok(workflowFindings(offBranch, env).some((f) => /deploy job does not refuse a run/.test(f)));
        }
        assert.match(deployFindings('steps: []\n', DEV).join(), /no `- id: deploy` step/);

        // The prod build pointed at the dev backend, the dev runtime, the dev image or the dev service.
        const prod = read(PROD.cloudbuild);
        const prodPlants: Array<[string, string, RegExp]> = [
            [PROD.apiBaseUrl, DEV.apiBaseUrl, /--set-env-vars/],
            [PROD.runtimeSa, DEV.runtimeSa, /--service-account/],
            [PROD.buildSa, DEV.buildSa, /does not name/],
            [PROD.image, DEV.image, /_IMAGE is not/],
            [`      - ${PROD.service}\n`, `      - ${DEV.service}\n`, /does not start `run deploy venue-call-agent`/],
        ];
        for (const [from, to, expect] of prodPlants) {
            assert.ok(prod.includes(from), `the control's anchor ${from} is gone from ${PROD.cloudbuild}`);
            const planted = prod.replace(from, to);
            assert.ok(deployFindings(planted, PROD).some((f) => expect.test(f)), `prod: planting ${to} was not caught`);
            assert.ok(crossFindings(planted, PROD, DEV).length > 0, `prod: the cross-check missed ${to}`);
        }

        // The prod workflow acting as the dev dispatcher, or building from the dev file.
        const main = read(PROD.workflow);
        const workflowPlants: Array<[string, string]> = [
            [PROD.dispatchSa, DEV.dispatchSa],
            ['--config=cloudbuild-prod.yaml', '--config=cloudbuild.yaml'],
        ];
        for (const [from, to] of workflowPlants) {
            assert.ok(main.includes(from), `the control's anchor ${from} is gone from ${PROD.workflow}`);
            assert.ok(workflowFindings(main.replace(from, to), PROD).length > 0, `prod workflow: planting ${to} was not caught`);
            assert.ok(crossFindings(`${prod}\n${main.replace(from, to)}`, PROD, DEV).length > 0, `cross-check missed ${to}`);
        }

        // The prod deploy no longer waiting on verify, calling another local workflow, or verify
        // that runs on any branch.
        const gatePlants: Array<[string, string, RegExp]> = [
            ['    needs: verify\n', '', /needs: verify/],
            [`uses: ${VERIFY_CALL}`, 'uses: ./.github/workflows/other.yml', /does not call|full commit SHA/],
            ["  verify:\n    if: github.ref == 'refs/heads/main'\n", '  verify:\n', /verify job does not refuse/],
        ];
        for (const [from, to, expect] of gatePlants) {
            assert.ok(main.includes(from), `the control's anchor ${JSON.stringify(from)} is gone from ${PROD.workflow}`);
            const findings = workflowFindings(main.replace(from, to), PROD);
            assert.ok(findings.some((f) => expect.test(f)), `prod workflow: ${JSON.stringify(to)} was not caught: ${findings.join('; ')}`);
        }
        assert.deepEqual(workflowFindings(read(DEV.workflow), DEV), [], 'dev is not gated, and must not be held to it');

        // The prefix trap: the prod service name inside the dev one is not a finding, a bare one is.
        assert.deepEqual(crossFindings('run deploy venue-call-agent-dev', DEV, PROD), []);
        assert.ok(crossFindings('run deploy venue-call-agent --quiet', DEV, PROD).length > 0);

        const docker = read('Dockerfile');
        const nvmrc = read('.nvmrc');
        assert.ok(dockerfileFindings(docker.replace(/@sha256:[0-9a-f]{64}/, ''), nvmrc).some((f) => /digest/.test(f)));
        assert.ok(dockerfileFindings(docker, '24.1\n').some((f) => /\.nvmrc says/.test(f)));
        assert.ok(dockerfileFindings(docker.replace('USER node', 'USER root'), nvmrc).some((f) => /root/.test(f)));
    });
});
