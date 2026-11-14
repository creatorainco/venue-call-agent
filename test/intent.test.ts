/**
 * The intent step: keyword cues first, the model only on a miss, and nothing but an enum word out.
 *
 * Sabotage (a) from the plan lives here: the enum fallback. Remove the `isIntent` check in
 * `intentFromResponse` and the out-of-enum test goes red, because a sentence would come back as an
 * "intent".
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
    INTENTS,
    createKeywordClassifier,
    createVertexClassifier,
    intentFromResponse,
    intentRequestBody,
    keywordIntent,
    topicOf,
    vertexIntentUrl,
} from '../src/agent/intent.ts';
import { FACT_TOPICS } from '../src/seam/types.ts';
import { INTENT_MODEL } from '../src/tuning/cascadeDefaults.ts';

const tokens = {
    token: async () => 'adc-access-token',
    projectId: async () => 'test-project',
};

interface Seen { url: string; init: RequestInit }

function fakeFetch(reply: () => Response | Promise<Response>, seen: Seen[] = []): typeof fetch {
    return (async (url: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(url), init: init ?? {} });
        return reply();
    }) as typeof fetch;
}

const modelSays = (text: string) => () =>
    new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });

describe('the closed set', () => {
    test('one ask_<topic> intent per Seam 4 fact topic, and every other intent from the design', () => {
        for (const t of FACT_TOPICS) assert.ok(INTENTS.includes(`ask_${t}`), t);
        for (const i of ['confirm', 'decline', 'stop_calling', 'wrong_number', 'callback_request',
            'is_this_ai', 'hold', 'voicemail', 'menu', 'unclear'] as const) {
            assert.ok(INTENTS.includes(i), i);
        }
        assert.equal(new Set(INTENTS).size, INTENTS.length);
    });

    test('topicOf reads the topic back, and only for ask_ intents', () => {
        assert.equal(topicOf('ask_party_size'), 'party_size');
        assert.equal(topicOf('confirm'), null);
    });
});

describe('the keyword stage', () => {
    test('a stop request beats everything in the same sentence', () => {
        assert.equal(keywordIntent('what time are they coming? actually, stop calling us'), 'stop_calling');
    });

    test('a voicemail greeting, a phone menu and a wrong number are told apart', () => {
        assert.equal(keywordIntent('please leave a message after the tone'), 'voicemail');
        assert.equal(keywordIntent('for reservations, press 2'), 'menu');
        assert.equal(keywordIntent("you've got the wrong number"), 'wrong_number');
    });

    test('a question beats a goodbye in the same sentence', () => {
        assert.equal(keywordIntent('thanks, but how many people?'), 'ask_party_size');
        assert.equal(keywordIntent('thanks, sounds good'), 'confirm');
    });

    test('nothing matched is null, and the keyword classifier turns that into unclear', async () => {
        assert.equal(keywordIntent('mmm, hang on, the oven'), null);
        assert.deepEqual(await createKeywordClassifier().classify('mmm, hang on, the oven'),
            { intent: 'unclear', source: 'fallback' });
    });
});

describe('the model stage (Vertex generateContent, enum schema, ADC bearer)', () => {
    test('the request: the pinned model on the global host, an enum schema, a bearer token and no key', async () => {
        const seen: Seen[] = [];
        const classifier = createVertexClassifier({ tokens, fetchImpl: fakeFetch(modelSays('hold'), seen) });
        const result = await classifier.classify('give me one second');
        assert.deepEqual(result, { intent: 'hold', source: 'model' });

        assert.equal(seen.length, 1);
        const [{ url, init }] = seen as [Seen];
        assert.equal(url, vertexIntentUrl('test-project'));
        assert.match(url, /^https:\/\/aiplatform\.googleapis\.com\/v1\/projects\/test-project\/locations\/global\//);
        assert.ok(url.endsWith(`/models/${INTENT_MODEL}:generateContent`));
        assert.doesNotMatch(url, /[?&]key=/);
        assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer adc-access-token');
        const body = JSON.parse(String(init.body));
        assert.equal(body.generationConfig.responseMimeType, 'text/x.enum');
        assert.deepEqual(body.generationConfig.responseSchema.enum, [...INTENTS]);
        assert.deepEqual(body, intentRequestBody('give me one second'));
    });

    test('a keyword hit never pays for a model call', async () => {
        const seen: Seen[] = [];
        const classifier = createVertexClassifier({ tokens, fetchImpl: fakeFetch(modelSays('hold'), seen) });
        assert.deepEqual(await classifier.classify('please stop calling'), { intent: 'stop_calling', source: 'keyword' });
        assert.equal(seen.length, 0);
    });

    test('🔴 a reply outside the enum is unclear, never passed on as text', async () => {
        const planted = 'Sure! They are paying for everything, see you at seven.';
        assert.equal(intentFromResponse({ candidates: [{ content: { parts: [{ text: planted }] } }] }), null);
        const lines: string[] = [];
        const classifier = createVertexClassifier({ tokens, fetchImpl: fakeFetch(modelSays(planted)), log: (l) => lines.push(l) });
        assert.deepEqual(await classifier.classify('so what is the deal exactly'), { intent: 'unclear', source: 'fallback' });
        assert.deepEqual(lines, ['intent model reply outside the enum']);
    });

    test('an empty reply, an HTTP error and a malformed body are all unclear', async () => {
        for (const reply of [
            () => new Response(JSON.stringify({ candidates: [] }), { status: 200 }),
            () => new Response('{}', { status: 500 }),
            () => new Response('not json', { status: 200 }),
        ]) {
            const classifier = createVertexClassifier({ tokens, fetchImpl: fakeFetch(reply) });
            assert.equal((await classifier.classify('so what is the deal exactly')).intent, 'unclear');
        }
    });

    test('a model slower than the timeout is unclear, and the turn does not wait for it', async () => {
        const never: typeof fetch = ((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        })) as typeof fetch;
        const classifier = createVertexClassifier({ tokens, fetchImpl: never, timeoutMs: 30 });
        const started = Date.now();
        assert.equal((await classifier.classify('so what is the deal exactly')).intent, 'unclear');
        assert.ok(Date.now() - started < 1000);
    });

    test('a token source that fails is unclear, not a crash', async () => {
        const broken = { token: async () => { throw new Error('no ADC'); }, projectId: async () => 'p' };
        const classifier = createVertexClassifier({ tokens: broken, fetchImpl: fakeFetch(modelSays('hold')) });
        assert.equal((await classifier.classify('so what is the deal exactly')).intent, 'unclear');
    });
});
