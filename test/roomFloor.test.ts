/**
 * Barge-in over the room's floor (it-22, docs/soak/2026-11-20.md). The corpus bed (RMS about 820)
 * sits over the pinned end threshold (600). With the fixed thresholds alone the detector never
 * ends a turn in it, so after the venue's first word it never starts another, and barge-in never
 * fires. `CascadeBridge` therefore passes `TURN_END` as the detector's floor. Reads the committed
 * corpus in soak/fixtures; nothing here talks to Google.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { TurnDetector } from '../src/carrier/vad.ts';
import type { RoomFloorSettings } from '../src/carrier/vad.ts';
import { VAD } from '../src/tuning/liveDefaults.ts';
import { TURN_END } from '../src/tuning/cascadeDefaults.ts';
import { CARRIER_AUDIO } from '../src/audio/format.ts';
import { EventEmitter } from 'node:events';
import { CascadeBridge } from '../src/carrier/cascadeBridge.ts';
import { FakeCallLeg } from '../src/carrier/fakeLeg.ts';
import { OutputGate } from '../src/carrier/outputGate.ts';
import { isSpeechFrame } from '../src/carrier/vad.ts';
import type { RecognizeStream, SpeechStreamFactory } from '../src/speech/stt.ts';

const DIR = new URL('../soak/fixtures/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', DIR), 'utf8')) as {
    noise: { file: string };
    calls: Array<{ turns: Array<{ file: string; speech_start_ms: number; speech_end_ms: number }> }>;
};
const fixture = (file: string): Buffer => readFileSync(new URL(file, DIR));
const bed = fixture(manifest.noise.file);
const FRAME = CARRIER_AUDIO.bytesPerFrame;
const FRAME_MS = CARRIER_AUDIO.frameMs;
/** 3 s of bed first, as a call has before the venue speaks over it. */
const LEAD_MS = 3000;
const lead = bed.subarray(0, (LEAD_MS / FRAME_MS) * FRAME);

function run(audio: Buffer, floor: RoomFloorSettings | null) {
    const detector = new TurnDetector(VAD, { floor });
    const starts: number[] = [];
    const ends: number[] = [];
    for (let i = 0; i + FRAME <= audio.length; i += FRAME) {
        const event = detector.push(audio.subarray(i, i + FRAME));
        if (event?.kind === 'speech_started') starts.push(event.at * FRAME_MS);
        if (event?.kind === 'turn_ended') ends.push(event.at * FRAME_MS);
    }
    return { starts, ends };
}

function corpus(floor: RoomFloorSettings | null) {
    let clips = 0;
    let missed = 0;
    let unended = 0;
    for (const call of manifest.calls) {
        for (const turn of call.turns) {
            clips += 1;
            const { starts, ends } = run(Buffer.concat([lead, fixture(turn.file), bed.subarray(0, 12_000)]), floor);
            if (!starts.some((at) => at >= LEAD_MS + turn.speech_start_ms)) missed += 1;
            if (!ends.some((at) => at >= LEAD_MS + turn.speech_end_ms)) unended += 1;
        }
    }
    return { clips, missed, unended };
}

describe('barge-in over the room floor', () => {
    it('30 s of bare bed starts no turn', () => {
        assert.deepEqual(run(Buffer.concat([lead, bed]), TURN_END).starts, []);
    });

    it('after 3 s of bed, every corpus clip starts a turn and ends it', () => {
        const result = corpus(TURN_END);
        assert.ok(result.clips >= 40, `the corpus has its clips (${result.clips})`);
        assert.equal(result.missed, 0, 'every clip starts a turn');
        assert.equal(result.unended, 0, 'every clip ends its turn');
    });

    it('control: with the fixed thresholds alone, the bed holds the turn open and no clip starts one', () => {
        const result = corpus(null);
        assert.equal(result.missed, result.clips, 'the bed swallowed every clip');
    });
});

class QuietStream extends EventEmitter implements RecognizeStream {
    write(): boolean { return true; }
    end(): this { return this; }
}

const tick = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

/**
 * A bridge mid-sentence (8 s of audio on the leg) hears 3 s of bed, then a corpus clip. Returns
 * how many barge-ins fired after the bed's first 3 s.
 */
async function bargeInsOverBed(options: { bargeInFloor?: RoomFloorSettings | null }): Promise<number> {
    const speech: SpeechStreamFactory = { recognizer: 'r', open: () => new QuietStream() };
    const leg = new FakeCallLeg({ turns: [], trailingSilenceMs: 60_000 });
    const gate = new OutputGate(leg, { isSpeech: (f) => isSpeechFrame(f, VAD), log: () => {} });
    gate.connect();
    const bridge = new CascadeBridge(gate, {
        tts: { synthesize: async () => Buffer.alloc(400 * FRAME, 0x10) },
        speech,
        vad: VAD,
        earlyTurnEnd: false,
        log: () => {},
        ...options,
    });
    bridge.start();
    let heard = false;
    void bridge.speakDisclosure({ id: 'd', text: 'Disclosure sentence.' }).then(() => { heard = true; });
    await tick();
    for (let i = 0; i < 500 && !heard; i++) leg.advance();
    await tick();
    assert.ok(heard, 'the disclosure played');
    void bridge.speak([{ id: 's1', text: 'A long sentence on the leg.' }]);
    await tick();
    assert.ok(bridge.speaking(), 'the agent is speaking');
    let interrupts = 0;
    let counting = false;
    const interrupt = bridge.interrupt.bind(bridge);
    bridge.interrupt = () => { if (counting) interrupts += 1; interrupt(); };
    const clip = manifest.calls.find((c) => c.turns.length > 0)!.turns[0]!;
    const audio = Buffer.concat([lead, fixture(clip.file)]);
    for (let i = 0; i + FRAME <= audio.length; i += FRAME) {
        if (i === lead.length) counting = true;
        bridge.sendAudio(audio.subarray(i, i + FRAME));
    }
    await bridge.hangup();
    return interrupts;
}

describe('CascadeBridge barges in over the room by default', () => {
    it('the venue speaking over the bed cuts the agent', async () => {
        assert.ok(await bargeInsOverBed({}) >= 1);
    });

    it('control: with the floor off, the same clip over the same bed cuts nothing', async () => {
        assert.equal(await bargeInsOverBed({ bargeInFloor: null }), 0);
    });
});
