/**
 * THE TWO AUDIO WORLDS THIS SERVICE SITS BETWEEN, and the fact that neither is negotiable.
 *
 * A telephone line and a language model do not speak the same audio, and the conversion is ours.
 * Getting it wrong does not throw — it produces a call that sounds like a robot underwater, or
 * silence that is actually full-scale noise, and neither shows up in a unit test that never looks
 * at a sample.
 *
 * 🔴 A CORRECTION TO SOMETHING WRITTEN DOWN IN THIS ESTATE. A memory note says the Live API
 * "resamples INPUT itself (send 8 kHz, declare audio/pcm;rate=8000), only the 24 kHz→8 kHz
 * outbound leg is ours." The first half is true and the conclusion does not follow. The API
 * accepts raw little-endian 16-bit PCM at a declared rate — it does NOT accept μ-law. A telephone
 * hands us μ-law, so the inbound leg needs a G.711 decode before anything is declared, and that
 * decode is unavoidably ours. Both legs are ours; only the resampling half of the inbound one is
 * theirs.
 *   source: https://ai.google.dev/gemini-api/docs/live-guide — "Audio data in the Live API is
 *   always raw, little-endian, 16-bit PCM. Audio output always uses a sample rate of 24kHz."
 *   re-fetched 2026-09-12.
 */

export interface AudioFormat {
    encoding: 'pcm_s16le' | 'mulaw';
    sampleRate: number;
    /** The MIME type to declare when sending. Absent where nothing is declared. */
    mime?: string;
}

/**
 * What the model reads and writes. Verified against the live guide, not assumed.
 *
 * Input rate is flexible because the API resamples — declare it honestly in the MIME type and it
 * will handle 8 kHz. Output is ALWAYS 24 kHz and there is no setting for it.
 */
export const MODEL_AUDIO: { in: AudioFormat; out: AudioFormat } = {
    in: { encoding: 'pcm_s16le', sampleRate: 16000, mime: 'audio/pcm;rate=16000' },
    out: { encoding: 'pcm_s16le', sampleRate: 24000 },
};

/**
 * 🔴 WHAT THE CARRIER SPEAKS — AN ASSUMPTION, NOT A DECISION, and the difference matters.
 *
 * No carrier is connected. Twilio has been suspended since 2026-07-22, no dialler exists in the
 * backend, and a grep across every venue-call file for `mulaw|g711|8000|pcmu|opus|codec|sample
 * rate` returns nothing — the only transport statement anywhere in the codebase is a note in
 * `venueCallToken.ts` that the token travels as a TwiML `<Parameter>` inside `<Connect><Stream>`.
 *
 * These values are the G.711 μ-law/8 kHz/20 ms that every North American carrier media stream
 * uses, including the one that note implies. They are the right thing to build against and they
 * are still a guess until TASK-973 picks a carrier.
 *
 * ⚠️ NO CALL SITE MAY HARDCODE 8000. Read it from here, so that when the guess is settled there
 * is exactly one line to change and a failing test to tell you that you missed one.
 */
export const CARRIER_AUDIO: AudioFormat & { frameMs: number; bytesPerFrame: number } = {
    encoding: 'mulaw',
    sampleRate: 8000,
    frameMs: 20,
    // 8000 samples/s × 0.020 s × 1 byte/sample (μ-law is 8-bit)
    bytesPerFrame: 160,
};

/**
 * 🔴 THE SILENCE BYTE IS 0xFF, NOT 0x00.
 *
 * A zero-filled μ-law buffer is full-scale NEGATIVE and plays as a roar. This is the single most
 * common way a first voice integration deafens somebody, and it is one character to get wrong.
 */
export const MULAW_SILENCE = 0xff;

/** A frame of carrier silence, correctly filled. Use this; never `Buffer.alloc(n)`. */
export function silentCarrierFrame(frames = 1): Buffer {
    return Buffer.alloc(CARRIER_AUDIO.bytesPerFrame * frames, MULAW_SILENCE);
}
