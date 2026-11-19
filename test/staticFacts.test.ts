/**
 * it-21 (I3P-06): the call context carries the static fact sentences, and the agent answers from
 * them without a round trip.
 *
 *   1. `carriedFacts` keeps only a static topic with a boolean `known` and a finished `say`, once
 *      per topic. 🔴 `still_active` is dropped even when the backend sends it.
 *   2. The cascade answers a carried topic from the context: no `/call-fact`, the same sentence the
 *      backend would have returned, and the same `lookup_booking_fact` tool call.
 *   3. 🔴 `still_active` is always asked live, even with a planted carried answer.
 *   4. A context with no `static_facts` (a backend from before it-21) asks every topic live.
 *   5. The mock carries exactly what its `call-fact` answers, for every topic but `still_active`.
 *
 * CONTROLS: each 🔴 case is run against a variant that must fail (see the PR for both outcomes).
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { carriedFact, createCascadeAgent } from '../src/agent/cascadeAgent.ts';
import { createKeywordClassifier } from '../src/agent/intent.ts';
import { carriedFacts, createSeamClient, SeamRefusal, type SeamClient } from '../src/seam/client.ts';
import { startMockSeam, type MockSeam } from '../src/mock/server.ts';
import { STATIC_FACT_TOPICS, FACT_TOPICS, type CallContext, type FactAnswer } from '../src/seam/types.ts';

let mock: MockSeam;
before(async () => { mock = await startMockSeam({ port: 0 }); });
after(async () => { await mock.close(); });

const factRoutes = () => mock.journal.filter((e) => e.route.endsWith('/call-fact'));

describe('it-21: carriedFacts keeps only what may be carried', () => {
    test('the static topics are every contract topic but still_active, in order', () => {
        assert.deepEqual([...STATIC_FACT_TOPICS], FACT_TOPICS.filter((t) => t !== 'still_active'));
    });

    test('🔴 still_active is dropped even when the backend sends it', () => {
        const kept = carriedFacts([{ topic: 'still_active', known: true, say: 'Yes, it is still on.' }]);
        assert.deepEqual(kept, []);
    });

    test('an unknown topic, a blank or missing say, a non-boolean known and a repeat are dropped', () => {
        const good: FactAnswer = { topic: 'party_size', known: true, say: 'A party of two.' };
        const kept = carriedFacts([
            good,
            { topic: 'party_size', known: true, say: 'A party of nine.' },
            { topic: 'not_a_topic', known: true, say: 'Something.' },
            { topic: 'arrival_time', known: true, say: '   ' },
            { topic: 'creator_name', known: 'yes', say: 'Kris.' },
            { topic: 'comp_terms', known: false },
            null,
        ]);
        assert.deepEqual(kept, [good]);
    });

    test('a value that is not an array carries nothing', () => {
        for (const value of [undefined, null, {}, 'party_size', 3]) assert.deepEqual(carriedFacts(value), []);
    });
});

describe('it-21: the cascade answers a carried topic from the context', () => {
    const agentFor = (seam: SeamClient, context?: CallContext) =>
        createCascadeAgent({ seam, intents: createKeywordClassifier(), ...(context ? { context } : {}) });

    test('a party-size question does not wait on /call-fact and says the backend sentence', async () => {
        const real = createSeamClient({ baseUrl: mock.baseUrl, token: 'mock:happy' });
        const context = await real.callContext();
        assert.ok(context.static_facts?.length, 'the mock context carried no facts');
        // A seam whose call-fact never answers until released: the turn must return without it.
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const asked: string[] = [];
        const seam: SeamClient = {
            ...real,
            callFact: async (topic) => { asked.push(topic); await gate; return real.callFact(topic); },
        };
        const agent = agentFor(seam, context);
        await agent.open();
        await agent.hear('hello, who is this?');
        const answer = await agent.hear('how many people are coming?');
        assert.deepEqual(answer.toolCalls, [{ name: 'lookup_booking_fact', args: { topic: 'party_size' } }]);
        assert.equal(answer.say[0], (await real.callFact('party_size')).say);
        assert.deepEqual(asked, ['party_size'], 'the carried turn sent no kill and expiry check');
        release();
    });

    test('🔴 a refused check on a carried turn ends the call on the next turn', async () => {
        const live = createSeamClient({ baseUrl: mock.baseUrl, token: 'mock:happy' });
        const context = await live.callContext();
        // The token ages out after the context was fetched: every later route refuses.
        const expired = createSeamClient({ baseUrl: mock.baseUrl, token: 'mock:expired-token' });
        const agent = agentFor(expired, context);
        await agent.open();
        await agent.hear('hello, who is this?');
        const answer = await agent.hear('how many people are coming?');
        assert.equal(answer.say[0], (await live.callFact('party_size')).say, 'the carried answer was not spoken');
        await assert.rejects(agent.hear('okay, thanks'), (error: unknown) =>
            error instanceof SeamRefusal && error.reason === 'token_expired');
    });

    test('🔴 still_active is asked live, even with a planted carried answer', async () => {
        const seam = createSeamClient({ baseUrl: mock.baseUrl, token: 'mock:cancelled-mid-call' });
        const context = await seam.callContext();
        const planted: CallContext = {
            ...context,
            static_facts: [...(context.static_facts ?? []), { topic: 'still_active', known: true, say: 'PLANTED: still on.' }],
        };
        assert.equal(carriedFact(planted, 'still_active'), undefined);
        const agent = agentFor(seam, planted);
        await agent.open();
        await agent.hear('hello, who is this?');
        const before = factRoutes().length;
        const answer = await agent.hear('is the booking still on?');
        assert.equal(factRoutes().length, before + 1, 'still_active did not reach /call-fact');
        assert.notEqual(answer.say[0], 'PLANTED: still on.');
        assert.equal(answer.say[0], (await seam.callFact('still_active')).say);
    });

    test('a context with no static_facts asks every topic live (a backend from before it-21)', async () => {
        const seam = createSeamClient({ baseUrl: mock.baseUrl, token: 'mock:happy' });
        const { static_facts: _dropped, ...older } = await seam.callContext();
        const agent = agentFor(seam, older as CallContext);
        await agent.open();
        await agent.hear('hello, who is this?');
        const before = factRoutes().length;
        await agent.hear('how many people are coming?');
        assert.equal(factRoutes().length, before + 1);
    });
});

describe('it-21: the mock carries what its call-fact answers', () => {
    test('one carried answer per static topic, each equal to the call-fact answer', async () => {
        for (const scenario of ['happy', 'comp-known', 'cancelled-mid-call']) {
            const seam = createSeamClient({ baseUrl: mock.baseUrl, token: `mock:${scenario}` });
            const context = await seam.callContext();
            assert.deepEqual(context.static_facts?.map((f) => f.topic), [...STATIC_FACT_TOPICS], scenario);
            for (const fact of context.static_facts ?? []) {
                assert.deepEqual(fact, await seam.callFact(fact.topic), `${scenario} ${fact.topic}`);
            }
        }
    });
});
