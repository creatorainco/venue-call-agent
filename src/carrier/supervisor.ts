/**
 * THE CALL SUPERVISOR: whatever happens inside a call, the line is hung up exactly once.
 *
 * 🔴 WHY THIS EXISTS. Before it, the call loop in `src/carrier/call.ts` hung up on ONE path: the
 * agent saying goodbye. Three other ways out left a live line behind them:
 *
 *   1. an exception from the agent or the loop was rethrown out of `guard()`, and the only
 *      `finally` closed the mock backend, not the call;
 *   2. a seam refusal or an unreachable seam mid-call `break`s out of the loop with nobody
 *      hanging up — and a refusal on `open()` never entered the loop at all;
 *   3. the call cap belonged to the fake leg, which ends itself at `maxMs`. A real carrier leg
 *      has no such clock, so on a real line nothing enforced `MAX_CALL_SECONDS`.
 *
 * On a fake leg each of these is a test that quietly ends. On a real carrier each is a silent open
 * call, billed by the minute, with a restaurant on the other end wondering who is breathing.
 *
 * WHAT IT DOES. `run(body)` is `try { body } catch { log, end reason internal_error } finally
 * { hang up }`. The body says why it is stopping with `stop(reason)` and breaks; it never has to
 * remember to hang up, because the `finally` does it whichever way the body left. `hangup()` is
 * one-shot, so the agent-ended path can hang up early (after its last sentence drains) and the
 * `finally` then sends nothing more: exactly one hangup per call, which `hung_up_once` in
 * `src/carrier/checks.ts` grades on every call.
 *
 * 🔴 THE CAP IS POLLED AND ALSO ARMED (VCA-6). `overCap()` compares the clock it is given against
 * the cap, and the loop asks once per frame. On the fake leg the clock is the leg's virtual one,
 * so a six-minute call is deterministic and takes a second. Polling cannot bound a turn that never
 * returns (an `await agent.hear()` that hangs stops the polling with it), so `run` also arms a
 * timer for whatever is left of the cap. When it fires, the call is hung up with `call_too_long`,
 * the body's `AbortSignal` aborts, and `run` returns without waiting for the body. The fake-call
 * runner turns the timer off (`capTimer: null`): its virtual clock and the fake leg's own backstop
 * already bound it, and a wall-clock timer there would race a clock it does not share.
 *
 * 🔴 THE END OF THE CALL IS REPORTED, ONCE (VCA-5). Given a `report` (the call's seam client),
 * the `finally` posts one `call_ended` after the hangup, on every way out: the agent's goodbye, the
 * far end hanging up, the cap, a seam refusal, a body that threw, and a SIGTERM drain (`shutdown`).
 * It is best-effort and bounded by `SEAM_TIMEOUT_MS`: a backend that is down or refuses costs one
 * redacted log line, never a second hangup and never an exception out of `run`. One report per
 * call, so its `seq` is 1; the backend treats the same or an older `seq` as a no-op.
 *
 * 🔴 A DRAIN IS ITS OWN END (VCA-7). The stream server aborts `shutdown` when SIGTERM's grace is
 * over. The supervisor then stops waiting for the body, as it does at the cap, hangs up and
 * reports `end_reason: 'shutdown'`, so the post lands inside Cloud Run's ten seconds rather than
 * racing the kill.
 *
 * 🔴 THE LOG IS REDACTED BY CONSTRUCTION. An error's message can carry what the far end said, a
 * phone number or a token, so it never reaches a log line. A line carries the call id, the event
 * kind and the error's class name, and nothing else.
 */

import type { CallLegEvents, HangupReason } from './leg.ts';
import { MAX_CALL_SECONDS, SEAM_TIMEOUT_MS } from '../tuning/liveDefaults.ts';
import { MAX_TURN_CHARS, MAX_TURNS } from '../seam/types.ts';
import type { CallEventInput, EndReason, Turn } from '../seam/types.ts';

/** What the supervisor needs of a leg. `OutputGate` and every `CallLeg` both qualify. */
export interface Hangable {
    readonly id: string;
    on(event: 'hangup', handler: CallLegEvents['hangup']): void;
    hangup(reason: HangupReason): Promise<void>;
}

export interface SupervisorOptions {
    /** Milliseconds of call time since the line was answered. */
    clock: () => number;
    /** The call cap. Defaults to `MAX_CALL_SECONDS` in src/tuning/liveDefaults.ts. */
    maxCallMs?: number;
    /** One line per event. Defaults to stderr. */
    log?: (line: string) => void;
    /**
     * Arms the cap: call `fire` after `ms`, return a cancel. Defaults to an unref'd `setTimeout`.
     * `null` turns the armed cap off and leaves only the polled one (the fake-call runner).
     */
    capTimer?: CapTimer | null;
    /**
     * Where the one `call_ended` goes: the call's seam client. Without it nothing is reported
     * (the fake-call runner, unit tests of the hangup alone).
     */
    report?: CallEndedSink;
    /** What the report carries: the turns and whether the disclosure played whole. */
    record?: () => CallRecord;
    /** Aborted by the stream server when a SIGTERM drain's grace is over. */
    shutdown?: AbortSignal;
    /** The bound on the report. Defaults to `SEAM_TIMEOUT_MS`. */
    reportTimeoutMs?: number;
}

