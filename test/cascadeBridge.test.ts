/**
 * The live speech path (I3P-01): `CascadeBridge` + `liveCall` on a fake leg, and the session
 * `main.ts` picks.
 *
 *   1. 🔴 A live session speaks the disclosure before anything else: the first frame written to the
 *      leg is the disclosure's audio, under the gate's protected range, and the carrier's mark for
 *      it comes back before any other sentence is released.
 *   2. 🔴 It never composes text: every string handed to synthesis is one the backend (call
 *      context, a seam `say`) or the four fixed phrases supplied, verbatim.
 *   3. The recogniser stream is open before the first inbound frame (I3P-08).
 *   4. 🔴 With no backend named, `startCall` is `noAgentSession`, and the cascade is never started.
 *      With a cascade that cannot start, a call is hung up with zero audio.
 *
 * CONTROLS: an `open()` that does not begin with the disclosure says nothing at all (the guard in
 * `liveCall` is what stops it; delete it and the "nothing before the disclosure" test goes red),
 * and the allowed-set check catches a planted composed sentence.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { FakeCallLeg } from '../src/carrier/fakeLeg.ts';
import type { FakeLegOptions } from '../src/carrier/fakeLeg.ts';
import type { Frame } from '../src/carrier/leg.ts';
import { liveCall } from '../src/carrier/call.ts';
import type { LiveCallResult } from '../src/carrier/call.ts';
import { CascadeBridge, toFrames } from '../src/carrier/cascadeBridge.ts';
import { OutputGate } from '../src/carrier/outputGate.ts';
import { isSpeechFrame } from '../src/carrier/vad.ts';
import { TwilioLeg } from '../src/carrier/twilioLeg.ts';
import { createCascadeAgent } from '../src/agent/cascadeAgent.ts';
import { createKeywordClassifier } from '../src/agent/intent.ts';
import type { CallAgent } from '../src/agent/contract.ts';
import { FIXED_PHRASES } from '../src/agent/phrases.ts';
import { startMockSeam } from '../src/mock/server.ts';
import type { MockSeam } from '../src/mock/server.ts';
import { createSeamClient } from '../src/seam/client.ts';
import type { SeamClient } from '../src/seam/client.ts';
import type { CallContext } from '../src/seam/types.ts';
import type { RecognizeStream, SpeechStreamFactory } from '../src/speech/stt.ts';
import { CARRIER_AUDIO, MULAW_SILENCE } from '../src/audio/format.ts';
import { VAD } from '../src/tuning/liveDefaults.ts';
import { cascadeSession, noAgentSession, selectStartCall } from '../src/server/main.ts';
import type { CascadeRuntime } from '../src/agent/cascade.ts';
import type { AuthorizedCall } from '../src/server/streamServer.ts';

class FakeStream extends EventEmitter implements RecognizeStream {
    readonly writes: unknown[] = [];
    ended = false;
    write(message: unknown): boolean { this.writes.push(message); return true; }
    end(): this { this.ended = true; return this; }
    final(text: string): void { this.emit('data', { results: [{ isFinal: true, alternatives: [{ transcript: text }] }] }); }
}

function fakeSpeech(): SpeechStreamFactory & { streams: FakeStream[] } {
    const streams: FakeStream[] = [];
    return {
        recognizer: 'projects/p/locations/us/recognizers/_',
        streams,
        open: () => { const s = new FakeStream(); streams.push(s); return s; },
    };
}

/**
 * Synthesis that answers every sentence with its own μ-law byte, so a frame on the wire says which
 * sentence it came from. Records every text it was asked for.
 */
function fakeTts(frames = 6) {
    const voices = new Map<string, number>();
    const asked: string[] = [];
    const byteFor = (text: string): number => {
        if (!voices.has(text)) voices.set(text, 0x10 + voices.size);
        return voices.get(text)!;
    };
    return {
        asked,
        byteFor,
        requests: 0,
        async synthesize(text: string): Promise<Buffer> {
            asked.push(text);
            return Buffer.alloc(frames * CARRIER_AUDIO.bytesPerFrame, byteFor(text));
        },
        async prerender(texts: readonly string[]): Promise<void> {
            await Promise.all(texts.map((t) => this.synthesize(t)));
        },
    };
}

