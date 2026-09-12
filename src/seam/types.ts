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

export type EventKind = 'unanswered_question' | 'human_callback' | 'answerer_reported';

export const EVENT_KINDS: readonly EventKind[] = [
    'unanswered_question',
    'human_callback',
    'answerer_reported',
];

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
}

export interface CallEventResult {
    recorded: true;
    /**
     * The sentence the agent may now say.
     *
     * 🔴 THE AGENT MAY NOT SPEAK A DEFERRAL BEFORE THIS RETURNS. The promise "someone will follow
     * up" is only true once the row exists, because the row IS the queue. Empty string for
     * `answerer_reported` — nothing is said to the venue on that one.
     */
    say: string;
    /** True when this call suppressed further attempts, synchronously, mid-call. */
    do_not_call: boolean;
}
