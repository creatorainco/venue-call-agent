/**
 * THE FAKE CARRIER: a client that opens the media WebSocket the way Twilio's `<Connect><Stream>`
 * does, and records what the far side did with it (TASK-3749 step 1, the driver).
 *
 * It places no call and reaches no carrier. It drives a WebSocket client it is HANDED (`connect`):
 * `src/` opens no connection of its own outside the three adapters (test/importBoundary.test.ts,
 * CORE-A11), so `scripts/soak-edge.mjs` and the tests supply `new WebSocket(...)`. Point it at a
 * local `npm start`, or at the dev Cloud Run service, and it plays the part of the phone line.
 *
 * Two families of leg:
 *
 *   - `twilio`: the real shape. `connected`, then `start` carrying the token in
 *     `customParameters.token`, then 20 ms paced μ-law `media` (a synthetic tone, not speech),
 *     `mark` echoed back as Twilio does once audio has played, then `stop` and a normal close.
 *   - the bogus ones (VCA-12): what a stranger who found the URL might send. `no-token` (a `start`
 *     with no token), `bad-token` (a token the backend never minted), `garbage` (a frame that is not
 *     JSON), `binary` (a binary frame), and `no-start` (connect and say nothing).
 *
 * What is measured comes from the wire, never from the server's own account of itself: whether the
 * upgrade was taken, who closed, with what code and reason, how long it took, and every outbound
 * message by event kind. A refusal is read off the wire too: a refused upgrade, or the close the
 * stream server sends for a leg it never accepted (`CLOSE_REFUSED`, 1008 `refused`). A `media` frame whose payload is not all μ-law silence is counted as AUDIO, because
 * the first safety property of a refused or unwired call is that it says nothing.
 *
 * 🔴 NEVER LOG THE TOKEN. The outcome carries the leg kind, not the token it was given.
 */

import type { ClientOptions, WebSocket } from 'ws';
import { CARRIER_AUDIO, MULAW_SILENCE } from '../audio/format.ts';
import { speechFrame } from '../carrier/fakeLeg.ts';
import { CLOSE_REFUSED } from '../carrier/twilioLeg.ts';

/** Opens the client socket. Supplied by the caller: `(url, options) => new WebSocket(url, options)`. */
export type Connect = (url: string, options: ClientOptions) => WebSocket;

export const LEG_KINDS = ['twilio', 'no-token', 'bad-token', 'garbage', 'binary', 'no-start'] as const;
export type LegKind = (typeof LEG_KINDS)[number];

/** The five a stranger might send (VCA-12). */
export const BOGUS_KINDS: readonly LegKind[] = ['no-token', 'bad-token', 'garbage', 'binary', 'no-start'];

/** Shaped like a pb token (`v1.<r>.<a>.<expiry>.<mac>`), signed by nobody. */
export const FORGED_TOKEN = 'v1.soak-reservation.soak-attempt.4102444800000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export interface LegPlan {
    kind: LegKind;
    /** Required for `twilio`; ignored by the bogus kinds, which bring their own. */
    token?: string;
    /** How long a `twilio` leg streams caller audio if the far side lets it. Default 3000. */
    mediaMs?: number;
    /** Give up and close from our side after this long. Default 15000. */
    timeoutMs?: number;
}

export interface LegOutcome {
    kind: LegKind;
    /** The WebSocket handshake answered 101. */
    upgraded: boolean;
    /** The HTTP status when the upgrade was refused. */
    httpStatus: number | null;
    /** The close code we saw, if the socket opened. */
    closeCode: number | null;
    /** The close reason we saw, if any. A short fixed word from our server, never a secret. */
    closeReason: string | null;
    /**
     * Who ended it: the server with a close frame, us after our script finished, us at the timeout,
     * or `error`: the socket failed, or dropped without a close frame (1006), which is a reset or a
     * crash and never a clean server-side end.
     */
    closedBy: 'server' | 'client' | 'timeout' | 'error';
    /** From the connect attempt to the close (or the refused upgrade). */
    msToClose: number;
    /** Outbound messages by `event`, as the far side sent them. */
    received: Record<string, number>;
    /** Outbound `media` frames whose payload is not all μ-law silence. */
    audibleFrames: number;
    /** Caller `media` frames we sent. */
    sentMedia: number;
    /** An error's class name, if the socket failed. Never its message. */
    error: string | null;
}

