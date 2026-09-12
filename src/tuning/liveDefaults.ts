/**
 * THE STARTING VALUES, AND WHY EACH ONE IS WHAT IT IS.
 *
 * "Tune the agent" is a phrase that means nothing until somebody writes down what the knobs are.
 * This file is that list. Every value below is a value SOMEBODY CHOSE, with the reason next to it,
 * because a setting nobody chose is a setting nobody can review — and on a telephone the
 * difference between two of these numbers is the difference between an agent that waits politely
 * and one that talks over a busy manager.
 *
 * 🔴 THE SMALL SURPRISE, AND IT IS GOOD NEWS: tuning here is a much narrower job than it sounds.
 * The system instruction, the disclosure, the four opening beats and every factual sentence all
 * arrive PER CALL from `call-context`. They are not in this repository and they are not tunable
 * from here. What is left is genuinely audio and turn-taking behaviour — which is the part a
 * measurement can settle.
 *
 * ⚠️ NOTHING HERE HAS BEEN MEASURED ON A REAL CALL. Every number is either the documented server
 * default or a first choice with a stated reason. `docs/TUNING.md` §3 is the measurement protocol
 * that replaces the reasons with readings; until somebody runs it, treat this file as a set of
 * hypotheses somebody wrote down carefully, not as settings that have been shown to work.
 *
 * Sources, all re-fetched 2026-09-12:
 *   https://ai.google.dev/gemini-api/docs/live-guide
 *   https://ai.google.dev/gemini-api/docs/live-api/capabilities
 *   https://ai.google.dev/gemini-api/docs/live-session
 *   https://ai.google.dev/gemini-api/docs/speech-generation
 */

/**
 * 🔴 THE MODEL IS NOT PART OF THE SESSION CONFIG. It is an argument to `live.connect`, not a
 * property of `LiveConnectConfig`. Putting it in the config object typechecks against a loose
 * type and is then silently dropped, which is the whole class of bug this file is arranged to
 * avoid — so it is exported separately and the test asserts it is not in the other object.
 *
 * WHY THIS ID AND NOT THE NEWER ONE. A forum thread (discuss.ai.google.dev/180918, last post
 * 2026-09-05, two posters, no Google reply) reports `gemini-3.1-flash-live-preview` taking 9–15
 * seconds to first audio, against 1.9–2.4 for the 2.5 native-audio line. That is two strangers on
 * a forum and not a measurement of ours — but on a telephone a nine-second silence after "hello"
 * is the call over, so the conservative pin is the right default until our own latency run says
 * otherwise. THAT RUN IS THE FIRST TUNING TASK.
 *
 * An explicit version rather than the `-latest` alias: an alias that moves under a deployed voice
 * agent changes what a restaurant hears with no commit and no review.
 */
export const LIVE_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';

/**
 * The alias the forum compared against, kept here so the comparison run has both ends.
 * Do not deploy an alias. Use it to reproduce a published figure and nothing else.
 */
export const LIVE_MODEL_ALIAS_FOR_COMPARISON = 'gemini-2.5-flash-native-audio-latest';

/** The one we are avoiding, named so the comparison is repeatable rather than folkloric. */
export const LIVE_MODEL_UNDER_SUSPICION = 'gemini-3.1-flash-live-preview';

/**
 * Voice activity detection — where almost all the audible tuning lives.
 *
 * These four are the ones that decide whether the agent feels like a person or like an answering
 * machine, and three of the four have no documented default at all.
 */
