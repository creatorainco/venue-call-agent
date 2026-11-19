/**
 * A WHOLE CALL, OVER AUDIO, AGAINST NOBODY.
 *
 * This is `src/harness/replay.ts` with a telephone underneath it. Same fixtures, same mock
 * backend, same agent interface, same `ReplayResult` — so `src/eval/rubric.ts` scores an audio
 * call without knowing one happened. Everything the text harness checks still gets checked; what
 * is added is the layer the text harness is blind to.
 *
 * 🔴 EVERY *TIMING* NUMBER IS READ OFF THE WIRE, NOT OFF EITHER SIDE'S ACCOUNT OF ITSELF.
 * Dead air, talk-over, the opening delay and the frame counts all come from `FakeCallLeg.inbound`
 * and `.outbound`, which record what the leg did rather than what anybody intended — the same
 * reason the replay harness scores off the mock's journal rather than the agent's self-report.
 *
 * ⚠️ TWO FIELDS ARE THE EXCEPTION AND SAYING OTHERWISE WAS WRONG. `cutShortSentences` and
 * `unheardSentences` come from the `SpokenResult` of every `speak()` — the bridge's own record of
 * what it queued and when. There is no way around that: the wire carries frames, and frames do
 * not know which sentence they belong to. It is sound arithmetic over an ordered queue rather than
 * an opinion, but it IS the component reporting on itself, and an earlier version of this header
 * claimed no measurement did that. Read those two as well-founded bookkeeping, not as evidence
 * of the same kind as the timings above.
 *
 * THE BRIDGE IS ASYNCHRONOUS AND THIS LOOP IS NOT. Turns arrive as `callerTurn` events and are
 * held until the loop is ready to answer; `speak()` is queued and its promise is read only once
 * the call is over, because its audio plays only as this loop advances the leg. A bridge `error`
 * is thrown on the next frame, inside the supervisor, so it ends the call as `internal_error`
 * with exactly one hangup.
 *
 * WHAT A NUMBER FROM HERE MEANS, EXACTLY. It contains: the turn detector's `silenceDurationMs`,
 * whatever model latency you asked for, and the time the agent spent in the seam. It does NOT
 * contain a carrier, jitter, packet loss, the real model, or a kitchen. It is a floor and a way
 * to compare two settings against each other — never a prediction of a real call.
 */

import { startMockSeam } from '../mock/server.ts';
import { createSeamClient, SeamRefusal, SeamUnavailable } from '../seam/client.ts';
import type { AgentTurn, CallTranscript, ToolCall, TranscriptLine } from '../agent/contract.ts';
import type { AgentFactory, Fixture, ReplayResult } from '../harness/replay.ts';
import { CARRIER_AUDIO } from '../audio/format.ts';
import { VAD, LATENCY_PERCENTILES, MAX_CALL_SECONDS } from '../tuning/liveDefaults.ts';
import { FakeCallLeg } from './fakeLeg.ts';
import type { TimelineTurn } from './fakeLeg.ts';
import { ScriptedBridge, sentenceDurationMs } from './bridge.ts';
import type { ScriptedBridgeOptions, Sentence, SentenceOutcome, SpokenResult } from './bridge.ts';
import { isSpeechFrame } from './vad.ts';
import type { VadSettings } from './vad.ts';
import { framesToMs, msToFrames } from './leg.ts';
import type { CallLeg, HangupReason } from './leg.ts';
import { OutputGate } from './outputGate.ts';
import { CallSupervisor } from './supervisor.ts';
import type { DisclosureRecord } from './outputGate.ts';
import { canTransition } from '../state.ts';
import { awaitVoicemailBeep, type BeepGateOptions, type BeepGateOutcome } from './beepGate.ts';
import type { CallState } from '../state.ts';
import { CascadeBridge } from './cascadeBridge.ts';
import type { CallerTurn } from './bridge.ts';
import type { CallAgent } from '../agent/contract.ts';
import { FIXED_PHRASES } from '../agent/phrases.ts';
import type { CallContext, Turn } from '../seam/types.ts';
import type { SpeechStreamFactory } from '../speech/stt.ts';
import type { Tts } from '../speech/tts.ts';
import type { CallEndedSink, CapTimer } from './supervisor.ts';

export interface AudioCallOptions {
    /** Turn detection. Defaults to the pinned block in src/tuning/liveDefaults.ts. */
    vad?: VadSettings;
    /**
     * How long the model is assumed to take between a turn ending and its first audio byte.
     *
     * Zero is not a neutral default, it is a claim that the model is instant — so a run at 0
     * measures the detector alone, and a run at a realistic figure measures what a restaurant
     * hears. `docs/TUNING.md` §3.2 has the only two figures anybody has quoted, both secondhand.
     */
    modelLatencyMs?: number;
    /** Override the derived timeline — for a fixture that needs an interrupt or a hang-up. */
    timeline?: readonly TimelineTurn[];
    /** The far end hangs up at this point in call time. */
    hangUpAtMs?: number;
    trailingSilenceMs?: number;
    /**
     * The call cap the supervisor enforces. Defaults to `MAX_CALL_SECONDS`. A test lowers it to
     * reach the cap without six minutes of script; the fake leg's own stop sits past it.
     */
    maxCallMs?: number;
    /** Where the gate and the supervisor write their one-line events. Defaults to stderr. */
    log?: (line: string) => void;
    /**
     * Build the bridge. Defaults to `ScriptedBridge`. A test passes a subclass to plant a fault
     * (a bridge that fails mid-call); the report still reads the scripted bridge's turn counts.
     */
    bridge?: (leg: CallLeg, options: ScriptedBridgeOptions) => ScriptedBridge;
}

/**
 * How far past the cap the fake leg's own hard stop sits. The supervisor owns the cap; this is a
 * backstop for a loop that ignores it, and a call that reaches it was never stopped by us.
 */
