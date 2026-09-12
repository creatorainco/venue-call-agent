/**
 * THE SEAM BETWEEN THE HARNESS AND THE BRAIN.
 *
 * Everything on this side of the interface is built: a mock backend, a replay harness, an eval
 * rubric, a fabrication check, and a reference implementation that proves all of it runs. The
 * brain — the thing that actually holds a Gemini Live session open and turns audio into turns —
 * is TASK-970 and is deliberately not here.
 *
 * 🔴 WHY THE INTERFACE HAS NO AUDIO IN IT. A turn is text in, text and tool calls out. That is not
 * a simplification for testing; it is the only shape in which the important properties are
 * checkable at all. "Did it speak before the disclosure", "did it quote the sentence the backend
 * returned", "did it log the question before promising a follow-up" are claims about a transcript.
 * Audio is a transport underneath this, and a real implementation carries one — but nothing that
 * can go wrong in front of a restaurant is decided in the audio layer.
 *
 * So: implement `CallAgent` with a model behind it, and every test, fixture and score in this
 * repository applies to it unchanged.
 */

import type { AnswererKind, CallbackReason, FactTopic } from '../seam/types.ts';

export type ToolName =
    | 'lookup_booking_fact'
    | 'log_unanswered_question'
    | 'request_human_callback'
    | 'report_answerer';

export const TOOL_NAMES: readonly ToolName[] = [
    'lookup_booking_fact',
    'log_unanswered_question',
    'request_human_callback',
    'report_answerer',
];

export interface ToolCall {
    name: ToolName;
    args: {
        topic?: FactTopic;
        question_verbatim?: string;
        reason?: CallbackReason;
        answerer?: AnswererKind;
    };
}

/**
 * One turn of agent behaviour.
 *
 * `toolCalls` are ordered BEFORE `say` on purpose, and the harness asserts it: a deferral spoken
 * before the row exists is a promise nobody is queued to keep, which is the specific thing
 * `operationsKb.ts` bans by name.
 */
export interface AgentTurn {
    /** Sentences spoken this turn, in order. Empty is legal — silence is a valid move. */
    say: string[];
    /** Tools called this turn, in order, all of them before the first word is spoken. */
    toolCalls: ToolCall[];
    /** True when the agent hangs up after speaking. */
    endCall: boolean;
    /** Free-text, for the transcript only. Never spoken. */
    note?: string;
}

export interface CallAgent {
    /**
     * The line was answered. The returned turn MUST begin with the disclosure sentence.
     *
     * There is no argument for "answered by what" — the agent finds that out by listening, the
     * same way a person would, and reports it with `report_answerer` once it knows.
     */
    open(): Promise<AgentTurn>;

    /** Something was said to us. Verbatim, not summarised. */
    hear(utterance: string): Promise<AgentTurn>;
}

/** What a transcript looks like once a call is over. Assert on this, never on audio. */
export interface TranscriptLine {
    who: 'agent' | 'venue' | 'system';
    text: string;
}

export interface CallTranscript {
    lines: TranscriptLine[];
    toolCalls: ToolCall[];
    /** Every sentence the agent spoke, flattened, in order. */
    spoken: string[];
    ended: boolean;
    /** Why the call stopped: the agent hung up, the fixture ran out, or a refusal ended it. */
    endedBecause: 'agent_ended' | 'transcript_exhausted' | 'seam_refusal' | 'seam_unavailable';
    /** Set when the seam ended it. */
    refusalReason?: string;
}
