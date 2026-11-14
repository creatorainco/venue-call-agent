/**
 * THE FAKE CARRIER: a client that opens the media WebSocket the way Twilio's `<Connect><Stream>`
 * does, and records what the far side did with it (TASK-3749 step 1, the driver).
 *
 * It places no call and reaches no carrier. It is a WebSocket client and nothing else: point it at
 * a local `npm start`, or at the dev Cloud Run service, and it plays the part of the phone line.
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
 * upgrade was taken, who closed, with what code, how long it took, and every outbound message by
 * event kind. A `media` frame whose payload is not all μ-law silence is counted as AUDIO, because
 * the first safety property of a refused or unwired call is that it says nothing.
 *
 * 🔴 NEVER LOG THE TOKEN. The outcome carries the leg kind, not the token it was given.
 */

import { WebSocket } from 'ws';
import { CARRIER_AUDIO, MULAW_SILENCE } from '../audio/format.ts';
import { speechFrame } from '../carrier/fakeLeg.ts';

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
    /** Who ended it: the server, us after our script finished, or us at the timeout. */
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

export async function runLeg(url: string, plan: LegPlan): Promise<LegOutcome> {
    if (plan.kind === 'twilio' && !plan.token) throw new Error('a twilio leg needs a token');
    const mediaMs = plan.mediaMs ?? 3000;
    const timeoutMs = plan.timeoutMs ?? 15_000;
    const t0 = Date.now();
    const outcome: LegOutcome = {
        kind: plan.kind,
        upgraded: false,
        httpStatus: null,
        closeCode: null,
        closedBy: 'server',
        msToClose: 0,
        received: {},
        audibleFrames: 0,
        sentMedia: 0,
        error: null,
    };

    return new Promise<LegOutcome>((resolve) => {
        const ws = new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: timeoutMs });
        let ourClose: LegOutcome['closedBy'] | null = null;
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
            if (ws.readyState !== WebSocket.OPEN) return;
            ourClose ??= by;
            ws.close(1000, '');
        };
        const giveUp = setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) {
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
            if (!outcome.upgraded && outcome.httpStatus === null) {
                outcome.closedBy = 'error';
                finish();
            }
        });
        ws.on('close', (code: number) => {
            outcome.closeCode = code;
            outcome.closedBy = ourClose ?? 'server';
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
            if (event === 'mark' && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ event: 'mark', streamSid: STREAM_SID, mark: message.mark ?? {} }));
            }
        });
        ws.on('open', () => {
            outcome.upgraded = true;
            script(ws, plan, mediaMs, outcome, (timer) => { pacer = timer; }, () => closeOurs('client'));
        });
    });
}

const STREAM_SID = 'MZsoakstream';
const CALL_SID = 'CAsoakcall';

function startMessage(customParameters: Record<string, string>): string {
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

const CONNECTED = JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' });

function script(
    ws: WebSocket,
    plan: LegPlan,
    mediaMs: number,
    outcome: LegOutcome,
    setPacer: (timer: NodeJS.Timeout) => void,
    end: () => void,
): void {
    const send = (text: string): void => { if (ws.readyState === WebSocket.OPEN) ws.send(text); };
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
            if (ws.readyState === WebSocket.OPEN) ws.send(Buffer.from([0xde, 0xad, 0xbe, 0xef]), { binary: true });
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
        if (ws.readyState !== WebSocket.OPEN) {
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

/**
 * The safety reading of one leg, by what it was expected to be.
 *
 *   - `refused`: the server ended it (a refused upgrade or a server-side close), and sent no audio.
 *   - `accepted-silent`: the server took the call, sent no audio (no agent is wired, or the agent
 *     ended before speaking), and ended it itself.
 */
export function judge(outcome: LegOutcome, expect: 'refused' | 'accepted-silent'): { pass: boolean; why: string[] } {
    const why: string[] = [];
    if (outcome.audibleFrames > 0) why.push(`${outcome.audibleFrames} audible outbound frame(s)`);
    if (outcome.closedBy !== 'server') why.push(`closed by ${outcome.closedBy}, not the server`);
    if (outcome.error && outcome.closedBy === 'error') why.push(`socket error ${outcome.error}`);
    if (expect === 'accepted-silent' && !outcome.upgraded) why.push('upgrade refused');
    return { pass: why.length === 0, why };
}
