/**
 * Text to speech: a finished backend sentence in, carrier-ready μ-law 8 kHz bytes out.
 *
 * REST `text:synthesize` over `fetch`, not an SDK: finished strings need no streaming synthesis,
 * and the repo holds its runtime dependencies to three (`CLAUDE.md`). Chirp 3 HD, MULAW at 8000 Hz,
 * so the bytes go to the line with no resampling in between.
 *
 * Every sentence is cached by sha256 of voice and text, and the disclosure is rendered before the
 * first word (`prerender`), so the sentence that must be heard first never waits on the network.
 *
 * 🔴 IT REFUSES, LOCALLY, BEFORE ANY REQUEST:
 *   - an empty or blank sentence (CORE-A16's other half: silence handed to synthesis is a bug
 *     upstream, never something to paper over with a placeholder);
 *   - input over Google's 5,000-byte cap (CS-04). The refusal is a `TtsRefused` with a reason, so
 *     the caller ends the call cleanly instead of finding out from a 400 mid-sentence.
 */

import { createHash } from 'node:crypto';
import type { TokenSource } from '../google/adc.ts';
import { TTS } from '../tuning/cascadeDefaults.ts';

export const TTS_ENDPOINT = 'https://texttospeech.googleapis.com/v1/text:synthesize';

export type TtsRefusalReason = 'empty' | 'too_long';

export class TtsRefused extends Error {
    readonly reason: TtsRefusalReason;

    constructor(reason: TtsRefusalReason, detail: string) {
        super(`tts refused (${reason}): ${detail}`);
        this.name = 'TtsRefused';
        this.reason = reason;
    }
}

export class TtsUnavailable extends Error {
    constructor(detail: string) {
        super(`tts unavailable: ${detail}`);
        this.name = 'TtsUnavailable';
    }
}

export interface TtsOptions {
    tokens: Pick<TokenSource, 'token'>;
    fetchImpl?: typeof fetch;
    voice?: string;
    timeoutMs?: number;
    maxInputBytes?: number;
    cacheEntries?: number;
}

export interface Tts {
    /** μ-law 8 kHz mono bytes for one finished sentence. */
    synthesize(text: string): Promise<Buffer>;
    /** Render ahead of time, so the first sentence of a call is already in the cache. */
    prerender(texts: readonly string[]): Promise<void>;
    /** For tests and the soak: how many requests actually left the process. */
    readonly requests: number;
}

/** Throws `TtsRefused` for input Google would refuse. Exported for the guard's own test. */
export function checkSynthesisInput(text: string, maxInputBytes: number = TTS.maxInputBytes): void {
    if (typeof text !== 'string' || text.trim() === '') {
        throw new TtsRefused('empty', 'a blank sentence reached synthesis');
    }
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > maxInputBytes) {
        throw new TtsRefused('too_long', `${bytes} bytes is over the ${maxInputBytes}-byte request cap`);
    }
}

/**
 * Google returns MULAW wrapped in a WAV container. The line wants raw μ-law, and a 44-byte header
 * played as audio is an audible click before every sentence, so the `data` chunk is unwrapped.
 */
export function unwrapWav(audio: Buffer): Buffer {
    if (audio.length < 12 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') {
        return audio;
    }
    let at = 12;
    while (at + 8 <= audio.length) {
        const id = audio.toString('ascii', at, at + 4);
        const size = audio.readUInt32LE(at + 4);
        if (id === 'data') return audio.subarray(at + 8, Math.min(audio.length, at + 8 + size));
        at += 8 + size + (size % 2);
    }
    throw new TtsUnavailable('a WAV response with no data chunk');
}

export function createTts(options: TtsOptions): Tts {
    const voice = options.voice ?? TTS.voice;
    const doFetch = options.fetchImpl ?? fetch;
    const timeoutMs = options.timeoutMs ?? TTS.timeoutMs;
    const maxInputBytes = options.maxInputBytes ?? TTS.maxInputBytes;
    const cacheEntries = options.cacheEntries ?? TTS.cacheEntries;
    const cache = new Map<string, Promise<Buffer>>();
    let requests = 0;

    const keyOf = (text: string) => createHash('sha256').update(`${voice}\n${text}`).digest('hex');

    async function request(text: string): Promise<Buffer> {
        const token = await options.tokens.token();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let response: Response;
        try {
            requests++;
            response = await doFetch(TTS_ENDPOINT, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    input: { text },
                    voice: { languageCode: TTS.languageCode, name: voice },
                    audioConfig: { audioEncoding: 'MULAW', sampleRateHertz: TTS.sampleRateHertz },
                }),
                signal: controller.signal,
            });
        } catch (error) {
            const detail = (error as Error)?.name === 'AbortError'
                ? `no response in ${timeoutMs}ms`
                : String((error as Error)?.message ?? error);
            throw new TtsUnavailable(detail);
        } finally {
            clearTimeout(timer);
        }
        if (!response.ok) throw new TtsUnavailable(`HTTP ${response.status}`);
        const payload = await response.json().catch(() => null) as { audioContent?: unknown } | null;
        if (typeof payload?.audioContent !== 'string' || payload.audioContent === '') {
            throw new TtsUnavailable('a response with no audio');
        }
        const audio = unwrapWav(Buffer.from(payload.audioContent, 'base64'));
        if (audio.length === 0) throw new TtsUnavailable('a response with empty audio');
        return audio;
    }

    async function synthesize(text: string): Promise<Buffer> {
        checkSynthesisInput(text, maxInputBytes);
        const key = keyOf(text);
        const hit = cache.get(key);
        if (hit) return hit;
        const pending = request(text);
        cache.set(key, pending);
        // A failure is not cached: the next call for the same sentence tries again.
        pending.catch(() => cache.delete(key));
        while (cache.size > cacheEntries) {
            const oldest = cache.keys().next().value;
            if (oldest === undefined) break;
            cache.delete(oldest);
        }
        return pending;
    }

    return {
        synthesize,
        async prerender(texts: readonly string[]): Promise<void> {
            await Promise.all(texts.map((t) => synthesize(t)));
        },
        get requests() {
            return requests;
        },
    };
}
