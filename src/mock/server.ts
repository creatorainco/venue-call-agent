/**
 * A LOCAL STAND-IN FOR SEAM 4. It has no database, no credentials and no network egress.
 *
 * WHY IT EXISTS. Everything about this feature that can go wrong in front of a restaurant is
 * decided by what comes back from three HTTP routes: whether the call proceeds at all, which
 * sentence is spoken, whether a deferral is allowed. Without a stand-in, exercising any of that
 * means a running platform-backend, a database with the right rows in it, and a signing secret —
 * which in practice means it does not get exercised, and the eleven refusal paths are read rather
 * than run.
 *
 * So: the shapes from `contract/seam4.json`, served from `fixtures/scenarios.json`, on localhost.
 * Every one of the eleven refusals is reachable by name. Nothing here talks to anything.
 *
 * 🔴 THE MOCK IS ALLOWED TO AUTHOR SENTENCES AND THE AGENT IS NOT. That asymmetry is the point of
 * the whole design, so it is worth being blunt about: this file is imitating the component that
 * owns the words. If you find yourself moving a sentence OUT of here and into `src/` proper to
 * make something easier, you have just deleted the property the feature is built on.
 *
 * 🔴 IT DEFAULTS TO THE FIXED BACKEND, NOT THE DEPLOYED ONE. A paused campaign refuses here, which
 * is TASK-968's behaviour and not today's. All remaining work is specified against the fixed
 * backend, so the default has to be the fixed backend; the live bug is still reachable, by asking
 * for it by name (`campaign-paused-today`), because a regression needs somewhere to live.
 *
 * HOW A CALLER PICKS A SCENARIO. The bearer token doubles as the selector: `mock:<scenario>`, or
 * `mock:<scenario>:<reservation_id>`. That keeps the client code identical to production — it
 * carries whatever token it was handed and never knows it is talking to a mock.
 *
 *     Authorization: Bearer mock:happy
 *     Authorization: Bearer mock:campaign-paused
 *
 * A token that is not in that shape refuses `token_invalid`, exactly as the real seam would.
 *
 * TWO EXTRA ROUTES, both under `/__mock/` so they cannot be confused with the contract:
 *     GET  /__mock/journal   every request received, in order, with its response
 *     POST /__mock/reset     empty the journal
 * The journal is what makes a conversation test assertable: "it asked for comp_terms once and
 * never asked for party_size" is a claim about the journal, not about the audio.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FIXTURES = JSON.parse(
    readFileSync(fileURLToPath(new URL('./fixtures/scenarios.json', import.meta.url)), 'utf8'),
) as MockFixtures;

interface FactShape { known: boolean; say: string; reason?: string }

interface Scenario {
    summary: string;
    answerer?: string;
    refuse?: Record<string, string | undefined>;
    facts?: Record<string, FactShape>;
    context?: Record<string, unknown>;
}

interface MockFixtures {
    event_sentences: Record<string, string>;
    default_facts: Record<string, FactShape>;
    default_context: Record<string, unknown>;
    scenarios: Record<string, Scenario>;
}

export interface JournalEntry {
    route: string;
    scenario: string;
    /** The request body as received. Bodies here are synthetic; nothing real is recorded. */
    body: unknown;
    status: number;
    /** The response body, so a test can assert on the sentence that was actually served. */
    response: unknown;
}

export interface MockSeamOptions {
    /** 0 asks the OS for a free port, which is what tests should do. */
    port?: number;
    /**
     * Milliseconds of delay before every response.
     *
     * Not a nicety. The agent's timeout is the difference between hanging up and standing there
     * silently while somebody says "hello? hello?", and that behaviour cannot be tested against a
     * server that answers in under a millisecond.
     */
    latencyMs?: number;
    /** When set, every route refuses this reason regardless of scenario — the whole-seam switch. */
    forceRefusal?: string;
}

export interface MockSeam {
    server: Server;
    port: number;
    baseUrl: string;
    journal: JournalEntry[];
    close(): Promise<void>;
}

const CONTRACT_ROUTES = new Set([
    '/reservations/call-context',
    '/reservations/call-fact',
    '/reservations/call-event',
]);

const FACT_TOPICS = new Set(Object.keys(FIXTURES.default_facts));

export function scenarioNames(): string[] {
    return Object.keys(FIXTURES.scenarios);
}

export function scenarioSummary(name: string): string | undefined {
    return FIXTURES.scenarios[name]?.summary;
}

/** `mock:<scenario>` or `mock:<scenario>:<reservation_id>`; anything else is not a token. */
function parseToken(header: string | undefined): { scenario: string; reservationId?: string } | null {
    const raw = (header ?? '').trim();
    if (!raw.toLowerCase().startsWith('bearer ')) return null;
    const value = raw.slice(7).trim();
    const parts = value.split(':');
    if (parts[0] !== 'mock' || !parts[1]) return null;
    if (!FIXTURES.scenarios[parts[1]]) return null;
    return parts[2] ? { scenario: parts[1], reservationId: parts[2] } : { scenario: parts[1] };
}

