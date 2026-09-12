/**
 * THE TELEPHONE LEG — the narrowest thing every carrier has in common.
 *
 * WHY THIS INTERFACE IS THIS SMALL. No carrier is chosen. Twilio, Telnyx, Vonage and Plivo all
 * offer duplex media over a WebSocket and they disagree about almost everything above the audio:
 * JSON-with-base64 versus raw binary frames, the names of the control messages, whether there is
 * a "mark" acknowledgement, how a barge-in is expressed. If this interface knew any of that, the
 * carrier decision would be baked into every file that touches audio.
 *
 * So it knows exactly four things, and all four are true of a telephone rather than of a vendor:
 *
 *   1. frames of telephone audio arrive, at a steady cadence, until they stop
 *   2. frames of telephone audio can be written back
 *   3. anything written but not yet played can be thrown away — that is barge-in, and every
 *      carrier has some way to say it because a human interrupting is not a vendor feature
 *   4. either end can hang up
 *
 * 🔴 AND HERE IS WHERE IT LEAKS, checked against four carriers' documentation on 2026-09-12
 * rather than assumed. `Frame` is a μ-law payload, and that is true of three of the four:
 *
 *   Twilio  — JSON frames, `media.payload` base64. "Value is always audio/x-mulaw", "always
 *             8000", "always 1". No negotiation of any kind.
 *   Telnyx  — JSON frames, base64. PCMU/8k by default, but SIX codecs are selectable and their
 *             docs recommend L16/16k for AI voice agents specifically: "reduced latency and
 *             eliminating transcoding overhead".
 *   Plivo   — JSON frames, base64, mulaw/8000, ~20 ms chunks (and Plivo documents the cadence,
 *             which Twilio does not).
 *   Vonage  — RAW BINARY WebSocket frames, 16-bit signed little-endian PCM, NO μ-law option at
 *             all, and control messages keyed `action` rather than `event`.
 *
 * So a Vonage adapter cannot accept this `Frame` as it stands. Either `Frame` grows a format —
 * `AudioFormat` in `src/audio/format.ts` already models one — or a Vonage adapter silently
 * transcodes on every frame in both directions, which is a quality and latency cost the
 * interface would be hiding. Prefer the former, and do the refactor while there is one caller.
 *
 * 🔴 THE FRAME SHAPE IS STILL AN ASSUMPTION AND IT LIVES IN ONE PLACE. `CARRIER_AUDIO` in
 * `src/audio/format.ts` carries the reasoning and the warning. Nothing here restates 8000 or 160;
 * read them from there so the day a carrier is picked there is one line to change.
 *
 * WHAT THIS IS NOT. It is not a transport. `src/carrier/fakeLeg.ts` is the only implementation
 * that exists, it speaks to nobody, and it is what `npm run call` runs against. A real adapter is
 * a later, small file: parse the vendor's frames, call these methods.
 */

import { CARRIER_AUDIO } from '../audio/format.ts';

/** Why a call ended. Deliberately about the call, not about a socket. */
export type HangupReason =
    | 'agent_ended'          // we said goodbye and hung up
    | 'far_end_hung_up'      // they hung up on us
    | 'timeline_exhausted'   // a fake leg ran out of script — a test artefact, never a real call
    | 'call_too_long'        // the cap in src/tuning/liveDefaults.ts
    | 'transport_failed';    // the socket died under us. Not the same as either party leaving.

/**
 * One frame of telephone audio.
 *
 * Always exactly `CARRIER_AUDIO.bytesPerFrame` bytes. A short frame is a bug, not a smaller frame:
 * carriers pace playback by frame, so a 120-byte frame is not "less audio", it is a click.
 */
export type Frame = Uint8Array;

export interface CallLegEvents {
    /** A frame arrived from the far end. */
    inbound(frame: Frame): void;
    /** The call is over. Fires exactly once. */
    hangup(reason: HangupReason): void;
}

export interface CallLeg {
    /** Opaque, for logs and for correlating with a call record. */
    readonly id: string;

    on<K extends keyof CallLegEvents>(event: K, handler: CallLegEvents[K]): void;

    /**
     * Queue one frame for playback.
     *
     * Queued, not played: audio leaves at wall-clock speed no matter how fast it is generated, so
     * everything written is a promise about the future that `clear()` can still cancel.
     */
    write(frame: Frame): void;

    /**
     * Throw away everything queued and not yet played.
     *
     * 🔴 THIS IS THE WHOLE OF BARGE-IN AND IT IS EASY TO GET SILENTLY WRONG. Without it, a manager
     * who interrupts is talked over for as long as the queue is deep — and the queue is deep
     * precisely when the agent has just been handed several sentences at once. The failure is
     * inaudible in any test that only reads a transcript, because the transcript is identical.
     */
    clear(): void;

    /** How many frames are queued and unplayed. The only honest measure of how rude an interrupt will be. */
    queuedFrames(): number;

    /** End the call from our side. Idempotent. */
    hangup(reason: HangupReason): Promise<void>;
}

/**
 * Every frame written or read must be exactly this long.
 *
 * 🔴 THIS IS STRICTER THAN ANY CARRIER'S CONTRACT AND THAT IS DELIBERATE HERE — but a real
 * adapter must NOT propagate the throw. Checked 2026-09-12: Twilio documents no inbound frame
 * duration or byte size anywhere, and in the outbound direction says the opposite of this —
 * "The audio can be of any size. The media messages are buffered and played in the order
 * received." Telnyx allows 20 ms to 30 seconds per chunk. The 20 ms / 160-byte figure is
 * de-facto observed behaviour on μ-law/8 kHz, not a promise anybody made.
 *
 * So: keep this assertion for the fake leg, where it catches real bugs and where we control both
 * ends. A carrier adapter that receives a 240-byte payload must RE-CHUNK it, not throw — the
 * carrier is within its rights and the call is live.
 */
export function assertFrame(frame: Frame, where: string): void {
    if (frame.length !== CARRIER_AUDIO.bytesPerFrame) {
        throw new Error(
            `${where}: frame is ${frame.length} bytes, must be exactly ${CARRIER_AUDIO.bytesPerFrame}. ` +
            'A carrier paces playback per frame, so a short frame is a click, not less audio. ' +
            'If this fired inside a real carrier adapter, re-chunk instead: no carrier promises this size.',
        );
    }
}

/** Milliseconds of audio in a given number of frames. The one place this arithmetic lives. */
export function framesToMs(frames: number): number {
    return frames * CARRIER_AUDIO.frameMs;
}

/** Frames needed to carry a given duration, rounded up — you cannot send part of a frame. */
export function msToFrames(ms: number): number {
    return Math.ceil(ms / CARRIER_AUDIO.frameMs);
}