/** A fake leg that also keeps the bytes of every frame written, in order. */
class RecordingLeg extends FakeCallLeg {
    readonly written: Frame[] = [];
    constructor(options: FakeLegOptions) { super(options); }
    override write(frame: Frame): void {
        this.written.push(frame);
        super.write(frame);
    }
}

const tick = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

let mock: MockSeam;
before(async () => { mock = await startMockSeam({ port: 0 }); });
after(async () => { await mock.close(); });

/** Every sentence the backend supplied on the call, read off the mock's journal. */
function backendStrings(context: CallContext): Set<string> {
    const allowed = new Set<string>([context.disclosure_sentence, ...context.opening_script, context.voicemail_script, ...FIXED_PHRASES]);
    for (const entry of mock.journal) {
        const body = entry.response as { say?: unknown } | undefined;
        if (typeof body?.say === 'string') allowed.add(body.say);
    }
    return allowed;
}

const CALLER = ['hello, who is this?', 'how many people are coming?', 'what time is the booking?'];

/**
 * One live call on a fake leg: the far end says each line after we finish speaking, and the fake
 * recogniser turns each of their turns into a final transcript the frame it ends.
 */
async function runLive(makeAgent?: (seam: SeamClient, context: CallContext) => CallAgent) {
    const seam = createSeamClient({ baseUrl: mock.baseUrl, token: 'mock:happy' });
    const context = await seam.callContext();
    const leg = new RecordingLeg({
        turns: CALLER.map((text) => ({ text, segmentsMs: [600] })),
        trailingSilenceMs: 4_000,
        patienceMs: 60_000,
    });
    const speech = fakeSpeech();
    const tts = fakeTts();
    const agent = makeAgent
        ? makeAgent(seam, context)
        : createCascadeAgent({ seam, intents: createKeywordClassifier(), context });
    const log: string[] = [];
    let result: LiveCallResult | null = null;
    const running = liveCall({
        leg, agent, tts, speech, context, report: seam,
        log: (line) => { log.push(line); },
        capTimer: null,
        maxCallMs: 120_000,
    }).then((r) => { result = r; });
    const streamsAtStart = speech.streams.length;

    let finals = 0;
    for (let guard = 0; result === null && guard < 200_000; guard += 1) {
        if (!leg.ended) leg.advance();
        while (finals < leg.truth.length) {
            speech.streams.at(-1)!.final(leg.truth[finals]!.text);
            finals += 1;
        }
        await tick();
    }
    await running;
    return { leg, tts, speech, context, result: result as unknown as LiveCallResult, streamsAtStart, log };
}

