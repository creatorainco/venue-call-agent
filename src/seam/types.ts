/**
 * The Seam 4 contract, in TypeScript.
 *
 * These types mirror `platform-backend`'s `venueCall.service.ts` at the commit recorded in
 * `contract/seam4.json`. They are a COPY of somebody else's shapes, which means they can go stale
 * silently — the other repository deploys on its own cadence and nothing here can see it. That is
 * what `contract/seam4.json` and `test/contract.test.ts` are for: the shapes are written down once
 * in a machine-readable form, and a test fails if this file and that file stop agreeing.
 *
 * 🔴 THE ONE PROPERTY THAT MAKES THIS FEATURE SAFE lives in these types and is easy to miss:
 * every field the restaurant will HEAR is a `string` that arrived from the backend, finished.
 * There is no field here holding a number, a price or a name that this service is expected to put
 * into a sentence itself. If you ever find yourself adding one, the fix is an endpoint over there,
 * not a template over here.
 */

/** Every refusal the three operations can produce. HTTP 409, reason as a bare word. */
export type SeamRefusalReason =
    | 'seam_disabled'
    | 'token_invalid'
    | 'token_expired'
    | 'token_scope_mismatch'
    | 'reservation_not_found'
    | 'reservation_not_active'
    | 'campaign_not_active'
    | 'venue_stopped'
    | 'outside_opening_hours'
    | 'disclosure_unavailable'
    | 'script_unavailable'
    | 'unknown_topic';

export const SEAM_REFUSAL_REASONS: readonly SeamRefusalReason[] = [
    'seam_disabled',
    'token_invalid',
    'token_expired',
    'token_scope_mismatch',
    'reservation_not_found',
    'reservation_not_active',
    'campaign_not_active',
    'venue_stopped',
    'outside_opening_hours',
    'disclosure_unavailable',
    'script_unavailable',
    'unknown_topic',
];

/**
 * The closed set of things the model may ask about.
 *
 * Closed, not open, and that is the whole design. An open topic parameter is an invitation for the
 * model to ask for a fact we do not have and then fill the gap itself — which is the failure this
 * seam exists to prevent, arriving through the front door.
 */
export type FactTopic =
    | 'party_size'
    | 'arrival_time'
    | 'creator_name'
    | 'comp_terms'
    | 'contact_email'
    | 'what_the_creator_will_do'
    | 'who_we_are'
    | 'still_active';

export const FACT_TOPICS: readonly FactTopic[] = [
    'party_size',
    'arrival_time',
    'creator_name',
    'comp_terms',
    'contact_email',
    'what_the_creator_will_do',
    'who_we_are',
    'still_active',
];

export type EventKind = 'unanswered_question' | 'human_callback' | 'answerer_reported' | 'call_ended';

export const EVENT_KINDS: readonly EventKind[] = [
    'unanswered_question',
    'human_callback',
    'answerer_reported',
    'call_ended',
];

/** `call_ended` only: how the call ended, as the runtime saw it. The backend's `end_reason`. */
export type EndReason =
    | 'completed'
    | 'venue_hung_up'
    | 'max_duration'
    | 'silence_timeout'
    | 'refused'
    | 'stream_error'
    | 'shutdown';

export const END_REASONS: readonly EndReason[] = [
    'completed',
    'venue_hung_up',
    'max_duration',
    'silence_timeout',
    'refused',
    'stream_error',
    'shutdown',
];

/** The backend's caps on one `call_ended` report (Joi, swagger): beyond either, the POST is a 400. */
export const MAX_TURNS = 200;
export const MAX_TURN_CHARS = 2000;

export interface Turn extends TurnStageTimings {
    speaker: 'agent' | 'venue';
    text: string;
    /** Milliseconds from the start of the call, when known. */
    at_ms?: number | null;
}

/** Which stage decided an intent: a keyword cue, the model, or the fallback when both failed. */
export type IntentSource = 'keyword' | 'model' | 'fallback';

/**
 * Optional per-turn stage timings (I3P-03, I3P-13), so dead air can be split by stage.
 *
 * Two kinds of number, named by the plan and kept apart here:
 *   - POINTS on the call clock (ms from the start of the call, like `at_ms`): `venue_end_ms` (the
 *     last audible frame of the venue's turn), `stt_final_ms` (the recogniser's final arrived),
 *     `tts_first_byte_ms` (synthesis returned audio for the sentence) and `first_frame_out_ms` (its
 *     first frame was written to the line).
 *   - DURATIONS: `intent_ms` (the classifier, keyword or model) and `seam_ms` (the backend calls
 *     the turn needed after the intent was known), with `intent_source` saying who decided.
 *
 * A venue turn carries `venue_end_ms` and `stt_final_ms`; the FIRST agent sentence of a reply
 * carries the rest. Every field is optional: a turn the runtime could not time carries none.
 *
 * 🔴 NOT ON THE WIRE YET. The backend's Joi schema for `turns` takes `speaker`, `text` and `at_ms`
 * and refuses any other key, so a report carrying these would be a 400 and the transcript would be
 * lost. `TURN_WIRE_FIELDS` is what the supervisor posts; the timings go to a `turn_timing` log line
 * (numbers and the source word, never text) until the backend lists them. `contract/seam4.json`
 * `call_ended.turns.stage_fields` and the `turn-stage-timings` divergence say the same.
 */
