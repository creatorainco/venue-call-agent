/**
 * Ending a venue turn on the interim (I3P-07, PERF-A): `src/speech/turnEnd.ts` and its use in
 * `CascadeBridge`.
 *
 *   1. A still interim that a keyword cue decides ends the turn after `cueSettleMs`; a short
 *      invited answer after `shortSettleMs`; anything else waits for the recogniser's final.
 *   2. 🔴 A goodbye never ends early: "thanks" is the head of "thanks, but who's paying?".
 *   3. A new interim restarts the wait: a turn still being spoken never ends early.
 *   4. The final that follows an early end is dropped when it is the same turn, and answered as a
 *      new turn when it says more (a question after the hello).
 *
 * CONTROL: with `earlyTurnEnd: false` the same interims end nothing; only the final does.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { FakeCallLeg } from '../src/carrier/fakeLeg.ts';
import { CascadeBridge } from '../src/carrier/cascadeBridge.ts';
import type { CallerTurn } from '../src/carrier/bridge.ts';
import { OutputGate } from '../src/carrier/outputGate.ts';
import { isSpeechFrame } from '../src/carrier/vad.ts';
import { VAD } from '../src/tuning/liveDefaults.ts';
import { TURN_END } from '../src/tuning/cascadeDefaults.ts';
import type { RecognizeStream, SpeechStreamFactory } from '../src/speech/stt.ts';
import { continues, earlySettleMs, earlyTurn, ForegroundSpeech, sameTurn, words } from '../src/speech/turnEnd.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('which interims may end a turn', () => {
    it('a keyword cue other than a goodbye: after cueSettleMs, invited or not', () => {
        for (const text of ['please stop calling us', 'wrong number', 'who is paying for the meal', 'for hours press 1', 'we need to cancel']) {
            assert.equal(earlySettleMs(text, false), TURN_END.cueSettleMs, text);
        }
    });

    it('🔴 a goodbye never ends early, short or not', () => {
        for (const text of ['thanks', 'great thanks', "that's all", 'noted']) {
            assert.equal(earlySettleMs(text, true), null, text);
        }
    });

    it('a short invited turn with no cue: after shortSettleMs; uninvited or long, it waits', () => {
        assert.equal(earlySettleMs('hello', true), TURN_END.shortSettleMs);
        assert.equal(earlySettleMs('golden crane', true), TURN_END.shortSettleMs);
        assert.equal(earlySettleMs('hello', false), null);
        assert.equal(earlySettleMs('hi this is the manager', true), TURN_END.shortSettleMs);
        assert.equal(earlySettleMs('do they need us to hold a table away', true), null);
        assert.equal(earlySettleMs('   ', true), null);
    });

    it('the final after an early end: same turn when it adds a little and the same cue', () => {
        const hello = earlyTurn('hello');
        assert.equal(sameTurn(hello, 'Hello?'), true);
        assert.equal(sameTurn(hello, 'hello happy birthday'), true);
        assert.equal(sameTurn(hello, "hello who's paying for the meal"), false, 'a question after the hello is answered');
        assert.equal(sameTurn(earlyTurn('please stop calling'), 'yeah please stop calling us'), true);
        assert.equal(sameTurn(hello, 'hello there this is the manager speaking right now'), false);
    });

    it('an interim continues the ended turn while it begins with the same words', () => {
        const early = earlyTurn('golden crane');
        assert.equal(continues(early, 'golden crane marcus'), true);
        assert.equal(continues(early, 'golden'), true);
        assert.equal(continues(early, 'who is paying'), false);
        assert.deepEqual(words("Who's paying?  Now."), ["who's", 'paying', 'now']);
    });
});

class FakeStream extends EventEmitter implements RecognizeStream {
    write(): boolean { return true; }
    end(): this { return this; }
    interim(text: string): void { this.emit('data', { results: [{ alternatives: [{ transcript: text }] }] }); }
    final(text: string): void { this.emit('data', { results: [{ isFinal: true, alternatives: [{ transcript: text }] }] }); }
}

/** A bridge on a fake recogniser with a hand-cranked settle clock. */
/** Low room noise, and a person well above it: mu-law bytes of small and large amplitude. */
const roomFrame = (): Uint8Array => new Uint8Array(160).map((_, i) => (i % 2 ? 0xf0 : 0x70));
const personFrame = (): Uint8Array => new Uint8Array(160).map((_, i) => (i % 2 ? 0x90 : 0x10));

