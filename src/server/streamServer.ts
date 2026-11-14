/**
 * THE PUBLIC EDGE: the HTTP server Twilio's `<Connect><Stream>` connects to.
 *
 * The Cloud Run service is public (docs/DEPLOY.md §2), so every gate is here and every one closes
 * by default:
 *
 *   - `GET /health` (and `/healthz`) answers 200 with no body. Every other plain request is a 404.
 *     Cloud Run's front end reserves `/healthz` on run.app URLs and never forwards it, so the deployed
 *     probe is `/health`; `/healthz` stays for local runs and existing callers.
 *   - A WebSocket upgrade is accepted only on exactly `/stream`: no other path, no query string.
 *     Carrier and proxy logs keep URLs, so a token in one would already be a leak.
 *   - At most `MAX_PREAUTH_SOCKETS` sockets per instance may be waiting for the backend's yes,
 *     and a frame over `MAX_FRAME_BYTES` closes the socket.
 *   - A socket the backend has not accepted within `PREAUTH_DEADLINE_MS` of its upgrade is closed.
 *   - The token arrives in Twilio's `start` message and is passed, opaque, to the backend's
 *     call-context endpoint. ANY failure there closes the line: a refusal, an unknown reason, a
 *     timeout, an unreadable answer. There is no retry and no default.
 *   - `startCall` (where the recogniser, the synthesiser and the model live) runs only after the
 *     backend has returned a call context. A stranger who finds the URL costs one short socket and
 *     nothing on the Google bill.
 *   - One live call per instance (`MAX_CALLS`), matching Cloud Run's `--concurrency 1`.
 *
 * 🔴 THE LOGS ARE REDACTED BY CONSTRUCTION. A line carries the stream id this process assigned,
 * an event kind and, for a refusal, the reason word from the contract's closed set. Never the
 * token, never a phone number, never an error's message.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { createSeamClient, SeamRefusal } from '../seam/client.ts';
import type { SeamClient } from '../seam/client.ts';
import type { CallContext } from '../seam/types.ts';
import { TwilioLeg } from '../carrier/twilioLeg.ts';
import type { StreamStart, TwilioLegOptions } from '../carrier/twilioLeg.ts';
import type { HangupReason } from '../carrier/leg.ts';
import { SEAM_TIMEOUT_MS } from '../tuning/liveDefaults.ts';

/** Cloud Run's front end swallows `/healthz` on run.app URLs (a Google 404), so `/health` is the deployed probe. */
const HEALTH_PATHS: ReadonlySet<string> = new Set(['/health', '/healthz']);

/** From the upgrade to the backend's yes. Twilio sends `start` within milliseconds of connecting. */
export const PREAUTH_DEADLINE_MS = 3000;
/** Sockets per instance still waiting for the backend's yes. */
export const MAX_PREAUTH_SOCKETS = 2;
/** A Twilio media message is a few hundred bytes; 64 KB is generous and still bounded. */
export const MAX_FRAME_BYTES = 64 * 1024;
/** One call per instance. Cloud Run's `--concurrency 1` says the same thing at the edge. */
export const MAX_CALLS = 1;
/** The only path that upgrades. Compared whole, so a query string does not match. */
export const STREAM_PATH = '/stream';
/**
 * The window of the refusal-log limiter (VCA-3). The first preauth_full or preauth_deadline in a
 * window is logged as it happens; the rest are counted and logged once, as `suppressed=N`, when
 * the window closes. A stranger hammering the URL then costs two lines per window, not one each.
 */
export const LOG_WINDOW_MS = 10_000;
/**
 * VCA-7: after a drain's forced hangup, what is left of Cloud Run's ten seconds for each live
 * session to post its `call_ended` and return. The post is bounded by `SEAM_TIMEOUT_MS`; the
 * margin covers the hangup itself and the server close. `DRAIN_GRACE_MS` in `main.ts` is sized so
 * that grace + this stays at or under `DRAIN_BUDGET_MS`.
 */
export const DRAIN_MARGIN_MS = 500;
export const DRAIN_SETTLE_MS = SEAM_TIMEOUT_MS + DRAIN_MARGIN_MS;
/** Cloud Run sends SIGKILL ten seconds after SIGTERM; the drain must be over half a second before. */
export const DRAIN_BUDGET_MS = 9500;

/** A call the backend has accepted. Everything a call session needs, and nothing it must not have. */
export interface AuthorizedCall {
    /** Live: `accept()` has been called, audio flows both ways. */
    leg: TwilioLeg;
    /** Bound to this call's token. The session never sees the token itself. */
    seam: SeamClient;
    /**
     * The context the backend returned when it accepted the token. The contract reads it once
     * before the first word, so a session uses this one rather than asking again.
     */
    context: CallContext;
    log: (line: string) => void;
    /**
     * Aborted when a SIGTERM drain's grace is over, just before the server hangs the line up.
     * Hand it to the call's `CallSupervisor` so the call ends, and reports, as a shutdown.
     */
    shutdown: AbortSignal;
}

