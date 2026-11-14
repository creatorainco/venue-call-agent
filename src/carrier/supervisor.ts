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
 * 🔴 THE LOG IS REDACTED BY CONSTRUCTION. An error's message can carry what the far end said, a
 * phone number or a token, so it never reaches a log line. A line carries the call id, the event
 * kind and the error's class name, and nothing else.
 */

import type { CallLegEvents, HangupReason } from './leg.ts';
import { MAX_CALL_SECONDS } from '../tuning/liveDefaults.ts';

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

    constructor(target: Hangable, options: SupervisorOptions) {
        this.target = target;
        this.clock = options.clock;
        this.maxCallMs = options.maxCallMs ?? MAX_CALL_SECONDS * 1000;
        this.log = options.log ?? ((line) => { process.stderr.write(`${line}\n`); });
        this.capTimer = options.capTimer === undefined ? wallTimer : options.capTimer;
        target.on('hangup', (reason) => { this.endedBy ??= reason; });
    }

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
        try {
            const work = body(controller.signal);
            // A body still running after the cap must not surface later as an unhandled rejection.
            work.catch(() => { /* before the cap the race below reports it; after it, nobody listens */ });
            const outcome = await Promise.race([work.then(() => 'done' as const), capped]);
            if (outcome === 'cap') {
                this.log(`call-supervisor ${this.target.id} cap_reached`);
                this.stopReason ??= 'call_too_long';
                controller.abort();
            }
        } catch (error) {
            this.crashed = true;
            this.stopReason = 'internal_error';
            this.log(`call-supervisor ${this.target.id} internal_error ${errorClass(error)}`);
        } finally {
            cancelCap();
            await this.hangup(this.endReason());
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
