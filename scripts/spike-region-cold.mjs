#!/usr/bin/env node
/**
 * SPIKE (it-22, spike/us-east4): cold start and the warm edge of one dev service, read from this
 * machine with the soak's own forged-token leg. Fake legs only: no carrier, no Twilio, no call.
 *
 *     node scripts/spike-region-cold.mjs --url https://<service> [--hold] [--warm 4] [--label x]
 *
 * Each probe opens the Twilio-shaped leg with FORGED_TOKEN: the service takes the upgrade, asks the
 * backend (pb dev, which refuses), and closes, silent. `upgradeMs` is connect to upgrade (the
 * container's start on a cold probe); `callMs` is upgrade to the server's close, so it carries the
 * service's own round trip to the backend's seam. Then GET /health.
 *
 * `--hold` first opens one idle leg and keeps it open (the stream server closes it at its 3 s
 * pre-auth deadline). At concurrency 1 that occupies the warm instance, so the probe lands on a
 * NEW instance: a cold start on a service that an uptime check never lets scale to zero.
 *
 * Prints one JSON line. Not part of the product; deleted with the spike if it does not win.
 */
import { WebSocket } from 'ws';
import { runCorpusCall } from '../src/soak/corpus.ts';
import { FORGED_TOKEN } from '../src/soak/driver.ts';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const base = opt('url', null);
if (!base) { process.stderr.write('--url is required\n'); process.exit(2); }
const warm = Number(opt('warm', '4'));
const label = opt('label', '');
const hold = argv.includes('--hold');

const wsUrl = new URL('/stream', base);
wsUrl.protocol = 'wss:';
const connect = (url, options) => new WebSocket(url, options);
const bed = Buffer.alloc(160, 0xff);

async function probe(kind) {
    const startedAt = new Date().toISOString();
    const leg = await runCorpusCall(connect, wsUrl.href, {
        token: FORGED_TOKEN, turns: [], bed, replyWaitMs: 3000, endWaitMs: 500, timeoutMs: 30_000,
    });
    const t0 = performance.now();
    let health = 0;
    try {
        health = (await fetch(new URL('/health', base), { signal: AbortSignal.timeout(30_000) })).status;
    } catch { /* 0 */ }
    return {
        kind, startedAt, at: new Date().toISOString(), upgradeMs: leg.upgradeMs, callMs: leg.callMs,
        closedBy: leg.closedBy, closeCode: leg.closeCode, audibleFramesOut: leg.audibleFramesOut,
        health, healthMs: Math.round(performance.now() - t0),
    };
}

let holder = null;
if (hold) {
    holder = new WebSocket(wsUrl.href);
    await new Promise((resolve, reject) => { holder.once('open', resolve); holder.once('error', reject); });
}
const probes = [await probe(hold ? 'cold (new instance beside a held one)' : 'first (cold if idle)')];
holder?.close();
for (let i = 0; i < warm; i += 1) probes.push(await probe('warm'));
process.stdout.write(`${JSON.stringify({ label, base, hold, probes })}\n`);
