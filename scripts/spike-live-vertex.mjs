#!/usr/bin/env node
/**
 * SPIKE (iteration-22, TASK-3749 I3P-15): Gemini Live on Vertex, measured on the loopback corpus.
 *
 *     node scripts/spike-live-vertex.mjs [--project creatorain-27e9e] [--location us-central1]
 *         [--vad defaults|fast] [--calls <n>] [--out docs/soak/<file>.json] [--md docs/soak/<file>.md]
 *
 * This is a spike, not a runtime. It places no call and reaches no carrier. It starts:
 *   - the repo's mock seam (`mock:<scenario>` tokens), for the per-call context;
 *   - a small Twilio-shaped WebSocket bridge on 127.0.0.1, which on `start` reads the call context,
 *     opens one Gemini Live session on Vertex (ADC), asks it to speak the disclosure and opening,
 *     and then pipes the venue's audio up and the model's audio down;
 *   - the same corpus driver as `npm run soak:corpus` (`runCorpusCall`), so first audio, start to
 *     disclosure and dead air are read off the wire by the same code as the cascade baseline.
 *
 * What it does NOT have, so its numbers flatter it: no tool calls (the model answers from the
 * static facts in its system instruction instead of fetching them), no hangup, no output gate,
 * no AMD. The venue's `clear` handling is the driver's (it ignores `clear`).
 *
 * Audio: venue μ-law 8 kHz is decoded and sent as `audio/pcm;rate=8000` (Live resamples). Model
 * audio (24 kHz PCM) is decimated to 8 kHz with the repo's own filter and μ-law encoded. A frame
 * whose peak is under -50 dBFS is sent as μ-law silence so a near-zero lead-in does not count as
 * first audio.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { GoogleAuth } from 'google-auth-library';

import { runCorpusCall, rank } from '../src/soak/corpus.ts';
import { summarise, disclosureRecall } from '../src/soak/report.ts';
import { startMockSeam } from '../src/mock/server.ts';
import { createSeamClient } from '../src/seam/client.ts';
import { probeRecognizeRequest, probeRecognizeUrl, recognizeTranscript } from '../src/speech/probeRequest.ts';
import { STT } from '../src/tuning/cascadeDefaults.ts';
import { LIVE_MODEL, LIVE_DEFAULTS } from '../src/tuning/liveDefaults.ts';
import { decode, encode } from '../src/audio/mulaw.ts';
import { createDecimator, upsampleLinear } from '../src/audio/resample.ts';
import { CARRIER_AUDIO, MULAW_SILENCE } from '../src/audio/format.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const project = opt('project', 'creatorain-27e9e');
const location = opt('location', 'us-central1');
const vadMode = opt('vad', 'defaults');
const maxCalls = Number(opt('calls', '0')) || Infinity;
const outPath = opt('out', null);
const mdPath = opt('md', null);
const say = (line) => process.stderr.write(`spike-live: ${line}\n`);

const config = JSON.parse(readFileSync(join(ROOT, 'soak', 'soak.config.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(ROOT, 'soak', 'fixtures', 'manifest.json'), 'utf8'));
const fixture = (file) => readFileSync(join(ROOT, 'soak', 'fixtures', file));
const bed = fixture(manifest.noise.file);
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
const token = async () => (await (await auth.getClient()).getAccessToken()).token;

const VAD_MODES = {
    // The repo's pinned starting values (src/tuning/liveDefaults.ts), unchanged.
    defaults: LIVE_DEFAULTS.realtimeInputConfig.automaticActivityDetection,
    // The fastest end of turn the API offers, for the floor of what Live can do.
    fast: { ...LIVE_DEFAULTS.realtimeInputConfig.automaticActivityDetection, endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH', silenceDurationMs: 300 },
};
const vad = VAD_MODES[vadMode];
if (!vad) throw new Error(`--vad must be one of ${Object.keys(VAD_MODES).join(', ')}`);

function liveUrl() {
    const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
    return `wss://${host}/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent`;
}

/** The per-call system instruction: the backend's own, then its sentences, read from call-context. */
function instructionFrom(ctx) {
    const facts = (ctx.static_facts ?? []).map((f) => `- ${f.topic}: ${f.say ?? f.sentence ?? JSON.stringify(f)}`).join('\n');
    return [
        ctx.system_instruction,
        `Your first words, alone, word for word, then stop and wait for the restaurant: ${ctx.disclosure_sentence}`,
        `When a person answers, say these lines once, word for word, in this order: ${(ctx.opening_script ?? []).join(' ')}`,
        'After that, answer briefly. Keep every reply to one or two short sentences.',
        facts ? `Sentences you may use, word for word, when asked about a topic:\n${facts}` : '',
        ctx.closing_sentence ? `When the call is finished, say: ${ctx.closing_sentence}` : '',
    ].filter(Boolean).join('\n\n');
}