describe('🔴 a live session on a fake leg', () => {
    it('speaks the disclosure before anything else, and it is heard', async () => {
        const { leg, tts, context, result } = await runLive();
        assert.ok(leg.written.length > 0, 'nothing was said');
        const disclosureByte = tts.byteFor(context.disclosure_sentence);
        assert.equal(leg.written[0]![0], disclosureByte, 'the first frame on the wire is not the disclosure');
        assert.equal(result.synthesised[0], context.disclosure_sentence);
        assert.equal(result.turns[0]?.speaker, 'agent');
        assert.equal(result.turns[0]?.text, context.disclosure_sentence);
        assert.equal(result.disclosure.started, true);
        assert.equal(result.disclosure.heard, true);
        // Every frame of the disclosure was written before any frame of anything else.
        const firstOther = leg.written.findIndex((f) => f[0] !== disclosureByte && f[0] !== MULAW_SILENCE);
        const lastDisclosure = leg.written.map((f) => f[0]).lastIndexOf(disclosureByte);
        assert.ok(firstOther > 0 && lastDisclosure < firstOther, 'another sentence was interleaved with the disclosure');
    });

    it('never composes text: every synthesised string is one the backend or the fixed phrases supplied', async () => {
        const { tts, context, result } = await runLive();
        const allowed = backendStrings(context);
        assert.ok(result.synthesised.length >= 4, `only ${result.synthesised.length} sentences: the call did not get going`);
        for (const text of [...result.synthesised, ...tts.asked]) assert.ok(allowed.has(text), `composed: ${JSON.stringify(text)}`);
        // CONTROL: the same check catches a planted sentence.
        assert.equal(allowed.has(`${context.disclosure_sentence} Have a nice day.`), false);
    });

    it('answers each turn, ends the call itself, and hangs up exactly once', async () => {
        const { leg, context, result } = await runLive();
        assert.deepEqual(leg.hangupsSent, ['agent_ended']);
        assert.equal(result.hungUpWith, 'agent_ended');
        assert.equal(result.failed, false);
        assert.equal(leg.writtenAfterHangup, 0);
        const agentLines = result.turns.filter((t) => t.speaker === 'agent').map((t) => t.text);
        for (const line of context.opening_script) assert.ok(agentLines.includes(line), 'the notice was not delivered');
        assert.deepEqual(result.turns.filter((t) => t.speaker === 'venue').map((t) => t.text), CALLER);
    });

    it('opens the recognition stream at call start, before any audio (I3P-08)', async () => {
        const { speech, streamsAtStart } = await runLive();
        assert.equal(streamsAtStart, 1);
        assert.equal(speech.streams.length, 1);
        const config = speech.streams[0]!.writes[0] as { streamingConfig?: unknown };
        assert.ok(config.streamingConfig, 'the first message is not the config');
        assert.equal(speech.streams[0]!.ended, true, 'the stream was not closed at the end of the call');
    });

    it('CONTROL: an open() that does not begin with the disclosure says nothing and ends as an internal error', async () => {
        const { leg, result } = await runLive((_seam, context) => ({
            open: async () => ({ say: [context.opening_script[0]!], toolCalls: [], endCall: false }),
            hear: async () => ({ say: [], toolCalls: [], endCall: false }),
        }));
        assert.equal(leg.written.length, 0, 'audio left before any disclosure');
        assert.equal(result.failed, true);
        assert.deepEqual(leg.hangupsSent, ['internal_error']);
    });
});

describe('CascadeBridge, barge-in', () => {
    it('speech over a sentence cuts it short and drops what is queued behind it', async () => {
        const leg = new FakeCallLeg({ turns: [{ text: 'wait', segmentsMs: [600], startWhen: { atMs: 3_000 } }], trailingSilenceMs: 2_000 });
        const gate = new OutputGate(leg, { isSpeech: (f) => isSpeechFrame(f, VAD), log: () => {} });
        gate.connect();
        const bridge = new CascadeBridge(gate, { tts: fakeTts(100), speech: fakeSpeech(), vad: VAD });
        leg.on('inbound', (f) => bridge.sendAudio(f));
        bridge.start();
        let disclosureDone = false;
        const disclosure = bridge.speakDisclosure({ id: 'd', text: 'the disclosure' });
        void disclosure.then(() => { disclosureDone = true; });
        await tick();
        // Play the disclosure out: 100 frames, then its mark. The far end speaks at 3 s, over `first`.
        while (!disclosureDone && leg.advance()) await tick();
        assert.ok(leg.elapsedMs < 3_000, 'the disclosure was still playing when they spoke');
        const long = bridge.speak([{ id: 'a', text: 'first' }, { id: 'b', text: 'second' }]);
        while (leg.advance()) await tick();
        await bridge.hangup();
        assert.equal((await disclosure).complete, true);
        const r = await long;
        assert.equal(r.complete, false);
        assert.ok(r.sentences[0]!.heardMs < r.sentences[0]!.fullMs, 'the cut sentence is reported heard in full');
        assert.equal(r.sentences[1]!.heardMs, 0, 'a sentence queued behind the barge-in was spoken');
        assert.ok(leg.cleared > 0, 'nothing was cleared');
    });

    /**
     * 🔴 A "hello?" over the disclosure (PR #40 review). The disclosure is protected, so the
     * barge-in clears only what is held behind it. Before the fix the bridge's own mark sat in that
     * held queue, the clear dropped it, the disclosure never settled and every later sentence
     * waited behind it until the call cap. `talkMs` 600 is under half the range (no replay);
     * 1_600 is over half (one replay): both must still let the next sentence play.
     */
    for (const talkMs of [600, 1_600]) {
        it(`a barge-in during the disclosure (${talkMs} ms of talk) still lets the next sentence play`, async () => {
            const leg = new RecordingLeg({ turns: [{ text: 'hello?', segmentsMs: [talkMs], startWhen: { atMs: 500 } }], trailingSilenceMs: 6_000 });
            const gate = new OutputGate(leg, { isSpeech: (f) => isSpeechFrame(f, VAD), log: () => {} });
            gate.connect();
            const tts = fakeTts(100);
            const bridge = new CascadeBridge(gate, { tts, speech: fakeSpeech(), vad: VAD });
            leg.on('inbound', (f) => bridge.sendAudio(f));
            bridge.start();
            let disclosureDone = false;
            const disclosure = bridge.speakDisclosure({ id: 'd', text: 'the disclosure' });
            void disclosure.then(() => { disclosureDone = true; });
            await tick();
            while (!disclosureDone && leg.advance()) await tick();
            assert.equal(disclosureDone, true, 'the disclosure never settled after a barge-in over it');
            assert.ok(leg.elapsedMs > 500, 'the far end did not speak during the disclosure');
            assert.equal(gate.disclosure().heard, true);
            assert.equal((await disclosure).complete, true);

            let nextDone = false;
            const next = bridge.speak([{ id: 'n', text: 'next' }]);
            void next.then(() => { nextDone = true; });
            while (!nextDone && leg.advance()) await tick();
            await bridge.hangup();
            assert.equal(nextDone, true, 'the sentence after the disclosure never settled: the agent went mute');
            assert.equal((await next).complete, true);
            assert.ok(leg.written.some((f) => f[0] === tts.byteFor('next')), 'the next sentence never reached the wire');
            assert.equal(bridge.speaking(), false);
        });
    }

    it('toFrames pads the last frame with μ-law silence', () => {
        const frames = toFrames(new Uint8Array(CARRIER_AUDIO.bytesPerFrame + 10).fill(0x20));
        assert.equal(frames.length, 2);
        assert.equal(frames[1]![9], 0x20);
        assert.equal(frames[1]![10], MULAW_SILENCE);
    });
});

