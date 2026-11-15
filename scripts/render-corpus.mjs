#!/usr/bin/env node
/**
 * `npm run soak:render` — render the loopback soak's audio corpus (TASK-3749 step 2, I3P-16).
 *
 *     node scripts/render-corpus.mjs [--project creatorain-27e9e] [--verify]
 *
 * Reads `soak/fixtures/scripts.json` (and, for the calls that name one, the caller turns of
 * `test/fixtures/conversations/<fixture>.json`), renders each venue turn with Google Text-to-Speech
 * v1 as LINEAR16 at 8 kHz in a voice that is not Chirp, levels it, lays it over a restaurant-noise
 * bed at the configured SNR, encodes it to μ-law and writes `soak/fixtures/<call>-<turn>.ulaw`,
 * the bed as `soak/fixtures/noise-bed.ulaw`, and `soak/fixtures/manifest.json`.
 *
 * The noise bed is made here, not downloaded: pink noise, a babble of generic dining-room lines in
 * four other voices, and dish clinks, from a fixed seed. No third-party recording, so no licence.
 *
 * `--verify` transcribes every clip with Speech-to-Text v2 on the runtime's own model (MULAW 8 kHz,
 * exactly what the line carries) and records the transcript, the share of words heard, and whether
 * the digits and money words survived. A clip STT hears nothing in fails the render (exit 1): a
 * silent or broken clip must never reach a soak, where it would read as an agent that never answered.
 * The one exception is a clip listed in `expect_unheard` with its reason (a real recogniser miss the
 * soak should charge); a listed clip that IS heard fails too, so the list cannot go stale.
 * The accuracy is labelled synthetic: synthetic speech flatters recognition.
 *
 * Identity: Application Default Credentials (`gcloud auth application-default login`), billed to
 * `--project`. Nothing read from the environment, no key file. Places no call.
 * Cost: about 70 short syntheses and, with --verify, 70 short recognitions: a few cents.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encode } from '../src/audio/mulaw.ts';
import { CARRIER_AUDIO } from '../src/audio/format.ts';
import { TTS_ENDPOINT } from '../src/speech/tts.ts';
import { probeRecognizeRequest, probeRecognizeUrl, recognizeTranscript } from '../src/speech/probeRequest.ts';
import { STT } from '../src/tuning/cascadeDefaults.ts';
import { disclosureRecall } from '../src/soak/report.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'soak', 'fixtures');
const RATE = CARRIER_AUDIO.sampleRate;

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const project = opt('project', 'creatorain-27e9e');
const verify = argv.includes('--verify');

const { GoogleAuth } = await import('google-auth-library');
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
async function post(url, body) {
    const token = await auth.getAccessToken();
    const res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-goog-user-project': project },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${new URL(url).host} HTTP ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
    return json;
}

/** LINEAR16 WAV from TTS -> Float64 samples in [-1, 1). */
function wavToFloat(bytes) {
    let at = 12;
    while (at + 8 <= bytes.length) {
        const id = bytes.toString('ascii', at, at + 4);
        const size = bytes.readUInt32LE(at + 4);
        if (id === 'data') {
            const pcm = bytes.subarray(at + 8, at + 8 + size);
            const out = new Float64Array(Math.floor(pcm.length / 2));
            for (let i = 0; i < out.length; i += 1) out[i] = pcm.readInt16LE(i * 2) / 32768;
            return out;
        }
        at += 8 + size + (size % 2);
    }
    throw new Error('no data chunk in the synthesised WAV');
}

async function synth(text, voice) {
    const body = {
        input: { text },
        voice: { languageCode: voice.languageCode, name: voice.name },
        audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: RATE },
    };
    const json = await post(TTS_ENDPOINT, body);
    return wavToFloat(Buffer.from(json.audioContent, 'base64'));
}

const rms = (xs) => Math.sqrt(xs.reduce((s, x) => s + x * x, 0) / Math.max(1, xs.length));
const db = (v) => 10 ** (v / 20);

/** Speech onset and end: first and last 10 ms window above -45 dBFS. */
function speechBounds(xs) {
    const win = RATE / 100;
    const floor = db(-45);
    let first = -1;
    let last = -1;
    for (let i = 0; i + win <= xs.length; i += win) {
        if (rms(xs.subarray(i, i + win)) > floor) {
            if (first < 0) first = i;
            last = i + win;
        }
    }
    return first < 0 ? null : { start: first, end: last };
}

/** A fixed-seed generator, so the bed is the same on every render. */
function rng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 2 ** 32;
    };
}

async function makeBed(spec, babble, voices) {
    const n = spec.bed_seconds * RATE;
    const rand = rng(20261114);
    const bed = new Float64Array(n);
    // Pink noise (Paul Kellet's economy filter).
    let b0 = 0, b1 = 0, b2 = 0;
    const pink = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
        const w = rand() * 2 - 1;
        b0 = 0.99765 * b0 + w * 0.0990460;
        b1 = 0.96300 * b1 + w * 0.2965164;
        b2 = 0.57000 * b2 + w * 1.0526913;
        pink[i] = b0 + b1 + b2 + w * 0.1848;
    }
    const pr = rms(pink);
    for (let i = 0; i < n; i += 1) bed[i] += (pink[i] / pr) * db(-6);
    // Babble: the dining-room lines in four voices at scattered offsets, looping around the bed.
    const chatter = new Float64Array(n);
    let k = 0;
    for (const line of babble) {
        const voice = voices[(k + 3) % voices.length];
        const xs = await synth(line, voice);
        for (let rep = 0; rep < 3; rep += 1) {
            const off = Math.floor(rand() * n);
            for (let i = 0; i < xs.length; i += 1) chatter[(off + i) % n] += xs[i];
        }
        k += 1;
    }
    const cr = rms(chatter) || 1;
    for (let i = 0; i < n; i += 1) bed[i] += (chatter[i] / cr) * db(spec.babble_level_db);
    // Clinks: short decaying tones between 2 and 3.4 kHz.
    const clinks = Math.round(spec.clink_per_second * spec.bed_seconds);
    for (let c = 0; c < clinks; c += 1) {
        const at = Math.floor(rand() * n);
        const f = 2000 + rand() * 1400;
        const len = Math.floor(RATE * 0.12);
        for (let i = 0; i < len; i += 1) bed[(at + i) % n] += Math.sin((2 * Math.PI * f * i) / RATE) * Math.exp(-i / (RATE * 0.02)) * 0.8;
    }
    // Level the bed so that speech at speech_rms_dbfs sits snr_db above it.
    const target = db(spec.speech_rms_dbfs - spec.snr_db);
    const g = target / rms(bed);
    for (let i = 0; i < n; i += 1) bed[i] *= g;
    return bed;
}