export interface StreamServerOptions {
    /** The backend that owns the seam. */
    apiBaseUrl: string;
    /**
     * Run one authorised call. The ONLY place a recogniser, synthesiser or model session may open.
     * When it returns or throws, the server hangs up if the session left the line up.
     */
    startCall: (call: AuthorizedCall) => Promise<void>;
    seamTimeoutMs?: number;
    /** Injectable for tests. Defaults to the global fetch. */
    fetchImpl?: typeof fetch;
    preAuthMs?: number;
    maxPreAuthSockets?: number;
    maxFrameBytes?: number;
    maxCalls?: number;
    log?: (line: string) => void;
    /** The window of the refusal-log limiter. Defaults to `LOG_WINDOW_MS`. */
    logWindowMs?: number;
    /** Pacer and clock overrides for the legs, for tests. */
    leg?: Pick<TwilioLegOptions, 'now' | 'every' | 'leadFrames'>;
}

export interface StreamServerStats {
    preAuth: number;
    calls: number;
    /** Sockets the backend accepted, over the life of the process. */
    accepted: number;
    /** Sockets closed before the backend accepted them, over the life of the process. */
    closedBeforeAccept: number;
    /** Upgrades refused because every pre-auth slot was taken. Counted whether or not logged. */
    refusedFull: number;
    /** Sockets closed by the pre-auth deadline. Counted whether or not logged. */
    preAuthDeadlines: number;
}

export interface StreamServer {
    readonly server: Server;
    /** Listen on all interfaces unless told otherwise. Resolves with the bound port. */
    listen(port: number, host?: string): Promise<number>;
    /**
     * SIGTERM. Refuse new sockets, close every unaccepted one, give live calls `graceMs` to end on
     * their own, then abort their `shutdown` signal and hang them up. Then wait up to `settleMs`
     * (default `DRAIN_SETTLE_MS`) for each session to post its `call_ended` and return, and close
     * the server.
     */
    drain(graceMs: number, settleMs?: number): Promise<void>;
    stats(): StreamServerStats;
}

interface Connection {
    id: string;
    leg: TwilioLeg | null;
    socket: Duplex;
    /** Holding a pre-auth slot. */
    preAuth: boolean;
    /** Accepted by the backend and handed to `startCall`. */
    live: boolean;
    /** `start` arrived and the backend has been asked. */
    waitingOnSeam: boolean;
    deadline: NodeJS.Timeout | null;
    /** Live calls only: aborted by the drain. */
    shutdown: AbortController | null;
}