const FRAME = CARRIER_AUDIO.bytesPerFrame;
const GATE_PEAK = 100; // about -50 dBFS on 16-bit PCM

/** One Twilio-shaped leg: the bridge between the driver and one Live session. */
function bridgeLeg(ws, seamUrl, record) {
    let live = null;
    let streamSid = 'MZ';
    let pending = Buffer.alloc(0);
    const decimator = createDecimator(MODEL_RATE, CARRIER_AUDIO.sampleRate);
    const t = { start: null, ctx: null, open: null, setup: null, firstModelAudio: null };
    const turns = [];
    let interrupted = 0;
    let goAway = 0;
    let gatedFrames = 0;
    /** Bridge-clock ms from `start` at which each model reply's first audible frame went out. */
    const onsets = [];
    let newGeneration = true;
    let audibleFrames = 0;
    let closed = false;
    const now = () => performance.now();
    const rel = (x) => (x === null || t.start === null ? null : Math.round(x - t.start));

    const sendFrame = (bytes) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: Buffer.from(bytes).toString('base64') } }));
    };
    const pushModelAudio = (pcm24) => {
        const pcm8 = decimator.push ? decimator.push(pcm24) : decimator(pcm24);
        const mu = encode(pcm8);
        pending = Buffer.concat([pending, mu]);
        while (pending.length >= FRAME) {
            const frame = pending.subarray(0, FRAME);
            pending = pending.subarray(FRAME);
            const pcm = decode(frame);
            let peak = 0;
            for (const s of pcm) peak = Math.max(peak, Math.abs(s));
            if (peak < GATE_PEAK) gatedFrames += 1; else {
                audibleFrames += 1;
                if (newGeneration) { onsets.push(rel(now())); newGeneration = false; }
            }
            sendFrame(peak < GATE_PEAK ? Buffer.alloc(FRAME, MULAW_SILENCE) : frame);
        }
    };

    ws.on('message', async (raw) => {
        let m;
        try { m = JSON.parse(raw.toString()); } catch { return; }
        if (m.event === 'start') {
            t.start = now();
            streamSid = m.start?.streamSid ?? streamSid;
            const callToken = m.start?.customParameters?.token;
            let ctx;
            try {
                ctx = await createSeamClient({ baseUrl: seamUrl, token: callToken }).callContext();
            } catch (e) {
                record.refused = String(e?.message ?? e);
                ws.close();
                return;
            }
            t.ctx = now();
            let bearer;
            try { bearer = await token(); } catch (e) { record.liveError = `token: ${e?.message}`; ws.close(); return; }
            t.token = now();
            live = new WebSocket(liveUrl(), { headers: { Authorization: `Bearer ${bearer}`, 'x-goog-user-project': project } });
            live.on('open', () => {
                t.open = now();
                live.send(JSON.stringify({ setup: {
                    model: `projects/${project}/locations/${location}/publishers/google/models/${LIVE_MODEL}`,
                    generationConfig: { responseModalities: ['AUDIO'], speechConfig: LIVE_DEFAULTS.speechConfig },
                    systemInstruction: { parts: [{ text: instructionFrom(ctx) }] },
                    realtimeInputConfig: { automaticActivityDetection: vad, turnCoverage: LIVE_DEFAULTS.realtimeInputConfig.turnCoverage },
                    inputAudioTranscription: {},
                } }));
            });
            live.on('message', (data) => {
                let s;
                try { s = JSON.parse(data.toString()); } catch { return; }
                if (s.setupComplete) {
                    t.setup = now();
                    live.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: 'The call has connected. Begin.' }] }], turnComplete: true } }));
                    return;
                }
                if (process.env.SPIKE_DEBUG && !s.serverContent?.modelTurn) say(`live msg ${rel(now())} ${JSON.stringify(s).slice(0, 160)}`);
                if (s.goAway) goAway += 1;
                const sc = s.serverContent;
                if (!sc) return;
                if (sc.interrupted) {
                    interrupted += 1;
                    newGeneration = true;
                    pending = Buffer.alloc(0);
                    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event: 'clear', streamSid }));
                }
                if (sc.inputTranscription?.text) {
                    const last = turns.at(-1);
                    if (!last || last.closed) turns.push({ firstInputTranscriptAt: rel(now()), firstAudioAt: null, closed: false });
                }
                for (const part of sc.modelTurn?.parts ?? []) {
                    const b64 = part.inlineData?.data;
                    if (!b64) continue;
                    if (t.firstModelAudio === null) t.firstModelAudio = now();
                    const last = turns.at(-1);
                    if (last && last.firstAudioAt === null) last.firstAudioAt = rel(now());
                    const bytes = Buffer.from(b64, 'base64');
                    pushModelAudio(new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length >> 1));
                }
                if (sc.turnComplete || sc.generationComplete) {
                    if (process.env.SPIKE_DEBUG && sc.turnComplete) say(`turn done ${rel(now())}: audible ${audibleFrames} gated ${gatedFrames}`);
                    if (sc.turnComplete) newGeneration = true;
                    const last = turns.at(-1);
                    if (last) last.closed = true;
                }
            });
            live.on('close', (code, reason) => {
                record.liveClose = { code, reason: reason.toString().slice(0, 200) };
                if (!closed && ws.readyState === WebSocket.OPEN) ws.close();
            });
            live.on('error', (e) => { record.liveError = e.message; });
            return;
        }
        if (m.event === 'media' && live && live.readyState === WebSocket.OPEN && t.setup !== null) {
            const pcm8 = decode(Buffer.from(m.media.payload, 'base64'));
            const pcm = INPUT_RATE === CARRIER_AUDIO.sampleRate ? pcm8 : upsampleLinear(pcm8, CARRIER_AUDIO.sampleRate, INPUT_RATE);
            const blob = { mimeType: `audio/pcm;rate=${INPUT_RATE}`, data: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64') };
            live.send(JSON.stringify({ realtimeInput: INPUT_FIELD === 'mediaChunks' ? { mediaChunks: [blob] } : { audio: blob } }));
            return;
        }
        if (m.event === 'stop') {
            closed = true;
            live?.close();
        }
    });
    ws.on('close', () => {
        closed = true;
        live?.close();
        Object.assign(record, {
            ctxMs: t.ctx && t.start ? Math.round(t.ctx - t.start) : null,
            tokenMs: t.token && t.ctx ? Math.round(t.token - t.ctx) : null,
            connectMs: t.open && t.token ? Math.round(t.open - t.token) : null,
            setupMs: t.setup && t.open ? Math.round(t.setup - t.open) : null,
            setupToFirstModelAudioMs: t.firstModelAudio && t.setup ? Math.round(t.firstModelAudio - t.setup) : null,
            interrupted, goAway, liveTurns: turns.length, onsets,
        });
    });
}
const MODEL_RATE = 24000;
/** Venue audio up: 16 kHz (the documented native input rate) unless `--input-rate 8000`. */
const INPUT_RATE = Number(opt('input-rate', '16000'));
const INPUT_FIELD = opt('input-field', 'audio');

