#!/usr/bin/env node
/**
 * Speech-format probe (TASK-3744 step 4). Dev tooling: it never runs on the service, dials nobody
 * and touches no telephone. Two REST round trips per model, on synthetic audio.
 *
 *   1. Text-to-Speech v1 `text:synthesize`, Chirp 3 HD, MULAW at 8000 Hz, of one fixed, fact-free
 *      sentence. Google wraps the μ-law in a WAV container; it is unwrapped exactly as the call path
 *      unwraps it (`unwrapWav` in `src/speech/tts.ts`), so STT gets what the line would carry.
 *   2. Speech-to-Text v2 `recognize` on those bytes with an explicit MULAW 8000 mono decoding
 *      config, once per model in `PROBE_STT_MODELS` (`telephony`, `chirp_3`), location `us`.
 *
 * It prints, per model, the HTTP status, the transcript, and whether "one two three" survived,
 * then one VERDICT line. Exit 0 = at least one model kept the digits; 1 = none did; 2 = setup.
 *
 * Identity: by default a short-lived token for the runtime service account, minted by your own
 * gcloud session (`gcloud auth print-access-token --impersonate-service-account ...`), so the probe
 * runs with exactly the runtime's grants. `--adc` uses Application Default Credentials instead.
 * No key file, no API key, nothing read from the environment.
 *
 *   node scripts/probe-speech.mjs [--project creatorain-27e9e] [--impersonate <sa-email>] [--adc]
 *
 * Cost: one synthesis and two short recognitions, a fraction of a cent.
 */

import { spawnSync } from 'node:child_process';

import {
    PROBE_STT_MODELS,
    digitsSurvived,
    probeRecognizeRequest,
    probeRecognizeUrl,
    probeSynthesizeRequest,
    recognizeTranscript,
} from '../src/speech/probeRequest.ts';
import { TTS_ENDPOINT, unwrapWav } from '../src/speech/tts.ts';

/** Generic on purpose: a probe sentence is not product copy, and `check:no-facts` scans scripts/. */
const PROBE_SENTENCE = 'This is a test of the telephone audio path, one two three.';

const argv = process.argv.slice(2);
function option(name, fallback) {
    const at = argv.indexOf(name);
    if (at === -1) return fallback;
    const value = argv[at + 1];
    if (!value || value.startsWith('--')) {
        console.error(`probe-speech: ${name} needs a value`);
        process.exit(2);
    }
    return value;
}

const project = option('--project', 'creatorain-27e9e');
const useAdc = argv.includes('--adc');
const serviceAccount = option('--impersonate', `venue-call-runtime@${project}.iam.gserviceaccount.com`);

if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) {
    console.error(`probe-speech: "${project}" is not a project id`);
    process.exit(2);
}
if (!/^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(serviceAccount)) {
    console.error(`probe-speech: "${serviceAccount}" is not a service account email`);
    process.exit(2);
}

async function accessToken() {
    if (useAdc) {
        const { GoogleAuth } = await import('google-auth-library');
        const token = await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getAccessToken();
        if (!token) throw new Error('ADC returned no access token');
        return token;
    }
    // gcloud is a .cmd on Windows, which only a shell can start, so there it goes as one command
    // line. The service account email was validated above, so it carries no shell syntax.
    const args = ['auth', 'print-access-token', `--impersonate-service-account=${serviceAccount}`];
    const result = process.platform === 'win32'
        ? spawnSync(['gcloud', ...args].join(' '), { encoding: 'utf8', shell: true })
        : spawnSync('gcloud', args, { encoding: 'utf8' });
    const token = (result.stdout ?? '').trim().split(/\r?\n/).pop() ?? '';
    if (result.status !== 0 || !token) {
        throw new Error(`gcloud could not mint a token for ${serviceAccount}: ${(result.stderr ?? '').trim().split(/\r?\n/).pop()}`);
    }
    return token;
}

async function post(url, token, body) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-goog-user-project': project },
        body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    return { status: response.status, payload };
}

function errorText(payload) {
    return payload?.error?.message ? String(payload.error.message).slice(0, 200) : '';
}

let token;
try {
    token = await accessToken();
} catch (error) {
    console.error(`probe-speech: ${error.message}`);
    process.exit(2);
}

console.log(`probe-speech: project ${project}, identity ${useAdc ? 'ADC' : serviceAccount}`);

const tts = await post(TTS_ENDPOINT, token, probeSynthesizeRequest(PROBE_SENTENCE));
const wrapped = typeof tts.payload?.audioContent === 'string' ? Buffer.from(tts.payload.audioContent, 'base64') : Buffer.alloc(0);
const audio = unwrapWav(wrapped);
console.log(`TTS  MULAW 8000  HTTP ${tts.status}  ${wrapped.length} bytes, ${wrapped.length - audio.length}-byte header stripped, ${audio.length} bytes of mu-law (${(audio.length / 8000).toFixed(2)} s)${errorText(tts.payload) ? `  ${errorText(tts.payload)}` : ''}`);
if (tts.status !== 200 || audio.length === 0) {
    console.log('VERDICT FAIL: synthesis returned no audio, so recognition was not tried');
    process.exit(1);
}

let passed = 0;
for (const model of PROBE_STT_MODELS) {
    const stt = await post(probeRecognizeUrl(project), token, probeRecognizeRequest(audio, model));
    const transcript = recognizeTranscript(stt.payload);
    const kept = stt.status === 200 && digitsSurvived(transcript);
    if (kept) passed += 1;
    console.log(`STT  ${model.padEnd(9)} HTTP ${stt.status}  digits ${kept ? 'KEPT' : 'LOST'}  transcript: ${JSON.stringify(transcript)}${errorText(stt.payload) ? `  ${errorText(stt.payload)}` : ''}`);
}

console.log(passed > 0
    ? `VERDICT PASS: digits survived on ${passed} of ${PROBE_STT_MODELS.length} STT models (MULAW 8000 in and out)`
    : `VERDICT FAIL: no STT model kept the digits`);
process.exit(passed > 0 ? 0 : 1);