export function createStreamServer(options: StreamServerOptions): StreamServer {
    const log = options.log ?? ((line: string) => { process.stderr.write(`${line}\n`); });
    const preAuthMs = options.preAuthMs ?? PREAUTH_DEADLINE_MS;
    const maxPreAuth = options.maxPreAuthSockets ?? MAX_PREAUTH_SOCKETS;
    const maxCalls = options.maxCalls ?? MAX_CALLS;
    const seamTimeoutMs = options.seamTimeoutMs ?? SEAM_TIMEOUT_MS;

    const wss = new WebSocketServer({
        noServer: true,
        maxPayload: options.maxFrameBytes ?? MAX_FRAME_BYTES,
        perMessageDeflate: false,
        clientTracking: false,
    });

    const connections = new Set<Connection>();
    let seq = 0;
    let preAuth = 0;
    let calls = 0;
    let accepted = 0;
    let closedBeforeAccept = 0;
    let refusedFull = 0;
    let deadlines = 0;
    let draining = false;
    const callsDone = new Set<() => void>();
    // VCA-3: a flood of refused upgrades costs at most two log lines per window, not one each.
    const logWindowMs = options.logWindowMs ?? LOG_WINDOW_MS;
    const preauthFullLog = windowedLog(log, 'preauth_full', logWindowMs);
    const deadlineLog = windowedLog(log, 'preauth_deadline', logWindowMs);

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        if ((req.method === 'GET' || req.method === 'HEAD') && HEALTH_PATHS.has(req.url ?? '')) {
            res.writeHead(draining ? 503 : 200, { 'Content-Length': '0' }).end();
            return;
        }
        res.writeHead(404, { 'Content-Length': '0' }).end();
    });

    const releasePreAuth = (conn: Connection): void => {
        if (!conn.preAuth) return;
        conn.preAuth = false;
        preAuth -= 1;
        if (conn.deadline) clearTimeout(conn.deadline);
        conn.deadline = null;
    };

    const forget = (conn: Connection): void => {
        if (!connections.has(conn)) return;
        connections.delete(conn);
        if (conn.preAuth) closedBeforeAccept += 1;
        releasePreAuth(conn);
    };

    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        if (draining) return refuse(socket, 503);
        if (req.method !== 'GET' || req.url !== STREAM_PATH) return refuse(socket, 404);
        if (preAuth >= maxPreAuth) {
            refusedFull += 1;
            preauthFullLog.note('stream-server preauth_full');
            return refuse(socket, 503);
        }

        seq += 1;
        const conn: Connection = {
            id: `stream-${seq}`,
            leg: null,
            socket,
            preAuth: true,
            live: false,
            waitingOnSeam: false,
            deadline: null,
            shutdown: null,
        };
        preAuth += 1;
        connections.add(conn);
        // The slot is released however the socket goes: a failed handshake never reaches the
        // callback below, and must not keep the slot.
        socket.once('close', () => forget(conn));
        conn.deadline = setTimeout(() => {
            if (!conn.preAuth) return;
            deadlines += 1;
            deadlineLog.note(`stream ${conn.id} preauth_deadline`);
            // Waiting on the backend is the backend not answering; no `start` is a peer that is not Twilio.
            if (conn.leg) hangupQuietly(conn, conn.leg, conn.waitingOnSeam ? 'seam_stopped' : 'transport_failed');
            else socket.destroy();
        }, preAuthMs);

        wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
            if (!conn.preAuth) {
                // The deadline fired during the handshake.
                ws.terminate();
                return;
            }
            const leg = new TwilioLeg({
                id: conn.id,
                socket: {
                    send: (text) => ws.send(text),
                    close: (code, reason) => ws.close(code, reason),
                },
                log,
                ...(options.leg ?? {}),
            });
            conn.leg = leg;
            // VCA-1: a leg handler that throws would otherwise escape a socket event and take the
            // whole process (and any other call on it) down. It ends this call instead.
            const guarded = (fn: () => void): void => {
                try {
                    fn();
                } catch (error) {
                    log(`stream ${conn.id} handler_failed ${errorClass(error)}`);
                    hangupQuietly(conn, leg, 'internal_error');
                }
            };
            ws.on('message', (data, isBinary) => {
                guarded(() => {
                    if (isBinary) leg.receiveBinary();
                    else leg.receive(rawToString(data));
                });
            });
            ws.on('close', () => guarded(() => leg.socketClosed()));
            ws.on('error', (error) => {
                log(`stream ${conn.id} socket_error ${errorClass(error)}`);
                guarded(() => leg.socketClosed());
            });
            leg.on('hangup', () => {
                // A pre-auth socket that ended (a violation, the far end, the deadline) frees its
                // slot now, not when the TCP close finally arrives.
                if (conn.preAuth) {
                    closedBeforeAccept += 1;
                    releasePreAuth(conn);
                }
            });
            leg.onStart((start) => {
                // VCA-2: not fire-and-forget. Whatever escapes authorize ends this call, once.
                authorize(conn, leg, start).catch((error: unknown) => {
                    log(`stream ${conn.id} authorize_failed ${errorClass(error)}`);
                    if (!leg.ended) hangupQuietly(conn, leg, 'internal_error');
                });
            });
        });
    });

    /**
     * `leg.hangup`, from a place nobody awaits. A hangup handler that throws is logged by class and
     * goes no further: the line is already down, and the rejection must not end the process.
     */
    function hangupQuietly(conn: Connection, leg: TwilioLeg, reason: HangupReason): void {
        leg.hangup(reason).catch((error: unknown) => {
            log(`stream ${conn.id} hangup_handler_failed ${errorClass(error)}`);
        });
    }

    /** Resolves when no call is live, or after `ms`, whichever is first. */
    function untilNoCalls(ms: number): Promise<void> {
        if (calls === 0) return Promise.resolve();
        return new Promise<void>((resolve) => {
            const timer = setTimeout(finish, ms);
            function finish(): void {
                clearTimeout(timer);
                callsDone.delete(check);
                resolve();
            }
            function check(): void { if (calls === 0) finish(); }
            callsDone.add(check);
        });
    }

    async function authorize(conn: Connection, leg: TwilioLeg, start: StreamStart): Promise<void> {
        if (calls >= maxCalls || draining) {
            log(`stream ${conn.id} busy`);
            await leg.hangup('internal_error');
            return;
        }

        const seam = createSeamClient({
            baseUrl: options.apiBaseUrl,
            token: start.token,
            timeoutMs: seamTimeoutMs,
            log,
            ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        });

        let context: CallContext;
        conn.waitingOnSeam = true;
        try {
            context = await seam.callContext();
        } catch (error) {
            if (leg.ended) return;
            log(`stream ${conn.id} ${error instanceof SeamRefusal ? `seam_refused ${error.reason}` : 'seam_unavailable'}`);
            await leg.hangup('seam_stopped');
            return;
        }

        // The deadline fired, the far end left, or a violation closed it while we waited.
        if (leg.ended || !conn.preAuth) return;
        if (calls >= maxCalls || draining) {
            log(`stream ${conn.id} busy`);
            await leg.hangup('internal_error');
            return;
        }

        releasePreAuth(conn);
        conn.live = true;
        conn.shutdown = new AbortController();
        calls += 1;
        accepted += 1;
        log(`stream ${conn.id} accepted`);
        try {
            leg.accept();
            await options.startCall({ leg, seam, context, log, shutdown: conn.shutdown.signal });
        } catch (error) {
            log(`stream ${conn.id} call_failed ${errorClass(error)}`);
        } finally {
            if (!leg.ended) {
                log(`stream ${conn.id} session_left_line_up`);
                // Quietly: a throwing hangup handler here must not skip the slot release below,
                // or every later call on this instance would be refused as busy.
                hangupQuietly(conn, leg, 'internal_error');
            }
            calls -= 1;
            conn.live = false;
            for (const done of callsDone) done();
        }
    }

    return {
        server,

        listen(port: number, host = '0.0.0.0'): Promise<number> {
            return new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(port, host, () => {
                    server.off('error', reject);
                    const address = server.address();
                    resolve(typeof address === 'object' && address ? address.port : port);
                });
            });
        },

        async drain(graceMs: number, settleMs: number = DRAIN_SETTLE_MS): Promise<void> {
            draining = true;
            for (const conn of connections) {
                if (conn.live) continue;
                if (conn.leg) hangupQuietly(conn, conn.leg, 'transport_failed');
                else conn.socket.destroy();
            }
            await untilNoCalls(graceMs);
            // VCA-7: the signal first, so each session's supervisor sees the drain before the line
            // goes down, sends the one hangup itself and reports the call as a shutdown. One turn
            // of the event loop lets it; a session with no supervisor is then hung up here.
            let aborted = false;
            for (const conn of connections) {
                if (conn.shutdown && !conn.shutdown.signal.aborted) {
                    conn.shutdown.abort();
                    aborted = true;
                }
            }
            if (aborted) await new Promise<void>((resolve) => { setImmediate(resolve); });
            for (const conn of connections) {
                if (conn.leg && !conn.leg.ended) {
                    log(`stream ${conn.id} drain_forced_hangup`);
                    hangupQuietly(conn, conn.leg, 'internal_error');
                }
            }
            // VCA-7: each session posts its call_ended from its supervisor's finally. Wait for
            // that, bounded, rather than closing the process under the post.
            await untilNoCalls(settleMs);
            preauthFullLog.flush();
            deadlineLog.flush();
            wss.close();
            await new Promise<void>((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections();
            });
        },

        stats(): StreamServerStats {
            return { preAuth, calls, accepted, closedBeforeAccept, refusedFull, preAuthDeadlines: deadlines };
        },
    };
}

