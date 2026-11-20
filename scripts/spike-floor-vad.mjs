// SPIKE it-22 (stall fix): the energy detector with and without the room floor, on the corpus.
//     node scripts/spike-floor-vad.mjs
import { readFileSync } from 'node:fs';
import { TurnDetector } from '../src/carrier/vad.ts';
import { VAD } from '../src/tuning/liveDefaults.ts';
const man = JSON.parse(readFileSync('soak/fixtures/manifest.json', 'utf8'));
const fx = (f) => readFileSync(`soak/fixtures/${f}`);
const bed = fx(man.noise.file);
function run(buf, db) {
    const d = new TurnDetector(VAD, { floorMarginDb: db });
    const starts = [], ends = [];
    for (let i = 0, f = 0; i + 160 <= buf.length; i += 160, f += 1) {
        const e = d.push(buf.subarray(i, i + 160));
        if (e?.kind === 'speech_started') starts.push(e.at * 20);
        if (e?.kind === 'turn_ended') ends.push(e.at * 20);
    }
    return { starts, ends };
}
// Warm the floor on 3 s of bed first, as a call does before the venue speaks.
const lead = bed.subarray(0, 24000);
for (const db of [null, 9]) {
    const b = run(Buffer.concat([lead, bed]), db);
    let missed = 0, early = 0, noEnd = 0; const lags = [];
    for (const c of man.calls) for (const t of c.turns) {
        const r = run(Buffer.concat([lead, fx(t.file), bed.subarray(0, 12000)]), db);
        const s0 = 3000 + t.speech_start_ms, e0 = 3000 + t.speech_end_ms;
        early += r.starts.filter((x) => x >= 3000 && x < s0).length;
        const first = r.starts.find((x) => x >= s0); if (first === undefined) missed += 1; else lags.push(first - s0);
        if (!r.ends.some((x) => x >= e0)) noEnd += 1;
    }
    lags.sort((a, b) => a - b);
    console.log(`floor=${db}: bed 30 s starts=${b.starts.length} ends=${b.ends.length}; clips missed=${missed} starts_before_speech=${early} no_end_after_speech=${noEnd} start_lag_p50=${lags[Math.floor(lags.length / 2)]} p90=${lags[Math.floor(lags.length * 0.9)]}`);
}