const FAKE_LEG_BACKSTOP_MS = 60_000;

export interface AudioReport {
    /** Milliseconds from the far end's last audible sound to our next audible byte, per turn. */
    deadAirMs: number[];
    /** p50 / p90 / p99 of the above, and the max. Never a mean; a mean hides the bad calls. */
    percentiles: Record<string, number>;
    maxDeadAirMs: number;
    /** How long after the call connected before we said anything at all. */
    openingDelayMs: number;
    /**
     * Frames in which BOTH ends were audible, outside the protected disclosure. Every one of them
     * is us talking over somebody when we could have stopped.
     */
    talkOverFrames: number;
    /**
     * Frames in which both ends were audible while the disclosure was playing. Deliberate: the
     * disclosure cannot be interrupted (src/carrier/outputGate.ts), so this is reported and is not
     * a barge-in failure. If they talked over more than half of it, it was played once more.
     */
    disclosureTalkOverFrames: number;
    /** A disclosure was started at all. False on a call refused before it spoke. */
    disclosureStarted: boolean;
    /**
     * The carrier acknowledged the disclosure's last frame. Read off the mark, not the queue: false
     * when the far end hung up before it finished, which is reported, not failed.
     */
    disclosureHeard: boolean;
    /** Times the disclosure was played again because it was talked over. 0 or 1. */
    disclosureReplays: number;
    /**
     * The far end hung up while the disclosure was still queued to play. The one excuse for
     * `disclosureHeard: false`; a hangup after the disclosure had already stopped is not one.
     */
    disclosureCutByHangup: boolean;
    /** Frames the barge-in threw away. Zero on a call nobody interrupted. */
    clearedFrames: number;
    /** Frames written after the far end hung up. Must be zero. */
    writtenAfterHangup: number;
    /**
     * How many times our side hung up. Must be exactly one: zero is a line left open, the bug
     * src/carrier/supervisor.ts exists for; two is a loop that lost track of its own hangup.
     */
    hangupsSent: number;
    framesIn: number;
    framesOut: number;
    audibleOutFrames: number;
    /** How many turns the detector found, against how many the fixture scripted. */
    detectedTurns: number;
    scriptedTurns: number;
    /** Detected turns with no scripted line — one utterance heard as two. */
    overSegmented: number;
    /**
     * Turns the far end really spoke that the detector never reported — one utterance heard as
     * none, or three heard as one.
     *
     * 🔴 THIS IS THE DIRECTION THAT WAS UNMEASURABLE, and it is the one the rig was built for.
     * `overSegmented` is `detected - consumed`, and `consumed` is incremented only where
     * `detected` is, so the difference is provably non-negative: turn COLLAPSE — the exact
     * failure that made the first version of the fake leg useless while looking like it worked —
     * was arithmetically incapable of showing up. This compares against the leg's own record of
     * what it actually played, which the detector never sees.
     */
    missedTurns: number;
    /**
     * Turns the far end finished that we never answered at all.
     *
     * Counted because the alternative was worse than silence: dead air was sampled only where a
     * reply existed, so a call in which the agent never spoke produced an EMPTY sample, and an
     * empty sample maxed to 0 ms — the best possible score. Total silence passed every check.
     */
    unansweredTurns: number;
    /**
     * Sentences the transcript records as spoken that the far end did not hear in full.
     *
     * A transcript records what was SENT. On a call where somebody interrupts, that and what was
     * heard are different things, and only one of them is about the restaurant.
     */
    cutShortSentences: number;
    /** Sentences whose audio never played at all, though the transcript says they were spoken. */
    unheardSentences: number;
    callMs: number;
    endedBecause: HangupReason;
    vad: string;
    modelLatencyMs: number;
}

export interface AudioCallResult {
    /** Identical in shape to a text replay, so `score()` reads it unchanged. */
    replay: ReplayResult;
    audio: AudioReport;
}

/**
 * Where a speaker pauses inside one utterance.
 *
 * Derived from the text rather than hand-authored per fixture, so a new conversation gets a
 * realistic envelope without anybody choosing one — and so the pauses cannot be quietly moved to
 * make a setting look good. A dash, a comma or an ellipsis is where a person stops to think.
 */
const INTERNAL_PAUSE = /\s+[-\u2013\u2014]\s+|,\s+|\.{3}\s*/;

/** One utterance, as runs of sound with thinking pauses between them. */
export function segmentsOf(text: string): number[] {
    const parts = text.split(INTERNAL_PAUSE).map((s) => s.trim()).filter(Boolean);
    return (parts.length ? parts : [text]).map((p) => sentenceDurationMs(p));
}

/** A text fixture as an audio timeline: they speak, they wait for an answer, they speak again. */
export function timelineFrom(fixture: Fixture): TimelineTurn[] {
    const interrupts = new Set(fixture.audio?.interruptTurns ?? []);
    const gapMs = fixture.audio?.gapMs;
    return fixture.turns.map((text, i) => ({
        text,
        segmentsMs: segmentsOf(text),
        ...(interrupts.has(i) ? { startWhen: 'interrupt' as const } : {}),
        ...(interrupts.has(i) && gapMs !== undefined ? { gapMs } : {}),
    }));
}

/**
 * The call state after the agent's turn, read off what the turn DID rather than what it said.
 *
 * The gate needs a state to enforce; the agent owns the conversation. So the move is derived from
 * the turn's tool calls and its shape, never from its words, and a move the machine does not allow
 * is not taken: a voicemail reported after the notice is a misreading, and the call stays where it
 * is rather than pretending a machine answered.
 *
 * `menu -> notice` is legal and not taken here. The scripted stub carries no signal for "a person
 * came off the menu"; the agent's own state replaces this once the voicemail and menu flags in
 * src/agent/scriptedStub.ts move into the machine.
 */
