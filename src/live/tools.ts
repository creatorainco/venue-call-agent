/** Strict, per-session routing to the existing backend client.
 * No retry: a timed-out write may already have been recorded by the backend.
 * Cancellation suppresses delivery; it cannot undo a request already sent.
 */
import { SeamRefusal, SeamUnavailable } from '../seam/client.ts';
import type { SeamClient } from '../seam/client.ts';
import { ANSWERER_KINDS, CALLBACK_REASONS, FACT_TOPICS } from '../seam/types.ts';
import type { CallEventInput, CallEventResult, FactAnswer, SeamRefusalReason } from '../seam/types.ts';
import type { SessionEvent } from './session.ts';

type Request = Extract<SessionEvent, { kind: 'tool_call' }>;
type Operation = { kind: 'fact'; topic: (typeof FACT_TOPICS)[number] }
    | { kind: 'event'; input: CallEventInput };
export type ToolFailure =
    | { kind: 'invalid_request' | 'unavailable' | 'delivery_failed' | 'limit_exceeded' }
    | { kind: 'refused'; reason: SeamRefusalReason };

export interface ToolSink {
    result(id: string, response: FactAnswer | CallEventResult): void;
    /** Stop requests must survive cancellation of the model's result delivery. */
    stopped(): void;
    /** Caller must close the session and playback when this fires. No raw error text. */
    failed(failure: ToolFailure): void;
}

interface Entry {
    fingerprint: string;
    cancelled: boolean;
    done: Promise<void>;
}

export class ToolRouter {
    private readonly seam: SeamClient;
    private readonly sink: ToolSink;
    private readonly limit: number;
    private readonly entries = new Map<string, Entry>();
    private readonly cancelled = new Set<string>();
    private tail = Promise.resolve();
    private closed = false;

    constructor(seam: SeamClient, sink: ToolSink, limit = 256) {
        if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid tool limit');
        this.seam = seam;
        this.sink = sink;
        this.limit = limit;
    }

    dispatch(request: Request): Promise<void> {
        if (this.closed) return Promise.resolve();
        let operation: Operation;
        try {
            if (typeof request.id !== 'string' || !request.id.trim()) throw new Error('missing id');
            operation = parse(request);
        } catch {
            this.fail({ kind: 'invalid_request' });
            return Promise.resolve();
        }
        if (this.cancelled.has(request.id)) return Promise.resolve();
        const fingerprint = JSON.stringify(operation);
        const previous = this.entries.get(request.id);
        if (previous) {
            if (previous.fingerprint !== fingerprint) this.fail({ kind: 'invalid_request' });
            return previous.done;
        }
        if (this.entries.size + this.cancelled.size >= this.limit) {
            this.fail({ kind: 'limit_exceeded' });
            return Promise.resolve();
        }
        const entry: Entry = { fingerprint, cancelled: false, done: Promise.resolve() };
        // Serial order prevents a later reply from overtaking an earlier backend write.
        entry.done = this.tail.then(async () => {
            if (this.closed || entry.cancelled) return;
            let response: FactAnswer | CallEventResult;
            try {
                response = operation.kind === 'fact'
                    ? await this.seam.callFact(operation.topic)
                    : await this.seam.callEvent(operation.input);
                validateResponse(operation, response);
            } catch (error) {
                if (error instanceof SeamRefusal) this.fail({ kind: 'refused', reason: error.reason });
                else this.fail({ kind: 'unavailable' });
                return;
            }
            if (this.closed) return;
            try {
                if ('do_not_call' in response && response.do_not_call) this.sink.stopped();
                if (!this.closed && !entry.cancelled) this.sink.result(request.id, response);
                if ('do_not_call' in response && response.do_not_call) this.close();
            } catch {
                this.fail({ kind: 'delivery_failed' });
            }
        });
        this.entries.set(request.id, entry);
        this.tail = entry.done;
        return entry.done;
    }

    cancel(ids: readonly string[]): void {
        if (this.closed) return;
        for (const id of ids) {
            if (typeof id !== 'string' || !id.trim()) { this.fail({ kind: 'invalid_request' }); return; }
            const entry = this.entries.get(id);
            if (entry) entry.cancelled = true;
            else if (!this.cancelled.has(id)) {
                if (this.entries.size + this.cancelled.size >= this.limit) {
                    this.fail({ kind: 'limit_exceeded' }); return;
                }
                this.cancelled.add(id);
            }
        }
    }

    close(): void {
        this.closed = true;
        this.entries.clear();
        this.cancelled.clear();
    }

    private fail(failure: ToolFailure): void {
        if (this.closed) return;
        this.close();
        // Failure notification cannot strand an unhandled promise in the event loop.
        try { this.sink.failed(failure); } catch { /* Caller owns its cleanup. */ }
    }
}

function parse(request: Request): Operation {
    const args = request.args;
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('invalid arguments');
    const object = args as Record<string, unknown>;
    const one = (key: string): string => {
        if (Object.keys(object).length !== 1 || !Object.hasOwn(object, key)
            || typeof object[key] !== 'string' || !object[key].trim()) throw new Error('invalid argument');
        return object[key];
    };
    const member = <T extends string>(key: string, values: readonly T[]): T => {
        const value = one(key);
        if (!values.includes(value as T)) throw new Error('unknown argument');
        return value as T;
    };
    switch (request.name) {
        case 'lookup_booking_fact': return { kind: 'fact', topic: member('topic', FACT_TOPICS) };
        case 'log_unanswered_question':
            return { kind: 'event', input: { kind: 'unanswered_question', question_verbatim: one('question_verbatim') } };
        case 'request_human_callback':
            return { kind: 'event', input: { kind: 'human_callback', reason: member('reason', CALLBACK_REASONS) } };
        case 'report_answerer':
            return { kind: 'event', input: { kind: 'answerer_reported', answerer: member('answerer', ANSWERER_KINDS) } };
        default: throw new Error('unknown tool');
    }
}

function validateResponse(operation: Operation, response: FactAnswer | CallEventResult): void {
    if (!response || typeof response.say !== 'string') throw new SeamUnavailable('tool', 'invalid response');
    if (operation.kind === 'fact') {
        if (!('known' in response) || typeof response.known !== 'boolean'
            || response.topic !== operation.topic || !response.say.trim()) {
            throw new SeamUnavailable('tool', 'invalid fact');
        }
    } else if (!('recorded' in response) || response.recorded !== true
        || typeof response.do_not_call !== 'boolean'
        || (operation.input.kind !== 'answerer_reported' && !response.say.trim())) {
        throw new SeamUnavailable('tool', 'invalid event');
    }
}