function rig(earlyTurnEnd = true, person = 1, tts: { synthesize: (text: string) => Promise<Buffer> } = { synthesize: async () => Buffer.alloc(0) }) {
    const stream = new FakeStream();
    const speech: SpeechStreamFactory = { recognizer: 'r', open: () => stream };
    const leg = new FakeCallLeg({ turns: [], trailingSilenceMs: 10_000 });
    const gate = new OutputGate(leg, { isSpeech: (f) => isSpeechFrame(f, VAD), log: () => {} });
    gate.connect();
    let now = 0;
    let timers: Array<{ at: number; fn: () => void; id: number }> = [];
    let ids = 0;
    const lines: string[] = [];
    const speculated: string[] = [];
    const bridge = new CascadeBridge(gate, {
        onSpeculate: (text) => speculated.push(text),
        tts,
        speech,
        vad: VAD,
        earlyTurnEnd,
        log: (line) => lines.push(line),
        setTimer: (fn, ms) => { ids += 1; timers.push({ at: now + ms, fn, id: ids }); return ids; },
        clearTimer: (id) => { timers = timers.filter((t) => t.id !== id); },
    });
    const turns: CallerTurn[] = [];
    bridge.on('callerTurn', (t) => turns.push(t));
    bridge.start();
    for (let i = 0; i < 100; i++) bridge.sendAudio(roomFrame());
    for (let i = 0; i < 20 * person; i++) bridge.sendAudio(personFrame());
    for (let i = 0; i < 20; i++) bridge.sendAudio(roomFrame());
    const advance = (ms: number): void => {
        now += ms;
        for (const t of timers.filter((x) => x.at <= now)) {
            timers = timers.filter((x) => x !== t);
            t.fn();
        }
    };
    return { stream, bridge, turns, advance, lines, speculated, leg };
}

