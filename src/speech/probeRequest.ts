/**
 * The speech-format probe's two request bodies (TASK-3744 step 4), kept pure so a test can pin
 * the one thing the probe exists to prove: that a carrier's μ-law 8 kHz mono audio is what both
 * Google calls are asked for.
 *
 * `scripts/probe-speech.mjs` builds its requests here and sends them. The probe synthesises one
 * sentence with Chirp 3 HD as MULAW 8000, unwraps the WAV container, and hands those exact bytes
 * to Speech-to-Text v2 `recognize` with an explicit MULAW 8000 decoding config, once per model.
 * If the digits in the sentence survive the round trip, the telephony format works end to end on
 * the non-streaming path. Streaming is proven by the call path itself (TASK-3748).
 *
 * The probe's sentence is passed in, never held here: this file is under `src/`, which carries no
 * spoken sentence (`npm run check:no-facts`).
 */

import { CARRIER_AUDIO } from '../audio/format.ts';
import { STT, TTS } from '../tuning/cascadeDefaults.ts';

/** The two STT v2 models the probe compares: the one the cascade runs on, and its challenger. */
export const PROBE_STT_MODELS: readonly string[] = ['telephony', 'chirp_3'];

/** REST `text:synthesize` body: Chirp 3 HD, MULAW at the carrier's rate, the cascade's own voice. */
export function probeSynthesizeRequest(text: string, voice: string = TTS.voice): Record<string, unknown> {
    return {
        input: { text },
        voice: { languageCode: TTS.languageCode, name: voice },
        audioConfig: { audioEncoding: 'MULAW', sampleRateHertz: CARRIER_AUDIO.sampleRate },
    };
}

/** STT v2 `recognize` body for raw μ-law bytes, decoded explicitly: there is no header to sniff. */
export function probeRecognizeRequest(audio: Buffer, model: string): Record<string, unknown> {
    return {
        config: {
            explicitDecodingConfig: {
                encoding: 'MULAW',
                sampleRateHertz: CARRIER_AUDIO.sampleRate,
                audioChannelCount: 1,
            },
            model,
            languageCodes: [STT.languageCode],
        },
        content: audio.toString('base64'),
    };
}

/** The v2 `recognize` URL on the regional endpoint, with the default (`_`) recognizer. */
export function probeRecognizeUrl(projectId: string, location: string = STT.location): string {
    return `https://${location}-speech.googleapis.com/v2/projects/${projectId}/locations/${location}/recognizers/_:recognize`;
}

/** Every transcript in one v2 `RecognizeResponse`, joined in order. */
export function recognizeTranscript(response: unknown): string {
    const results = (response as { results?: unknown })?.results;
    if (!Array.isArray(results)) return '';
    return results
        .map((r) => (r as { alternatives?: Array<{ transcript?: unknown }> })?.alternatives?.[0]?.transcript)
        .filter((t): t is string => typeof t === 'string')
        .join(' ')
        .trim();
}

/** Did "one two three" survive, as words or as digits ("1 2 3", "1, 2, 3", "123")? */
export function digitsSurvived(transcript: string): boolean {
    const t = transcript.toLowerCase();
    return /\bone\W+two\W+three\b/.test(t) || /\b1\W*2\W*3\b/.test(t);
}
