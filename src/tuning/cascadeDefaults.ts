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
    /**
     * SHORT, not SUPERSHORT. Measured 2026-11-14 on the soak corpus (47 clips, noise bed, interim
     * results on, `telephony` in `us`): end of speech to the final was p50 1117 / p90 2177 ms on
     * SHORT and p50 1173 / p90 2170 ms on SUPERSHORT, the same within noise, so the telephony model
     * does not act on the finer setting. Short turns are ended early on the interim instead
     * (`src/speech/turnEnd.ts`).
     */
    endpointingSensitivity: 'ENDPOINTING_SENSITIVITY_SHORT',
    /**
     * Interim results on (I3P-07): a one-word "Hello?" shows as an interim 0.1-0.3 s after the
     * speech ends, while its final came 1.7-5.7 s later in the noise bed. The interim is what
     * lets a turn end before the recogniser's endpointer calls it.
     */
    interimResults: true,
} as const;

/**
 * Ending a turn on the interim, before the recogniser's final (I3P-07). The interim must have
 * stood unchanged this long: Google revises an interim every 100-300 ms while words are coming,
 * so a still interim is a pause, not a word in flight.
 */
export const TURN_END = {
    /** A keyword cue in the interim decides the turn (stop, wrong number, a machine, a question). */
    cueSettleMs: 450,
    /** The hello after the disclosure ("Hello?", "Golden Crane."): no cue needed. */
    shortSettleMs: 600,
    /**
     * "Short" is at most this many words: a greeting is a name and a role ("Hi, this is the
     * manager." is five). At 3 the soak's "Hi, this is the manager" waited for a final that never
     * came, and the venue heard nothing for 8 s (2026-11-15 run).
     */
    shortWords: 6,
    /**
     * The final that follows an early end is the same turn, and is dropped, when it decides the
     * same cue and carries at most this many words more (babble glued to "hello"). Anything else
     * in it is a new turn and is answered.
     */
    sameTurnExtraWords: 4,
    /**
     * The intent model starts on an interim once it has stood this long (`CallAgent.prefetch`):
     * not on every revision, which sent four requests for one "hello" in the 2026-11-15 run.
     */
    speculateAfterMs: 250,
    /**
     * The voice at the phone, not the room (`ForegroundSpeech`): the room's floor is the 20th
     * percentile of the last 3 s of frame energy, and a frame 9 dB over it is the person on the
     * line. An early end needs 8 such frames (160 ms) in the last 2.5 s. Measured on the corpus
     * bed: at most 2 in any 2 s of room alone, at least 13 in every clip.
     */
    floorFrames: 150,
    floorPercentile: 0.2,
    foregroundMarginDb: 9,
    foregroundWindowFrames: 125,
    foregroundMinFrames: 8,
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
    /**
     * The ceiling grows with the sentence: max(timeoutMs, timeoutBaseMs + timeoutPerCharMs a
     * character). Chirp 3 HD took 4.9-5.1 s for the mock's 498-character voicemail script, so a
     * flat 4 s aborted it on every call (`prerender_failed`, then `internal_error TtsUnavailable`
     * on a call that needed it; docs/soak/2026-11-20.md). Measured about 1 s per 100 characters;
     * 12 ms leaves headroom. Every sentence of 208 characters or fewer keeps the flat 4 s.
     */
    timeoutBaseMs: 1500,
    timeoutPerCharMs: 12,
    /** Finished strings repeat across calls; the cache is bounded so it cannot grow unbounded. */
    cacheEntries: 256,
} as const;