export function nextState(state: CallState, turn: AgentTurn): CallState {
    if (state === 'idle' || state === 'connected' || state === 'ended') return state;
    const answerer = turn.toolCalls.find((c) => c.name === 'report_answerer')?.args.answerer;
    let next = state;
    if (answerer === 'voicemail') {
        if (canTransition(state, 'voicemail')) next = 'voicemail';
    } else if (answerer === 'phone_menu') {
        if (canTransition(state, 'menu')) next = 'menu';
    } else if (answerer === undefined && turn.say.length > 0) {
        if (state === 'disclosing') next = 'notice';
        else if (state === 'notice' || state === 'qa') next = 'qa';
    }
    if (turn.endCall && (next === 'notice' || next === 'qa') && canTransition(state, 'closing')) next = 'closing';
    return next;
}

export async function audioCall(
    fixture: Fixture,
    makeAgent: AgentFactory,
    options: AudioCallOptions = {},
): Promise<AudioCallResult> {
    const vad = options.vad ?? VAD;
    const modelLatencyMs = options.modelLatencyMs ?? 0;
    const maxCallMs = options.maxCallMs ?? MAX_CALL_SECONDS * 1000;

    const mock = await startMockSeam({
        port: 0,
        ...(fixture.latencyMs ? { latencyMs: fixture.latencyMs } : {}),
    });

    try {
        const seam = createSeamClient({ baseUrl: mock.baseUrl, token: `mock:${fixture.scenario}` });
        const agent = makeAgent({ seam, fixture });

        const hangUpAtMs = options.hangUpAtMs ?? fixture.audio?.hangUpAtMs;
        const leg = new FakeCallLeg({
            id: `fake:${fixture.name}`,
            turns: options.timeline ?? timelineFrom(fixture),
            ...(hangUpAtMs === undefined ? {} : { hangUpAtMs }),
            ...(options.trailingSilenceMs === undefined ? {} : { trailingSilenceMs: options.trailingSilenceMs }),
            maxMs: maxCallMs + FAKE_LEG_BACKSTOP_MS,
        });
        // Every outbound frame goes through the gate; the bridge cannot tell it is not the leg.
        const gate = new OutputGate(leg, {
            isSpeech: (frame) => isSpeechFrame(frame, vad),
            ...(options.log ? { log: options.log } : {}),
        });
        // Every way out of the call goes through the supervisor, which hangs up exactly once.
        const supervisor = new CallSupervisor(gate, {
            clock: () => leg.elapsedMs,
            maxCallMs,
            // The polled cap on the virtual clock bounds a fake call; a wall timer would race it.
            capTimer: null,
            ...(options.log ? { log: options.log } : {}),
        });
        gate.connect();
        const bridgeOptions: ScriptedBridgeOptions = { vad, script: fixture.turns };
        const bridge = options.bridge
            ? options.bridge(gate, bridgeOptions)
            : new ScriptedBridge(gate, bridgeOptions);

        /** The first error the bridge reported. Thrown on the next frame, inside the supervisor. */
        let bridgeFailure: Error | null = null;
        bridge.on('error', (error) => { bridgeFailure ??= error; });
        const bridgeFailed = (): boolean => bridgeFailure !== null;
        const throwIfBridgeFailed = (): void => {
            if (bridgeFailure !== null) throw bridgeFailure;
        };

        /** Every `speak()`, read once the call is over and every sentence's fate is known. */
        const speeches: Array<Promise<SpokenResult>> = [];
        let sentenceSeq = 0;
        /** One id per sentence, unique on this call, so an outcome can name the sentence it is about. */
        const withIds = (say: readonly string[]): Sentence[] =>
            say.map((text) => { sentenceSeq += 1; return { id: `s${sentenceSeq}`, text }; });
        const say = (sentences: readonly Sentence[]): void => {
            speeches.push(bridge.speak(sentences).catch((error: unknown) => {
                // The bridge also emits `error` for this; the loop throws on the next frame.
                bridgeFailure ??= error instanceof Error ? error : new Error('speak rejected');
                return { sentences: [], complete: false };
            }));
        };

        const lines: TranscriptLine[] = [];
        gate.onReplay((frames) => {
            bridge.delay(frames);
            // A system line, not an agent line: the agent said the disclosure once, and the gate
            // replayed its audio. `spoken` stays a record of what the agent said.
            lines.push({ who: 'system', text: 'disclosure replayed: the far end talked over more than half of it' });
        });
        const toolCalls: ToolCall[] = [];
        const spoken: string[] = [];
        let ended = false;
        let endedBecause: CallTranscript['endedBecause'] = 'transcript_exhausted';
        let refusalReason: string | undefined;
        let hangupReason: HangupReason = 'timeline_exhausted';
        /** The far end's last audible frame for each turn we answered. Used for dead air. */
        const answeredAfterFrame: number[] = [];

        leg.on('hangup', (reason) => { hangupReason = reason; });

        const record = (turn: AgentTurn) => {
            for (const call of turn.toolCalls) {
                toolCalls.push(call);
                lines.push({ who: 'system', text: `tool ${call.name} ${JSON.stringify(call.args)}` });
            }

            // 🔴 YOU CANNOT ANSWER A DIAL TONE, and this branch is a real bug fix rather than
            // defensive coding. Measured 2026-09-12: sweeping a hang-up across every instant of
            // every fixture found 85 points at which the agent went on generating audio after
            // the leg had closed — up to 1,239 frames, nearly twenty-five seconds, into a dead
            // socket. It was invisible because no fixture had ever hung up, so the
            // `no_audio_after_hangup` check had never been observed acting on a real call loop.
            //
            // The transcript must not claim those sentences either. A record of what the agent
            // WOULD have said, filed as what it said, is the same class of untruth as counting
            // an interrupted sentence as delivered.
            const speakable = turn.say.length > 0 && !leg.ended;
            if (gate.state !== 'connected' && !leg.ended) {
                const next = nextState(gate.state, turn);
                if (next !== gate.state) gate.enter(next);
            }
            const sentences = speakable ? withIds(turn.say) : [];
            if (speakable && gate.state === 'connected') {
                // The first thing this call says is the disclosure (CallAgent.open() must begin
                // with it; the rubric checks the words). It goes out as the protected range, and
                // anything after it in the same turn is held until the carrier says it played.
                // The latency pad is leading silence: the gate plays it but keeps it out of the
                // protected range, so it is neither replayed nor counted as disclosure talk-over.
                gate.beginDisclosure();
                if (modelLatencyMs > 0) bridge.padSilence(modelLatencyMs);
                say(sentences.slice(0, 1));
                gate.endDisclosure();
                if (sentences.length > 1) say(sentences.slice(1));
            } else if (speakable) {
                if (modelLatencyMs > 0) bridge.padSilence(modelLatencyMs);
                say(sentences);
            }
            if (speakable) {
                for (const sentence of turn.say) {
                    spoken.push(sentence);
                    lines.push({ who: 'agent', text: sentence });
                }
            } else if (turn.say.length) {
                lines.push({
                    who: 'system',
                    text: `not spoken — the line was already closed: ${JSON.stringify(turn.say)}`,
                });
            }

            if (turn.note) lines.push({ who: 'system', text: `note: ${turn.note}` });
            if (turn.endCall) {
                ended = true;
                endedBecause = 'agent_ended';
            }
        };

        const guard = async (run: () => Promise<AgentTurn>): Promise<boolean> => {
            try {
                record(await run());
                return true;
            } catch (error) {
                if (error instanceof SeamRefusal) {
                    lines.push({ who: 'system', text: `seam refused: ${error.reason}` });
                    ended = true;
                    endedBecause = 'seam_refusal';
                    refusalReason = error.reason;
                    supervisor.stop('seam_stopped');
                    return false;
                }
                if (error instanceof SeamUnavailable) {
                    lines.push({ who: 'system', text: `seam unavailable: ${error.detail}` });
                    ended = true;
                    endedBecause = 'seam_unavailable';
                    supervisor.stop('seam_stopped');
                    return false;
                }
                // Anything else is ours. The supervisor catches it, logs it redacted and hangs up.
                throw error;
            }
        };

        const startedAt = process.hrtime.bigint();

        // The live part of the call. However it leaves — a goodbye, a refusal, the cap, the far end,
        // or an exception — the supervisor's `finally` hangs up, once.
        await supervisor.run(async () => {
            // The line was answered. Everything after this happens in call time.
            const opened = await guard(() => agent.open());

            if (opened) {
                let pending: { text: string; lastAudibleFrame: number } | null = null;
                // A turn is held until the loop below is ready to answer it, one frame later.
                bridge.on('callerTurn', (turn) => {
                    pending = { text: turn.text, lastAudibleFrame: turn.lastAudibleFrame };
                });
                leg.on('inbound', (frame) => { bridge.sendAudio(frame); });

                while (!leg.ended) {
                    const alive = leg.advance();
                    // A recogniser or synthesiser that died ends the call here, as an internal
                    // error, before anything else on this frame is answered or spoken.
                    throwIfBridgeFailed();
                    // The cap is the supervisor's, not the leg's: a real carrier leg has no clock of
                    // its own. A turn they finished on this frame is not answered past the cap.
                    if (!leg.ended && supervisor.overCap()) {
                        supervisor.stop('call_too_long');
                        break;
                    }
                    // `!leg.ended` again: `advance()` may have closed the line during this very
                    // frame, and a turn detected on the frame before it is a turn there is now
                    // nobody left to answer.
                    if (pending && !leg.ended) {
                        const turn: { text: string; lastAudibleFrame: number } = pending;
                        pending = null;
                        lines.push({ who: 'venue', text: turn.text });
                        answeredAfterFrame.push(turn.lastAudibleFrame);
                        if (!(await guard(() => agent.hear(turn.text)))) break;
                    }
                    if (ended) {
                        // The agent hung up. Let its last sentence finish playing rather than cutting
                        // it off mid-word — a real dialler waits for the queue to drain before it
                        // tears the leg down, and a test that does not would score a truncated call.
                        // The gate's count, not the leg's: audio held behind an unacknowledged
                        // disclosure is still owed to the far end.
                        while (!bridgeFailed() && gate.queuedFrames() > 0 && !supervisor.overCap() && leg.advance()) { /* drain */ }
                        throwIfBridgeFailed();
                        await supervisor.hangup(supervisor.overCap() ? 'call_too_long' : 'agent_ended');
                        break;
                    }
                    if (!alive) break;
                }

                // Close the bridge. Anything the far end was still saying surfaces now as a final
                // `callerTurn` (only while the line is up), and it is counted, never answered:
                // every way out of the loop above is a stop (a goodbye, a refusal, the cap, the far
                // end hanging up). Answering after a stop was the largest of the 85 leaks: it
                // called the agent and spoke the answer into a closed socket.
                await bridge.hangup();
            }
        });

        // Idempotent. On every path but an exception it already ran inside the call. Whatever was
        // still queued never played, so it is charged honestly rather than credited to the agent.
        await bridge.hangup();

        if (supervisor.failed) {
            // The message is not copied in: it may carry what somebody said. The class name is in
            // the supervisor's log line.
            lines.push({ who: 'system', text: 'internal error: the supervisor hung up' });
            ended = true;
            endedBecause = 'internal_error';
        }

        // Every `speak()` has resolved: `hangup()` settles whatever was still owed.
        const sentences = (await Promise.all(speeches)).flatMap((result) => result.sentences);

        const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

        return {
            replay: {
                fixture,
                transcript: {
                    lines,
                    toolCalls,
                    spoken,
                    ended,
                    endedBecause,
                    ...(refusalReason ? { refusalReason } : {}),
                },
                allowedSentences: allowedFrom(mock.journal),
                journal: [...mock.journal],
                elapsedMs,
            },
            audio: measure(leg, bridge, {
                answeredAfterFrame,
                silenceDurationMs: vad.silenceDurationMs,
                scriptedTurns: fixture.turns.length,
                endedBecause: supervisor.failed ? 'internal_error' : hangupReason,
                vad: bridge.vadDescription,
                modelLatencyMs,
                disclosure: gate.disclosure(),
                sentences,
            }),
        };
    } finally {
        await mock.close();
    }
}

