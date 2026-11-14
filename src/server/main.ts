/**
 * The container's entrypoint: `node src/server/main.ts`, and `npm start` runs the same file.
 *
 * Binds all interfaces on `PORT` (Cloud Run sets it; locally `loadConfig` defaults it), points the
 * seam at `CREATORAIN_API_BASE_URL`, and drains on SIGTERM.
 *
 * 🔴 NO CALL AGENT IS WIRED YET, AND THE DEFAULT SESSION SAYS NOTHING. The cascade's brain
 * (`src/agent/cascade.ts`: speech in, closed intent, backend sentence, speech out) exists; its
 * audio path over the Twilio leg is the next step of TASK-3748. Until that lands, a call the
 * backend accepts is hung up at once by `noAgentSession`, through the supervisor, with zero audio
 * sent: no disclosure, no sentence, nothing a restaurant could hear. That is the fail-closed shape
 * of "the agent is missing", and it is what the dev probe in TASK-3748 step 5 observes.
 */

import { loadConfig } from '../config.ts';
import { isEntryPoint } from '../harness/fixtures.ts';
import { CallSupervisor } from '../carrier/supervisor.ts';
import { createStreamServer } from './streamServer.ts';
import type { AuthorizedCall, StreamServer } from './streamServer.ts';

/**
 * Cloud Run allows ten seconds between SIGTERM and SIGKILL. A live call gets most of that to end
 * on its own before it is hung up, so the hangup is ours and not the kernel's.
 */
export const DRAIN_GRACE_MS = 8000;

/** The session used while no call agent exists: hang up, once, having said nothing. */
export async function noAgentSession(call: AuthorizedCall): Promise<void> {
    const supervisor = new CallSupervisor(call.leg, { clock: () => call.leg.elapsedMs, log: call.log });
    await supervisor.run(async () => {
        call.log(`stream ${call.leg.id} no_call_agent`);
        supervisor.stop('internal_error');
    });
}

export async function startServer(env: NodeJS.ProcessEnv = process.env): Promise<{ stream: StreamServer; port: number }> {
    const config = loadConfig(env);
    const stream = createStreamServer({ apiBaseUrl: config.apiBaseUrl, startCall: noAgentSession });
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
