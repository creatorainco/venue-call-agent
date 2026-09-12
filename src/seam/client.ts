/**
 * The only way this service talks to CreatoRain.
 *
 * Three calls, one credential, and every failure shaped so the caller cannot accidentally carry on
 * talking. There is no `getOrDefault` here and there never will be: a default returned to a voice
 * agent is a sentence spoken to a restaurant.
 *
 * 🔴 A REFUSAL IS NOT AN ERROR TO RECOVER FROM. Every 409 means the call cannot proceed, and the
 * correct handling of all eleven is the same — stop before speaking. They are separate words only
 * so the operator reading the ledger afterwards can tell "nobody configured this" from "somebody
 * presented a bad credential".
 *
 * 🔴 A TIMEOUT IS NOT A REFUSAL. If the seam does not answer, we do not know whether the booking
 * still stands, and "I don't know" is not a thing to say to somebody holding a table. The caller
 * must end the call, not improvise around it. `SeamUnavailable` is deliberately a different class
 * from `SeamRefusal` so a `catch` cannot flatten the two.
 */

import type {
    CallContext,
    CallEventInput,
    CallEventResult,
    FactAnswer,
    FactTopic,
    SeamRefusalReason,
} from './types.ts';
import { FACT_TOPICS, SEAM_REFUSAL_REASONS } from './types.ts';

/**
 * The backend refused, in words, and named which of the eleven reasons.
 *
 * ⚠️ Note the plain field assignments rather than TypeScript's `constructor(public readonly x)`
 * shorthand. Node runs the `.ts` files in this repo by ERASING types, not compiling them, and
 * parameter properties are one of the few constructs erasure cannot express. Same reason there are
 * no `enum`s and no namespaces anywhere here. `tsconfig.json` sets `erasableSyntaxOnly` so the
 * typechecker refuses them rather than leaving it to whoever runs the tests next.
 */
export class SeamRefusal extends Error {
    readonly reason: SeamRefusalReason;
    readonly route: string;

    constructor(reason: SeamRefusalReason, route: string) {
        super(`seam refused ${route}: ${reason}`);
        this.name = 'SeamRefusal';
        this.reason = reason;
        this.route = route;
    }
}

/**
 * The backend did not answer, or answered something we cannot read.
 *
 * Separate from `SeamRefusal` on purpose. A refusal is a decision we can act on; this is the
 * absence of one, and the only safe response to it mid-call is to stop.
 */
export class SeamUnavailable extends Error {
    readonly route: string;
    readonly detail: string;

    constructor(route: string, detail: string) {
        super(`seam unavailable at ${route}: ${detail}`);
        this.name = 'SeamUnavailable';
        this.route = route;
        this.detail = detail;
    }
}

export interface SeamClientOptions {
    baseUrl: string;
    /** The capability token for ONE attempt at ONE booking. Never logged, never in a URL. */
    token: string;
    /**
     * How long to wait before giving up on one request.
     *
     * The default is deliberately short. This runs while a person is holding a telephone: three
     * seconds of nothing is already a long silence, and a caller who waits ten is worse than a
     * caller who stops. Tune it in `src/tuning/defaults.ts`, not here.
     */
    timeoutMs?: number;
    /** Injectable for tests. Defaults to the global fetch. */
    fetchImpl?: typeof fetch;
}

export interface SeamClient {
    callContext(): Promise<CallContext>;
    callFact(topic: FactTopic): Promise<FactAnswer>;
    callEvent(input: CallEventInput): Promise<CallEventResult>;
}

const DEFAULT_TIMEOUT_MS = 2500;

export function createSeamClient(options: SeamClientOptions): SeamClient {
    const base = options.baseUrl.replace(/\/+$/, '');
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const doFetch = options.fetchImpl ?? fetch;

    async function post(route: string, body: unknown): Promise<unknown> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let response: Response;
        try {
            response = await doFetch(`${base}${route}`, {
                method: 'POST',
                headers: {
                    // 🔴 The header, never the query string. Carrier and proxy request logs retain URLs.
                    Authorization: `Bearer ${options.token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body ?? {}),
                signal: controller.signal,
            });
        } catch (error) {
            const detail = (error as Error)?.name === 'AbortError'
                ? `no response in ${timeoutMs}ms`
                : String((error as Error)?.message ?? error);
            throw new SeamUnavailable(route, detail);
        } finally {
            clearTimeout(timer);
        }

        let payload: unknown;
        try {
            payload = await response.json();
        } catch {
            throw new SeamUnavailable(route, `HTTP ${response.status} with an unreadable body`);
        }

        if (response.status === 409) {
            const reason = (payload as { reason?: string })?.reason;
            // An unrecognised reason word is NOT treated as a generic refusal. It means the two
            // repositories disagree about the contract, and that is worth surfacing loudly rather
            // than swallowing into "the call cannot proceed" — the ledger would lose the fact.
            if (typeof reason === 'string' && (SEAM_REFUSAL_REASONS as readonly string[]).includes(reason)) {
                throw new SeamRefusal(reason as SeamRefusalReason, route);
            }
            throw new SeamUnavailable(route, `409 with an unknown reason: ${String(reason)}`);
        }

        if (!response.ok) throw new SeamUnavailable(route, `HTTP ${response.status}`);
        return payload;
    }

    return {
        async callContext(): Promise<CallContext> {
            const payload = await post('/reservations/call-context', {}) as CallContext;
            // Validated rather than trusted. The disclosure is the one sentence that must exist
            // before any audio leaves, so a context that arrived without it is not a context.
            if (!payload?.disclosure_sentence || !Array.isArray(payload?.opening_script)) {
                throw new SeamUnavailable('/reservations/call-context', 'context without a disclosure or an opening');
            }
            return payload;
        },

        async callFact(topic: FactTopic): Promise<FactAnswer> {
            // Checked locally too, not only by the backend. A topic this service invented is a bug
            // in this service, and it should fail here where the stack trace is useful rather than
            // arrive as a 409 that reads like a backend problem.
            if (!FACT_TOPICS.includes(topic)) {
                throw new SeamUnavailable('/reservations/call-fact', `not a topic in the contract: ${topic}`);
            }
            const payload = await post('/reservations/call-fact', { topic }) as FactAnswer;
            // 🔴 `say` is always a finished sentence, including on the not-known branches. An empty
            // one reaching a model is where it improvises, so it is an error, not a degraded answer.
            if (typeof payload?.say !== 'string' || payload.say.trim() === '') {
                throw new SeamUnavailable('/reservations/call-fact', `empty sentence for topic ${topic}`);
            }
            return payload;
        },

        async callEvent(input: CallEventInput): Promise<CallEventResult> {
            const payload = await post('/reservations/call-event', input) as CallEventResult;
            if (payload?.recorded !== true) {
                throw new SeamUnavailable('/reservations/call-event', 'the event was not recorded');
            }
            // `say` may legitimately be empty here — `answerer_reported` says nothing to the venue.
            return payload;
        },
    };
}
