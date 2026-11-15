#!/usr/bin/env node
/**
 * `npm run soak:corpus` — the loopback soak with real speech (TASK-3749, I3P-02, I3P-13).
 *
 *     node scripts/soak-corpus.mjs [--dev-url https://<service>] [--project creatorain-27e9e]
 *         [--calls <n>] [--out docs/soak/<date>.json] [--md docs/soak/<date>.md]
 *
 * Two stages, both with fake legs only: no carrier, no Twilio, no call placed.
 *
 *   1. DEV (`--dev-url`), first, so the first probe can find the service scaled to zero. Each probe
 *      is a GET of /health and one Twilio-shaped leg carrying a FORGED token: the service takes the
 *      upgrade, asks the backend, is refused and closes, silent. What it measures is the container's
 *      cold start (connect to upgrade) and the warm edge. It cannot reach the speech path: a call is
 *      authorised by a token platform-backend mints on a dial, and pb dev's seam has no
 *      VENUE_CALL_SECRET (TASK-3749 plan, S2 waits for ladder D). No agent sets that secret.
 *   2. LOCAL: the runtime as the container runs it (`node src/server/main.ts`) on this machine, its
 *      seam pointed at the repo's mock seam (`mock:<scenario>` tokens), with the REAL cascade: Google
 *      STT v2, Gemini Flash-Lite on Vertex and Google TTS over Application Default Credentials. The
 *      corpus in `soak/fixtures/` is played call by call through `runCorpusCall`. The first call goes
 *      to a fresh process the moment it listens: that is the process's cold path to the disclosure.
 *
 * Per call it reads the wire (first audio, start to disclosure, longest silence, frames after the
 * venue hung up) and the runtime's `turn_timing` log lines (endpointing wait, intent, seam,
 * synthesis), and transcribes the agent's first utterance to hold it to the disclosure sentence.
 *
 * Writes the JSON report to `--out` and the markdown to `--md`. Exit 0 if the gate passed, 1 if not,
 * 2 on setup. A failed gate is still a report: the plan merges the measurement either way.
 * The agent's speech is transcribed for the disclosure check only; no transcript is written out.
 */

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

import { runCorpusCall, rank } from '../src/soak/corpus.ts';
import { FORGED_TOKEN } from '../src/soak/driver.ts';
import { summarise, disclosureRecall } from '../src/soak/report.ts';
import { startMockSeam } from '../src/mock/server.ts';
import { createSeamClient } from '../src/seam/client.ts';
import { probeRecognizeRequest, probeRecognizeUrl, recognizeTranscript } from '../src/speech/probeRequest.ts';
import { STT, INTENT_MODEL, INTENT_TIMEOUT_MS } from '../src/tuning/cascadeDefaults.ts';
import { createVertexClassifier, keywordIntent } from '../src/agent/intent.ts';
import { createAdcTokenSource } from '../src/google/adc.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const project = opt('project', 'creatorain-27e9e');
const devUrl = opt('dev-url', null);
const maxCalls = Number(opt('calls', '0')) || Infinity;
const outPath = opt('out', null);
const mdPath = opt('md', null);
/** Where to save the runtime's own log lines (event words and numbers; it never logs a transcript). */
const runtimeLogPath = opt('runtime-log', null);

