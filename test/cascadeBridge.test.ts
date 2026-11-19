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
import { liveCall, VOICEMAIL_HOLD_ACTION } from '../src/carrier/call.ts';
import type { LiveCallResult } from '../src/carrier/call.ts';
import { CascadeBridge, toFrames } from '../src/carrier/cascadeBridge.ts';
import { OutputGate } from '../src/carrier/outputGate.ts';
import { isSpeechFrame } from '../src/carrier/vad.ts';
import { TwilioLeg } from '../src/carrier/twilioLeg.ts';
import { createCascadeAgent } from '../src/agent/cascadeAgent.ts';
import { createScriptedStub } from '../src/agent/scriptedStub.ts';
import { createKeywordClassifier } from '../src/agent/intent.ts';
import type { CallAgent } from '../src/agent/contract.ts';
import { FIXED_PHRASES } from '../src/agent/phrases.ts';
import { startMockSeam } from '../src/mock/server.ts';
import type { MockSeam } from '../src/mock/server.ts';
import { createSeamClient } from '../src/seam/client.ts';
import type { SeamClient } from '../src/seam/client.ts';
import type { CallContext } from '../src/seam/types.ts';
import { AnswererUnsupported } from '../src/carrier/beepGate.ts';
import type { AnswererVerdict } from '../src/carrier/beepGate.ts';
import { SeamRefusal } from '../src/seam/client.ts';
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
    // it-21: the fact sentences the context carried are the backend's words too.
    for (const fact of context.static_facts ?? []) allowed.add(fact.say);
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

    it('it-21: every fact sentence the context carried is rendered, after the opening', async () => {
        const { tts, context } = await runLive();
        const facts = (context.static_facts ?? []).map((f) => f.say);
        assert.ok(facts.length > 0, 'the mock context carried no facts');
        for (const say of facts) assert.ok(tts.asked.includes(say), `not rendered: ${JSON.stringify(say)}`);
        const lastBeat = Math.max(...context.opening_script.map((b) => tts.asked.indexOf(b)));
        const firstFact = Math.min(...facts.map((f) => tts.asked.indexOf(f)));
        assert.ok(lastBeat < firstFact, 'a fact sentence was rendered before the opening beats');
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

    it('stamps the stage timings (I3P-03): venue turns when heard, each reply first sentence when decided and sounded', async () => {
        const { result, log } = await runLive();
        const venue = result.turns.filter((t) => t.speaker === 'venue');
        assert.equal(venue.length, CALLER.length);
        for (const t of venue) {
            assert.equal(typeof t.venue_end_ms, 'number');
            assert.equal(typeof t.stt_final_ms, 'number');
            assert.ok(t.stt_final_ms! >= t.venue_end_ms!, 'the final came before the speech ended');
        }
        // The disclosure was sounded, so it carries the synthesis points but no intent.
        const disclosure = result.turns[0]!;
        assert.equal(typeof disclosure.first_frame_out_ms, 'number');
        assert.ok(disclosure.first_frame_out_ms! >= disclosure.tts_first_byte_ms!);
        assert.equal(disclosure.intent_ms, undefined);
        // Every agent turn right after a venue turn is a reply's first sentence: timed and sourced.
        const replies = result.turns.filter((t, i) => t.speaker === 'agent' && result.turns[i - 1]?.speaker === 'venue');
        assert.ok(replies.length >= 2, 'the call did not get going');
        for (const r of replies) {
            assert.equal(r.intent_source, 'keyword');
            assert.ok(r.intent_ms! >= 0 && r.seam_ms! >= 0);
            assert.equal(typeof r.first_frame_out_ms, 'number');
        }
        // And the report logged them without a word of the transcript.
        const timing = log.filter((l) => l.includes(' turn_timing '));
        assert.ok(timing.length >= venue.length + replies.length);
        for (const line of timing) for (const said of [...CALLER, ...result.synthesised]) assert.ok(!line.includes(said));
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

/**
 * it-05: a voicemail greeting. The far end is a machine reading its greeting; the agent hears the
 * cue and ends with the voicemail script. `poll` is the answering-machine verdict the call reads.
 */
async function runVoicemail(
    answerer?: { poll: () => Promise<AnswererVerdict>; intervalMs?: number; timeoutMs?: number },
    opts: {
        token?: string;
        agent?: 'cascade' | 'stub';
        seam?: SeamClient;
        makeAgent?: (seam: SeamClient, context: CallContext) => CallAgent;
        callerTurns?: string[];
    } = {},
) {
    // The hold runs on a clock that moves with the fake leg (one frame per wait), so the far end's
    // simulated silence does not run out while the test's real clock waits.
    let fakeMs = 0;
    const gateClock = { now: () => fakeMs, sleep: async (ms: number) => { fakeMs += ms; await tick(); } };
    const seam = opts.seam ?? createSeamClient({ baseUrl: mock.baseUrl, token: opts.token ?? 'mock:happy' });
    const context = await seam.callContext();
    const leg = new RecordingLeg({
        turns: (opts.callerTurns ?? [VOICEMAIL_GREETING]).map((text) => ({ text, segmentsMs: [900] })),
        trailingSilenceMs: 4_000,
        patienceMs: 60_000,
    });
    const speech = fakeSpeech();
    const tts = fakeTts();
    const agent = opts.makeAgent ? opts.makeAgent(seam, context) : opts.agent === 'stub'
        ? createScriptedStub({ seam })
        : createCascadeAgent({ seam, intents: createKeywordClassifier(), context });
    const log: string[] = [];
    let result: LiveCallResult | null = null;
    const running = liveCall({
        leg, agent, tts, speech, context, report: seam,
        log: (line) => { log.push(line); },
        capTimer: null,
        maxCallMs: 120_000,
        ...(answerer ? { answerer: { ...gateClock, ...answerer } } : {}),
    }).then((r) => { result = r; });
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
    const r = result as unknown as LiveCallResult;
    const said = r.turns.filter((t) => t.speaker === 'agent').map((t) => t.text);
    return { leg, tts, context, result: r, log, said };
}

const VOICEMAIL_GREETING = 'you have reached Test Venue, please leave a message after the tone';

describe('it-05: the voicemail message waits for the beep', () => {
    it('holds the message until the greeting ends, then speaks it and hangs up', async () => {
        let polls = 0;
        const verdicts: AnswererVerdict[] = [
            { answered_by: null, message_end: false },
            { answered_by: null, message_end: false },
            { answered_by: 'machine_end_beep', message_end: true },
        ];
        const { context, result, log, said } = await runVoicemail({
            poll: async () => verdicts[Math.min(polls++, verdicts.length - 1)]!,
            intervalMs: 250,
        });
        const hold = log.find((l) => l.startsWith('voicemail_hold'));
        assert.ok(hold, log.join('\n'));
        assert.match(hold, /outcome=message_end .* polls=3 /);
        assert.ok(said.includes(context.voicemail_script), 'the message was left after the beep');
        assert.equal(result.hungUpWith, 'agent_ended');
    });

    it('a fax hears nothing: hang up without the message', async () => {
        const { context, result, log, said } = await runVoicemail({
            poll: async () => ({ answered_by: 'fax', message_end: false }),
            intervalMs: 250,
        });
        assert.ok(log.some((l) => l.startsWith('voicemail_hold outcome=fax')), log.join('\n'));
        assert.ok(!said.includes(context.voicemail_script), 'nothing spoken to a fax');
        assert.equal(result.hungUpWith, 'agent_ended');
    });

    it('a seam that keeps failing still speaks at the bound (an error is not a verdict)', async () => {
        const { context, log, said } = await runVoicemail({
            poll: async () => { throw new Error('seam down'); },
            intervalMs: 250,
            timeoutMs: 1_000,
        });
        assert.ok(log.some((l) => /^voicemail_hold outcome=timeout .*poll_errors=[1-9]/.test(l)), log.join('\n'));
        assert.ok(said.includes(context.voicemail_script));
    });

    it('CONTROL: with no answerer the message is spoken at once, as before', async () => {
        const { context, log, said, result } = await runVoicemail();
        assert.ok(!log.some((l) => l.startsWith('voicemail_hold')));
        assert.ok(said.includes(context.voicemail_script));
        assert.equal(result.hungUpWith, 'agent_ended');
        assert.equal(result.voicemailHold, null, 'no hold ran, and the result says so');
    });
});

/** Every frame of a sentence carries one byte from the fake voice; was any of this one written? */
function wroteAudioOf(leg: RecordingLeg, tts: ReturnType<typeof fakeTts>, text: string): boolean {
    const byte = tts.byteFor(text);
    return leg.written.some((f) => f.length > 0 && f.every((x) => x === byte));
}

describe('it-05: the person cut-in (a person never hears the voicemail script)', () => {
    for (const which of ['cascade', 'stub'] as const) {
        it(`${which}: the carrier says human, the held message is dropped and the agent answers the person`, async () => {
            const before = mock.journal.length;
            const { leg, tts, context, result, log, said } = await runVoicemail({
                poll: async () => ({ answered_by: 'human', message_end: false }),
                intervalMs: 250,
            }, { agent: which });
            assert.ok(log.some((l) => l.startsWith('voicemail_hold outcome=human action=returned_to_conversation')), log.join('\n'));
            // 🔴 the script never reached speak(), nor the wire.
            assert.ok(!result.synthesised.includes(context.voicemail_script), result.synthesised.join(' | '));
            assert.ok(!said.includes(context.voicemail_script));
            assert.ok(!wroteAudioOf(leg, tts, context.voicemail_script), 'no frame of the voicemail audio went out');
            // The conversation turn ran: the person hears the notice, after the disclosure.
            assert.equal(said[0], context.disclosure_sentence);
            for (const beat of context.opening_script) assert.ok(said.includes(beat), `notice beat spoken: ${beat}`);
            assert.ok(result.synthesised.includes(context.opening_script[0]!));
            // The ledger is told twice, in order: voicemail (the misreading), then human.
            const answerers = mock.journal.slice(before)
                .filter((e) => e.route === '/reservations/call-event' && (e.body as { kind?: string }).kind === 'answerer_reported')
                .map((e) => (e.body as { answerer?: string }).answerer);
            assert.deepEqual(answerers, ['voicemail', 'human']);
            assert.deepEqual(
                { outcome: result.voicemailHold?.outcome, action: result.voicemailHold?.action },
                { outcome: 'human', action: 'returned_to_conversation' },
            );
            assert.equal(result.failed, false);
        });
    }

    it('POSITIVE CONTROL: message_end still speaks the voicemail script, on the wire', async () => {
        const { leg, tts, context, result, said } = await runVoicemail({
            poll: async () => ({ answered_by: 'machine_end_beep', message_end: true }),
            intervalMs: 250,
        });
        assert.ok(result.synthesised.includes(context.voicemail_script));
        assert.ok(said.includes(context.voicemail_script));
        assert.ok(wroteAudioOf(leg, tts, context.voicemail_script), 'the helper does see the voicemail audio when it plays');
        assert.ok(!said.includes(context.opening_script[0]!), 'the notice is never read to a machine');
        assert.equal(result.voicemailHold?.action, 'spoke_message');
        assert.equal(result.hungUpWith, 'agent_ended');
    });

    it('undetermined (Twilio unknown) speaks the message now, and the result says so', async () => {
        const { context, result, said } = await runVoicemail({
            poll: async () => ({ answered_by: 'unknown', message_end: false }),
            intervalMs: 250,
        });
        assert.ok(said.includes(context.voicemail_script));
        assert.deepEqual(
            { outcome: result.voicemailHold?.outcome, action: result.voicemailHold?.action },
            { outcome: 'undetermined', action: 'spoke_message' },
        );
    });

    it('timeout speaks the message at the bound, and the result says so', async () => {
        const { context, result, said } = await runVoicemail({
            poll: async () => ({ answered_by: null, message_end: false }),
            intervalMs: 250,
            timeoutMs: 1_000,
        });
        assert.ok(said.includes(context.voicemail_script));
        assert.equal(result.voicemailHold?.outcome, 'timeout');
        assert.equal(result.voicemailHold?.action, 'spoke_message');
        assert.ok((result.voicemailHold?.waitedMs ?? 0) >= 1_000);
    });

    it('fax hangs up silent, and the result says so', async () => {
        const { context, result, said } = await runVoicemail({
            poll: async () => ({ answered_by: 'fax', message_end: false }),
            intervalMs: 250,
        });
        assert.ok(!said.includes(context.voicemail_script));
        assert.ok(!result.synthesised.includes(context.voicemail_script));
        assert.equal(result.voicemailHold?.action, 'hung_up_silent');
        assert.equal(result.hungUpWith, 'agent_ended');
    });

    it('the verdict table is exactly the documented one', () => {
        assert.deepEqual({ ...VOICEMAIL_HOLD_ACTION }, {
            message_end: 'spoke_message',
            undetermined: 'spoke_message',
            timeout: 'spoke_message',
            human: 'returned_to_conversation',
            fax: 'hung_up_silent',
            unsupported: 'spoke_message',
            aborted: 'call_ended',
        });
    });

    it('a seam refusal on every poll is not a verdict: it waits out the bound, then speaks', async () => {
        const { context, result, said } = await runVoicemail({
            poll: async () => { throw new SeamRefusal('reservation_not_found', '/reservations/call-answerer'); },
            intervalMs: 250,
            timeoutMs: 1_000,
        });
        assert.equal(result.voicemailHold?.outcome, 'timeout');
        assert.ok((result.voicemailHold?.pollErrors ?? 0) >= 1);
        assert.ok(said.includes(context.voicemail_script));
        assert.equal(result.failed, false);
    });

    it('a backend without the call-answerer route (404) speaks at once, not after the bound', async () => {
        let polls = 0;
        const { context, result, said } = await runVoicemail({
            poll: async () => { polls += 1; throw new AnswererUnsupported('/reservations/call-answerer'); },
            intervalMs: 250,
            timeoutMs: 30_000,
        });
        assert.equal(polls, 1, 'one read, no waiting');
        assert.deepEqual(
            { outcome: result.voicemailHold?.outcome, action: result.voicemailHold?.action },
            { outcome: 'unsupported', action: 'spoke_message' },
        );
        assert.equal(result.voicemailHold?.waitedMs, 0);
        assert.ok(said.includes(context.voicemail_script));
        assert.equal(result.failed, false);
    });

    it('the hold records where the call came from and how many caller turns it heard', async () => {
        const { result } = await runVoicemail({ poll: async () => ({ answered_by: null, message_end: false }), intervalMs: 250, timeoutMs: 1_000 });
        assert.equal(result.voicemailHold?.enteredFrom, 'disclosing');
        assert.equal(typeof result.voicemailHold?.callerTurnsDuringHold, 'number');
    });

    it('a failed human re-report ends the call: the person still never hears the voicemail script', async () => {
        const real = createSeamClient({ baseUrl: mock.baseUrl, token: 'mock:happy' });
        const seam: SeamClient = {
            ...real,
            callEvent: async (input) => {
                if (input.kind === 'answerer_reported' && (input as { answerer?: string }).answerer === 'human') {
                    throw new Error('seam down');
                }
                return real.callEvent(input);
            },
        };
        const { leg, tts, context, result, said } = await runVoicemail({
            poll: async () => ({ answered_by: 'human', message_end: false }),
            intervalMs: 250,
        }, { seam });
        assert.ok(!result.synthesised.includes(context.voicemail_script));
        assert.ok(!said.includes(context.voicemail_script));
        assert.ok(!wroteAudioOf(leg, tts, context.voicemail_script));
        assert.ok(!said.includes(context.opening_script[0]!), 'the call ended before the notice');
    });

    it('a cut-in after a phone menu hangs up silent: neither the script nor an undisclosed notice', async () => {
        // No agent reaches menu -> voicemail -> human today; a hand-written one drives the path.
        const makeAgent = (_seam: SeamClient, context: CallContext): CallAgent => {
            let heard = 0;
            return {
                open: async () => ({ say: [context.disclosure_sentence], toolCalls: [], endCall: false }),
                hear: async (_text, info) => {
                    heard += 1;
                    if (info?.person) return { say: [...context.opening_script], toolCalls: [], endCall: false };
                    if (heard === 1) return { say: [], toolCalls: [{ name: 'report_answerer', args: { answerer: 'phone_menu' } }], endCall: false };
                    return { say: [context.voicemail_script], toolCalls: [{ name: 'report_answerer', args: { answerer: 'voicemail' } }], endCall: true };
                },
            };
        };
        const { leg, tts, context, result, said, log } = await runVoicemail({
            poll: async () => ({ answered_by: 'human', message_end: false }),
            intervalMs: 250,
        }, { makeAgent, callerTurns: ['press one for reservations', VOICEMAIL_GREETING] });
        assert.ok(log.some((l) => l.startsWith('voicemail_hold outcome=human action=hung_up_silent') && l.includes('from=menu')), log.join('\n'));
        assert.equal(result.voicemailHold?.enteredFrom, 'menu');
        assert.ok(!result.synthesised.includes(context.voicemail_script));
        assert.ok(!wroteAudioOf(leg, tts, context.voicemail_script));
        assert.ok(!said.includes(context.opening_script[0]!), 'no notice to a person who came off a menu undisclosed');
        assert.equal(result.hungUpWith, 'agent_ended');
    });

    it('menu -> voicemail on one turn, endCall on a later one: a person verdict still hangs up silent', async () => {
        // The entry state is recorded at the transition into voicemail, not inferred from the turn
        // that ends the call (that turn starts in `voicemail` and knows nothing of the menu).
        const makeAgent = (_seam: SeamClient, context: CallContext): CallAgent => {
            let heard = 0;
            return {
                open: async () => ({ say: [context.disclosure_sentence], toolCalls: [], endCall: false }),
                hear: async (_text, info) => {
                    heard += 1;
                    if (info?.person) return { say: [...context.opening_script], toolCalls: [], endCall: false };
                    if (heard === 1) return { say: [], toolCalls: [{ name: 'report_answerer', args: { answerer: 'phone_menu' } }], endCall: false };
                    if (heard === 2) return { say: [], toolCalls: [{ name: 'report_answerer', args: { answerer: 'voicemail' } }], endCall: false };
                    return { say: [context.voicemail_script], toolCalls: [], endCall: true };
                },
            };
        };
        const { leg, tts, context, result, said, log } = await runVoicemail({
            poll: async () => ({ answered_by: 'human', message_end: false }),
            intervalMs: 250,
        }, { makeAgent, callerTurns: ['press one for reservations', VOICEMAIL_GREETING, 'please leave a message'] });
        assert.ok(log.some((l) => l.startsWith('voicemail_hold outcome=human action=hung_up_silent') && l.includes('from=menu')), log.join('\n'));
        assert.equal(result.voicemailHold?.enteredFrom, 'menu');
        assert.equal(result.voicemailHold?.action, 'hung_up_silent');
        assert.deepEqual(said, [context.disclosure_sentence], 'nothing spoken after the disclosure');
        assert.ok(!result.synthesised.includes(context.voicemail_script));
        assert.ok(!result.synthesised.includes(context.opening_script[0]!));
        assert.ok(!wroteAudioOf(leg, tts, context.voicemail_script));
        assert.equal(result.hungUpWith, 'agent_ended');
    });

    it('end to end through the mock call-answerer route: the voicemail scenario holds, then speaks at the beep', async () => {
        const seam = createSeamClient({ baseUrl: mock.baseUrl, token: 'mock:voicemail:cutin-e2e-beep' });
        const before = mock.journal.length;
        const { context, result, said } = await runVoicemail({ poll: () => seam.callAnswerer!(), intervalMs: 250 }, { seam });
        const reads = mock.journal.slice(before).filter((e) => e.route === '/reservations/call-answerer');
        assert.equal(reads.length, 2, 'null on the first read, machine_end_beep on the second');
        assert.ok(said.includes(context.voicemail_script));
        assert.equal(result.voicemailHold?.outcome, 'message_end');
    });

    it('end to end through the mock call-answerer route: a person detected by the carrier is answered, not left a message', async () => {
        const local = await startMockSeam({ port: 0, amd: [null, 'human'] });
        try {
            const seam = createSeamClient({ baseUrl: local.baseUrl, token: 'mock:voicemail' });
            const { context, result, said } = await runVoicemail({ poll: () => seam.callAnswerer!(), intervalMs: 250 }, { seam });
            assert.ok(!result.synthesised.includes(context.voicemail_script));
            assert.ok(said.includes(context.opening_script[0]!));
            assert.equal(result.voicemailHold?.action, 'returned_to_conversation');
            assert.equal(local.journal.filter((e) => e.route === '/reservations/call-answerer').length, 2);
        } finally {
            await local.close();
        }
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
