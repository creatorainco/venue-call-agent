/**
 * The container's entrypoint: `node src/server/main.ts`, and `npm start` runs the same file.
 *
 * Binds all interfaces on `PORT` (Cloud Run sets it; locally `loadConfig` defaults it), points the
 * seam at `CREATORAIN_API_BASE_URL`, and drains on SIGTERM.
 *
 * 🔴 THE CALL AGENT IS THE CASCADE, BEHIND THE FAIL-CLOSED DEFAULT (I3P-01). `selectStartCall`
 * picks the session once, at boot:
 *
 *   - no `CREATORAIN_API_BASE_URL` (a local run against the mock default): `noAgentSession`,
 *     which hangs up through the supervisor with zero audio sent. Unchanged from before.
 *   - a backend named: `cascadeSession`, the live speech path (`liveCall` over `CascadeBridge`).
 *     If the cascade cannot start (no ADC, no project, a library that will not load), or is not
 *     ready within `CASCADE_READY_MS` of a call, that call gets `noAgentSession`: silence and a
 *     hangup, never a half-working voice.
 *
 * A backend that has not authorised the call never reaches either session: the stream server
 * closes the line before `startCall` (src/server/streamServer.ts), so a disabled seam stays silent.
 *
 * The cascade is started and warmed at boot, without holding up `listen`: the ADC token is
 * fetched, TLS is opened to the synthesis and intent hosts, and the four fixed phrases are
 * synthesised (I3P-04), so the first call does not pay for any of it.
 *
 * 🔴 THE WARM-UP IS RETRIED INSIDE A REQUEST (PERF-A). On Cloud Run the CPU is throttled outside
 * requests, so the boot warm-up of a fresh instance can die (`cascade_warm_failed TtsUnavailable`
 * in the dev log, 2026-11-14). Every stream upgrade and every call start asks the warmer again;
 * while the process is not warm that runs the warm-up, one at a time, inside the request that has
 * the CPU, before and during the disclosure. Once warm it is a no-op.
 *
 * 🔴 /health HOLDS THE CPU FOR THE WARM-UP (soak 2026-11-16, TASK-3749). platform-backend pings
 * `GET /health` on the stream host before it dials. A /health that answered at once let Cloud Run
 * throttle the CPU again, and the warm-up then took 6-10 s instead of ~2.2 s. So /health asks the
 * warmer and waits for it, at most `HEALTH_WARM_WAIT_MS`, before its 200; once warm it answers at
 * once. The warm-up also renders the backend's disclosure (src/agent/warmSentences.ts), the first
 * sentence every call says.
 */

import { loadConfig } from '../config.ts';
import { isEntryPoint } from '../harness/fixtures.ts';
import { CallSupervisor } from '../carrier/supervisor.ts';
import { createStreamServer } from './streamServer.ts';
import type { AuthorizedCall, StreamServer } from './streamServer.ts';
import { startCascade } from '../agent/cascade.ts';
import type { CascadeRuntime } from '../agent/cascade.ts';
import { FIXED_PHRASES } from '../agent/phrases.ts';
import { BACKEND_FIRST_SENTENCES } from '../agent/warmSentences.ts';
import { liveCall } from '../carrier/call.ts';
import { warmSilero } from '../speech/silero.ts';
import { warmSmartTurn } from '../speech/smartTurn.ts';

/**
 * Cloud Run allows ten seconds between SIGTERM and SIGKILL. A live call gets most of that to end
 * on its own before it is hung up, so the hangup is ours and not the kernel's. VCA-7: what is
 * left after the grace is the session's to post its `call_ended` (bounded by `SEAM_TIMEOUT_MS`)
 * plus a margin, so grace + `DRAIN_SETTLE_MS` stays at or under `DRAIN_BUDGET_MS` (9.5 s).
 */
export const DRAIN_GRACE_MS = 6500;

/** The silent session: hang up, once, having said nothing, and report it. The fail-closed default. */
export async function noAgentSession(call: AuthorizedCall): Promise<void> {
    const supervisor = new CallSupervisor(call.leg, {
        clock: () => call.leg.elapsedMs,
        log: call.log,
        // Nothing was said, so the report carries no turns and the disclosure was not heard.
        report: call.seam,
        shutdown: call.shutdown,
    });
    await supervisor.run(async () => {
        call.log(`stream ${call.leg.id} no_call_agent`);
        supervisor.stop('internal_error');
    });
}