/**
 * A LIVE CALL: the fixture-free loop beside `audioCall`, over a real leg (I3P-01).
 *
 * Same shape as `audioCall` and the same guarantees, with nothing scripted in it: the agent is the
 * cascade, the bridge is `CascadeBridge` (recogniser in, synthesis out), and time is the wall
 * clock. Every outbound frame goes through `OutputGate`, so nothing plays before the disclosure
 * and the disclosure cannot be talked over; every way out goes through `CallSupervisor`, so the
 * line is hung up exactly once and one `call_ended` is posted.
 *
 * 🔴 THE FIRST SENTENCE IS THE DISCLOSURE OR NOTHING IS SAID. `CallAgent.open()` must begin with
 * the context's `disclosure_sentence`. A first sentence that is anything else is a bug: the call
 * ends as `internal_error` with zero audio rather than speak to somebody who was not told.
 *
 * 🔴 NOTHING HERE COMPOSES A WORD. Every sentence spoken is a string the agent returned, and the
 * agent returns only backend strings and the four fixed phrases (`src/agent/cascadeAgent.ts`).
 *
 * Synthesis is warmed at call start: the disclosure is awaited (it is the first thing heard), the
 * opening, the voicemail script and the fixed phrases render in the background (I3P-05). The
 * recogniser stream opens at call start too (I3P-08), so neither handshake sits in a turn.
 */
