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
 * fetched and the four fixed phrases are synthesised, which also opens TLS to the synthesis host
 * (I3P-04), so the first call does not pay for either.
 */

import { loadConfig } from '../config.ts';
import { isEntryPoint } from '../harness/fixtures.ts';
import { CallSupervisor } from '../carrier/supervisor.ts';
import { createStreamServer } from './streamServer.ts';
import type { AuthorizedCall, StreamServer } from './streamServer.ts';
import { startCascade } from '../agent/cascade.ts';
import type { CascadeRuntime } from '../agent/cascade.ts';
import { FIXED_PHRASES } from '../agent/phrases.ts';
import { liveCall } from '../carrier/call.ts';

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
    if (!speechEnabled(env)) return noAgentSession;
    const log = deps.log ?? ((line: string) => { process.stderr.write(`${line}\n`); });
    const runtime = (deps.cascade ?? (() => startCascade({ log })))();
    runtime.then(
        (rt) => warm(rt, log),
        (error: unknown) => { log(`cascade_unavailable ${errorClass(error)}`); },
    );
    return cascadeSession(runtime);
}

/** Best effort and never thrown: a cold first sentence is slower, not broken. */
async function warm(runtime: CascadeRuntime, log: (line: string) => void): Promise<void> {
    try {
        await runtime.tts.prerender(FIXED_PHRASES);
        log('cascade_warm');
    } catch (error) {
        log(`cascade_warm_failed ${errorClass(error)}`);
    }
}

/** The live session: the cascade on this call's leg, or silence if the cascade is not there. */
export function cascadeSession(runtime: Promise<CascadeRuntime>, readyMs: number = CASCADE_READY_MS): StartCall {
    return async (call: AuthorizedCall): Promise<void> => {
        const startedAt = Date.now();
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
    const stream = createStreamServer({ apiBaseUrl: config.apiBaseUrl, startCall: selectStartCall(env, deps) });
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
