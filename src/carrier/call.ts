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
 * `unheardSentences` come from `ScriptedBridge.spoken` — the bridge's own record of what it
 * queued and when. There is no way around that: the wire carries frames, and frames do not know
 * which sentence they belong to. It is sound arithmetic over an ordered queue rather than an
 * opinion, but it IS the component reporting on itself, and an earlier version of this header
 * claimed no measurement did that. Read those two as well-founded bookkeeping, not as evidence
 * of the same kind as the timings above.
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
import type { VadSettings } from './vad.ts';
import { framesToMs, msToFrames } from './leg.ts';
import type { HangupReason } from './leg.ts';

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
}

export interface AudioReport {
    /** Milliseconds from the far end's last audible sound to our next audible byte, per turn. */
    deadAirMs: number[];
    /** p50 / p90 / p99 of the above, and the max. Never a mean; a mean hides the bad calls. */
    percentiles: Record<string, number>;
    maxDeadAirMs: number;
    /** How long after the call connected before we said anything at all. */
    openingDelayMs: number;
    /** Frames in which BOTH ends were audible. Every one of them is us talking over somebody. */
    talkOverFrames: number;
    /** Frames the barge-in threw away. Zero on a call nobody interrupted. */
    clearedFrames: number;
    /** Frames written after the far end hung up. Must be zero. */
    writtenAfterHangup: number;
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
    return fixture.turns.map((text, i) => ({
        text,
        segmentsMs: segmentsOf(text),
        ...(interrupts.has(i) ? { startWhen: 'interrupt' as const } : {}),
    }));
}

export async function audioCall(
    fixture: Fixture,
    makeAgent: AgentFactory,
    options: AudioCallOptions = {},
): Promise<AudioCallResult> {
    const vad = options.vad ?? VAD;
    const modelLatencyMs = options.modelLatencyMs ?? 0;

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
            maxMs: MAX_CALL_SECONDS * 1000,
        });
        const bridge = new ScriptedBridge(leg, { vad, script: fixture.turns });

        const lines: TranscriptLine[] = [];
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
            if (speakable) {
                if (modelLatencyMs > 0) bridge.padSilence(modelLatencyMs);
                bridge.speak(turn.say);
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
                    return false;
                }
                if (error instanceof SeamUnavailable) {
                    lines.push({ who: 'system', text: `seam unavailable: ${error.detail}` });
                    ended = true;
                    endedBecause = 'seam_unavailable';
                    return false;
                }
                throw error;
            }
        };

        const startedAt = process.hrtime.bigint();

        // The line was answered. Everything after this happens in call time.
        const opened = await guard(() => agent.open());

        if (opened) {
            let pending: { text: string; lastAudibleFrame: number } | null = null;
            leg.on('inbound', (frame) => {
                const turn = bridge.push(frame);
                if (turn) pending = { text: turn.text, lastAudibleFrame: turn.lastAudibleFrame };
            });

            while (!leg.ended) {
                const alive = leg.advance();
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
                    while (leg.queuedFrames() > 0 && leg.advance()) { /* drain */ }
                    await leg.hangup('agent_ended');
                    break;
                }
                if (!alive) break;
            }

            // Anything the far end was still saying when the leg stopped — but only if the
            // line is still up. If they hung up mid-sentence there is no one to reply to, and
            // this was the largest of the 85 leaks: it called the agent and spoke the answer
            // into a closed socket.
            const last = leg.ended ? null : bridge.flush();
            if (last && !ended) {
                lines.push({ who: 'venue', text: last.text });
                answeredAfterFrame.push(last.lastAudibleFrame);
                await guard(() => agent.hear(last.text));
            }
        }

        // The call is over. Whatever was still queued never played, so charge it honestly rather
        // than crediting the agent with sentences the leg died holding.
        //
        // `outbound.length` and not `elapsedFrames`: they are equal today, and only one of them
        // is a count of frames that actually went out. The other is a clock, and a clock stays
        // right by accident. Subtracting `queuedFrames()` here would be worse than redundant —
        // hanging up empties the queue, so it is always zero by the time this runs.
        bridge.settle(leg.outbound.length);

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
                endedBecause: hangupReason,
                vad: bridge.vadDescription,
                modelLatencyMs,
            }),
        };
    } finally {
        await mock.close();
    }
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
    },
): AudioReport {
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
    const heard = bridge.heard();
    const inboundAudible = new Set(leg.inbound.filter((f) => f.audible).map((f) => f.at));
    let talkOver = 0;
    for (const f of audibleOut) if (inboundAudible.has(f.at)) talkOver += 1;

    return {
        deadAirMs,
        percentiles: percentiles(deadAirMs),
        maxDeadAirMs: deadAirMs.length ? Math.max(...deadAirMs) : 0,
        openingDelayMs: audibleOut.length ? framesToMs(audibleOut[0]!.at) : 0,
        talkOverFrames: talkOver,
        clearedFrames: leg.cleared,
        writtenAfterHangup: leg.writtenAfterHangup,
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
            if (typeof body.voicemail_script === 'string') {
                allowed.push(body.voicemail_script);
                allowed.push(...body.voicemail_script.split(/(?<=[.?!])\s+/).filter(Boolean));
            }
        }
        if (typeof body.say === 'string' && body.say.trim()) allowed.push(body.say);
    }
    return allowed;
}