export interface LiveCallOptions {
    /** The answered leg. `TwilioLeg` on the runtime, a fake one in the tests. */
    leg: CallLeg & { readonly elapsedMs: number; readonly ended: boolean };
    agent: CallAgent;
    tts: Pick<Tts, 'synthesize' | 'prerender'>;
    speech: SpeechStreamFactory;
    /** The context the backend returned when it accepted the call. */
    context: CallContext;
    /** Where the one `call_ended` goes: the call's seam client. */
    report?: CallEndedSink;
    log?: (line: string) => void;
    shutdown?: AbortSignal;
    vad?: VadSettings;
    maxCallMs?: number;
    /** The armed cap. Defaults to the supervisor's wall timer; a test may pass null. */
    capTimer?: CapTimer | null;
    /**
     * it-05: the answering-machine verdict, polled while a voicemail message waits for the beep
     * (pb `call-answerer`). Absent: the message is spoken at once, as before.
     */
    answerer?: Pick<BeepGateOptions, 'poll' | 'intervalMs' | 'timeoutMs' | 'sleep' | 'now'>;
}

/**
 * What a voicemail hold (it-05) did, verdict by verdict. One per call at most: a held message is the
 * call's last turn, or the hold is left for the conversation and the agent never takes the line for
 * a machine again.
 *
 *   message_end   the greeting ended: the voicemail script is spoken            -> spoke_message
 *   undetermined  Twilio said `unknown` and will say nothing more: spoken now   -> spoke_message
 *   timeout       no verdict inside the bound: spoken anyway (a late message
 *                 beats none, and the call cap still ends the call)             -> spoke_message
 *   human         a person answered: the script is NOT spoken; the call leaves
 *                 `voicemail` for `notice` and the same words are heard again
 *                 with `person: true`, so the agent answers the person         -> returned_to_conversation
 *   fax           nobody will hear a message: hang up without a word            -> hung_up_silent
 *   unsupported   the backend has no call-answerer route (pb not promoted yet):
 *                 nothing to wait for, spoken now, as with no answerer          -> spoke_message
 *   aborted       the call ended or is draining while it waited                -> call_ended
 */
export type VoicemailHoldAction = 'spoke_message' | 'returned_to_conversation' | 'hung_up_silent' | 'call_ended';

export interface VoicemailHoldRecord {
    outcome: BeepGateOutcome;
    action: VoicemailHoldAction;
    waitedMs: number;
    polls: number;
    pollErrors: number;
    /**
     * Caller turns that finished while the message was held. On timeout or undetermined the message
     * is spoken anyway; a person the agent took for a machine shows up here first, so the soak can
     * count how often that happens (review 2026-11-15; the leftover risk is on TASK-3750).
     */
    callerTurnsDuringHold: number;
    /** The state the call was in before `voicemail`: `disclosing`, or `menu` after a phone menu. */
    enteredFrom: CallState;
}

/** The action each verdict of the beep gate takes. Exported so the table above is tested, not trusted. */
export const VOICEMAIL_HOLD_ACTION: Readonly<Record<BeepGateOutcome, VoicemailHoldAction>> = Object.freeze({
    message_end: 'spoke_message',
    undetermined: 'spoke_message',
    timeout: 'spoke_message',
    human: 'returned_to_conversation',
    fax: 'hung_up_silent',
    unsupported: 'spoke_message',
    aborted: 'call_ended',
});

export interface LiveCallResult {
    /** Every sentence handed to synthesis, in order. */
    synthesised: string[];
    /** The voicemail hold, when one ran (it-05); null when the call never held a message. */
    voicemailHold: VoicemailHoldRecord | null;
    /** What the `call_ended` report carried. */
    turns: Turn[];
    disclosure: DisclosureRecord;
    hungUpWith: HangupReason | null;
    failed: boolean;
}

