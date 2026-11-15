/**
 * The audio corpus in `soak/fixtures/` (TASK-3749 step 2, I3P-16) holds together without a network.
 *
 *   - every clip the manifest names exists, is whole 8 kHz μ-law, and is as long as the manifest says;
 *   - speech sits inside the clip and is LOUDER than the noise around it (a clip of only noise, or
 *     of silence, fails: CONTROL below);
 *   - every call's scenario exists in the mock seam, so its token is accepted;
 *   - a call rendered from a conversation fixture says exactly that fixture's caller turns, so the
 *     corpus cannot drift from the text fixtures without a re-render;
 *   - twenty calls, five of them new digit- or money-heavy scripts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { decode } from '../src/audio/mulaw.ts';
import { scenarioNames } from '../src/mock/server.ts';
import { disclosureRecall } from '../src/soak/report.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIR = join(ROOT, 'soak', 'fixtures');
const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8')) as {
    audio: { encoding: string; sample_rate: number };
    noise: { file: string };
    calls: Array<{
        id: string;
        scenario: string;
        source: string;
        turns: Array<{ file: string; text: string; speech_start_ms: number; speech_end_ms: number; duration_ms: number; digits_or_money: boolean }>;
    }>;
};
const RATE = manifest.audio.sample_rate;

function rmsOf(pcm: Int16Array, fromMs: number, toMs: number): number {
    const a = Math.max(0, Math.floor((fromMs / 1000) * RATE));
    const b = Math.min(pcm.length, Math.floor((toMs / 1000) * RATE));
    let sum = 0;
    for (let i = a; i < b; i += 1) sum += pcm[i]! * pcm[i]!;
    return Math.sqrt(sum / Math.max(1, b - a));
}

/** Speech energy over the noise just before it, in dB. */
function speechOverLead(clip: Uint8Array, startMs: number, endMs: number): number {
    const pcm = decode(clip);
    return 20 * Math.log10(rmsOf(pcm, startMs, endMs) / Math.max(1, rmsOf(pcm, 0, startMs)));
}

describe('the soak audio corpus', () => {
    it('is 8 kHz μ-law, twenty calls, five of them new digit or money scripts', () => {
        assert.equal(manifest.audio.encoding, 'mulaw');
        assert.equal(RATE, 8000);
        assert.equal(manifest.calls.length, 20);
        const fresh = manifest.calls.filter((c) => c.source === 'new');
        assert.equal(fresh.length, 5);
        for (const c of fresh) assert.ok(c.turns.some((t) => t.digits_or_money), `${c.id} has no digits or money words`);
        assert.ok(existsSync(join(DIR, manifest.noise.file)));
    });

    it('every clip exists, has the length the manifest says, and its speech is above the noise', () => {
        for (const call of manifest.calls) {
            for (const t of call.turns) {
                const clip = readFileSync(join(DIR, t.file));
                assert.ok(Math.abs((clip.length / RATE) * 1000 - t.duration_ms) <= 1, `${t.file} length`);
                assert.ok(t.speech_start_ms < t.speech_end_ms && t.speech_end_ms <= t.duration_ms, `${t.file} bounds`);
                const snr = speechOverLead(clip, t.speech_start_ms, t.speech_end_ms);
                assert.ok(snr >= 6, `${t.file}: speech only ${snr.toFixed(1)} dB over the noise`);
            }
        }
    });

    it('CONTROL: a clip of noise alone, or of silence, fails the speech-over-noise check', () => {
        const bed = readFileSync(join(DIR, manifest.noise.file)).subarray(0, RATE * 3);
        assert.ok(speechOverLead(bed, 200, 2500) < 6, 'noise read as speech');
        const silence = new Uint8Array(RATE * 3).fill(0xff);
        assert.ok(!(speechOverLead(silence, 200, 2500) >= 6), 'silence read as speech');
    });

    it('every scenario is one the mock seam knows', () => {
        const known = new Set(scenarioNames());
        for (const c of manifest.calls) assert.ok(known.has(c.scenario), `${c.id}: no mock scenario ${c.scenario}`);
    });

    it('a call rendered from a conversation fixture says that fixture\'s caller turns, exactly', () => {
        for (const c of manifest.calls.filter((x) => x.source !== 'new')) {
            const fx = JSON.parse(readFileSync(join(ROOT, c.source), 'utf8')) as { turns: string[] };
            assert.deepEqual(c.turns.map((t) => t.text), fx.turns, `${c.id} drifted from ${c.source}: re-render`);
        }
    });
});

describe('disclosureRecall', () => {
    it('is the share of the sentence\'s words heard, case and punctuation folded', () => {
        assert.equal(disclosureRecall('Hi, this is an automated call.', 'hi this is an automated call'), 1);
        assert.equal(disclosureRecall('one two three four', 'one two'), 0.5);
        // CONTROL: a repeated word in the transcript is not counted twice.
        assert.equal(disclosureRecall('call call', 'call'), 0.5);
        assert.equal(disclosureRecall('', 'anything'), 0);
    });
});