const config = JSON.parse(readFileSync(join(ROOT, 'soak', 'soak.config.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(ROOT, 'soak', 'fixtures', 'manifest.json'), 'utf8'));
const fixture = (file) => readFileSync(join(ROOT, 'soak', 'fixtures', file));
const bed = fixture(manifest.noise.file);
const connect = (url, options) => new WebSocket(url, options);
const say = (line) => process.stderr.write(`soak-corpus: ${line}\n`);

const { GoogleAuth } = await import('google-auth-library');
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
async function transcribe(ulaw) {
    if (!ulaw.length) return '';
    const token = await auth.getAccessToken();
    const res = await fetch(probeRecognizeUrl(project), {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-goog-user-project': project },
        body: JSON.stringify(probeRecognizeRequest(Buffer.from(ulaw), STT.model)),
        signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return `<stt http ${res.status}>`;
    return recognizeTranscript(await res.json());
}

// ── 1. DEV: cold start and the warm edge, with a forged token ────────────────────────────────
// `--dev-only` runs this stage, prints the probes and exits: a quick cold-start reading.
async function devProbe(base) {
    const wsUrl = new URL('/stream', base);
    wsUrl.protocol = 'wss:';
    const probes = [];
    const n = config.dev.coldProbes + config.dev.warmProbes;
    for (let i = 0; i < n; i += 1) {
        // The WebSocket leg goes FIRST: whatever reaches an idle service first pays the container's
        // start, and that has to be the leg a phone call would open, not a health read.
        const leg = await runCorpusCall(connect, wsUrl.href, {
            token: FORGED_TOKEN, turns: [], bed, replyWaitMs: 3000, endWaitMs: 500, timeoutMs: 30_000,
        });
        const t0 = performance.now();
        let health = 0;
        try {
            health = (await fetch(new URL('/health', base), { signal: AbortSignal.timeout(30_000) })).status;
        } catch { /* 0 */ }
        const healthMs = Math.round(performance.now() - t0);
        probes.push({
            at: new Date().toISOString(),
            kind: i < config.dev.coldProbes ? 'first (cold if the service was idle)' : 'warm',
            health, healthMs,
            upgradeMs: leg.upgradeMs, closedBy: leg.closedBy, closeCode: leg.closeCode,
            callMs: leg.callMs, audibleFramesOut: leg.audibleFramesOut,
        });
        say(`dev probe ${i + 1}: health ${health} in ${healthMs} ms, upgrade ${leg.upgradeMs} ms, closed by ${leg.closedBy} ${leg.closeCode} after ${leg.callMs} ms, ${leg.audibleFramesOut} audible`);
    }
    return probes;
}

// ── 2. LOCAL: the runtime with the real cascade, the mock seam behind it ─────────────────────
function freePort() {
    return new Promise((resolve, reject) => {
        const s = createServer();
        s.once('error', reject);
        s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    });
}

function startRuntime(seamUrl, port) {
    const lines = [];
    const spawnedAt = performance.now();
    // The quota shim lets a user's ADC login bill `project` (scripts/soak-local-quota.mjs).
    const child = spawn(process.execPath, ['--import', './scripts/soak-local-quota.mjs', 'src/server/main.ts'], {
        cwd: ROOT,
        env: {
            ...process.env,
            PORT: String(port),
            CREATORAIN_API_BASE_URL: seamUrl,
            GOOGLE_CLOUD_PROJECT: project,
            GOOGLE_CLOUD_QUOTA_PROJECT: project,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    let listening = null;
    const ready = new Promise((resolve, reject) => {
        let buf = '';
        child.stderr.on('data', (chunk) => {
            buf += String(chunk);
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                lines.push({ t: performance.now(), line });
                if (listening === null && line.includes('listening on')) {
                    listening = performance.now() - spawnedAt;
                    resolve();
                }
            }
        });
        child.once('exit', (code) => reject(new Error(`runtime exited ${code}`)));
    });
    return { child, lines, ready, listeningMs: () => listening, spawnedAt };
}

const TIMING = /turn_timing i=(\d+) speaker=(agent|venue) (.*)$/;
function timingsBetween(lines, from, to) {
    const rows = [];
    for (const { t, line } of lines) {
        if (t < from || t > to) continue;
        const m = TIMING.exec(line);
        if (!m) continue;
        const row = { i: Number(m[1]), speaker: m[2] };
        for (const kv of m[3].split(' ')) {
            const [k, v] = kv.split('=');
            row[k] = k === 'intent_source' ? v : Number(v);
        }
        rows.push(row);
    }
    return rows.sort((a, b) => a.i - b.i);
}

/** For each agent reply that follows a venue turn: where the runtime spent the time. */
function stages(rows) {
    const out = [];
    for (let k = 1; k < rows.length; k += 1) {
        const venue = rows[k - 1];
        const reply = rows[k];
        if (venue.speaker !== 'venue' || reply.speaker !== 'agent' || reply.intent_ms === undefined) continue;
        if (reply.i !== venue.i + 1) continue;
        const decidedAt = venue.stt_final_ms + reply.intent_ms + reply.seam_ms;
        out.push({
            endpointing_ms: venue.stt_final_ms - venue.venue_end_ms,
            intent_ms: reply.intent_ms,
            intent_source: reply.intent_source,
            seam_ms: reply.seam_ms,
            synthesis_ms: reply.tts_first_byte_ms !== undefined ? reply.tts_first_byte_ms - decidedAt : null,
            queue_ms: reply.first_frame_out_ms !== undefined && reply.tts_first_byte_ms !== undefined ? reply.first_frame_out_ms - reply.tts_first_byte_ms : null,
            runtime_total_ms: reply.first_frame_out_ms !== undefined ? reply.first_frame_out_ms - venue.venue_end_ms : null,
            // From the recogniser's final to the reply's first frame: everything after endpointing.
            after_final_ms: reply.first_frame_out_ms !== undefined ? reply.first_frame_out_ms - venue.stt_final_ms : null,
        });
    }
    return out;
}

async function localSoak() {
    const mock = await startMockSeam({ port: 0 });
    const port = await freePort();
    const rt = startRuntime(mock.baseUrl, port);
    await rt.ready;
    say(`runtime listening ${Math.round(rt.listeningMs())} ms after spawn`);
    const url = `ws://127.0.0.1:${port}/stream`;
    const disclosureFor = new Map();
    const calls = [];
    try {
        for (const [n, call] of manifest.calls.entries()) {
            if (n >= maxCalls) break;
            if (!disclosureFor.has(call.scenario)) {
                const ctx = await createSeamClient({ baseUrl: mock.baseUrl, token: `mock:${call.scenario}` }).callContext().catch(() => null);
                disclosureFor.set(call.scenario, ctx?.disclosure_sentence ?? null);
            }
            const turns = call.turns.map((t) => ({ audio: fixture(t.file), speechEndMs: t.speech_end_ms, speechStartMs: t.speech_start_ms }));
            const from = performance.now();
            const outcome = await runCorpusCall(connect, url, {
                token: `mock:${call.scenario}`, turns, bed,
                replyWaitMs: config.venue.replyWaitMs, quietMs: config.venue.quietMs, endWaitMs: config.venue.endWaitMs,
            });
            // Let the supervisor's call_ended and its turn_timing lines land.
            await new Promise((r) => setTimeout(r, 1500));
            const rows = timingsBetween(rt.lines, from, performance.now());
            const heard = await transcribe(outcome.disclosureAudio);
            const expected = disclosureFor.get(call.scenario);
            const recall = expected ? disclosureRecall(expected, heard) : null;
            const { disclosureAudio, ...wire } = outcome;
            void disclosureAudio;
            // The wire's first audio less the runtime's time after the final is the wait for the
            // recogniser to call the turn over (plus transport), read without trusting the VAD.
            // Paired only when every answered turn has exactly one timed reply, in order.
            const st = stages(rows);
            const answered = outcome.turns.filter((t) => t.firstAudioMs !== null);
            if (answered.length === st.length) {
                answered.forEach((t, k) => {
                    if (st[k].after_final_ms !== null) st[k].endpointing_wire_ms = t.firstAudioMs - st[k].after_final_ms;
                });
            }
            calls.push({
                id: call.id, scenario: call.scenario, cold: n === 0,
                outcome: { ...wire, disclosureAudio: new Uint8Array(0) },
                disclosureRecall: recall === null ? null : Number(recall.toFixed(2)),
                stages: st,
                disclosureTimings: rows.find((r) => r.i === 0 && r.speaker === 'agent') ?? null,
            });
            say(`${call.id}: start->audio ${outcome.startToFirstAudioMs} ms, turns ${outcome.turns.map((t) => t.firstAudioMs ?? 'none').join('/')}, disclosure recall ${recall?.toFixed(2)}, closed by ${outcome.closedBy}`);
        }
    } finally {
        rt.child.kill('SIGTERM');
        await mock.close();
        if (runtimeLogPath) writeFileSync(resolve(ROOT, runtimeLogPath), rt.lines.map((l) => `${Math.round(l.t - rt.spawnedAt)} ${l.line}`).join('\n') + '\n');
    }
    const warm = rt.lines.find((l) => /^cascade_warm( |$)/.test(l.line));
    return {
        listeningMs: Math.round(rt.listeningMs()),
        warmedMs: warm ? Math.round(warm.t - rt.spawnedAt) : null,
        calls,
    };
}

// ── 3. INTENT: the pinned model's real latency, without the runtime's timeout (I3P-13) ───────
/**
 * Every corpus line no keyword cue decides goes to the model the runtime pins, with a 10 s ceiling
 * in place of the runtime's own, so the distribution is measured rather than cut off. Billed to
 * `project` with the same quota header the local runtime gets. Synthetic venue lines only.
 */
async function intentProbe() {
    const tokens = await createAdcTokenSource();
    const fetchImpl = (url, init) => fetch(url, { ...init, headers: { ...init.headers, 'x-goog-user-project': project } });
    const lines = [...new Set(manifest.calls.flatMap((c) => c.turns.map((t) => t.text)))].filter((t) => keywordIntent(t) === null);
    const rows = [];
    for (let pass = 0; pass < 2; pass += 1) {
        for (const text of lines) {
            const reasons = [];
            const classifier = createVertexClassifier({ tokens: { token: () => tokens.token(), projectId: async () => project }, fetchImpl, timeoutMs: 10_000, log: (l) => reasons.push(l) });
            const t0 = performance.now();
            const { intent, source } = await classifier.classify(text);
            rows.push({ pass, ms: Math.round(performance.now() - t0), source, intent, failure: reasons[0] ?? null });
        }
    }
    const ok = rows.filter((r) => r.source === 'model').map((r) => r.ms);
    return {
        model: INTENT_MODEL,
        runtimeTimeoutMs: INTENT_TIMEOUT_MS,
        calls: rows.length,
        answered: ok.length,
        p50: rank(ok, 50), p90: rank(ok, 90), p99: rank(ok, 99), max: ok.length ? Math.max(...ok) : null,
        withinRuntimeTimeout: ok.filter((v) => v <= INTENT_TIMEOUT_MS).length,
        failures: [...new Set(rows.map((r) => r.failure).filter(Boolean))],
    };
}

// ── run ──────────────────────────────────────────────────────────────────────────────────────
const startedAt = new Date().toISOString();
const dev = devUrl ? await devProbe(devUrl) : null;
if (argv.includes('--dev-only')) process.exit(dev ? 0 : 2);
const local = await localSoak();
const intent = await intentProbe();
say(`intent probe: ${intent.answered}/${intent.calls} answered, p50 ${intent.p50} ms, p90 ${intent.p90} ms, ${intent.withinRuntimeTimeout} within ${intent.runtimeTimeoutMs} ms`);

const cold = local.calls.find((c) => c.cold);
const devCold = dev?.[0]?.upgradeMs ?? null;
const localCold = cold?.outcome.startToFirstAudioMs ?? null;
// The cold-start reading the gate is held to: a cold dev container's upgrade, then a cold
// process's path from `start` to the disclosure's first frame. Both are measured; their sum is
// what a venue would wait after answering a call that lands on a cold instance.
const coldStartMs = devCold !== null && localCold !== null ? devCold + localCold : localCold;
const summary = summarise(local.calls.map((c) => ({ id: c.id, outcome: c.outcome })), config.gate, {
    replyWaitMs: config.venue.replyWaitMs,
    coldStartMs,
});
const recalls = local.calls.map((c) => c.disclosureRecall).filter((r) => r !== null);
const disclosureFailures = local.calls.filter((c) => c.disclosureRecall !== null && c.disclosureRecall < config.disclosure.minWordRecall).map((c) => c.id);
const allStages = local.calls.flatMap((c) => c.stages);
const stagePct = {};
for (const k of ['endpointing_wire_ms', 'endpointing_ms', 'intent_ms', 'seam_ms', 'synthesis_ms', 'queue_ms', 'after_final_ms', 'runtime_total_ms']) {
    const xs = allStages.map((s) => s[k]).filter((v) => typeof v === 'number');
    stagePct[k] = { n: xs.length, p50: rank(xs, 50), p90: rank(xs, 90), max: xs.length ? Math.max(...xs) : null };
}
const sources = {};
for (const s of allStages) sources[s.intent_source] = (sources[s.intent_source] ?? 0) + 1;

const report = {
    startedAt,
    target: { dev: devUrl, local: 'node src/server/main.ts on the soak machine, mock seam, real Google STT/Gemini/TTS via ADC' },
    pins: { stt: `${STT.model} (${STT.location})`, intent_model: INTENT_MODEL },
    config,
    dev,
    local: { listeningMs: local.listeningMs, warmedMs: local.warmedMs, coldCallStartToFirstAudioMs: localCold },
    coldStart: { devUpgradeMs: devCold, localStartToFirstAudioMs: localCold, estimateMs: coldStartMs },
    summary,
    disclosure: { checked: recalls.length, minRecall: recalls.length ? Math.min(...recalls) : null, belowThreshold: disclosureFailures },
    stages: stagePct,
    intentSources: sources,
    intentProbe: intent,
    calls: local.calls.map((c) => ({
        id: c.id, scenario: c.scenario, cold: c.cold,
        startToFirstAudioMs: c.outcome.startToFirstAudioMs,
        disclosurePlayedMs: c.outcome.disclosurePlayedMs,
        disclosureRecall: c.disclosureRecall,
        firstAudioMs: c.outcome.turns.map((t) => t.firstAudioMs),
        turnsPlayed: c.outcome.turnsPlayed,
        longestSilenceMs: c.outcome.longestSilenceMs,
        closedBy: c.outcome.closedBy,
        framesAfterStop: c.outcome.framesAfterStop,
        stages: c.stages,
    })),
};
if (outPath) {
    mkdirSync(dirname(resolve(ROOT, outPath)), { recursive: true });
    writeFileSync(resolve(ROOT, outPath), `${JSON.stringify(report, null, 2)}\n`);
}
if (mdPath) writeFileSync(resolve(ROOT, mdPath), markdown(report));
say(`gate ${summary.gate.pass ? 'PASS' : 'FAIL'}${summary.gate.failures.length ? `: ${summary.gate.failures.join('; ')}` : ''}`);
process.exit(summary.gate.pass && !disclosureFailures.length ? 0 : 1);

function markdown(r) {
    const s = r.summary;
    const ms = (v) => (v === null || v === undefined ? 'n/a' : `${v} ms`);
    const L = [];
    L.push(`# Loopback soak, ${new Date(r.startedAt).toLocaleDateString('en-CA')} (run ${r.startedAt.slice(0, 16)}Z)`);
    L.push('');
    L.push('Generated by `scripts/soak-corpus.mjs` (`npm run soak:corpus`); the JSON beside this file holds every number. Fake legs only: no carrier, no Twilio, no call placed.');
    L.push('');
    L.push(`**Gate: ${s.gate.pass ? 'PASS' : 'FAIL'}.**${s.gate.failures.length ? ` ${s.gate.failures.join('; ')}.` : ''} Thresholds from \`soak/soak.config.json\`: p50 first audio <= ${r.config.gate.p50FirstAudioMs} ms, p90 <= ${r.config.gate.p90FirstAudioMs} ms (stretch ${r.config.gate.stretchP90FirstAudioMs} ms), cold start to the disclosure <= ${r.config.gate.coldStartMs} ms.`);
    L.push('');
    L.push('## First audio (end of the venue\'s speech to the agent\'s first audible frame)');
    L.push('');
    L.push(`${s.calls} calls, ${s.turns} venue turns timed, ${s.unansweredTurns} unanswered (each charged the venue's ${r.config.venue.replyWaitMs} ms wait), ${s.endedByServerTurns} on which the call was ended by the server before an answer was due (not timed).`);
    L.push('');
    L.push('| | p50 | p90 | p99 | max |');
    L.push('|---|---|---|---|---|');
    L.push(`| first audio | ${ms(s.firstAudio.p50)} | ${ms(s.firstAudio.p90)} | ${ms(s.firstAudio.p99)} | ${ms(s.firstAudio.max)} |`);
    L.push(`| start to disclosure (every call that spoke) | ${ms(s.startToFirstAudio.p50)} | ${ms(s.startToFirstAudio.p90)} | ${ms(s.startToFirstAudio.p99)} | ${ms(s.startToFirstAudio.max)} |`);
    L.push(`| longest silence per call (dead air) | ${ms(s.longestSilence.p50)} | ${ms(s.longestSilence.p90)} | ${ms(s.longestSilence.p99)} | ${ms(s.longestSilence.max)} |`);
    L.push('');
    L.push(`Turns over 2 s: ${s.turnsOver2s}. Over 4 s: ${s.turnsOver4s}. Audible frames after the venue hung up: ${s.framesAfterStop}.`);
    L.push('');
    L.push('## Where the time goes (runtime `turn_timing` lines, per reply)');
    L.push('');
    L.push('| stage | n | p50 | p90 | max |');
    L.push('|---|---|---|---|---|');
    for (const [k, v] of Object.entries(r.stages)) L.push(`| ${k.replace(/_ms$/, '')} | ${v.n} | ${ms(v.p50)} | ${ms(v.p90)} | ${ms(v.max)} |`);
    L.push('');
    L.push("Reading the stages: `endpointing_wire` is the wire's first audio less everything the runtime did after the recogniser's final (the wait for STT to call the turn over, plus transport), paired only where every answered turn has one timed reply. `endpointing` is the runtime's own `stt_final_ms - venue_end_ms`, which leans on the VAD's end of turn. `synthesis` runs from the decision to the reply's audio, and includes any wait behind sentences still playing. `after_final` is the recogniser's final to the reply's first frame out.");
    L.push('');
    L.push(`Intent decided by: ${Object.entries(r.intentSources).map(([k, v]) => `${k} ${v}`).join(', ') || 'n/a'}. Pins: STT ${r.pins.stt}, intent model ${r.pins.intent_model}.`);
    L.push('');
    const ip = r.intentProbe;
    L.push(`Intent model probe (${ip.model}, ${ip.calls} classifications of the corpus lines no keyword decides, 10 s ceiling instead of the runtime's ${ip.runtimeTimeoutMs} ms): ${ip.answered} answered; p50 ${ms(ip.p50)}, p90 ${ms(ip.p90)}, p99 ${ms(ip.p99)}, max ${ms(ip.max)}; ${ip.withinRuntimeTimeout} of ${ip.answered} inside the runtime's timeout.${ip.failures.length ? ` Failures: ${ip.failures.join('; ')}.` : ''}`);
    L.push('');
    L.push('## Cold start');
    L.push('');
    L.push(`- Dev container, connect to WebSocket upgrade on the first probe: ${ms(r.coldStart.devUpgradeMs)}.`);
    L.push(`- Local process: listening ${ms(r.local.listeningMs)} after spawn; cascade warm ${ms(r.local.warmedMs)} after spawn; first call (sent the moment it listened) \`start\` to the disclosure: ${ms(r.coldStart.localStartToFirstAudioMs)}.`);
    L.push(`- Gate reading (the two added): ${ms(r.coldStart.estimateMs)}.`);
    L.push('');
    if (r.dev) {
        L.push('### venue-call-agent-dev probes (forged token: refused, silent)');
        L.push('');
        L.push('| probe | at | /health | health ms | upgrade ms | closed by | code | audible out |');
        L.push('|---|---|---|---|---|---|---|---|');
        r.dev.forEach((p, i) => L.push(`| ${i + 1} ${p.kind} | ${p.at.slice(11, 19)}Z | ${p.health} | ${p.healthMs} | ${p.upgradeMs ?? 'n/a'} | ${p.closedBy} | ${p.closeCode ?? ''} | ${p.audibleFramesOut} |`));
        L.push('');
    }
    L.push('## Disclosure integrity');
    L.push('');
    L.push(`The agent's first utterance on each call, transcribed (STT ${r.pins.stt}) and held to the scenario's disclosure sentence: ${r.disclosure.checked} checked, lowest word recall ${r.disclosure.minRecall ?? 'n/a'}, below ${r.config.disclosure.minWordRecall}: ${r.disclosure.belowThreshold.length ? r.disclosure.belowThreshold.join(', ') : 'none'}.`);
    L.push('');
    L.push('## Per call');
    L.push('');
    L.push('| call | scenario | start to disclosure | disclosure played | recall | first audio per turn | longest silence | closed by |');
    L.push('|---|---|---|---|---|---|---|---|');
    for (const c of r.calls) {
        L.push(`| ${c.id}${c.cold ? ' (cold process)' : ''} | ${c.scenario} | ${ms(c.startToFirstAudioMs)} | ${ms(c.disclosurePlayedMs)} | ${c.disclosureRecall ?? 'n/a'} | ${c.firstAudioMs.map((v) => (v === null ? 'none' : v)).join(' / ') || 'none played'} | ${ms(c.longestSilenceMs)} | ${c.closedBy} |`);
    }
    L.push('');
    return `${L.join('\n')}\n`;
}