async function readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (!chunks.length) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        return {};
    }
}

function contextFor(scenario: Scenario, reservationId: string | undefined): Record<string, unknown> {
    const ctx = { ...FIXTURES.default_context, ...(scenario.context ?? {}) };
    if (reservationId) ctx.reservation_id = reservationId;
    return ctx;
}

function factFor(scenario: Scenario, topic: string): FactShape | undefined {
    return scenario.facts?.[topic] ?? FIXTURES.default_facts[topic];
}

function eventSentence(body: { kind?: string; reason?: string }): string {
    const keyed = `${body.kind}:${body.reason}`;
    return FIXTURES.event_sentences[keyed] ?? FIXTURES.event_sentences[body.kind ?? ''] ?? '';
}

export async function startMockSeam(options: MockSeamOptions = {}): Promise<MockSeam> {
    const journal: JournalEntry[] = [];
    const latency = Math.max(0, options.latencyMs ?? 0);

    const server = createServer((req, res) => {
        void handle(req, res).catch((error: unknown) => {
            // A mock that throws quietly is worse than no mock: the test fails somewhere else and
            // the reader chases the agent instead of the fixture.
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ mock_error: String((error as Error)?.message ?? error) }));
        });
    });

    async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const route = (req.url ?? '').split('?')[0] ?? '';

        if (route === '/__mock/journal' && req.method === 'GET') {
            return send(res, 200, journal);
        }
        if (route === '/__mock/reset' && req.method === 'POST') {
            journal.length = 0;
            return send(res, 200, { reset: true });
        }
        if (route === '/__mock/scenarios' && req.method === 'GET') {
            return send(res, 200, Object.fromEntries(
                Object.entries(FIXTURES.scenarios).map(([k, v]) => [k, v.summary]),
            ));
        }

        if (!CONTRACT_ROUTES.has(route) || req.method !== 'POST') {
            // Deliberately NOT a 409. A 404 here means the agent asked for a route the contract
            // does not have, and dressing that up as a refusal would hide a real disagreement.
            return send(res, 404, { mock_error: `not a Seam 4 route: ${req.method} ${route}` });
        }

        const body = await readBody(req) as Record<string, unknown>;
        const parsed = parseToken(req.headers.authorization);

        if (latency) await new Promise((resolve) => setTimeout(resolve, latency));

        if (!parsed) {
            return refuse(res, route, 'unparsed-token', body, 'token_invalid');
        }

        const scenario = FIXTURES.scenarios[parsed.scenario] as Scenario;
        const name = parsed.scenario;

        const forced = options.forceRefusal;
        const scenarioRefusal = scenario.refuse?.[route.replace('/reservations/', '')];
        const refusal = forced ?? scenarioRefusal;
        if (refusal) return refuse(res, route, name, body, refusal);

        if (route === '/reservations/call-context') {
            return ok(res, route, name, body, contextFor(scenario, parsed.reservationId));
        }

        if (route === '/reservations/call-fact') {
            const topic = String(body.topic ?? '');
            if (!FACT_TOPICS.has(topic)) return refuse(res, route, name, body, 'unknown_topic');
            const fact = factFor(scenario, topic);
            if (!fact) return refuse(res, route, name, body, 'unknown_topic');
            return ok(res, route, name, body, { ...fact, topic });
        }

        // call-event
        const kind = String(body.kind ?? '');
        if (!['unanswered_question', 'human_callback', 'answerer_reported'].includes(kind)) {
            return send(res, 400, { mock_error: `not an event kind in the contract: ${kind}` });
        }
        const stop = kind === 'human_callback' && body.reason === 'asked_to_stop_calling';
        return ok(res, route, name, body, {
            recorded: true,
            say: eventSentence(body as { kind?: string; reason?: string }),
            do_not_call: stop,
        });
    }

    function ok(res: ServerResponse, route: string, scenario: string, body: unknown, payload: unknown): void {
        journal.push({ route, scenario, body, status: 200, response: payload });
        send(res, 200, payload);
    }

    function refuse(res: ServerResponse, route: string, scenario: string, body: unknown, reason: string): void {
        const payload = { ok: false, reason };
        journal.push({ route, scenario, body, status: 409, response: payload });
        send(res, 409, payload);
    }

    function send(res: ServerResponse, status: number, payload: unknown): void {
        const text = JSON.stringify(payload);
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
        res.end(text);
    }

    const port = await new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port ?? 0, '127.0.0.1', () => {
            const address = server.address();
            resolve(typeof address === 'object' && address ? address.port : 0);
        });
    });

    return {
        server,
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        journal,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}
