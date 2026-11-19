/**
 * The backend's first sentence, mirrored ONLY as a synthesis cache key for the warm-up. Never spoken
 * from here.
 *
 * Every call opens with the backend's disclosure (`context.disclosure_sentence`, platform-backend
 * `VENUE_CALL_DISCLOSURE` in src/helpers/location/venueCallScript.ts, a constant: the agency's
 * spoken name changes the callback sentence, not this one). The agent says what the seam sends and
 * nothing else; this copy is never passed to `say`. Its one use is `createWarmer` (src/server/main.ts)
 * pre-rendering the same text, so the first call on a fresh instance finds the disclosure audio in
 * the cache instead of paying 1.1-1.7 s of synthesis before the first word (soak 2026-11-16,
 * TASK-3749).
 *
 * If the backend changes the sentence and this copy is stale, nothing wrong is said: the first call
 * on each instance synthesises the backend's text as before (slower, not broken). Drift is caught by
 * `npm run contract:derive` (row "sentence: disclosure, pre-rendered at warm-up") and by
 * test/healthWarm.test.ts against the mock's disclosure, which that same script checks against the
 * backend.
 */

export const DISCLOSURE_CACHE_KEY = 'Hi — this is an automated call from CreatoRain. We arrange restaurant visits for content creators. This call is transcribed for our records.';

/** What the warm-up renders besides the four fixed phrases. */
export const BACKEND_FIRST_SENTENCES: readonly string[] = [DISCLOSURE_CACHE_KEY];
