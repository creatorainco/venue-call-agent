/**
 * Configuration, read once.
 *
 * 🔴 THE RULE THAT MATTERS IS STILL FAIL-CLOSED: nothing may discover a missing credential while a
 * restaurant is on the line. But the first version of this file enforced that by demanding all
 * four values at boot, including two that only a real Gemini session needs — so a laptop with no
 * Google account could not start a service whose entire local story requires no Google account.
 * That is fail-closed pointed at the wrong door: it blocked the work and protected nothing, since
 * a service that never boots never reaches a call either.
 *
 * So `loadConfig()` succeeds with an empty environment and gives you everything the local path
 * needs, and the deployed service needs exactly the same two values: where the backend is, and
 * which port to bind.
 *
 * 🔴 NO SECRET AND NO KEY LIVE HERE (CORE-A11, C2, 2026-11-13). The agent used to be configured to
 * hold `VENUE_CALL_SECRET`, the literal that signs a token for ANY reservation, and two key-shaped
 * Gemini and Speech credentials. None of them belongs on the agent: pb mints each call's token and
 * hands it over in the stream's `start` frame, and every Google call authenticates with ADC
 * (`src/google/adc.ts`). Minting a token by hand is dev tooling and stays in
 * `scripts/mint-token.mjs`, which reads the secret itself. `test/importBoundary.test.ts` fails the
 * build if anything under `src/` reads one of those names again.
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
    };
}
