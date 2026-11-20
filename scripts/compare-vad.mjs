#!/usr/bin/env node
/**
 * SPIKE (it-22, I3P-09): Silero VAD against the tuned energy detector on the soak's noise corpus.
 *
 *     VCA_SILERO_MODEL=<silero_vad.onnx> node scripts/compare-vad.mjs [--fg <dB>|none] [--out <file.json>]
 *
 * No network, no call. For each corpus clip (speech already mixed with the bed, with
 * speech_start_ms / speech_end_ms marked) and for the bare bed (30 s, at its own level and +6 dB),
 * it runs both detectors and reports:
 *   - false starts: a `speech_started` on the bare bed, or before speech_start_ms in a clip
 *     (the barge-in that would cut our own sentence for a dropped tray);
 *   - start lag: first `speech_started` after speech_start_ms (how fast a real barge-in is heard);
 *   - missed: a clip in which neither start fires;
 *   - end lag: `turn_ended` after speech_end_ms, at each detector's own silence setting.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TurnDetector } from '../src/carrier/vad.ts';
import { VAD } from '../src/tuning/liveDefaults.ts';
import { SileroStream, SILERO_BARGE_IN, warmSilero, sileroLoaded } from '../src/speech/silero.ts';
import { decode, encode } from '../src/audio/mulaw.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const outPath = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : null;
const fgArg = argv.includes('--fg') ? argv[argv.indexOf('--fg') + 1] : 'none';
const FG = fgArg === 'none' ? null : Number(fgArg);
const manifest = JSON.parse(readFileSync(join(ROOT, 'soak/fixtures/manifest.json'), 'utf8'));
const fixture = (f) => readFileSync(join(ROOT, 'soak/fixtures', f));
if (!(await warmSilero())) throw new Error('set VCA_SILERO_MODEL');
// --level-only: the control. The same foreground gate with Silero's score held at 1, so what
// Silero itself adds over a level gate shows.
const model = argv.includes('--level-only')
    ? { infer: async (_input, state) => ({ prob: 1, state }) }
    : sileroLoaded();

const FRAME = 160;
const frames = (ulaw) => {
    const out = [];
    for (let i = 0; i + FRAME <= ulaw.length; i += FRAME) out.push(ulaw.subarray(i, i + FRAME));
    return out;
};
const gain = (ulaw, db) => {
    const pcm = decode(ulaw);
    const k = 10 ** (db / 20);
    return encode(Int16Array.from(pcm, (s) => Math.max(-32768, Math.min(32767, Math.round(s * k)))));
};

async function run(ulaw, fgDb) {
    const energy = new TurnDetector(VAD);
    const eStarts = [], eEnds = [];
    const fs = frames(ulaw);
    let eSpeechFrames = 0, eIn = false;
    fs.forEach((f) => {
        const e = energy.push(f);
        if (e?.kind === 'speech_started') eIn = true;
        if (e?.kind === 'turn_ended') eIn = false;
        if (eIn) eSpeechFrames += 1;
        if (e?.kind === 'speech_started') eStarts.push(e.at * 20);
        if (e?.kind === 'turn_ended') eEnds.push(e.at * 20);
    });
    const sStarts = [], sEnds = [];
    let sIn = false, sLast = 0, sSpeechMs = 0;
    const silero = new SileroStream(model, { ...SILERO_BARGE_IN, foregroundDb: fgDb, silenceMs: VAD.silenceDurationMs }, (e) => {
        const t = e.atFrame * 20 + 20;
        if (sIn) sSpeechMs += t - sLast;
        sLast = t;
        if (e.kind === 'speech_started') { sStarts.push(t); sIn = true; }
        else { sEnds.push(t); sIn = false; }
    });
    const t0 = performance.now();
    fs.forEach((f) => silero.push(f));
    await silero.drain();
    const inferMs = performance.now() - t0;
    if (sIn) sSpeechMs += fs.length * 20 - sLast;
    return { energy: { starts: eStarts, ends: eEnds, speechMs: eSpeechFrames * 20 }, silero: { starts: sStarts, ends: sEnds, speechMs: sSpeechMs }, inferMs, audioMs: fs.length * 20 };
}

const pct = (xs, p) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
};

const bed = fixture(manifest.noise.file);
const result = { bed: {}, clips: [], summary: {} };
for (const [label, audio] of [['bed', bed], ['bed+6dB', gain(bed, 6)], ['bed+10dB', gain(bed, 10)]]) {
    const r = await run(audio, FG);
    result.bed[label] = { seconds: r.audioMs / 1000, energyFalseStarts: r.energy.starts.length, sileroFalseStarts: r.silero.starts.length,
        energySpeechShare: +(r.energy.speechMs / r.audioMs).toFixed(3), sileroSpeechShare: +(r.silero.speechMs / r.audioMs).toFixed(3) };
}
let inferMs = 0, audioMs = 0;
for (const call of manifest.calls) {
    for (const turn of call.turns) {
        // 1.5 s of the bed after the clip, as the line carries it, so an 800 ms end can fire.
        const clip = fixture(turn.file);
        const r = await run(Buffer.concat([clip, bed.subarray(0, 12000)]), FG);
        inferMs += r.inferMs; audioMs += r.audioMs;
        const row = { file: turn.file, speech_start_ms: turn.speech_start_ms, speech_end_ms: turn.speech_end_ms };
        for (const k of ['energy', 'silero']) {
            const early = r[k].starts.filter((t) => t < turn.speech_start_ms).length;
            const first = r[k].starts.find((t) => t >= turn.speech_start_ms);
            const end = r[k].ends.find((t) => t >= turn.speech_end_ms);
            row[k] = { falseStartsBefore: early, startLagMs: first === undefined ? null : first - turn.speech_start_ms, endLagMs: end === undefined ? null : end - turn.speech_end_ms, midTurnEnds: r[k].ends.filter((t) => t < turn.speech_end_ms && t > turn.speech_start_ms).length };
        }
        result.clips.push(row);
    }
}
for (const k of ['energy', 'silero']) {
    const lags = result.clips.map((c) => c[k].startLagMs).filter((x) => x !== null);
    const ends = result.clips.map((c) => c[k].endLagMs).filter((x) => x !== null);
    result.summary[k] = {
        clips: result.clips.length,
        missed: result.clips.filter((c) => c[k].startLagMs === null && c[k].falseStartsBefore === 0).length,
        falseStartsBeforeSpeech: result.clips.reduce((a, c) => a + c[k].falseStartsBefore, 0),
        midTurnEnds: result.clips.reduce((a, c) => a + c[k].midTurnEnds, 0),
        startLagP50: pct(lags, 0.5), startLagP90: pct(lags, 0.9),
        endLagP50: pct(ends, 0.5), endLagP90: pct(ends, 0.9),
        bedFalseStarts: Object.fromEntries(Object.entries(result.bed).map(([l, b]) => [l, b[`${k}FalseStarts`]])),
        bedShareCalledSpeech: Object.fromEntries(Object.entries(result.bed).map(([l, b]) => [l, b[`${k}SpeechShare`]])),
    };
}
result.summary.sileroRealTimeFactor = +(inferMs / audioMs).toFixed(4);
process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
if (outPath) writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