describe('CascadeBridge ends a turn on a still interim', () => {
    it('the hello after the disclosure ends at shortSettleMs; its final is dropped as the same turn', () => {
        const { stream, turns, advance, lines } = rig();
        stream.interim('hello');
        advance(TURN_END.shortSettleMs - 1);
        assert.equal(turns.length, 0);
        advance(1);
        assert.deepEqual(turns.map((t) => t.text), ['hello']);
        assert.equal(turns[0]!.early, true, 'the agent is told the turn was ended early');
        stream.final('hello happy birthday');
        assert.deepEqual(turns.map((t) => t.text), ['hello'], 'the same turn is not answered twice');
        assert.ok(lines.includes('final_same_turn'));
        assert.ok(lines.some((l) => l.startsWith('turn_end early')));
        assert.ok(lines.every((l) => !/hello/.test(l)), 'no transcript in a log line');
    });

    it('a new interim restarts the wait: words still coming never end the turn', () => {
        const { stream, turns, advance } = rig();
        stream.interim('hello');
        advance(TURN_END.shortSettleMs - 100);
        stream.interim('hello who is it you are calling for');
        advance(TURN_END.shortSettleMs);
        assert.equal(turns.length, 0, 'a long turn with no cue waits for the final');
        stream.final('hello who is it you are calling for');
        assert.deepEqual(turns.map((t) => t.text), ['hello who is it you are calling for']);
    });

    it('a question after an early hello is answered as a turn of its own', () => {
        const { stream, turns, advance, lines } = rig();
        stream.interim('hello');
        advance(TURN_END.shortSettleMs);
        stream.final("hello who's paying for the meal");
        assert.deepEqual(turns.map((t) => t.text), ['hello', "hello who's paying for the meal"]);
        assert.equal(turns[1]!.early, undefined, 'a final is not early');
        assert.ok(lines.includes('final_new_turn'));
    });

    it('a keyword cue ends an uninvited turn at cueSettleMs; a goodbye waits for its final', () => {
        const { stream, bridge, turns, advance } = rig();
        bridge.expectShortTurn(false);
        stream.interim('please stop calling us');
        advance(TURN_END.cueSettleMs);
        assert.deepEqual(turns.map((t) => t.text), ['please stop calling us']);
        stream.final('please stop calling us');
        stream.interim('thanks');
        advance(5_000);
        assert.equal(turns.length, 1, '🔴 a goodbye is never ended on the interim');
        stream.final('thanks');
        assert.deepEqual(turns.map((t) => t.text), ['please stop calling us', 'thanks']);
    });

    it('after the hangup a pending settle ends nothing', async () => {
        const { stream, bridge, turns, advance } = rig();
        stream.interim('hello');
        await bridge.hangup();
        advance(5_000);
        assert.equal(turns.length, 0);
    });

    it('🔴 the room alone: an interim of babble never ends a turn; its final still would', () => {
        const { stream, turns, advance, lines } = rig(true, 0);
        stream.interim('happy birthday');
        advance(5_000);
        assert.equal(turns.length, 0, 'babble from the next table is not the venue speaking');
        assert.ok(lines.includes('turn_end room_only'));
    });

    it('the agent is asked to start on an interim once it has stood speculateAfterMs, once', () => {
        const { stream, advance, speculated } = rig();
        stream.interim('hel');
        advance(TURN_END.speculateAfterMs - 1);
        stream.interim('hello');
        advance(TURN_END.speculateAfterMs - 1);
        assert.deepEqual(speculated, [], 'not on every revision');
        advance(1);
        assert.deepEqual(speculated, ['hello']);
        advance(TURN_END.shortSettleMs);
        assert.deepEqual(speculated, ['hello']);
    });

    it('CONTROL: with earlyTurnEnd false the same interims end nothing; the final does', () => {
        const { stream, turns, advance } = rig(false);
        stream.interim('hello');
        advance(5_000);
        assert.equal(turns.length, 0);
        stream.final('hello');
        assert.deepEqual(turns.map((t) => t.text), ['hello']);
    });
});