function toMulaw(xs) {
    const pcm = new Int16Array(xs.length);
    for (let i = 0; i < xs.length; i += 1) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(xs[i] * 32767)));
    return encode(pcm);
}

const DIGIT_OR_MONEY = /(\d|\$|\bdollars?\b|\bpercent\b|\bhundred\b|\bsixty\b|\btwenty\b|\bfour\b|\bsix\b|\bseven\b|\beight\b)/i;

const scripts = JSON.parse(readFileSync(join(OUT, 'scripts.json'), 'utf8'));
mkdirSync(OUT, { recursive: true });

const bed = await makeBed(scripts.noise, scripts.babble, scripts.voices);
writeFileSync(join(OUT, 'noise-bed.ulaw'), toMulaw(bed));

const LEAD = Math.floor(RATE * 0.2);
const TAIL = Math.floor(RATE * 0.3);
let bedAt = 0;
const calls = [];
let failed = 0;
for (const [ci, call] of scripts.calls.entries()) {
    let turns = call.turns;
    let scenario = call.scenario;
    if (call.fixture) {
        const fx = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'conversations', `${call.fixture}.json`), 'utf8'));
        turns = fx.turns;
        scenario ??= fx.scenario;
    }
    const voice = scripts.voices[ci % scripts.voices.length];
    const rows = [];
    for (const [ti, text] of turns.entries()) {
        const raw = await synth(text, voice);
        const bounds = speechBounds(raw);
        if (!bounds) throw new Error(`${call.id} turn ${ti}: synthesis returned silence`);
        const speech = raw.subarray(bounds.start, bounds.end);
        const gain = db(scripts.noise.speech_rms_dbfs) / rms(speech);
        const len = LEAD + speech.length + TAIL;
        const mix = new Float64Array(len);
        for (let i = 0; i < len; i += 1) mix[i] = bed[(bedAt + i) % bed.length];
        for (let i = 0; i < speech.length; i += 1) mix[LEAD + i] += speech[i] * gain;
        bedAt = (bedAt + len) % bed.length;
        const file = `${call.id}-${ti + 1}.ulaw`;
        const ulaw = toMulaw(mix);
        writeFileSync(join(OUT, file), ulaw);
        const row = {
            file,
            text,
            speech_start_ms: Math.round((LEAD / RATE) * 1000),
            speech_end_ms: Math.round(((LEAD + speech.length) / RATE) * 1000),
            duration_ms: Math.round((len / RATE) * 1000),
            digits_or_money: DIGIT_OR_MONEY.test(text),
        };
        if (verify) {
            const json = await post(probeRecognizeUrl(project), probeRecognizeRequest(ulaw, STT.model));
            const heard = recognizeTranscript(json);
            row.stt = { model: STT.model, heard, word_recall: Number(disclosureRecall(text, heard).toFixed(2)) };
            const expected = scripts.expect_unheard?.[file];
            if (!heard.trim() && !expected) {
                failed += 1;
                process.stderr.write(`render-corpus: STT heard nothing in ${file}\n`);
            } else if (heard.trim() && expected) {
                failed += 1;
                process.stderr.write(`render-corpus: ${file} is listed in expect_unheard but STT heard it: remove the entry\n`);
            }
            if (expected) row.stt.expected_unheard = expected;
        }
        rows.push(row);
    }
    calls.push({ id: call.id, scenario, source: call.fixture ? `test/fixtures/conversations/${call.fixture}.json` : 'new', voice: voice.name, turns: rows });
    process.stderr.write(`render-corpus: ${call.id} (${rows.length} turns, ${voice.name})\n`);
}

const manifest = {
    $comment: 'Generated by scripts/render-corpus.mjs from soak/fixtures/scripts.json. Do not edit by hand: change the scripts and re-render.',
    generated: new Date().toISOString().slice(0, 10),
    synthetic: true,
    audio: { encoding: 'mulaw', sample_rate: RATE, channels: 1 },
    tts: 'Text-to-Speech v1 text:synthesize, LINEAR16 8000 Hz, non-Chirp voices, levelled and mixed here',
    noise: { file: 'noise-bed.ulaw', ...scripts.noise, source: 'procedural (pink noise, synthesised babble, clinks), fixed seed 20261114; no third-party recording' },
    verified_with: verify ? { stt: `v2 recognize, model ${STT.model}, location ${STT.location}, MULAW 8000` } : null,
    calls,
};
writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const clips = calls.reduce((n, c) => n + c.turns.length, 0);
process.stderr.write(`render-corpus: ${calls.length} calls, ${clips} clips${verify ? `, ${failed} STT-silent` : ''}\n`);
process.exit(failed ? 1 : 0);
