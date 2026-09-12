/**
 * THE REPLAY HARNESS. It runs a whole call and dials nobody.
 *
 * One fixture is one conversation: what the floor manager says, turn by turn, and what must be
 * true when it is over. The harness starts a local Seam 4, hands the agent a client for it, feeds
 * it the utterances in order, and writes down everything that happened.
 *
 * 🔴 THE TRANSCRIPT IS BUILT FROM THE MOCK'S JOURNAL, NOT FROM THE AGENT'S SELF-REPORT.
 * The agent says which tools it called; the journal records which requests actually arrived. When
 * those two disagree the journal is right, and the disagreement is the finding. An agent that
 * believes it logged a question and did not is exactly the failure mode that ends with a promise
 * nobody is queued to keep — so the check has to read the thing that happened, not the thing that
 * was intended.
 *
 * The same reasoning fixes where the ALLOWED sentence list comes from: the journal, again. Every
 * `say` the backend actually returned, plus the disclosure, the four beats and the voicemail line
 * from the context response. Nothing the agent supplies is trusted into that set, because the set
 * is the yardstick the agent is being measured against.
 */

import { startMockSeam, type MockSeam } from '../mock/server.ts';
import { createSeamClient, SeamRefusal, SeamUnavailable, type SeamClient } from '../seam/client.ts';
import type { CallAgent, CallTranscript, ToolCall, TranscriptLine } from '../agent/contract.ts';

export interface Fixture {
    name: string;
    /** Which mock scenario backs this call. */
    scenario: string;
    /** What actually answered the phone, for the checks that depend on it. */
    answerer: 'human' | 'phone_menu' | 'voicemail' | 'automated_system' | 'wrong_number';
    /** One line of prose saying what this conversation is testing. Printed in the eval report. */
    about: string;
    /** What the other end says, in order. The agent may end the call before they run out. */
    turns: string[];
    /** Milliseconds of seam latency to simulate. Omit for none. */
    latencyMs?: number;
    /**
     * How this conversation behaves as AUDIO. Read only by `npm run call`; this harness ignores
     * it entirely, which is the point — the same fixture is graded as a transcript and as a
     * telephone call, and neither grading can quietly diverge from the other's script.
     */
    audio?: FixtureAudio;
    expect: FixtureExpectations;
}

export interface FixtureAudio {
    /**
     * Zero-based indices of turns that start WHILE we are still speaking, instead of waiting.
     *
     * 🔴 Without at least one fixture using this, `stopped_when_interrupted` in
     * `src/carrier/checks.ts` is a check that has never been observed failing on a real call —
     * and a guard that has only ever been seen passing is indistinguishable from one that cannot
     * fail. There is a unit test with a planted fault as well; this is the graded one.
     */
    interruptTurns?: number[];
    /** The far end hangs up at this point in call time, mid-anything. */
    hangUpAtMs?: number;
    /** Prose, for a reader. Ignored by everything. */
    about?: string;
}

export interface FixtureExpectations {
    /** Tool calls that MUST appear in the mock's journal, in this order (gaps allowed between). */
    must_call?: Array<{ route: string; body_contains?: Record<string, unknown> }>;
    /** Tool calls that must NOT appear at all. */
    must_not_call?: Array<{ route: string; body_contains?: Record<string, unknown> }>;
    /** Fragments that must appear somewhere in what the agent said. */
    must_say_contains?: string[];
    /** Patterns that must NOT appear in anything the agent said. */
    must_not_say_matching?: string[];
    /** Whether the agent must have hung up by the end. */
    must_end_call?: boolean;
    /** The call must end before a single word is spoken (a refusal case). */
    must_not_speak_at_all?: boolean;
    /** Upper bound on sentences spoken. Brevity is the courtesy; it is also measurable. */
    max_sentences?: number;
    /** Upper bound on unauthorised-but-harmless sentences. Glue climbing means improvising. */
    max_glue?: number;
}