describe('🔴 the session main.ts picks, behind the fail-closed default', () => {
    it('no backend named: startCall is noAgentSession and the cascade is never started', () => {
        let started = 0;
        const cascade = async (): Promise<CascadeRuntime> => { started += 1; throw new Error('must not start'); };
        assert.equal(selectStartCall({}, { cascade }), noAgentSession);
        assert.equal(selectStartCall({ CREATORAIN_API_BASE_URL: '   ' }, { cascade }), noAgentSession);
        assert.equal(started, 0);
    });

    it('a backend named: startCall is the cascade session (CONTROL for the test above)', async () => {
        const startCall = selectStartCall(
            { CREATORAIN_API_BASE_URL: 'https://datadev.creatorain.com' },
            { cascade: () => Promise.reject(new Error('no Google here')), log: () => {} },
        );
        assert.notEqual(startCall, noAgentSession);
    });

    it('a cascade that cannot start: the call is hung up having sent no audio', async () => {
        const sent: string[] = [];
        const leg = new TwilioLeg({
            id: 'stream-t',
            socket: { send: (text) => { sent.push(text); }, close: () => {} },
            every: () => () => {},
            log: () => {},
        });
        leg.receive(JSON.stringify({
            event: 'start',
            streamSid: 'MZ1',
            start: {
                streamSid: 'MZ1', callSid: 'CA1',
                mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
                customParameters: { token: 't' },
            },
        }));
        leg.accept();
        const reported: unknown[] = [];
        const call = {
            leg,
            seam: { callEvent: async (input: unknown) => { reported.push(input); return {}; } } as unknown as SeamClient,
            context: {} as CallContext,
            log: () => {},
            shutdown: new AbortController().signal,
        } satisfies AuthorizedCall;
        const failing = Promise.reject(new Error('no ADC'));
        failing.catch(() => {});
        await cascadeSession(failing, 50)(call);
        assert.equal(leg.ended, true);
        assert.deepEqual(leg.hangupsSent, ['internal_error']);
        assert.equal(sent.filter((m) => JSON.parse(m).event === 'media').length, 0);
        assert.equal(reported.length, 1);
    });
});