export async function runLeg(connect: Connect, url: string, plan: LegPlan): Promise<LegOutcome> {
    if (plan.kind === 'twilio' && !plan.token) throw new Error('a twilio leg needs a token');
    const mediaMs = plan.mediaMs ?? 3000;
    const timeoutMs = plan.timeoutMs ?? 15_000;
    const t0 = Date.now();
    const outcome: LegOutcome = {
        kind: plan.kind,
        upgraded: false,
        httpStatus: null,
        closeCode: null,
        closeReason: null,
        closedBy: 'server',
        msToClose: 0,
        received: {},
        audibleFrames: 0,
        sentMedia: 0,
        error: null,
    };

    return new Promise<LegOutcome>((resolve) => {
        const ws = connect(url, { perMessageDeflate: false, handshakeTimeout: timeoutMs });
        let ourClose: LegOutcome['closedBy'] | null = null;
        let errored = false;
        let pacer: NodeJS.Timeout | null = null;
        let done = false;

        const finish = (): void => {
            if (done) return;
            done = true;
            if (pacer) clearInterval(pacer);
            clearTimeout(giveUp);
            outcome.msToClose = Date.now() - t0;
            resolve(outcome);
        };
        const closeOurs = (by: LegOutcome['closedBy']): void => {
            if (ws.readyState !== ws.OPEN) return;
            ourClose ??= by;
            ws.close(1000, '');
        };
        const giveUp = setTimeout(() => {
            if (ws.readyState === ws.OPEN) {
                closeOurs('timeout');
                // A peer that never answers the close handshake is cut.
                setTimeout(() => { ws.terminate(); }, 2000).unref();
            } else {
                outcome.closedBy = 'timeout';
                ws.terminate();
                finish();
            }
        }, timeoutMs);

        ws.on('unexpected-response', (_req, res) => {
            outcome.httpStatus = res.statusCode ?? 0;
            outcome.closedBy = 'server';
            res.resume();
            ws.terminate();
            finish();
        });
        ws.on('error', (error: Error) => {
            outcome.error = /^[A-Za-z_$][\w$]*$/.test(error.name) ? error.name : 'Error';
            errored = true;
            if (!outcome.upgraded && outcome.httpStatus === null) {
                outcome.closedBy = 'error';
                finish();
            }
        });
        ws.on('close', (code: number, reason: Buffer) => {
            outcome.closeCode = code;
            outcome.closeReason = reason.length ? String(reason).slice(0, 64) : null;
            // 1006: the connection went without a close frame. After an error, or with no frame at
            // all, nobody ended the call cleanly: a reset or a crash must not read as a server end.
            outcome.closedBy = ourClose ?? (errored || code === 1006 ? 'error' : 'server');
            finish();
        });
        ws.on('message', (data, isBinary) => {
            if (isBinary) {
                outcome.received.binary = (outcome.received.binary ?? 0) + 1;
                return;
            }
            let message: { event?: unknown; streamSid?: unknown; media?: { payload?: unknown }; mark?: { name?: unknown } };
            try {
                message = JSON.parse(String(data)) as typeof message;
            } catch {
                outcome.received.unparseable = (outcome.received.unparseable ?? 0) + 1;
                return;
            }
            const event = typeof message.event === 'string' ? message.event : 'no_event';
            outcome.received[event] = (outcome.received[event] ?? 0) + 1;
            if (event === 'media' && typeof message.media?.payload === 'string') {
                if (!isSilentPayload(message.media.payload)) outcome.audibleFrames += 1;
            }
            // Twilio echoes a mark once the audio queued before it has played.
            if (event === 'mark' && ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({ event: 'mark', streamSid: STREAM_SID, mark: message.mark ?? {} }));
            }
        });
        ws.on('open', () => {
            outcome.upgraded = true;
            script(ws, plan, mediaMs, outcome, (timer) => { pacer = timer; }, () => closeOurs('client'));
        });
    });
}

export const STREAM_SID = 'MZsoakstream';
export const CALL_SID = 'CAsoakcall';

export function startMessage(customParameters: Record<string, string>): string {
    return JSON.stringify({
        event: 'start',
        sequenceNumber: '1',
        streamSid: STREAM_SID,
        start: {
            streamSid: STREAM_SID,
            callSid: CALL_SID,
            accountSid: 'ACsoakaccount',
            tracks: ['inbound'],
            mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: CARRIER_AUDIO.sampleRate, channels: 1 },
            customParameters,
        },
    });
}

export const CONNECTED = JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' });