/**
 * VCA-9: on Cloud Run (`K_SERVICE` is set there and nowhere we run by hand) the backend must be
 * named explicitly and reached over https. Without that the service would answer calls against the
 * local mock's default URL, or send capability tokens in clear text, so it refuses to start: a
 * failed revision is loud, a service that cannot authorise calls is not.
 */
export function assertDeployableBaseUrl(env: NodeJS.ProcessEnv): void {
    if (!env.K_SERVICE?.trim()) return;
    const raw = env.CREATORAIN_API_BASE_URL?.trim() ?? '';
    if (!raw) {
        throw new Error('venue-call-agent refuses to start on Cloud Run: CREATORAIN_API_BASE_URL is not set.');
    }
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new Error('venue-call-agent refuses to start on Cloud Run: CREATORAIN_API_BASE_URL is not a URL.');
    }
    if (url.protocol !== 'https:') {
        throw new Error('venue-call-agent refuses to start on Cloud Run: CREATORAIN_API_BASE_URL must be https.');
    }
}

/** How long a call waits for a cascade still starting before it is hung up silent instead. */
export const CASCADE_READY_MS = 5000;

export type StartCall = (call: AuthorizedCall) => Promise<void>;

/** What `startServer` needs from the session choice: the call handler and the upgrade hook. */
export interface Session {
    startCall: StartCall;
    /** Called on every stream upgrade the server takes, inside the request: warms a cold process. */
    onUpgrade?: () => void;
    /** Awaited (bounded) by GET/HEAD /health before its 200, so the probe holds the CPU for the warm-up. */
    onHealth?: () => Promise<void>;
}

export interface ServerDeps {
    /** Builds the per-process cascade. Defaults to `startCascade()` over ADC; tests inject a fake. */
    cascade?: () => Promise<CascadeRuntime>;
    log?: (line: string) => void;
}

/** The live path is on only when a backend is named. Anything else is the silent default. */
export function speechEnabled(env: NodeJS.ProcessEnv): boolean {
    return Boolean(env.CREATORAIN_API_BASE_URL?.trim());
}

/**
 * Pick the session for every call on this process. With no backend named it is `noAgentSession`,
 * and the cascade is never started (no Google client, no request). Otherwise the cascade starts
 * now, in the background, and warms itself.
 */
export function selectStartCall(env: NodeJS.ProcessEnv, deps: ServerDeps = {}): StartCall {
    return selectSession(env, deps).startCall;
}

/** `selectStartCall` plus the upgrade hook that warms a cold process inside a request. */
export function selectSession(env: NodeJS.ProcessEnv, deps: ServerDeps = {}): Session {
    if (!speechEnabled(env)) return { startCall: noAgentSession };
    const log = deps.log ?? ((line: string) => { process.stderr.write(`${line}\n`); });
    const runtime = (deps.cascade ?? (() => startCascade({ log })))();
    runtime.catch((error: unknown) => { log(`cascade_unavailable ${errorClass(error)}`); });
    // Best effort and never thrown: a cold first sentence is slower, not broken.
    const warmer = createWarmer(runtime, log);
    void warmer.ensure();
    return {
        startCall: cascadeSession(runtime, CASCADE_READY_MS, warmer),
        onUpgrade: () => { void warmer.ensure(); },
        onHealth: () => warmer.ensure(),
    };
}

/** One warm-up at a time; a failed one is tried again on the next ask. Never throws. */
export interface Warmer {
    /** Start the warm-up unless the process is warm or one is running. */
    ensure(): Promise<void>;
    readonly warm: boolean;
}

/**
 * The longest /health waits on the warm-up before it answers 200 anyway. Under platform-backend's
 * warm-ping timeout (`VENUE_CALL_WARM_PING_TIMEOUT_MS`, 3000) so the ping sees its answer, and far
 * under the uptime check's 30 s. Bounded because the service runs at concurrency 1: a /health in
 * flight holds the instance's one slot.
 */
export const HEALTH_WARM_WAIT_MS = 2500;

