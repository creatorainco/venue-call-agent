/**
 * THE BEEP GATE (venue-call plan it-05, gap I3P-11). A voicemail message spoken over the greeting is
 * a message nobody hears: the recording starts at the beep. When the agent has decided it reached a
 * voicemail, the call holds the voicemail script here until one of four things happens:
 *
 *   message_end  the carrier's answering-machine detection (Twilio AsyncAmd, DetectMessageEnd) says
 *                the greeting ended (`machine_end_*`), read through pb's POST /reservations/call-answerer;
 *   human        the same detection says a person answered: the held message is NOT spoken. The
 *                call leaves `voicemail` for `notice` and the agent answers the person (the cut-in,
 *                src/carrier/call.ts VOICEMAIL_HOLD_ACTION), re-reporting the answerer as human;
 *   undetermined Twilio's own bound ran out (`unknown`): it will say nothing more, speak now;
 *   fax          a fax tone: nobody will hear a message, hang up without speaking;
 *   timeout      no verdict inside the bound (30 s by default): speak anyway. A late message beats
 *                none, and the call cap still ends the call;
 *   unsupported  the backend has no call-answerer route (an HTTP 404, AnswererUnsupported): there
 *                is no answerer to wait for, so speak now, as a call without one does;
 *   aborted      the call ended or is draining.
 *
 * 🔴 A POLL THAT FAILS IS NOT A VERDICT. A seam error, a refusal or a null keeps waiting until the
 * bound. Treating an error as "speak now" would put the message over the greeting again, which is
 * the defect this file exists to remove; treating it as "human" would leave a voicemail silent. The
 * one exception is `AnswererUnsupported`: a route that does not exist will not start answering
 * inside 30 s, and waiting it out puts the message late into a recording already running.
 *
 * Pure and injectable: no seam client, no timers of its own beyond the `sleep` it is given, so the
 * tests drive it on a fake clock.
 */

export interface AnswererVerdict {
    answered_by: string | null;
    message_end: boolean;
}

export type BeepGateOutcome = 'message_end' | 'human' | 'undetermined' | 'fax' | 'timeout' | 'unsupported' | 'aborted';

/** The backend has no answering-machine verdict to give (its call-answerer route is missing). */
export class AnswererUnsupported extends Error {
    readonly route: string;

    constructor(route: string) {
        super(`no answerer at ${route}`);
        this.name = 'AnswererUnsupported';
        this.route = route;
    }
}

export interface BeepGateOptions {
    /** One read of the verdict (pb `call-answerer`). May throw; a throw keeps waiting. */
    poll: () => Promise<AnswererVerdict>;
    /** Between polls. 1.5 s keeps a 30 s hold at 20 seam requests, well inside the 120 / 15 min limiter. */
    intervalMs?: number;
    /** The bound on the whole hold. */
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Injected for tests. Resolves after `ms`, or early when `signal` aborts. */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    /** Injected for tests: milliseconds since some origin. */
    now?: () => number;
}

export const BEEP_GATE_INTERVAL_MS = 1500;
export const BEEP_GATE_TIMEOUT_MS = 30_000;

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        const t = setTimeout(done, ms);
        function done() {
            clearTimeout(t);
            signal?.removeEventListener('abort', done);
            resolve();
        }
        signal?.addEventListener('abort', done, { once: true });
    });
}

export async function awaitVoicemailBeep(
    opts: BeepGateOptions,
): Promise<{ outcome: BeepGateOutcome; waitedMs: number; polls: number; pollErrors: number }> {
    const intervalMs = Math.max(250, opts.intervalMs ?? BEEP_GATE_INTERVAL_MS);
    const timeoutMs = Math.max(0, opts.timeoutMs ?? BEEP_GATE_TIMEOUT_MS);
    const sleep = opts.sleep ?? defaultSleep;
    const now = opts.now ?? (() => performance.now());
    const start = now();
    let polls = 0;
    let pollErrors = 0;
    const done = (outcome: BeepGateOutcome) => ({ outcome, waitedMs: Math.round(now() - start), polls, pollErrors });

    for (;;) {
        if (opts.signal?.aborted) return done('aborted');
        try {
            polls++;
            const v = await opts.poll();
            if (opts.signal?.aborted) return done('aborted');
            if (v.message_end) return done('message_end');
            if (v.answered_by === 'human') return done('human');
            if (v.answered_by === 'unknown') return done('undetermined');
            if (v.answered_by === 'fax') return done('fax');
        } catch (error) {
            if (error instanceof AnswererUnsupported) return done('unsupported');
            pollErrors++;
        }
        const left = timeoutMs - (now() - start);
        if (left <= 0) return done('timeout');
        await sleep(Math.min(intervalMs, left), opts.signal);
        if (opts.signal?.aborted) return done('aborted');
        if (now() - start >= timeoutMs) return done('timeout');
    }
}