export async function liveCall(options: LiveCallOptions): Promise<LiveCallResult> {
    const { leg, agent, tts, context } = options;
    const vad = options.vad ?? VAD;
    const log = options.log ?? ((line: string) => { process.stderr.write(`${line}\n`); });
    const gate = new OutputGate(leg, { isSpeech: (frame) => isSpeechFrame(frame, vad), log });
    const turns: Turn[] = [];
    const supervisor = new CallSupervisor(gate, {
        clock: () => leg.elapsedMs,
        log,
        ...(options.maxCallMs === undefined ? {} : { maxCallMs: options.maxCallMs }),
        ...(options.capTimer === undefined ? {} : { capTimer: options.capTimer }),
        ...(options.report ? { report: options.report } : {}),
        ...(options.shutdown ? { shutdown: options.shutdown } : {}),
        record: () => ({ turns, disclosureHeard: gate.disclosure().heard }),
    });
    gate.connect();

    // The stage timings (I3P-03): a sentence id points at the agent turn that first spoke it, and
    // the bridge stamps that turn when its audio came back and when its first frame went out.
    const timedTurns = new Map<string, Turn>();
    const now = (): number => Math.round(leg.elapsedMs);
    const onStage = (id: string, stage: 'tts_first_byte' | 'first_frame_out'): void => {
        const row = timedTurns.get(id);
        if (row === undefined) return;
        if (stage === 'tts_first_byte') row.tts_first_byte_ms ??= now();
        else row.first_frame_out_ms ??= now();
    };
    const bridge = new CascadeBridge(gate, {
        tts,
        speech: options.speech,
        vad,
        onStage,
        log: (line) => log(`live-call ${leg.id} ${line}`),
        onSpeculate: (text) => agent.prefetch?.(text),
    });
    const heard: Array<CallerTurn & { finalAtMs: number }> = [];
    let failure: Error | null = null;
    let voicemailHold: VoicemailHoldRecord | null = null;
    // The state the call was in at the moment it entered `voicemail`, recorded at that transition.
    // A voicemail can be reported on one turn and the call ended on a later one, so the state just
    // before the ending turn is `voicemail` itself and says nothing about where the call came from.
    let voicemailEnteredFrom: CallState | null = null;
    let wake: (() => void) | null = null;
    const poke = (): void => { const w = wake; wake = null; w?.(); };
    bridge.on('callerTurn', (turn) => { heard.push({ ...turn, finalAtMs: now() }); poke(); });
    bridge.on('error', (error) => { failure ??= error; poke(); });
    gate.on('hangup', () => poke());
    gate.on('inbound', (frame) => { bridge.sendAudio(frame); });
    bridge.start();

    // Warm synthesis for everything this call may say. Only the disclosure is waited for.
    const later = [...context.opening_script, context.closing_sentence, context.voicemail_script, ...FIXED_PHRASES]
        .filter((text): text is string => typeof text === 'string' && text.trim() !== '');
    tts.prerender(later).catch((error: unknown) => {
        log(`live-call ${leg.id} prerender_failed ${error instanceof Error ? error.name : typeof error}`);
    });

    const speeches: Array<Promise<SpokenResult>> = [];
    let sentenceSeq = 0;
    const nextId = (): string => { sentenceSeq += 1; return `s${sentenceSeq}`; };
    const keep = (spoken: Promise<SpokenResult>): void => {
        speeches.push(spoken.catch((error: unknown) => {
            failure ??= error instanceof Error ? error : new Error('speak rejected');
            poke();
            return { sentences: [], complete: false };
        }));
    };
    const said = (text: string): Turn => {
        const row: Turn = { speaker: 'agent', text, at_ms: Math.round(leg.elapsedMs) };
        turns.push(row);
        return row;
    };

    const guard = async (run: () => Promise<AgentTurn>): Promise<AgentTurn | null> => {
        try {
            return await run();
        } catch (error) {
            if (error instanceof SeamRefusal || error instanceof SeamUnavailable) {
                log(`live-call ${leg.id} ${error instanceof SeamRefusal ? 'seam_refused' : 'seam_unavailable'}`);
                supervisor.stop('seam_stopped');
                return null;
            }
            throw error;
        }
    };

    await supervisor.run(async (signal) => {
        signal.addEventListener('abort', poke, { once: true });
        const throwIfFailed = (): void => { if (failure !== null) throw failure; };

        const opened = await guard(() => agent.open());
        if (opened === null || leg.ended || signal.aborted) return;
        // A recogniser that died while open() ran ends the call before it says anything.
        throwIfFailed();
        const [first, ...rest] = opened.say;
        if (first !== context.disclosure_sentence) {
            throw new Error('open() did not begin with the disclosure sentence the backend supplied');
        }
        const disclosureId = nextId();
        timedTurns.set(disclosureId, said(first));
        keep(bridge.speakDisclosure({ id: disclosureId, text: first }));
        if (rest.length) {
            keep(bridge.speak(rest.map((text) => ({ id: nextId(), text }))));
            rest.forEach(said);
        }

        while (true) {
            if (failure === null && heard.length === 0 && !leg.ended && !signal.aborted) {
                await new Promise<void>((resolve) => { wake = resolve; });
            }
            throwIfFailed();
            if (leg.ended || signal.aborted) return;
            const caller = heard.shift();
            if (caller === undefined) continue;
            turns.push({
                speaker: 'venue',
                text: caller.text,
                at_ms: Math.round(leg.elapsedMs),
                venue_end_ms: framesToMs(caller.lastAudibleFrame),
                stt_final_ms: caller.finalAtMs,
            });
            // Only the hello after the disclosure is an invited short turn. A question of ours, such
            // as the opening's "any questions?", invites a question, and "hang on, who's paying?"
            // must not end at "hang on" (soak 2026-11-15).
            bridge.expectShortTurn(false);
            let turn = await guard(() => agent.hear(caller.text, caller.early ? { early: true } : undefined));
            if (turn === null) return;
            throwIfFailed();
            if (leg.ended || signal.aborted) return;
            if (gate.state !== 'connected') {
                const next = nextState(gate.state, turn);
                if (next !== gate.state) {
                    if (next === 'voicemail') voicemailEnteredFrom = gate.state;
                    gate.enter(next);
                }
            }
            // it-05 (I3P-11): a voicemail message spoken over the greeting is never heard, because
            // the recording starts at the beep. Hold it until the carrier says the greeting ended,
            // a person answered, or the bound runs out. What each verdict does: VOICEMAIL_HOLD_ACTION.
            if (gate.state === 'voicemail' && turn.endCall && turn.say.length > 0 && options.answerer) {
                // Fail closed: the recorded entry state, never an inferred one. Unknown is recorded as
                // `voicemail`, which is not `disclosing`, so a person verdict hangs up silent.
                const enteredFrom: CallState = voicemailEnteredFrom ?? 'voicemail';
                const queuedBefore = heard.length;
                const hold = await awaitVoicemailBeep({ ...options.answerer, signal });
                const callerTurnsDuringHold = Math.max(0, heard.length - queuedBefore);
                const ended = leg.ended || signal.aborted;
                let action: VoicemailHoldAction = ended ? 'call_ended' : VOICEMAIL_HOLD_ACTION[hold.outcome];
                // A person who came off a phone menu was never told who we are on this leg of the
                // call: the notice may not be their first words. The cut-in edge (voicemail ->
                // notice) is only taken from a call that went straight from the disclosure to the
                // voicemail; from a menu (or from an entry state that was never recorded) the call
                // hangs up without a word. Neither agent reaches this today (a menu report stops a
                // later voicemail report).
                if (action === 'returned_to_conversation' && enteredFrom !== 'disclosing') action = 'hung_up_silent';
                voicemailHold = {
                    outcome: hold.outcome, action, waitedMs: hold.waitedMs, polls: hold.polls,
                    pollErrors: hold.pollErrors, callerTurnsDuringHold, enteredFrom,
                };
                log(`voicemail_hold outcome=${hold.outcome} action=${action} waited_ms=${hold.waitedMs} polls=${hold.polls} poll_errors=${hold.pollErrors} caller_turns=${callerTurnsDuringHold} from=${enteredFrom}`);
                throwIfFailed();
                if (action === 'call_ended') return;
                if (action === 'hung_up_silent') {
                    await supervisor.hangup('agent_ended');
                    return;
                }
                if (action === 'returned_to_conversation') {
                    // 🔴 THE PERSON CUT-IN. A person must never hear the voicemail script. The
                    // held turn is dropped unspoken, the call leaves `voicemail` by the machine's
                    // own edge (voicemail -> notice, src/state.ts), and the same words are heard
                    // again as a person's, so the agent answers them in the conversation.
                    gate.enter('notice');
                    const again = await guard(() => agent.hear(caller.text, { ...(caller.early ? { early: true } : {}), person: true }));
                    if (again === null) return;
                    throwIfFailed();
                    if (leg.ended || signal.aborted) return;
                    // Belt and braces: whatever the agent returns, the message is not said to a person.
                    const kept = again.say.filter((text) => text !== context.voicemail_script);
                    if (kept.length !== again.say.length) log(`live-call ${leg.id} voicemail_script_withheld_from_person`);
                    turn = { ...again, say: kept };
                    const next = nextState(gate.state, turn);
                    if (next !== gate.state) gate.enter(next);
                }
            }
            if (turn.say.length > 0) {
                const sentences = turn.say.map((text) => ({ id: nextId(), text }));
                const rows = turn.say.map(said);
                // The reply's first sentence carries how the reply was decided and when it sounded.
                const lead = rows[0]!;
                if (turn.timing) Object.assign(lead, turn.timing);
                timedTurns.set(sentences[0]!.id, lead);
                keep(bridge.speak(sentences));
            }
            if (turn.endCall) {
                // Let the last sentence play out before hanging up; the cap and a drain still win.
                const aborted = new Promise<void>((resolve) => {
                    if (signal.aborted) resolve();
                    else signal.addEventListener('abort', () => resolve(), { once: true });
                });
                await Promise.race([Promise.all(speeches), aborted]);
                throwIfFailed();
                if (!signal.aborted) await supervisor.hangup('agent_ended');
                return;
            }
        }
    });
    await bridge.hangup();

    return {
        synthesised: [...bridge.synthesised],
        voicemailHold,
        turns,
        disclosure: gate.disclosure(),
        hungUpWith: supervisor.hungUpWith,
        failed: supervisor.failed,
    };
}

