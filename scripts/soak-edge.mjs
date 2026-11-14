#!/usr/bin/env node
/**
 * `npm run soak:edge` — the 3-call safety soak and the five bogus sockets (TASK-3749, VCA-12).
 *
 *     SOAK_TOKEN=<token> npm run soak:edge -- --url=https://<service> --legs=3 --expect=refused --bogus
 *     SOAK_TOKEN=mock:happy npm run soak:edge -- --url=http://127.0.0.1:8080 --legs=3 --expect=accepted-silent --bogus
 *
 * The token comes from `SOAK_TOKEN`, never argv, so it is in no shell history or process list.
 * Prints one JSON report and exits 1 if any leg failed its expectation or a health read was not 200.
 * It places no call: only a WebSocket to the URL given, and a GET of its /health.
 */

import { runEdgeSoak } from '../src/soak/edge.ts';

function flag(name) {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    if (hit) return hit.slice(name.length + 3);
    return process.argv.includes(`--${name}`) ? 'true' : undefined;
}

async function health(url) {
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        return res.status;
    } catch {
        return 0;
    }
}

const url = flag('url');
const expect = flag('expect') ?? 'refused';
if (!url || (expect !== 'refused' && expect !== 'accepted-silent')) {
    process.stderr.write('usage: SOAK_TOKEN=<token> npm run soak:edge -- --url=<base> [--legs=3] [--expect=refused|accepted-silent] [--bogus] [--media-ms=3000]\n');
    process.exit(2);
}
const legs = Number.parseInt(flag('legs') ?? '3', 10);
const token = process.env.SOAK_TOKEN?.trim();
if (legs > 0 && !token) {
    process.stderr.write('SOAK_TOKEN is not set; a Twilio-shaped leg needs a token.\n');
    process.exit(2);
}
const mediaMs = flag('media-ms');
const report = await runEdgeSoak({
    baseUrl: url,
    ...(token ? { token } : {}),
    legs,
    bogus: flag('bogus') === 'true',
    expect,
    ...(mediaMs ? { mediaMs: Number.parseInt(mediaMs, 10) } : {}),
    health,
});
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(report.pass ? 0 : 1);
