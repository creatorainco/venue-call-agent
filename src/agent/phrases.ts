/**
 * The four sentences an agent may say that do not come from the backend.
 *
 * None of them states a fact about a booking, a venue, an offer or a policy: they ask for a person,
 * apologise to a stranger, or close. Everything else a restaurant hears is a finished string from
 * the seam. Shared by the scripted stub and the cascade so the fabrication rubric's known-sentence
 * set has one source, and so a fifth sentence has to be added here, in review, on purpose.
 *
 * Moving these to the backend too is open work: `docs/LIMITS.md` names it.
 */

export const ASK_FOR_STAFF = 'Could you connect me with a member of staff?';
export const SORRY_WRONG_NUMBER = 'Sorry to have bothered you.';
export const CLOSE_AFTER_ANSWERS = "That's everything — the details are in the email. Thanks for your time.";
export const CLOSE_THANKS = 'Thanks for your time.';

/**
 * The close for this call. Script v7 (backend it-10) sends `closing_sentence`, which names who
 * called and the number to reach us (47 CFR 64.1200(b)); it replaces both fixed closes. A context
 * from an older backend has none, and the fixed phrase is said as before.
 */
export function closeFor(context: { closing_sentence?: string }, fallback: string): string {
    const backend = context.closing_sentence;
    return typeof backend === 'string' && backend.trim() !== '' ? backend : fallback;
}

/** All four, for pre-rendering: synthesised once per process, never composed. */
export const FIXED_PHRASES: readonly string[] = [ASK_FOR_STAFF, SORRY_WRONG_NUMBER, CLOSE_AFTER_ANSWERS, CLOSE_THANKS];
