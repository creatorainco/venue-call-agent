/**
 * Configuration. Every value is REQUIRED and read once, at boot.
 *
 * 🔴 THE SERVICE REFUSES TO START IF ANYTHING IS MISSING, AND NAMES WHAT IS MISSING.
 * The alternative — starting and discovering the gap mid-call — means a restaurant is already on
 * the line when the failure surfaces. There is no polite recovery from that, so the failure is
 * moved to boot where nobody is listening.
 *
 * Note the shape of the boolean read: `=== '1'`, exactly. The string 'false' is TRUTHY in
 * JavaScript, and a flag written `'false'` that silently enables a dialler is the kind of mistake
 * this estate has already made once.
 */

export interface Config {
    apiBaseUrl: string;
    venueCallSecret: string;
    geminiApiKey: string;
    speechToTextCredentials: string;
    port: number;
}

const REQUIRED = [
    'CREATORAIN_API_BASE_URL',
    'VENUE_CALL_SECRET',
    'GEMINI_API_KEY',
    'SPEECH_TO_TEXT_CREDENTIALS',
] as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    const missing = REQUIRED.filter((k) => !(env[k] ?? '').trim());
    if (missing.length) {
        throw new Error(
            `venue-call-agent refuses to start. Missing required configuration: ${missing.join(', ')}. ` +
            `See .env.example. Starting half-configured means finding out mid-call.`,
        );
    }
    const port = Number.parseInt((env.PORT ?? '8787').trim(), 10);
    if (!Number.isFinite(port) || port <= 0) {
        throw new Error(`venue-call-agent refuses to start. PORT is not a usable port: ${env.PORT}`);
    }
    return {
        apiBaseUrl: (env.CREATORAIN_API_BASE_URL as string).trim(),
        venueCallSecret: (env.VENUE_CALL_SECRET as string).trim(),
        geminiApiKey: (env.GEMINI_API_KEY as string).trim(),
        speechToTextCredentials: (env.SPEECH_TO_TEXT_CREDENTIALS as string).trim(),
        port,
    };
}