export interface TurnStageTimings {
    venue_end_ms?: number;
    stt_final_ms?: number;
    intent_ms?: number;
    intent_source?: IntentSource;
    seam_ms?: number;
    tts_first_byte_ms?: number;
    first_frame_out_ms?: number;
}

/** The turn fields the backend accepts today, in contract order. */
export const TURN_WIRE_FIELDS = ['speaker', 'text', 'at_ms'] as const;

/** The optional stage timings, in contract order. Agent-side only until the backend accepts them. */
export const TURN_STAGE_FIELDS = [
    'venue_end_ms',
    'stt_final_ms',
    'intent_ms',
    'intent_source',
    'seam_ms',
    'tts_first_byte_ms',
    'first_frame_out_ms',
] as const;

export const INTENT_SOURCES: readonly IntentSource[] = ['keyword', 'model', 'fallback'];

/** The turn as the backend accepts it: the wire fields only, in contract order. */
export function wireTurn(turn: Turn): Turn {
    const out: Turn = { speaker: turn.speaker, text: turn.text };
    if (turn.at_ms !== undefined) out.at_ms = turn.at_ms;
    return out;
}

/** The stage timings a turn carries, or null when it carries none. */
export function stageTimings(turn: Turn): TurnStageTimings | null {
    const out: Record<string, number | string> = {};
    for (const field of TURN_STAGE_FIELDS) {
        const value = turn[field];
        if (value !== undefined) out[field] = value;
    }
    return Object.keys(out).length ? out as TurnStageTimings : null;
}

export type CallbackReason =
    | 'wants_to_cancel'
    | 'wants_to_change_time'
    | 'disputes_the_comp'
    | 'asked_to_stop_calling'
    | 'not_our_booking'
    | 'other';

export const CALLBACK_REASONS: readonly CallbackReason[] = [
    'wants_to_cancel',
    'wants_to_change_time',
    'disputes_the_comp',
    'asked_to_stop_calling',
    'not_our_booking',
    'other',
];

export type AnswererKind = 'human' | 'automated_system' | 'phone_menu' | 'voicemail' | 'wrong_number';

export const ANSWERER_KINDS: readonly AnswererKind[] = [
    'human',
    'automated_system',
    'phone_menu',
    'voicemail',
    'wrong_number',
];

/**
 * `POST /reservations/call-context`, read once before the first word.
 *
 * `opening_script` is four beats and `disclosure_sentence` is spoken before all of them. Neither
 * is a template. Speak them; do not tidy them, reorder them, or merge them.
 */
export interface CallContext {
    reservation_id: string;
    attempt_id: string;
    still_active: boolean;
    venue: { name: string | null; city_state: string | null };
    brand: { name: string | null };
    creator: { spoken_name: string };
    when: { spoken_time: string; local_date: string | null };
    disclosure_sentence: string;
    opening_script: string[];
    /**
     * Script v7 (backend it-10): the last sentence of a live call. It names the business and the
     * number of the line that called (47 CFR 64.1200(b)). Absent from an older backend; the agent
     * then closes with its fixed phrases, as before.
     */
    closing_sentence?: string;
    voicemail_script: string;
    system_instruction: string;
    answerable_topics: string[];
    script_version: string;
}

/**
 * `POST /reservations/call-fact`.
 *
 * 🔴 `say` IS ALWAYS A FINISHED SENTENCE, INCLUDING WHEN `known` IS FALSE. There is no branch that
 * returns an empty string, and that is deliberate: an empty string handed to a model is where it
 * improvises. `known: false` does not mean "say nothing" — it means "say this honest deferral".
 */
export interface FactAnswer {
    known: boolean;
    say: string;
    reason?: 'not_recorded' | 'not_agreed' | 'no_contact';
    topic: FactTopic;
}

export interface CallEventInput {
    kind: EventKind;
    /** VERBATIM. A summarised question is a question nobody can answer later. */
    question_verbatim?: string | null;
    reason?: CallbackReason | null;
    answerer?: AnswererKind | null;
    /**
     * `call_ended` only (required there): the report counter. The same or an older `seq` is a no-op
     * on the backend, so a retry reuses its `seq` and a later, fuller report carries a higher one.
     */
    seq?: number;
    /** `call_ended` only (required there). */
    end_reason?: EndReason;
    /** `call_ended` only (required there): whether the venue heard the full AI disclosure. */
    disclosure_heard?: boolean;
    /** `call_ended` only (required there). Staff-only on the backend; never logged on either side. */
    turns?: Turn[];
}

export interface CallEventResult {
    recorded: true;
    /**
     * The sentence the agent may now say.
     *
     * 🔴 THE AGENT MAY NOT SPEAK A DEFERRAL BEFORE THIS RETURNS. The promise "someone will follow
     * up" is only true once the row exists, because the row IS the queue. Empty string for
     * `answerer_reported` and `call_ended` — nothing is said to the venue on either.
     */
    say: string;
    /** True when this call suppressed further attempts, synchronously, mid-call. */
    do_not_call: boolean;
    /** `call_ended` only: true when this `seq` was already on record, so nothing was written. */
    replay?: boolean;
    /** `call_ended` only: the transcript row the ledger now points at. */
    transcript_id?: string | null;
}