function freePort() {
    return new Promise((ok, no) => {
        const s = createServer();
        s.once('error', no);
        s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); });
    });
}

async function transcribe(ulaw) {
    if (!ulaw.length) return '';
    const res = await fetch(probeRecognizeUrl(project), {
        method: 'POST',
        headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json', 'x-goog-user-project': project },
        body: JSON.stringify(probeRecognizeRequest(Buffer.from(ulaw), STT.model)),
        signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return `<stt http ${res.status}>`;
    return recognizeTranscript(await res.json());
}

const startedAt = new Date().toISOString();
const mock = await startMockSeam({ port: 0 });
const port = await freePort();
let current = null;
const wss = new WebSocketServer({ host: '127.0.0.1', port, path: '/stream' });
wss.on('connection', (ws) => bridgeLeg(ws, mock.baseUrl, current));
await new Promise((r) => wss.once('listening', r));
const url = `ws://127.0.0.1:${port}/stream`;
const calls = [];
try {
    for (const [n, call] of manifest.calls.entries()) {
        if (n >= maxCalls) break;
        if (opt('only', null) && call.id !== opt('only', null)) continue;
        const ctx = await createSeamClient({ baseUrl: mock.baseUrl, token: `mock:${call.scenario}` }).callContext().catch(() => null);
        const turns = call.turns.map((x) => ({ audio: fixture(x.file), speechEndMs: x.speech_end_ms, speechStartMs: x.speech_start_ms }));
        current = {};
        const outcome = await runCorpusCall((u, o) => new WebSocket(u, o), url, {
            token: `mock:${call.scenario}`, turns, bed,
            replyWaitMs: config.venue.replyWaitMs, quietMs: config.venue.quietMs, endWaitMs: config.venue.endWaitMs,
        });
        await new Promise((r) => setTimeout(r, 500));
        const heard = await transcribe(outcome.disclosureAudio).catch((e) => `<stt ${e?.cause?.code ?? e?.message}>`);
        const expected = ctx?.disclosure_sentence ?? null;
        const recall = expected ? disclosureRecall(expected, heard) : null;
        const { disclosureAudio, ...wire } = outcome;
        void disclosureAudio;
        calls.push({ id: call.id, scenario: call.scenario, cold: n === 0, outcome: { ...wire, disclosureAudio: new Uint8Array(0) }, disclosureRecall: recall === null ? null : Number(recall.toFixed(2)), bridge: current });
        say(`${call.id}: start->audio ${outcome.startToFirstAudioMs} ms (ctx ${current.ctxMs} / token ${current.tokenMs} / connect ${current.connectMs} / setup ${current.setupMs} / gen ${current.setupToFirstModelAudioMs}), turns ${outcome.turns.map((x) => x.firstAudioMs ?? 'none').join('/')}, recall ${recall?.toFixed(2)}, interrupted ${current.interrupted}, closed by ${outcome.closedBy}${current.liveClose?.code && current.liveClose.code !== 1000 && current.liveClose.code !== 1005 ? `, live close ${current.liveClose.code} ${current.liveClose.reason}` : ''}`);
    }
} finally {
    wss.close();
    await mock.close();
}

const cold = calls.find((c) => c.cold);
const summary = summarise(calls.map((c) => ({ id: c.id, outcome: c.outcome })), config.gate, { replyWaitMs: config.venue.replyWaitMs, coldStartMs: cold?.outcome.startToFirstAudioMs ?? null });
const split = {};
for (const k of ['ctxMs', 'tokenMs', 'connectMs','setupMs', 'setupToFirstModelAudioMs']) {
    const xs = calls.map((c) => c.bridge?.[k]).filter((v) => typeof v === 'number');
    split[k] = { n: xs.length, p50: rank(xs, 50), p90: rank(xs, 90), max: xs.length ? Math.max(...xs) : null };
}
const recalls = calls.map((c) => c.disclosureRecall).filter((r) => r !== null);
// Each venue turn, classified: answered after the venue finished; spoke over it (a reply began
// while the venue was still talking and nothing came after); or silent. Both clocks are this
// process's performance.now() from `start`, so the bridge's onsets line up with the driver's turns.
const turnClass = { answered: 0, answeredButTalkedOver: 0, spokeOverThenSilent: 0, silent: 0, endedByServer: 0 };
for (const c of calls) {
    const plan = manifest.calls.find((m) => m.id === c.id);
    c.outcome.turns.forEach((t, k) => {
        const clip = plan.turns[t.turn ?? k];
        const endAt = t.speechEndAtMs;
        const startAt = endAt - (clip.speech_end_ms - (clip.speech_start_ms ?? 0));
        const over = (c.bridge?.onsets ?? []).some((o) => o >= startAt + 150 && o < endAt);
        let cls;
        if (t.endedByServer) cls = 'endedByServer';
        else if (t.firstAudioMs !== null) cls = over ? 'answeredButTalkedOver' : 'answered';
        else cls = over ? 'spokeOverThenSilent' : 'silent';
        t.class = cls;
        turnClass[cls] += 1;
    });
}
const report = {
    startedAt, spike: 'gemini-live-vertex', model: LIVE_MODEL, location, vad: { mode: vadMode, ...vad }, voice: LIVE_DEFAULTS.speechConfig,
    config, summary, startSplit: split,
    disclosure: { checked: recalls.length, lowest: recalls.length ? Math.min(...recalls) : null, below: calls.filter((c) => c.disclosureRecall !== null && c.disclosureRecall < config.disclosure.minWordRecall).map((c) => c.id) },
    interrupted: calls.reduce((a, c) => a + (c.bridge?.interrupted ?? 0), 0),
    turnClass,
    calls,
};
if (outPath) writeFileSync(resolve(ROOT, outPath), JSON.stringify(report, null, 2) + '\n');
const f = (p) => `${p.p50 ?? 'n/a'} / ${p.p90 ?? 'n/a'} / ${p.p99 ?? 'n/a'} / ${p.max ?? 'n/a'}`;
const md = [
    `# Spike: Gemini Live on Vertex, loopback corpus (${startedAt})`,
    '',
    `Generated by \`scripts/spike-live-vertex.mjs\` on branch \`spike/live-vertex\`. Fake legs only: no carrier, no Twilio, no call placed. Model \`${LIVE_MODEL}\` in ${location}, VAD \`${vadMode}\` (${JSON.stringify(vad)}).`,
    '',
    `Gate (same thresholds as the soak): ${summary.gate.pass ? 'PASS' : 'FAIL'}${summary.gate.failures.length ? `: ${summary.gate.failures.join('; ')}` : ''}.`,
    '',
    '| | p50 / p90 / p99 / max |',
    '|---|---|',
    `| first audio (end of venue speech to first audible frame) | ${f(summary.firstAudio)} ms |`,
    `| start to disclosure | ${f(summary.startToFirstAudio)} ms |`,
    `| longest silence per call (dead air) | ${f(summary.longestSilence)} ms |`,
    '',
    `${summary.calls} calls, ${summary.turns} venue turns timed, ${summary.unansweredTurns} unanswered (charged ${config.venue.replyWaitMs} ms). Turns over 2 s: ${summary.turnsOver2s}; over 4 s: ${summary.turnsOver4s}. Model interruptions (barge-in on the noise bed or venue speech): ${report.interrupted}.`,
    '',
    `Venue turns, classified: answered after the venue finished ${turnClass.answered}; answered but the model also started while the venue was still talking ${turnClass.answeredButTalkedOver}; spoke over the venue and then said nothing after it finished ${turnClass.spokeOverThenSilent}; silent ${turnClass.silent}; call ended by the server ${turnClass.endedByServer}.`,
    '',
    '## Start to disclosure, split (bridge clock)',
    '',
    '| stage | n | p50 | p90 | max |',
    '|---|---|---|---|---|',
    ...Object.entries(split).map(([k, v]) => `| ${k} | ${v.n} | ${v.p50} | ${v.p90} | ${v.max} |`),
    '',
    `Disclosure recall (STT ${STT.model} on the agent's first utterance): ${report.disclosure.checked} checked, lowest ${report.disclosure.lowest}, below ${config.disclosure.minWordRecall}: ${report.disclosure.below.join(', ') || 'none'}.`,
    '',
    '## Per call',
    '',
    '| call | start to disclosure | first audio per turn | longest silence | recall | interrupted |',
    '|---|---|---|---|---|---|',
    ...calls.map((c) => `| ${c.id}${c.cold ? ' (first)' : ''} | ${c.outcome.startToFirstAudioMs ?? 'none'} ms | ${c.outcome.turns.map((x) => x.firstAudioMs ?? (x.class === 'spokeOverThenSilent' ? 'over' : 'none')).join(' / ')} | ${c.outcome.longestSilenceMs} ms | ${c.disclosureRecall ?? 'n/a'} | ${c.bridge?.interrupted ?? 0} |`),
    '',
    'Not in this harness, so these numbers flatter Live: tool calls for facts (it answers from facts in its instruction), hangup, the output gate, AMD and the stop-calling seam write.',
    '',
].join('\n');
if (mdPath) writeFileSync(resolve(ROOT, mdPath), md);
process.stdout.write(md);
process.exit(0);