/** Everything the warm-up renders: the backend's first sentence and the four fixed phrases. */
export const WARM_PHRASES: readonly string[] = [...BACKEND_FIRST_SENTENCES, ...FIXED_PHRASES];

/** How many times one ask tries the warm-up before it waits for the next ask. */
export const WARM_ATTEMPTS = 2;

export function createWarmer(runtime: Promise<CascadeRuntime>, log: (line: string) => void, attempts: number = WARM_ATTEMPTS): Warmer {
    let warm = false;
    let running: Promise<void> | null = null;
    async function attempt(): Promise<void> {
        let rt: CascadeRuntime;
        try {
            rt = await runtime;
        } catch {
            return; // `cascade_unavailable` is logged once, by selectSession.
        }
        for (let n = 1; n <= attempts && !warm; n += 1) {
            const startedAt = Date.now();
            try {
                // TLS to the hosts a call uses, in parallel with the token, the disclosure and the fixed phrases.
                await Promise.all([rt.preconnect?.(), rt.tts.prerender(WARM_PHRASES), warmSilero(), warmSmartTurn()]);
                warm = true;
                log(`cascade_warm ms=${Date.now() - startedAt} attempt=${n}`);
            } catch (error) {
                log(`cascade_warm_failed ${errorClass(error)} attempt=${n}`);
            }
        }
    }
    return {
        get warm() { return warm; },
        ensure(): Promise<void> {
            if (warm) return Promise.resolve();
            running ??= attempt().finally(() => { running = null; });
            return running;
        },
    };
}

/** The live session: the cascade on this call's leg, or silence if the cascade is not there. */
export function cascadeSession(runtime: Promise<CascadeRuntime>, readyMs: number = CASCADE_READY_MS, warmer?: Warmer): StartCall {
    return async (call: AuthorizedCall): Promise<void> => {
        const startedAt = Date.now();
        void warmer?.ensure();
        const rt = await ready(runtime, readyMs);
        // How long the accepted call waited on the cascade: the staging probe reads it.
        const waitedMs = Date.now() - startedAt;
        if (rt === null) {
            call.log(`stream ${call.leg.id} cascade_unavailable waited_ms=${waitedMs}`);
            await noAgentSession(call);
            return;
        }
        call.log(`stream ${call.leg.id} cascade_ready waited_ms=${waitedMs}`);
        await liveCall({
            leg: call.leg,
            agent: rt.agentFor(call.seam, call.context),
            tts: rt.tts,
            speech: rt.speech,
            context: call.context,
            report: call.seam,
            log: call.log,
            shutdown: call.shutdown,
            ...(call.seam.callAnswerer ? { answerer: { poll: () => call.seam.callAnswerer!() } } : {}),
        });
    };
}

async function ready(runtime: Promise<CascadeRuntime>, ms: number): Promise<CascadeRuntime | null> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
    try {
        return await Promise.race([runtime.catch(() => null), late]);
    } finally {
        clearTimeout(timer);
    }
}

function errorClass(error: unknown): string {
    if (error instanceof Error) return /^[A-Za-z_$][\w$]*$/.test(error.name) ? error.name : 'Error';
    return typeof error;
}

export async function startServer(
    env: NodeJS.ProcessEnv = process.env,
    deps: ServerDeps = {},
): Promise<{ stream: StreamServer; port: number }> {
    assertDeployableBaseUrl(env);
    const config = loadConfig(env);
    const session = selectSession(env, deps);
    const stream = createStreamServer({
        apiBaseUrl: config.apiBaseUrl,
        startCall: session.startCall,
        ...(session.onUpgrade ? { onUpgrade: session.onUpgrade } : {}),
        ...(session.onHealth ? { onHealth: session.onHealth, healthWaitMs: HEALTH_WARM_WAIT_MS } : {}),
    });
    const port = await stream.listen(config.port, '0.0.0.0');
    return { stream, port };
}

if (isEntryPoint(import.meta.url)) {
    const { stream, port } = await startServer();
    process.stderr.write(`venue-call-agent listening on ${port}\n`);
    process.once('SIGTERM', () => {
        void stream.drain(DRAIN_GRACE_MS).then(() => process.exit(0));
    });
}