function script(
    ws: WebSocket,
    plan: LegPlan,
    mediaMs: number,
    outcome: LegOutcome,
    setPacer: (timer: NodeJS.Timeout) => void,
    end: () => void,
): void {
    const send = (text: string): void => { if (ws.readyState === ws.OPEN) ws.send(text); };
    switch (plan.kind) {
        case 'twilio':
            send(CONNECTED);
            send(startMessage({ token: plan.token as string }));
            stream(ws, mediaMs, outcome, setPacer, end);
            return;
        case 'bad-token':
            send(CONNECTED);
            send(startMessage({ token: FORGED_TOKEN }));
            stream(ws, mediaMs, outcome, setPacer, end);
            return;
        case 'no-token':
            send(CONNECTED);
            send(startMessage({}));
            return;
        case 'garbage':
            send('{"event":"start", this is not json');
            return;
        case 'binary':
            if (ws.readyState === ws.OPEN) ws.send(Buffer.from([0xde, 0xad, 0xbe, 0xef]), { binary: true });
            return;
        case 'no-start':
            // Say nothing; the server's pre-auth deadline should close us.
            return;
    }
}

/** 20 ms paced caller audio, then `stop` and a normal close if the far side is still there. */
function stream(
    ws: WebSocket,
    mediaMs: number,
    outcome: LegOutcome,
    setPacer: (timer: NodeJS.Timeout) => void,
    end: () => void,
): void {
    const frames = Math.max(1, Math.round(mediaMs / CARRIER_AUDIO.frameMs));
    let i = 0;
    const timer = setInterval(() => {
        if (ws.readyState !== ws.OPEN) {
            clearInterval(timer);
            return;
        }
        if (i >= frames) {
            clearInterval(timer);
            ws.send(JSON.stringify({ event: 'stop', sequenceNumber: String(i + 2), streamSid: STREAM_SID, stop: { callSid: CALL_SID } }));
            end();
            return;
        }
        ws.send(JSON.stringify({
            event: 'media',
            sequenceNumber: String(i + 2),
            streamSid: STREAM_SID,
            media: { track: 'inbound', chunk: String(i + 1), timestamp: String(i * CARRIER_AUDIO.frameMs), payload: Buffer.from(speechFrame(i)).toString('base64') },
        }));
        outcome.sentMedia += 1;
        i += 1;
    }, CARRIER_AUDIO.frameMs);
    setPacer(timer);
}

/** True when every byte of a base64 μ-law payload is the silence byte. */
export function isSilentPayload(payload: string): boolean {
    const bytes = Buffer.from(payload, 'base64');
    for (const byte of bytes) if (byte !== MULAW_SILENCE) return false;
    return true;
}

/** The far side refused the leg: it refused the upgrade, or closed with `CLOSE_REFUSED`. */
export function refusedOnWire(outcome: LegOutcome): boolean {
    if (outcome.httpStatus !== null) return true;
    return outcome.closeCode === CLOSE_REFUSED.code && outcome.closeReason === CLOSE_REFUSED.reason;
}

/**
 * The safety reading of one leg, by what it was expected to be. Every leg must send no audio and
 * be ended by the server with a close frame (or a refused upgrade). Then:
 *
 *   - `refused`: the wire shows the refusal (`refusedOnWire`). A leg the server took and then hung
 *     up on is NOT a refusal, however silent: an auth bypass at the edge must fail here.
 *   - `accepted-silent`: the server took the call (the upgrade, and no refusal close), sent no
 *     audio (no agent is wired, or the agent ended before speaking), and ended it itself.
 */
export function judge(outcome: LegOutcome, expect: 'refused' | 'accepted-silent'): { pass: boolean; why: string[] } {
    const why: string[] = [];
    if (outcome.audibleFrames > 0) why.push(`${outcome.audibleFrames} audible outbound frame(s)`);
    if (outcome.closedBy !== 'server') {
        why.push(`closed by ${outcome.closedBy}, not the server${outcome.error ? ` (socket error ${outcome.error})` : ''}`);
    }
    const refused = refusedOnWire(outcome);
    if (expect === 'refused' && !refused) {
        why.push(`no refusal on the wire (close ${outcome.closeCode ?? 'none'} ${JSON.stringify(outcome.closeReason ?? '')})`);
    }
    if (expect === 'accepted-silent') {
        if (!outcome.upgraded) why.push('upgrade refused');
        else if (refused) why.push(`refused (close ${outcome.closeCode} ${JSON.stringify(outcome.closeReason ?? '')}), not accepted`);
    }
    return { pass: why.length === 0, why };
}
