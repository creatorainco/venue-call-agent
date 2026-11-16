/**
 * THE SEAM BETWEEN THE HARNESS AND THE BRAIN.
 *
 * Everything on this side of the interface is built: a mock backend, a replay harness, an eval
 * rubric, a fabrication check, and a reference implementation that proves all of it runs. The
 * brain — the thing that actually holds a Gemini Live session open and turns audio into turns —
 * is the Gemini Live adapter task and is deliberately not here.
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

import type { IntentSource } from '../seam/types.ts';
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
    /**
     * How long deciding this turn took, when the agent measured it (I3P-03, I3P-13): the intent
     * classifier, which stage decided, and the backend calls after it. Numbers only, never text.
     */
    timing?: { intent_ms: number; intent_source: IntentSource; seam_ms: number };
}

/** How a turn was heard, when the bridge knows more than the words. */
export interface HeardInfo {
    /**
     * Ended on a still interim, before the recogniser's final (PERF-A): possibly the head of a
     * longer sentence. The call must not end on a model's reading of it.
     */
    early?: boolean;
    /**
     * it-05, the person cut-in: the carrier's answering-machine detection says a PERSON answered,
     * after this agent took them for a voicemail. The same words are heard again with this set.
     * From here the agent treats the line as a person: it never takes it for a machine again,
     * reports `report_answerer: human` once, and answers them in the conversation. It must never
     * return the voicemail script on this call again; the call loop also strips it if one does.
     */
    person?: boolean;
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
    hear(utterance: string, heard?: HeardInfo): Promise<AgentTurn>;

    /**
     * Optional. What will probably be heard next, before it is final: an agent may start working
     * it out early (the cascade starts its intent model). Never answered, never spoken from.
     */
    prefetch?(utterance: string): void;
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
    /**
     * Why the call stopped: the agent hung up, the fixture ran out, a refusal ended it, or our own
     * code threw (`internal_error`: only an audio call has a supervisor to catch it).
     */
    endedBecause: 'agent_ended' | 'transcript_exhausted' | 'seam_refusal' | 'seam_unavailable' | 'internal_error';
    /** Set when the seam ended it. */
    refusalReason?: string;
}