interface WindowedLog {
    /** Log `line` if it opens a window, else count it. */
    note(line: string): void;
    /** Close the current window now: log the suppressed count, if any. */
    flush(): void;
}

function windowedLog(log: (line: string) => void, kind: string, windowMs: number): WindowedLog {
    let timer: NodeJS.Timeout | null = null;
    let suppressed = 0;
    const flush = (): void => {
        if (timer) clearTimeout(timer);
        timer = null;
        if (suppressed > 0) log(`stream-server ${kind} suppressed=${suppressed}`);
        suppressed = 0;
    };
    return {
        note(line: string): void {
            if (timer) {
                suppressed += 1;
                return;
            }
            log(line);
            timer = setTimeout(flush, windowMs);
            timer.unref();
        },
        flush,
    };
}

/** Answer an upgrade we will not take with a bare status line, then drop the socket. */
function refuse(socket: Duplex, status: 404 | 503): void {
    const text = status === 404 ? 'Not Found' : 'Service Unavailable';
    socket.once('finish', () => socket.destroy());
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function rawToString(data: Buffer | ArrayBuffer | Buffer[]): string {
    if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
    return data.toString('utf8');
}

/** The error's class name and nothing else. Its message may hold a token or what somebody said. */
function errorClass(error: unknown): string {
    if (error instanceof Error) return /^[A-Za-z_$][\w$]*$/.test(error.name) ? error.name : 'Error';
    return typeof error;
}
