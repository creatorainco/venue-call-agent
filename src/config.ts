/**
 * Configuration, in three classes, read once.
 *
 * 🔴 THE RULE THAT MATTERS IS STILL FAIL-CLOSED: nothing may discover a missing credential while a
 * restaurant is on the line. But the first version of this file enforced that by demanding all
 * four values at boot, including two that only a real Gemini session needs — so a laptop with no
 * Google account could not start a service whose entire local story requires no Google account.
 * That is fail-closed pointed at the wrong door: it blocked the work and protected nothing, since
 * a service that never boots never reaches a call either.
 *
 * So the check moved to where the risk is. `loadConfig()` succeeds with an empty environment and
 * gives you everything the local path needs. `requireLiveSession()` is called at the ONE moment
 * before a model session opens, and refuses there, naming what is missing. The failure is still
 * before the phone rings; it is just no longer before `npm test`.
 *
 * Note the shape of any boolean read: `=== '1'`, exactly. The string 'false' is TRUTHY in
 * JavaScript, and a flag written `'false'` that silently enables a dialler is a mistake this
 * estate has already made once. `readFlag` below is the only sanctioned way to read one.
 */

/** Everything the local path needs. Every field has a working default. */
export interface Config {
    /** Where the backend lives. Defaults to the in-repo mock. */
    apiBaseUrl: string;
    /** The agent's own listen port. Only matters once a carrier has somewhere to call back. */
    port: number;
    /** Shared literal that signs the call token. Empty locally; the mock does not check it. */
    venueCallSecret: string;
}

/** The credentials a real model session needs, and nothing else does. */
export interface LiveConfig {
    geminiApiKey: string;
    /** Overrides the pin in src/tuning/liveDefaults.ts. Empty means "use the pin". */
    geminiLiveModel: string;
    speechToTextCredentials: string;
}

/** The mock's default port. Kept in step with src/mock/cli.ts. */
export const DEFAULT_API_BASE_URL = 'http://127.0.0.1:8788';

const trimmed = (env: NodeJS.ProcessEnv, key: string): string => (env[key] ?? '').trim();

/**
 * A boolean from the environment.
 *
 * ONLY `'1'` is true. Every other string — including `'true'`, `'yes'`, and most importantly
 * `'false'` — is false. Exported so nothing has to re-derive it and get it wrong.
 */
export function readFlag(env: NodeJS.ProcessEnv, key: string): boolean {
    return trimmed(env, key) === '1';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    const rawPort = trimmed(env, 'PORT') || '8787';
    const port = Number.parseInt(rawPort, 10);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
        throw new Error(
            `venue-call-agent refuses to start. PORT is not a usable port: ${JSON.stringify(env.PORT)}. ` +
            'Leave it unset for 8787.',
        );
    }
    return {
        apiBaseUrl: trimmed(env, 'CREATORAIN_API_BASE_URL') || DEFAULT_API_BASE_URL,
        port,
        venueCallSecret: trimmed(env, 'VENUE_CALL_SECRET'),
    };
}

/**
 * Call this immediately before opening a model session, and nowhere else.
 *
 * 🔴 IT MUST BE CALLED BEFORE THE DIAL, NOT AFTER THE ANSWER. The whole reason this function
 * exists as a separate step is that the failure has to land somewhere nobody is listening. A
 * missing key discovered after the carrier connects is a restaurant holding a silent line.
 */
export function requireLiveSession(env: NodeJS.ProcessEnv = process.env): LiveConfig {
    const required = ['GEMINI_API_KEY', 'SPEECH_TO_TEXT_CREDENTIALS'] as const;
    const missing = required.filter((k) => !trimmed(env, k));
    if (missing.length) {
        throw new Error(
            `venue-call-agent cannot open a model session. Missing: ${missing.join(', ')}. ` +
            'See .env.example. None of these is needed for npm test, npm run eval or npm run mock — ' +
            'if you are hitting this locally, you are on a path that talks to Google and probably ' +
            'did not mean to be.',
        );
    }
    return {
        geminiApiKey: trimmed(env, 'GEMINI_API_KEY'),
        geminiLiveModel: trimmed(env, 'GEMINI_LIVE_MODEL'),
        speechToTextCredentials: trimmed(env, 'SPEECH_TO_TEXT_CREDENTIALS'),
    };
}

/**
 * Talking to a REAL platform-backend needs the shared signing literal; the mock does not.
 *
 * Separate from `requireLiveSession` because the two failures have different fixes and pointing a
 * developer at the wrong one costs an afternoon.
 */
export function requireRealBackend(config: Config): void {
    if (!config.venueCallSecret) {
        throw new Error(
            'venue-call-agent cannot mint a token for a real backend: VENUE_CALL_SECRET is unset. ' +
            'It is a shared literal, not an issued credential — set the same value here and on the ' +
            'backend. Against the in-repo mock you do not need it at all.',
        );
    }
}
