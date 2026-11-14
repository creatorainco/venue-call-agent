/**
 * The cascade's pins: the intent model, the speech-to-text recognizer and the synthesis voice.
 *
 * The cascade is the first-call brain (TASK-3748 step 3): speech in, ONE closed intent, a finished
 * backend sentence, speech out. The model chooses from an enum and never speaks. Every value here
 * is a starting point the loopback soak (TASK-3749) measures, not a tuning result.
 *
 * 🔴 CREDENTIALS: NONE. Every Google call in the cascade authenticates with Application Default
 * Credentials, which on Cloud Run is the runtime service account. There is no API key, no key file
 * path and no signing secret anywhere in the cascade's configuration, and
 * `test/importBoundary.test.ts` fails the build if `src/` starts reading one.
 */

/**
 * The intent model. An explicit version, never a `-latest` alias, for the same reason as the Live
 * pin in `liveDefaults.ts`: an alias that moves under a deployed voice agent changes what a
 * restaurant hears with no commit and no review.
 *
 * Read from the Vertex model page by the round-2 audit (2026-11-08, `audit.md` B-rows): GA
 * 2026-07-21, supports `text/x.enum` with a `responseSchema`, temperature no longer settable,
 * default thinking MINIMAL, served on the `global` endpoint, retirement "July 21, 2027 or later".
 */
export const INTENT_MODEL = 'gemini-3.5-flash-lite';

/**
 * The earliest day Google says each pinnable intent model may retire, keyed by id so a re-pin
 * cannot keep the old model's date: re-pin to an id with no row here and the build fails.
 */
export const INTENT_MODEL_RETIREMENTS: Readonly<Record<string, string>> = {
    'gemini-3.5-flash-lite': '2027-07-21',
};

/** The pin's own earliest retirement. `test/cascadeDefaults.test.ts` fails the build from it. */
export const INTENT_MODEL_EARLIEST_RETIREMENT: string = INTENT_MODEL_RETIREMENTS[INTENT_MODEL] ?? '';

/** Vertex location for `generateContent`. Flash-Lite is served on the global endpoint. */
export const INTENT_LOCATION = 'global';

/**
 * How long a turn waits for the model before it treats the reply as `unclear`. Between the
 * 700-1000 ms the design names: a caller holding a phone hears this as silence.
 */
export const INTENT_TIMEOUT_MS = 900;

/** Speech-to-text v2: the telephony model in the `us` multi-region, MULAW 8 kHz declared. */
export const STT = {
    model: 'telephony',
    location: 'us',
    languageCode: 'en-US',
    /**
     * Audio is sent in batches, never one request per 20 ms carrier frame (CS-01): 160 ms is
     * inside the 100-200 ms band the design names.
     */
    batchMs: 160,
    /**
     * A streaming recognition session is capped at about five minutes. The stream is rolled to a
     * fresh one at 4:30 so the cap never lands mid-sentence.
     */
    rolloverMs: 270_000,
    endpointingSensitivity: 'ENDPOINTING_SENSITIVITY_SHORT',
} as const;

/** Text-to-speech: a Chirp 3 HD voice, MULAW 8 kHz so the bytes go to the line untouched. */
export const TTS = {
    voice: 'en-US-Chirp3-HD-Aoede',
    languageCode: 'en-US',
    sampleRateHertz: 8000,
    /**
     * CS-04. Google refuses a synthesis request whose input is over 5,000 bytes, and Chirp 3 HD
     * takes no SSML. The guard refuses locally, before any network call, so an over-long backend
     * sentence is an error with a stack trace rather than a silent line.
     *
     * Rate note, not enforced here: Chirp 3 HD voices allow 200 requests a minute per project.
     * The sha256 cache and the pre-rendered disclosure keep a call to a handful of requests; at
     * concurrency 1 and five instances that is far below the cap (`docs/LIMITS.md`).
     */
    maxInputBytes: 5000,
    timeoutMs: 4000,
    /** Finished strings repeat across calls; the cache is bounded so it cannot grow unbounded. */
    cacheEntries: 256,
} as const;