export const VAD = {
    /** Automatic VAD stays ON. Manual activity signalling means WE decide when a turn ended, from
     *  a carrier stream with jitter in it, which is strictly harder than letting the model do it. */
    disabled: false,

    /**
     * How eager the model is to treat incoming audio as the start of speech.
     *
     * LOW rather than HIGH: a restaurant floor is a noisy place, and a high-sensitivity start
     * detector treats a dropped tray as the manager beginning to talk, which makes the agent stop
     * mid-sentence for nothing. The cost of LOW is a slightly later barge-in, which is the
     * cheaper error.
     */
    startOfSpeechSensitivity: 'START_SENSITIVITY_LOW' as const,

    /** Same reasoning, other end. A trailing "umm" should not read as a finished turn. */
    endOfSpeechSensitivity: 'END_SENSITIVITY_LOW' as const,

    /**
     * How much audio before the detected start is included. Higher recovers clipped first
     * syllables, which on a phone is the difference between "…orty-five" and "forty-five".
     */
    prefixPaddingMs: 300,

    /**
     * 🔴 800 IS THE DOCUMENTED SERVER DEFAULT, and this value is deliberately equal to it.
     *
     * An earlier draft of this file proposed 700 while arguing for caution. That is backwards:
     * 700 makes the agent interrupt SOONER than stock, not later. Start at the default so the
     * first measurement is against known behaviour, then move it with a reading in hand.
     *
     * Which way to move: UP costs dead air after every turn and buys fewer interruptions; DOWN
     * feels snappier and talks over people who pause to think. A restaurant manager holding a
     * phone between shoulder and ear pauses a lot.
     */
    silenceDurationMs: 800,
} as const;

/**
 * The session-level config passed to `live.connect({ config })`.
 *
 * ⚠️ `turnCoverage` is NOT a top-level field — it lives under `realtimeInputConfig`. Put it at the
 * top level and the API ignores it silently, and the default differs between the 2.5 and 3.x
 * lines, so "it worked before the model change" is exactly how this bites.
 */
export const LIVE_DEFAULTS = {
    responseModalities: ['AUDIO'] as const,

    speechConfig: {
        /**
         * Puck. Google's own telephony sample uses it, which is the only voice evidence available
         * that is about telephones rather than about demos. Charon reads as more "informative" and
         * is the obvious alternative; pick between them with the listening test in docs/TUNING.md
         * §3.4, not from the descriptor words on the docs page.
         */
        voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } },
    },

    realtimeInputConfig: {
        automaticActivityDetection: {
            disabled: VAD.disabled,
            startOfSpeechSensitivity: VAD.startOfSpeechSensitivity,
            endOfSpeechSensitivity: VAD.endOfSpeechSensitivity,
            prefixPaddingMs: VAD.prefixPaddingMs,
            silenceDurationMs: VAD.silenceDurationMs,
        },
        /** Send everything, including while the model is speaking — barge-in depends on it. */
        turnCoverage: 'TURN_INCLUDES_ALL_INPUT' as const,
    },

    /**
     * Both transcripts, on.
     *
     * The OUTPUT transcript is what the fabrication check reads, and it is not free of a conflict
     * of interest — it is the model's own account of its own speech. `SPEECH_TO_TEXT_CREDENTIALS`
     * exists so a second, independent transcriber can witness the same audio. Whether Google STT
     * on the same project counts as independent is an open question, written down in
     * docs/LIMITS.md rather than assumed away.
     */
    inputAudioTranscription: {},
    outputAudioTranscription: {},

    /**
     * An audio-only session is capped at 15 minutes without this. Our calls are capped at six, so
     * the cap is not the reason — the reason is that a session which hits the limit mid-sentence
     * is the worst possible failure, and compression makes that impossible rather than unlikely.
     */
    contextWindowCompression: { slidingWindow: {} },

    /** Survive a transient disconnect without the restaurant hearing it. */
    sessionResumption: {},
} as const;

/**
 * How long we wait for the seam mid-call.
 *
 * Not a Gemini setting — ours — but it belongs beside the others because it is the other half of
 * the same experience. A person asked a question and is now listening to nothing.
 *
 * 🔴 A TIMEOUT IS NOT A REFUSAL. When it fires, the agent has no answer and no way to get one,
 * and the correct move is to end the call rather than improvise. See `src/seam/client.ts`.
 */
export const SEAM_TIMEOUT_MS = 2500;

/**
 * The maximum length of one call, in seconds.
 *
 * Six minutes, from the token's own header: the credential lives twenty minutes and is sized as
 * "longer than the longest sane call (capped at 6 minutes) plus dial, ring and answering-machine
 * detection". If this ever exceeds the token TTL, calls start failing at the seam mid-conversation.
 */
export const MAX_CALL_SECONDS = 360;

/**
 * What the tuning run must report, so two runs are comparable.
 *
 * p50 alone hides the calls that went wrong; a mean hides them completely. The number that
 * decides whether this feature is usable is p90, and the number that decides whether it is
 * embarrassing is max.
 */
export const LATENCY_PERCENTILES: readonly number[] = [50, 90, 99];