describe('the whole turn supersedes the reply to its early half (it-22, docs/soak/2026-11-20.md)', () => {
    const tick = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });
    /** 10 frames of audio a sentence, so each one sits on the leg until its mark comes back. */
    const audible = { synthesize: async () => Buffer.alloc(1_600, 0x10) };
    const OPENING = [1, 2, 3, 4].map((n) => ({ id: `o${n}`, text: `Opening sentence ${n}.` }));

    async function earlyHelloThenOpening() {
        const r = rig(true, 1, audible);
        // The gate lets no audio out before the disclosure: play it whole first.
        let heard = false;
        void r.bridge.speakDisclosure({ id: 'd', text: 'Disclosure sentence.' }).then(() => { heard = true; });
        for (let i = 0; i < 60 && !heard; i++) {
            await tick();
            r.leg.advance();
        }
        assert.ok(heard, 'the disclosure played');
        r.stream.interim('hello');
        r.advance(TURN_END.shortSettleMs);
        assert.deepEqual(r.turns.map((t) => t.text), ['hello']);
        const opening = r.bridge.speak(OPENING);
        await tick();
        assert.deepEqual(r.bridge.synthesised.slice(1), ['Opening sentence 1.'], 'the first sentence is on the leg');
        return { ...r, opening };
    }

    /** The mark of the sentence on the leg comes back: it was heard in full. */
    async function markBack(r: { bridge: CascadeBridge; leg: FakeCallLeg }): Promise<void> {
        const on = (): unknown => (r.bridge as unknown as { playing: unknown }).playing;
        const playing = on();
        assert.ok(playing, 'a sentence is on the leg');
        for (let i = 0; i < 30 && on() === playing; i++) r.leg.advance();
        assert.notEqual(on(), playing, 'its mark came back');
        for (let i = 0; i < 5; i++) await tick();
    }

    it('a new-turn final while the agent speaks drops the queued rest of the early reply; the one playing finishes', async () => {
        const r = await earlyHelloThenOpening();
        r.stream.final("hello who's paying for the meal");
        assert.deepEqual(r.turns.map((t) => t.text), ['hello', "hello who's paying for the meal"]);
        assert.ok(r.lines.includes('superseded_early_reply'));
        await markBack(r);
        assert.deepEqual(r.bridge.synthesised.slice(1), ['Opening sentence 1.'], 'nothing after the sentence playing is rendered');
        const result = await r.opening;
        assert.deepEqual(result.sentences.map((s) => s.heardMs > 0), [true, false, false, false]);
    });

    it('control: a same-turn final supersedes nothing, and the whole opening plays', async () => {
        const r = await earlyHelloThenOpening();
        r.stream.final('Hello?');
        assert.ok(!r.lines.includes('superseded_early_reply'));
        for (let n = 0; n < OPENING.length; n++) await markBack(r);
        const result = await r.opening;
        assert.equal(r.bridge.synthesised.length, 1 + OPENING.length);
        assert.equal(result.complete, true);
    });

    it('the speak_wait line says what a reply queued behind, with no text', async () => {
        const r = await earlyHelloThenOpening();
        void r.bridge.speak([{ id: 'r1', text: 'A reply.' }]);
        for (let n = 0; n < OPENING.length; n++) await markBack(r);
        assert.ok(r.lines.some((l) => /^speak_wait ms=\d+ behind=none sentences=4$/.test(l)), r.lines.join(' | '));
        assert.ok(r.lines.some((l) => /^speak_wait ms=\d+ behind=sentence sentences=1$/.test(l)), r.lines.join(' | '));
    });
});

describe('ForegroundSpeech on the soak corpus: the person at the phone, not the room', () => {
    const dir = join(import.meta.dirname, '..', 'soak', 'fixtures');
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
        noise: { file: string };
        calls: Array<{ turns: Array<{ file: string; speech_end_ms: number }> }>;
    };
    const bed = readFileSync(join(dir, manifest.noise.file));
    const frames = (buf: Uint8Array): Uint8Array[] => {
        const out: Uint8Array[] = [];
        for (let at = 0; at + 160 <= buf.length; at += 160) out.push(buf.subarray(at, at + 160));
        return out;
    };

    it('the noise bed alone (babble, clinks, pink noise) is never heard as a person', () => {
        const fg = new ForegroundSpeech();
        let heard = 0;
        for (const f of frames(Buffer.concat([bed, bed]))) {
            fg.push(f);
            if (fg.heard()) heard += 1;
        }
        assert.equal(heard, 0);
    });

    it('every clip is heard, read 1 s after its speech ends (about when an interim settles)', () => {
        const missed: string[] = [];
        for (const turn of manifest.calls.flatMap((c) => c.turns)) {
            const fg = new ForegroundSpeech();
            for (const f of frames(bed.subarray(0, 8 * 3000))) fg.push(f);
            const clip = readFileSync(join(dir, turn.file));
            for (const f of frames(clip.subarray(0, 8 * turn.speech_end_ms))) fg.push(f);
            for (const f of frames(bed.subarray(8 * 3000, 8 * 4000))) fg.push(f);
            if (!fg.heard()) missed.push(turn.file);
        }
        assert.deepEqual(missed, []);
    });
});