export function measure(
    leg: FakeCallLeg,
    bridge: ScriptedBridge,
    ctx: {
        answeredAfterFrame: number[];
        /** Needed to know which turns the detector even had time to report. */
        silenceDurationMs: number;
        scriptedTurns: number;
        endedBecause: HangupReason;
        vad: string;
        modelLatencyMs: number;
        /** The gate's record. Absent for a rig with no gate, which then reports no disclosure. */
        disclosure?: DisclosureRecord;
        /**
         * What became of every sentence, from the `SpokenResult` of each `speak()`. Absent for a
         * rig that drives a bridge by hand and never awaits it; the scripted bridge's own record
         * is read instead, and it is the same arithmetic.
         */
        sentences?: ReadonlyArray<Pick<SentenceOutcome, 'heardMs' | 'fullMs'>>;
    },
): AudioReport {
    const disclosure = ctx.disclosure ?? NO_DISCLOSURE;
    const audibleOut = leg.outbound.filter((f) => f.audible);
    const firstAudibleAfter = (frame: number): number | null => {
        for (const f of audibleOut) if (f.at > frame) return f.at;
        return null;
    };

    const deadAirMs: number[] = [];
    let unanswered = 0;
    for (const frame of ctx.answeredAfterFrame) {
        const next = firstAudibleAfter(frame);
        if (next !== null) {
            deadAirMs.push(framesToMs(next - frame));
            continue;
        }
        // We never spoke again. The restaurant did not wait zero milliseconds; it waited until
        // the call ended, and then it was still waiting. Charge the whole remainder.
        unanswered += 1;
        deadAirMs.push(framesToMs(Math.max(0, leg.outbound.length - frame)));
    }

    const silenceFrames = msToFrames(ctx.silenceDurationMs);
    const detectable = leg.truth.filter((turn) => leg.outbound.length - turn.endFrame >= silenceFrames);
    const heard = ctx.sentences ?? bridge.heard();
    const inboundAudible = new Set(leg.inbound.filter((f) => f.audible).map((f) => f.at));
    let talkOver = 0;
    let disclosureTalkOver = 0;
    for (const f of audibleOut) {
        if (!inboundAudible.has(f.at)) continue;
        if (disclosure.protectedFrames.has(f.at)) disclosureTalkOver += 1;
        else talkOver += 1;
    }

    return {
        deadAirMs,
        percentiles: percentiles(deadAirMs),
        maxDeadAirMs: deadAirMs.length ? Math.max(...deadAirMs) : 0,
        openingDelayMs: audibleOut.length ? framesToMs(audibleOut[0]!.at) : 0,
        talkOverFrames: talkOver,
        disclosureTalkOverFrames: disclosureTalkOver,
        disclosureStarted: disclosure.started,
        disclosureHeard: disclosure.heard,
        disclosureReplays: disclosure.replays,
        disclosureCutByHangup: disclosure.cutByHangup,
        clearedFrames: leg.cleared + disclosure.heldCleared,
        // The gate drops a write after the end before the leg can count it. The write is still
        // the bug — a loop that kept generating audio — so both counts are charged.
        writtenAfterHangup: leg.writtenAfterHangup + disclosure.droppedAfterEnd,
        hangupsSent: leg.hangupsSent.length,
        framesIn: leg.inbound.length,
        framesOut: leg.outbound.length,
        audibleOutFrames: audibleOut.length,
        detectedTurns: bridge.detectedTurns,
        scriptedTurns: ctx.scriptedTurns,
        overSegmented: bridge.overSegmented,
        // Against the leg's own truth, not against the fixture: a call the agent ended early
        // legitimately has fewer turns SPOKEN, and comparing with the script would punish it.
        //
        // And only against turns the detector had TIME to report. A turn that finishes inside
        // the last `silenceDurationMs` of the call was never detectable — the line closed while
        // the detector was still counting silence — and charging that to the agent made a
        // hang-up look like deafness. Measured: `they-hang-up` at 8000 ms reported a lost turn
        // for a question nobody could have heard the end of.
        missedTurns: Math.max(0, detectable.length - bridge.detectedTurns),
        unansweredTurns: unanswered,
        cutShortSentences: heard.filter((h) => h.heardMs < h.fullMs).length,
        unheardSentences: heard.filter((h) => h.heardMs === 0).length,
        callMs: leg.elapsedMs,
        endedBecause: ctx.endedBecause,
        vad: ctx.vad,
        modelLatencyMs: ctx.modelLatencyMs,
    };
}

