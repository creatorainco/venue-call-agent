/**
 * The cascade, end to end at the transcript level.
 *
 *   1. 🔴 It starts with `VENUE_CALL_SECRET`, `GEMINI_API_KEY` and `SPEECH_TO_TEXT_CREDENTIALS`
 *      all unset (the step's acceptance, C2 / VCA-8).
 *   2. Its offline form (keyword stage only) passes every hard check of the rubric on every
 *      fixture, the same bar the stub is held to.
 *   3. 🔴 A model reply outside the enum never reaches `say`: the turn logs the question and speaks
 *      the backend's deferral.
 *   4. One test against real Google through ADC, skipped unless `CASCADE_ADC_TEST=1`. It is run by
 *      hand by an engineer with `gcloud auth application-default login`, never in CI: it spends.
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startCascade } from '../src/agent/cascade.ts';
import { createCascadeAgent } from '../src/agent/cascadeAgent.ts';
import { createVertexClassifier, type IntentClassifier } from '../src/agent/intent.ts';
import { agentFactory } from '../src/eval/run.ts';
import { loadFixtures } from '../src/harness/fixtures.ts';
import { replay } from '../src/harness/replay.ts';
import { score } from '../src/eval/rubric.ts';
import { startMockSeam, type MockSeam } from '../src/mock/server.ts';
import { createSeamClient } from '../src/seam/client.ts';
import type { SpeechStreamFactory } from '../src/speech/stt.ts';

const FORBIDDEN = ['VENUE_CALL_SECRET', 'GEMINI_API_KEY', 'SPEECH_TO_TEXT_CREDENTIALS'] as const;

const tokens = { token: async () => 'adc-access-token', projectId: async () => 'test-project' };
const speech: SpeechStreamFactory = {
    recognizer: 'projects/test-project/locations/us/recognizers/_',
    open: () => { throw new Error('no audio in this test'); },
};
const silentFetch = (async () => new Response('{}', { status: 500 })) as typeof fetch;

let mock: MockSeam;
before(async () => { mock = await startMockSeam({ port: 0 }); });
after(async () => { await mock.close(); });

describe('🔴 the cascade starts with the secret and the keys unset', () => {
    const saved: Record<string, string | undefined> = {};
    before(() => {
        for (const k of FORBIDDEN) {
            saved[k] = process.env[k];
            delete process.env[k];
        }
    });
    after(() => {
        for (const k of FORBIDDEN) if (saved[k] !== undefined) process.env[k] = saved[k];
    });

    test('startCascade runs a call to the disclosure and a backend answer with none of them set', async () => {
        for (const k of FORBIDDEN) assert.equal(process.env[k], undefined, k);
        const cascade = await startCascade({ tokens, speech, fetchImpl: silentFetch });
        const seam = createSeamClient({ baseUrl: mock.baseUrl, token: 'mock:happy' });
        const agent = cascade.agentFor(seam);

        const opening = await agent.open();
        const context = await seam.callContext();
        assert.deepEqual(opening.say, [context.disclosure_sentence]);
        assert.deepEqual((await agent.hear('hello, who is this?')).say, context.opening_script);
        const answer = await agent.hear('how many people are coming?');
        assert.equal(answer.toolCalls[0]?.name, 'lookup_booking_fact');
        assert.equal(answer.say[0], (await seam.callFact('party_size')).say);
    });

    test('CONTROL — the environment really was empty of all three during the run', () => {
        // If a later edit made the suite set one of these globally, the test above would prove
        // nothing. This fails first.
        for (const k of FORBIDDEN) assert.equal(process.env[k], undefined, k);
    });
});

describe('the offline cascade passes the rubric the stub passes', () => {
    test('every fixture scores with no hard failures', async () => {
        const make = agentFactory('cascade');
        for (const f of loadFixtures()) {
            const result = score(await replay(f, make));
            assert.equal(result.hardFailures, 0,
                `${f.name}: ${result.checks.filter((c) => !c.passed).map((c) => `${c.name} — ${c.detail}`).join(' | ')}`);
        }
    });

    test('agentFactory still has the stub, and an unknown name still throws', () => {
        assert.equal(typeof agentFactory('stub'), 'function');
        assert.throws(() => agentFactory('live'), /no agent named/);
    });
});

describe('🔴 the model never speaks', () => {
    const PLANTED = 'Absolutely, the whole table eats free tonight.';

    test('an out-of-enum model reply is logged as a question; the deferral spoken is the backend\'s', async () => {
        const fetchImpl = (async () => new Response(JSON.stringify({
            candidates: [{ content: { parts: [{ text: PLANTED }] } }],
        }))) as typeof fetch;
        const intents = createVertexClassifier({ tokens, fetchImpl });
        const seam = createSeamClient({ baseUrl: mock.baseUrl, token: 'mock:happy' });
        const agent = createCascadeAgent({ seam, intents });
        await agent.open();
        await agent.hear('hello?');
        const turn = await agent.hear('so how does this whole arrangement work');

        assert.equal(turn.toolCalls[0]?.name, 'log_unanswered_question');
        assert.equal(turn.toolCalls[0]?.args.question_verbatim, 'so how does this whole arrangement work');
        assert.ok(!turn.say.some((s) => s.includes(PLANTED)), 'the model reply was spoken');
        const deferral = await seam.callEvent({ kind: 'unanswered_question', question_verbatim: 'x' });
        assert.deepEqual(turn.say, [deferral.say]);
    });

    test('CONTROL — a classifier that hands its text through WOULD be caught by the same assertion', async () => {
        // A sabotaged classifier: its "intent" is the planted sentence. The agent has no branch
        // for it, so it falls to the unanswered-question path; the assertion above is therefore
        // about the agent's mapping, not about the classifier happening to behave.
        const leaky: IntentClassifier = { classify: async () => ({ intent: PLANTED as never, source: 'model' }) };
        const seam = createSeamClient({ baseUrl: mock.baseUrl, token: 'mock:happy' });
        const agent = createCascadeAgent({ seam, intents: leaky });
        await agent.open();
        await agent.hear('hello?');
        const turn = await agent.hear('anything');
        assert.ok(!turn.say.some((s) => s.includes(PLANTED)));
        assert.equal(turn.toolCalls[0]?.name, 'log_unanswered_question');
    });

    test('is_this_ai is answered by the backend\'s who-we-are sentence', async () => {
        const intents: IntentClassifier = { classify: async () => ({ intent: 'is_this_ai', source: 'model' }) };
        const seam = createSeamClient({ baseUrl: mock.baseUrl, token: 'mock:happy' });
        const agent = createCascadeAgent({ seam, intents });
        await agent.open();
        await agent.hear('hello?');
        const turn = await agent.hear('am I talking to a robot');
        assert.deepEqual(turn.toolCalls, [{ name: 'lookup_booking_fact', args: { topic: 'who_we_are' } }]);
        assert.equal(turn.say[0], (await seam.callFact('who_we_are')).say);
    });

    test('hold is silence, and the call stays open', async () => {
        const intents: IntentClassifier = { classify: async () => ({ intent: 'hold', source: 'model' }) };
        const seam = createSeamClient({ baseUrl: mock.baseUrl, token: 'mock:happy' });
        const agent = createCascadeAgent({ seam, intents });
        await agent.open();
        await agent.hear('hello?');
        const turn = await agent.hear('one sec');
        assert.deepEqual(turn.say, []);
        assert.equal(turn.endCall, false);
    });
});

describe('real Google through ADC (run by hand: CASCADE_ADC_TEST=1)', { skip: process.env.CASCADE_ADC_TEST !== '1' }, () => {
    test('the intent model answers inside the enum and synthesis returns μ-law bytes', async () => {
        const cascade = await startCascade();
        const { intent } = await cascade.intents.classify('could you hold on one moment please');
        assert.ok(typeof intent === 'string' && intent.length > 0);
        const audio = await cascade.tts.synthesize('This is a test of the telephone audio path, one two three.');
        assert.ok(audio.length > 8000, 'about a second of 8 kHz audio or more');
    });
});