/** Anything that takes a call event; `SeamClient` qualifies. */
export interface CallEndedSink {
    callEvent(input: CallEventInput): Promise<unknown>;
}

export interface CallRecord {
    turns: Turn[];
    disclosureHeard: boolean;
}

/** A call that said nothing: no turns, and the disclosure was not heard. */
const SILENT_CALL: CallRecord = { turns: [], disclosureHeard: false };

/** The one report a call makes. A later, fuller report would carry a higher number. */
export const CALL_ENDED_SEQ = 1;

/** The contract's `end_reason` for the reason the line was hung up with. */
export function endReasonFor(reason: HangupReason, shutdown = false): EndReason {
    if (shutdown) return 'shutdown';
    switch (reason) {
        case 'agent_ended': return 'completed';
        case 'far_end_hung_up': return 'venue_hung_up';
        case 'call_too_long': return 'max_duration';
        case 'seam_stopped': return 'refused';
        case 'transport_failed':
        case 'timeline_exhausted':
        case 'internal_error':
            return 'stream_error';
    }
}

export type CapTimer = (fire: () => void, ms: number) => () => void;

const wallTimer: CapTimer = (fire, ms) => {
    const timer = setTimeout(fire, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
};

export class CallSupervisor {
    private readonly target: Hangable;
    private readonly clock: () => number;
    private readonly maxCallMs: number;
    private readonly log: (line: string) => void;
    private readonly capTimer: CapTimer | null;

    private stopReason: HangupReason | null = null;
    private endedBy: HangupReason | null = null;
    private sent: HangupReason | null = null;
    private crashed = false;
    private readonly report: CallEndedSink | null;
    private readonly record: () => CallRecord;
    private readonly shutdown: AbortSignal | null;
    private readonly reportTimeoutMs: number;
    /** The drain arrived while the line was still up. */
    private shutDown = false;
    private reported = false;

    constructor(target: Hangable, options: SupervisorOptions) {
        this.target = target;
        this.clock = options.clock;
        this.maxCallMs = options.maxCallMs ?? MAX_CALL_SECONDS * 1000;
        this.log = options.log ?? ((line) => { process.stderr.write(`${line}\n`); });
        this.capTimer = options.capTimer === undefined ? wallTimer : options.capTimer;
        this.report = options.report ?? null;
        this.record = options.record ?? (() => SILENT_CALL);
        this.shutdown = options.shutdown ?? null;
        this.reportTimeoutMs = options.reportTimeoutMs ?? SEAM_TIMEOUT_MS;
        // Registered before anything else can end the line, so a drain's own forced hangup on the
        // leg (which follows the abort) still finds the call up and is reported as the shutdown.
        // A drain that lands after the body said stop('agent_ended') but before the hangup is
        // reported as end_reason shutdown, not completed. Accepted: the call was cut short by the
        // drain either way, and the hangup that follows is the drain's.
        const onShutdown = (): void => {
            if (this.sent === null && this.endedBy === null) this.shutDown = true;
        };
        if (this.shutdown?.aborted) onShutdown();
        else this.shutdown?.addEventListener('abort', onShutdown, { once: true });
        target.on('hangup', (reason) => { this.endedBy ??= reason; });
    }

    /** True once one `call_ended` has been attempted for this call. */
    get endReported(): boolean { return this.reported; }

    /** True once the body threw. The call is then graded as an internal error, whatever else happened. */
    get failed(): boolean { return this.crashed; }

    /** Why the body is stopping, if it said. */
    get stopping(): HangupReason | null { return this.stopReason; }

    /** The reason the one hangup was sent with, or null before it was. */
    get hungUpWith(): HangupReason | null { return this.sent; }

    /** The call has reached its cap. The loop asks once per frame. */
    overCap(): boolean {
        return this.clock() >= this.maxCallMs;
    }

    /** Record why the call is ending. The first reason wins; the hangup itself happens in `run`. */
    stop(reason: HangupReason): void {
        this.stopReason ??= reason;
    }

    /**
     * Hang up now. One-shot: a second call, including the one `run`'s `finally` makes, sends
     * nothing. Sent even when the far end already hung up, because "they left" is not proof the
     * carrier tore the call down, and a carrier hangup on an ended call is a no-op.
     */
    async hangup(reason: HangupReason): Promise<void> {
        if (this.sent !== null) return;
        this.sent = reason;
        this.stopReason ??= reason;
        await this.target.hangup(reason);
    }

    /**
     * Run the live part of a call. Never throws for the body: an error is logged, redacted, and
     * becomes `internal_error`. The `finally` hangs up whichever way the body left. The body is
     * given a signal that aborts when the armed cap fires; `run` does not wait for it after that.
     */
    async run(body: (signal: AbortSignal) => Promise<void>): Promise<void> {
        const controller = new AbortController();
        let cancelCap = (): void => {};
        const capped = new Promise<'cap'>((resolve) => {
            if (this.capTimer === null) return;
            const left = Math.max(0, this.maxCallMs - this.clock());
            cancelCap = this.capTimer(() => resolve('cap'), left);
        });
        let stopListening = (): void => {};
        const drained = new Promise<'shutdown'>((resolve) => {
            const signal = this.shutdown;
            if (signal === null) return;
            if (signal.aborted) { resolve('shutdown'); return; }
            const fire = (): void => resolve('shutdown');
            signal.addEventListener('abort', fire, { once: true });
            stopListening = () => signal.removeEventListener('abort', fire);
        });
        try {
            const work = body(controller.signal);
            // A body still running after the cap must not surface later as an unhandled rejection.
            work.catch(() => { /* before the cap the race below reports it; after it, nobody listens */ });
            const outcome = await Promise.race([work.then(() => 'done' as const), capped, drained]);
            if (outcome === 'cap') {
                this.log(`call-supervisor ${this.target.id} cap_reached`);
                this.stopReason ??= 'call_too_long';
                controller.abort();
            } else if (outcome === 'shutdown') {
                this.log(`call-supervisor ${this.target.id} shutdown`);
                this.stopReason ??= 'internal_error';
                controller.abort();
            }
        } catch (error) {
            this.crashed = true;
            this.stopReason = 'internal_error';
            this.log(`call-supervisor ${this.target.id} internal_error ${errorClass(error)}`);
        } finally {
            cancelCap();
            stopListening();
            try {
                // If the hangup throws, the inner finally still posts call_ended and run() rethrows.
                await this.hangup(this.endReason());
            } finally {
                await this.reportEnded();
            }
        }
    }

    /**
     * Post the one `call_ended`, after the hangup. Best-effort: bounded by `reportTimeoutMs`,
     * never throws, and a second call (there is none on any path) sends nothing.
     */
    private async reportEnded(): Promise<void> {
        if (this.report === null || this.reported) return;
        this.reported = true;
        let record: CallRecord;
        try {
            record = this.record();
        } catch (error) {
            this.log(`call-supervisor ${this.target.id} call_ended_record_failed ${errorClass(error)}`);
            record = SILENT_CALL;
        }
        const input: CallEventInput = {
            kind: 'call_ended',
            seq: CALL_ENDED_SEQ,
            end_reason: endReasonFor(this.sent ?? 'internal_error', this.shutDown),
            disclosure_heard: record.disclosureHeard === true,
            // Within the backend's caps, so an over-long call is a trimmed report, not a 400.
            turns: record.turns.slice(0, MAX_TURNS).map((turn) => ({
                ...turn,
                text: turn.text.slice(0, MAX_TURN_CHARS),
            })),
        };
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<'timeout'>((resolve) => {
            // Not unref'd: this timer may be the only thing keeping the loop alive while a seam
            // never answers, and an unref'd one lets the process exit before the bound fires. It is
            // bounded by reportTimeoutMs and cleared in the finally below.
            timer = setTimeout(() => resolve('timeout'), this.reportTimeoutMs);
        });
        try {
            const outcome = await Promise.race([this.report.callEvent(input).then(() => 'sent' as const), timeout]);
            if (outcome === 'timeout') this.log(`call-supervisor ${this.target.id} call_ended_unrecorded timeout`);
        } catch (error) {
            this.log(`call-supervisor ${this.target.id} call_ended_unrecorded ${errorClass(error)}`);
        } finally {
            clearTimeout(timer);
        }
    }

    /** Why the call ended, for the finally. Said by the body, else the leg's own end. */
    private endReason(): HangupReason {
        if (this.stopReason !== null) return this.stopReason;
        if (this.endedBy !== null) return this.endedBy;
        // The body returned with the line still up and no reason. That is the bug this file
        // exists for, so it is logged as one, and the line is closed anyway.
        this.log(`call-supervisor ${this.target.id} exited_without_reason`);
        return 'internal_error';
    }
}

/** The error's class name and nothing else. Its message may hold what somebody said. */
function errorClass(error: unknown): string {
    if (error instanceof Error) return /^[A-Za-z_$][\w$]*$/.test(error.name) ? error.name : 'Error';
    return typeof error;
}