const NO_DISCLOSURE: DisclosureRecord = Object.freeze({
    started: false,
    heard: false,
    replays: 0,
    cutByHangup: false,
    protectedFrames: new Set<number>(),
    droppedAfterEnd: 0,
    heldCleared: 0,
});

/** p50 / p90 / p99, nearest-rank. Deliberately no mean — see docs/TUNING.md §3.1. */
export function percentiles(values: readonly number[]): Record<string, number> {
    const out: Record<string, number> = {};
    if (!values.length) return out;
    const sorted = [...values].sort((a, b) => a - b);
    for (const p of LATENCY_PERCENTILES) {
        const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
        out[`p${p}`] = sorted[rank - 1]!;
    }
    return out;
}

/** Frames of audio per second of call time. One place, so nothing re-derives 50. */
export const FRAMES_PER_SECOND = 1000 / CARRIER_AUDIO.frameMs;

/**
 * Every sentence the backend actually supplied on this call, read off the journal.
 *
 * Copied in shape from `src/harness/replay.ts` on purpose rather than imported: that function is
 * private there, and the yardstick for a call must be derived from that call's own journal. If
 * the two ever disagree, `test/carrier.test.ts` fails — there is a test that asserts an audio
 * call and a text replay of the same fixture agree on the allowed set.
 */
function allowedFrom(journal: Awaited<ReturnType<typeof startMockSeam>>['journal']): string[] {
    const allowed: string[] = [];
    for (const entry of journal) {
        if (entry.status !== 200) continue;
        const body = entry.response as Record<string, unknown>;
        if (entry.route === '/reservations/call-context') {
            if (typeof body.disclosure_sentence === 'string') allowed.push(body.disclosure_sentence);
            if (Array.isArray(body.opening_script)) allowed.push(...(body.opening_script as string[]));
            if (typeof body.closing_sentence === 'string') allowed.push(body.closing_sentence);
            if (typeof body.voicemail_script === 'string') {
                allowed.push(body.voicemail_script);
                allowed.push(...body.voicemail_script.split(/(?<=[.?!])\s+/).filter(Boolean));
            }
        }
        if (typeof body.say === 'string' && body.say.trim()) allowed.push(body.say);
    }
    return allowed;
}