export interface ReplayResult {
    fixture: Fixture;
    transcript: CallTranscript;
    /** Every sentence the backend supplied on this call. The yardstick for the fabrication check. */
    allowedSentences: string[];
    /** The mock's record of what actually arrived, in order. */
    journal: MockSeam['journal'];
    /** Wall-clock milliseconds the agent took, excluding mock start-up. */
    elapsedMs: number;
}

export type AgentFactory = (deps: { seam: SeamClient; fixture: Fixture }) => CallAgent;

export async function replay(fixture: Fixture, makeAgent: AgentFactory): Promise<ReplayResult> {
    const mock = await startMockSeam({
        port: 0,
        ...(fixture.latencyMs ? { latencyMs: fixture.latencyMs } : {}),
    });

    try {
        const seam = createSeamClient({
            baseUrl: mock.baseUrl,
            token: `mock:${fixture.scenario}`,
        });

        const agent = makeAgent({ seam, fixture });
        const lines: TranscriptLine[] = [];
        const toolCalls: ToolCall[] = [];
        const spoken: string[] = [];
        let ended = false;
        let endedBecause: CallTranscript['endedBecause'] = 'transcript_exhausted';
        let refusalReason: string | undefined;

        const startedAt = process.hrtime.bigint();

        const record = (turn: { say: string[]; toolCalls: ToolCall[]; endCall: boolean; note?: string }) => {
            for (const call of turn.toolCalls) {
                toolCalls.push(call);
                lines.push({ who: 'system', text: `tool ${call.name} ${JSON.stringify(call.args)}` });
            }
            for (const sentence of turn.say) {
                spoken.push(sentence);
                lines.push({ who: 'agent', text: sentence });
            }
            if (turn.note) lines.push({ who: 'system', text: `note: ${turn.note}` });
            if (turn.endCall) {
                ended = true;
                endedBecause = 'agent_ended';
            }
        };

        const guard = async (run: () => Promise<{ say: string[]; toolCalls: ToolCall[]; endCall: boolean; note?: string }>) => {
            try {
                record(await run());
                return true;
            } catch (error) {
                if (error instanceof SeamRefusal) {
                    // The correct end. Every refusal means the call cannot proceed, and the agent's
                    // only right move is to stop — which is asserted by the transcript being empty.
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

        if (await guard(() => agent.open())) {
            for (const utterance of fixture.turns) {
                if (ended) break;
                lines.push({ who: 'venue', text: utterance });
                if (!(await guard(() => agent.hear(utterance)))) break;
            }
        }

        const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

        return {
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
        };
    } finally {
        await mock.close();
    }
}

/**
 * Every sentence the backend actually supplied on this call, read off the journal.
 *
 * Deliberately not assembled from the fixture file. A fixture is a thing a person edits, and a
 * yardstick a person can edit to make a failing call pass is not a yardstick.
 */
function allowedFrom(journal: MockSeam['journal']): string[] {
    const allowed: string[] = [];
    for (const entry of journal) {
        if (entry.status !== 200) continue;
        const body = entry.response as Record<string, unknown>;
        if (entry.route === '/reservations/call-context') {
            if (typeof body.disclosure_sentence === 'string') allowed.push(body.disclosure_sentence);
            if (Array.isArray(body.opening_script)) allowed.push(...(body.opening_script as string[]));
            if (typeof body.voicemail_script === 'string') allowed.push(body.voicemail_script);
            // The voicemail is one long paragraph in the contract but is spoken as sentences, so
            // its parts are permitted individually too. Splitting the yardstick, never the check.
            if (typeof body.voicemail_script === 'string') {
                allowed.push(...body.voicemail_script.split(/(?<=[.?!])\s+/).filter(Boolean));
            }
        }
        if (typeof body.say === 'string' && body.say.trim()) allowed.push(body.say);
    }
    return allowed;
}
