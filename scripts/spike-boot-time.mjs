#!/usr/bin/env node
/**
 * SPIKE (it-22, spike/us-east4): how long `node src/server/main.ts` takes to listen, and to log
 * `cascade_warm`, on this machine. No call, no carrier: the process is spawned, timed and killed.
 *
 *     node scripts/spike-boot-time.mjs [--runs 5] [--env KEY=VALUE ...] [--no-warm]
 *
 * The backend is pointed at a closed local port, so nothing is authorised; the cascade still starts
 * at boot (a backend is named), which is the cost a Cloud Run instance pays.
 */
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const runs = Number(opt('runs', '5'));
const extra = {};
argv.forEach((a, i) => { if (a === '--env') { const [k, ...v] = argv[i + 1].split('='); extra[k] = v.join('='); } });
const waitWarm = !argv.includes('--no-warm');

function once(port) {
    return new Promise((resolve) => {
        const t0 = performance.now();
        const child = spawn(process.execPath, ['--import', './scripts/soak-local-quota.mjs', 'src/server/main.ts'], {
            env: { ...process.env, PORT: String(port), CREATORAIN_API_BASE_URL: 'http://127.0.0.1:9', ...extra },
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        const r = { listenMs: null, warmMs: null, warmLine: null };
        let buf = '';
        const done = () => { child.kill(); resolve(r); };
        const timer = setTimeout(done, 20_000);
        child.stderr.on('data', (d) => {
            buf += d;
            if (r.listenMs === null && buf.includes('listening on')) {
                r.listenMs = Math.round(performance.now() - t0);
                if (!waitWarm) { clearTimeout(timer); done(); }
            }
            const m = /cascade_warm(_failed)? [^\n]*/.exec(buf);
            if (r.warmMs === null && m) { r.warmMs = Math.round(performance.now() - t0); r.warmLine = m[0]; clearTimeout(timer); done(); }
        });
    });
}

const results = [];
for (let i = 0; i < runs; i += 1) results.push(await once(18_600 + i));
const med = (xs) => { const s = xs.filter((x) => x !== null).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
process.stdout.write(`${JSON.stringify({ extra, results, listenP50: med(results.map((r) => r.listenMs)), warmP50: med(results.map((r) => r.warmMs)) })}\n`);
