#!/usr/bin/env node
/**
 * SPIKE (iteration-22, TASK-3791 / I3P-15): ConversationRelay as challenger B, on the loopback.
 *
 *     node scripts/spike-conversationrelay.mjs [--project creatorain-27e9e] [--calls <n>]
 *         [--transcript heard|text] [--out docs/soak/<file>.json] [--md docs/soak/<file>.md]
 *
 * ConversationRelay moves speech to Twilio: Twilio runs the recogniser, the end-of-turn decision and
 * the voice, and our service only trades text over a WebSocket (`setup`, `prompt` in; `text`, `end`
 * out). Without a Twilio call, only OUR half of that loop exists. This spike measures that half:
 *
 *   - a ConversationRelay-protocol server on 127.0.0.1 (the adapter TASK-3791 describes): on `setup`
 *     it reads the call context from the repo's mock seam and speaks the cascade's own `open()`; on a
 *     `prompt` with `last: true` it calls the cascade's own `hear()` (the real keyword cues and the
 *     real Gemini Flash-Lite intent model on Vertex), and streams the sentences back as `text`;
 *   - a fake Twilio side that plays the corpus as `prompt` messages. Its `voicePrompt` is what Google
 *     STT telephony heard in each clip (`manifest.json` `stt.heard`), a stand-in for Twilio's own
 *     recogniser, or the script text with `--transcript text`.
 *
 * It reads, per turn: `prompt(last)` to the first `text` token (Twilio calls this "application"
 * latency) and to the turn's last token, plus the WebSocket loopback round trip. Twilio's
 * end-of-turn wait, its transcription, its voice and the network to Twilio are NOT measurable
 * without a call; the report estimates them from vendor documentation and says so.
 *
 * It places no call, reaches no carrier and talks to no Twilio endpoint.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

import { rank } from '../src/soak/corpus.ts';
import { startMockSeam } from '../src/mock/server.ts';
import { createSeamClient } from '../src/seam/client.ts';
import { createCascadeAgent } from '../src/agent/cascadeAgent.ts';
import { createVertexClassifier } from '../src/agent/intent.ts';
import { createAdcTokenSource } from '../src/google/adc.ts';
import { INTENT_MODEL, INTENT_TIMEOUT_MS } from '../src/tuning/cascadeDefaults.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const project = opt('project', 'creatorain-27e9e');
const maxCalls = Number(opt('calls', '0')) || Infinity;
const transcriptSource = opt('transcript', 'heard');
const outPath = opt('out', null);
const mdPath = opt('md', null);
const say = (line) => process.stderr.write(`spike-cr: ${line}\n`);

const manifest = JSON.parse(readFileSync(join(ROOT, 'soak', 'fixtures', 'manifest.json'), 'utf8'));
const adc = await createAdcTokenSource();
const tokens = { token: () => adc.token(), projectId: async () => project };
const fetchImpl = (url, init) => fetch(url, { ...init, headers: { ...init.headers, 'x-goog-user-project': project } });
const intents = createVertexClassifier({ tokens, fetchImpl, log: () => {} });

function freePort() {
    return new Promise((ok, no) => {
        const s = createServer();
        s.once('error', no);
        s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); });
    });
}

/** Our side of ConversationRelay: the adapter, with the cascade brain unchanged. */
function relaySession(ws, seamUrl) {
    let agent = null;
    let chain = Promise.resolve();
    const speak = (turn) => {
        const sentences = turn.say ?? [];
        sentences.forEach((s, i) => ws.send(JSON.stringify({ type: 'text', token: s, last: i === sentences.length - 1 && !turn.endCall, interruptible: true })));
        if (!sentences.length) ws.send(JSON.stringify({ type: 'text', token: '', last: true }));
        if (turn.endCall) ws.send(JSON.stringify({ type: 'end', handoffData: JSON.stringify({ reason: turn.note ?? 'agent_end' }) }));
    };
    ws.on('message', (raw) => {
        let m;
        try { m = JSON.parse(raw.toString()); } catch { return; }
        chain = chain.then(async () => {
            if (m.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
            if (m.type === 'setup') {
                const seam = createSeamClient({ baseUrl: seamUrl, token: m.customParameters?.token });
                let context;
                try { context = await seam.callContext(); } catch (e) {
                    ws.send(JSON.stringify({ type: 'end', handoffData: JSON.stringify({ reason: 'refused', detail: String(e?.message ?? e) }) }));
                    return;
                }
                agent = createCascadeAgent({ seam, intents, context });
                speak(await agent.open());
                return;
            }
            if (m.type === 'prompt' && m.last && agent) {
                speak(await agent.hear(m.voicePrompt));
            }
        }).catch((e) => say(`session error ${e?.message ?? e}`));
    });
}

/** The fake Twilio side: one corpus call as `setup` and `prompt`s, timed on its own clock. */
function playCall(url, call) {
    return new Promise((done) => {
        const ws = new WebSocket(url);
        const out = { id: call.id, scenario: call.scenario, setupToFirstTextMs: null, turns: [], ended: null, rttMs: [] };
        let waiting = null; // { sentAt, firstAt, resolve }
        let ended = false;
        const now = () => performance.now();
        const reply = () => new Promise((r) => {
            waiting = { sentAt: now(), firstAt: null, lastAt: null, tokens: 0, resolve: r };
        });
        const timer = (ms) => new Promise((r) => setTimeout(r, ms));
        ws.on('message', (raw) => {
            const m = JSON.parse(raw.toString());
            if (m.type === 'pong' && waiting?.ping) { waiting.resolve(now() - waiting.sentAt); return; }
            if (m.type === 'end') { ended = true; out.ended = JSON.parse(m.handoffData ?? '{}').reason ?? 'end'; waiting?.resolve?.(null); return; }
            if (m.type !== 'text' || !waiting) return;
            if (waiting.firstAt === null && m.token) waiting.firstAt = now();
            waiting.tokens += 1;
            if (m.last) { waiting.lastAt = now(); waiting.resolve(null); }
        });
        ws.on('open', async () => {
            for (let i = 0; i < 5; i += 1) {
                const p = new Promise((r) => { waiting = { sentAt: now(), ping: true, resolve: r }; });
                ws.send(JSON.stringify({ type: 'ping' }));
                out.rttMs.push(Number((await p).toFixed(2)));
            }
            const setup = reply();
            const sentAt = waiting.sentAt;
            ws.send(JSON.stringify({ type: 'setup', sessionId: `VXspike${call.id}`, callSid: 'CAspike', direction: 'outbound-api', customParameters: { token: `mock:${call.scenario}` } }));
            await Promise.race([setup, timer(15_000)]);
            out.setupToFirstTextMs = waiting.firstAt === null ? null : Math.round(waiting.firstAt - sentAt);
            for (const [n, t] of call.turns.entries()) {
                if (ended) break;
                const voicePrompt = transcriptSource === 'text' ? t.text : (t.stt?.heard ?? t.text);
                const r = reply();
                const w = waiting;
                ws.send(JSON.stringify({ type: 'prompt', voicePrompt, lang: 'en-US', last: true }));
                await Promise.race([r, timer(15_000)]);
                out.turns.push({
                    turn: n,
                    firstTextMs: w.firstAt === null ? null : Math.round(w.firstAt - w.sentAt),
                    lastTextMs: w.lastAt === null ? null : Math.round(w.lastAt - w.sentAt),
                    tokens: w.tokens,
                });
            }
            ws.close();
        });
        ws.on('close', () => done(out));
        ws.on('error', (e) => { out.error = e.message; done(out); });
    });
}

// Warm the token and the TLS to the intent host once, as the runtime's preconnect does (PERF-A).
const warmFrom = performance.now();
await intents.classify('Sorry, could you say that again?');
const warmMs = Math.round(performance.now() - warmFrom);
say(`warm-up classify ${warmMs} ms (excluded)`);
const startedAt = new Date().toISOString();
const mock = await startMockSeam({ port: 0 });
const port = await freePort();
const wss = new WebSocketServer({ host: '127.0.0.1', port, path: '/relay' });
wss.on('connection', (ws) => relaySession(ws, mock.baseUrl));
await new Promise((r) => wss.once('listening', r));
const url = `ws://127.0.0.1:${port}/relay`;
const calls = [];
try {
    for (const [n, call] of manifest.calls.entries()) {
        if (n >= maxCalls) break;
        const r = await playCall(url, call);
        calls.push(r);
        say(`${call.id}: setup->text ${r.setupToFirstTextMs} ms, turns ${r.turns.map((t) => t.firstTextMs ?? 'none').join('/')}, ended ${r.ended ?? 'client'}`);
    }
} finally {
    wss.close();
    await mock.close();
}

const pct = (xs) => ({ n: xs.length, p50: rank(xs, 50), p90: rank(xs, 90), p99: rank(xs, 99), max: xs.length ? Math.max(...xs) : null });
const turns = calls.flatMap((c) => c.turns);
const firstText = turns.map((t) => t.firstTextMs).filter((v) => v !== null);
const summary = {
    calls: calls.length,
    turns: turns.length,
    silentTurns: turns.filter((t) => t.firstTextMs === null).length,
    setupToFirstText: pct(calls.map((c) => c.setupToFirstTextMs).filter((v) => v !== null)),
    promptToFirstText: pct(firstText),
    promptToLastText: pct(turns.map((t) => t.lastTextMs).filter((v) => v !== null)),
    loopbackRtt: pct(calls.flatMap((c) => c.rttMs)),
};
const report = { startedAt, spike: 'conversationrelay-loopback', intent_model: INTENT_MODEL, intent_timeout_ms: INTENT_TIMEOUT_MS, transcript: transcriptSource, summary, calls };
if (outPath) writeFileSync(resolve(ROOT, outPath), JSON.stringify(report, null, 2) + '\n');
const row = (name, p) => `| ${name} | ${p.n} | ${p.p50} | ${p.p90} | ${p.p99} | ${p.max} |`;
const md = [
    `# Spike: ConversationRelay, our half on the loopback (${startedAt})`,
    '',
    `Generated by \`scripts/spike-conversationrelay.mjs\` on branch \`spike/conversationrelay\`. No call, no carrier, no Twilio endpoint. The cascade brain unchanged (keyword cues, then \`${INTENT_MODEL}\` on Vertex with its ${INTENT_TIMEOUT_MS} ms timeout); \`voicePrompt\` = ${transcriptSource === 'text' ? 'the script text' : "Google STT telephony's transcript of each corpus clip"}.`,
    '',
    `${summary.calls} calls, ${summary.turns} prompts, ${summary.silentTurns} answered with silence or an end.`,
    '',
    '| our side (ms) | n | p50 | p90 | p99 | max |',
    '|---|---|---|---|---|---|',
    row('setup to the first text token (disclosure)', summary.setupToFirstText),
    row('prompt(last) to the first text token ("application")', summary.promptToFirstText),
    row('prompt(last) to the last text token', summary.promptToLastText),
    row('WebSocket loopback round trip', summary.loopbackRtt),
    '',
    'Not measured, because each needs a real Twilio call: the end-of-turn wait before `last: true`, Twilio\'s transcription, the time from our first token to Twilio\'s first audio, and the network between Twilio and our service.',
    '',
    '## Per call',
    '',
    '| call | setup to text | prompt to first text, per turn | ended by |',
    '|---|---|---|---|',
    ...calls.map((c) => `| ${c.id} | ${c.setupToFirstTextMs ?? 'none'} ms | ${c.turns.map((t) => t.firstTextMs ?? 'none').join(' / ')} | ${c.ended ?? 'client'} |`),
    '',
].join('\n');
if (mdPath) writeFileSync(resolve(ROOT, mdPath), md);
process.stdout.write(md);
process.exit(0);
