/**
 * Synthesis: the request-size guard (CS-04), the blank-sentence refusal, the cache and the WAV
 * unwrap. Every test injects `fetch`; nothing here talks to Google.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { TTS_ENDPOINT, TtsRefused, TtsUnavailable, checkSynthesisInput, createTts, unwrapWav } from '../src/speech/tts.ts';
import { TTS } from '../src/tuning/cascadeDefaults.ts';

const tokens = { token: async () => 'adc-access-token' };

function wav(data: Buffer): Buffer {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(7, 20); // μ-law
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(8000, 24);
    header.writeUInt32LE(8000, 28);
    header.writeUInt16LE(1, 32);
    header.writeUInt16LE(8, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]);
}

const AUDIO = Buffer.from([0x10, 0x20, 0x30, 0x40, 0x50]);

function counting(reply: () => Response = () => new Response(JSON.stringify({ audioContent: wav(AUDIO).toString('base64') }))) {
    const bodies: Array<{ url: string; body: Record<string, any>; auth: string }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
        bodies.push({
            url: String(url),
            body: JSON.parse(String(init?.body)),
            auth: (init?.headers as Record<string, string>).Authorization ?? '',
        });
        return reply();
    }) as typeof fetch;
    return { fetchImpl, bodies };
}

describe('CS-04: the request-size guard refuses locally, before any request', () => {
    test('5,000 bytes passes; 5,001 is refused with a reason', () => {
        assert.doesNotThrow(() => checkSynthesisInput('a'.repeat(5000)));
        assert.throws(() => checkSynthesisInput('a'.repeat(5001)), (e: unknown) => e instanceof TtsRefused && e.reason === 'too_long');
    });

    test('the cap is bytes, not characters: 2,000 three-byte characters are refused', () => {
        assert.throws(() => checkSynthesisInput('€'.repeat(2000)), TtsRefused);
    });

    test('🔴 an over-long sentence never reaches the network', async () => {
        const { fetchImpl, bodies } = counting();
        const tts = createTts({ tokens, fetchImpl });
        await assert.rejects(tts.synthesize('a'.repeat(TTS.maxInputBytes + 1)), TtsRefused);
        assert.equal(bodies.length, 0);
    });

    test('a blank sentence is refused, not synthesised as silence', async () => {
        const { fetchImpl, bodies } = counting();
        const tts = createTts({ tokens, fetchImpl });
        for (const blank of ['', '   ', '\n']) {
            await assert.rejects(tts.synthesize(blank), (e: unknown) => e instanceof TtsRefused && e.reason === 'empty');
        }
        assert.equal(bodies.length, 0);
    });
});

describe('the request and the response', () => {
    test('Chirp 3 HD, MULAW at 8 kHz, an ADC bearer token and no key in the URL', async () => {
        const { fetchImpl, bodies } = counting();
        const audio = await createTts({ tokens, fetchImpl }).synthesize('A finished backend sentence.');
        assert.deepEqual(audio, AUDIO, 'the WAV header is unwrapped');
        const [sent] = bodies;
        assert.equal(sent!.url, TTS_ENDPOINT);
        assert.doesNotMatch(sent!.url, /[?&]key=/);
        assert.equal(sent!.auth, 'Bearer adc-access-token');
        assert.equal(sent!.body.voice.name, TTS.voice);
        assert.deepEqual(sent!.body.audioConfig, { audioEncoding: 'MULAW', sampleRateHertz: 8000 });
        assert.deepEqual(sent!.body.input, { text: 'A finished backend sentence.' });
    });

    test('raw audio with no WAV header passes through unchanged', () => {
        assert.deepEqual(unwrapWav(AUDIO), AUDIO);
    });

    test('a response with no audio, or an HTTP error, is TtsUnavailable', async () => {
        for (const reply of [
            () => new Response(JSON.stringify({}), { status: 200 }),
            () => new Response('{}', { status: 403 }),
        ]) {
            await assert.rejects(createTts({ tokens, fetchImpl: counting(reply).fetchImpl }).synthesize('Hello there.'), TtsUnavailable);
        }
    });
});

describe('the sha256 cache', () => {
    test('the same sentence is requested once, however often it is spoken', async () => {
        const { fetchImpl, bodies } = counting();
        const tts = createTts({ tokens, fetchImpl });
        await Promise.all([tts.synthesize('Same.'), tts.synthesize('Same.')]);
        await tts.synthesize('Same.');
        assert.equal(bodies.length, 1);
        assert.equal(tts.requests, 1);
    });

    test('prerender puts the disclosure in the cache before the call needs it', async () => {
        const { fetchImpl, bodies } = counting();
        const tts = createTts({ tokens, fetchImpl });
        await tts.prerender(['Disclosure.', 'Beat one.']);
        await tts.synthesize('Disclosure.');
        assert.equal(bodies.length, 2);
    });

    test('a failure is not cached: the next attempt asks again', async () => {
        let fail = true;
        const { fetchImpl, bodies } = counting(() => fail
            ? new Response('{}', { status: 500 })
            : new Response(JSON.stringify({ audioContent: AUDIO.toString('base64') })));
        const tts = createTts({ tokens, fetchImpl });
        await assert.rejects(tts.synthesize('Retry me.'));
        fail = false;
        assert.deepEqual(await tts.synthesize('Retry me.'), AUDIO);
        assert.equal(bodies.length, 2);
    });

    test('the cache is bounded', async () => {
        const { fetchImpl, bodies } = counting();
        const tts = createTts({ tokens, fetchImpl, cacheEntries: 2 });
        await tts.synthesize('One.');
        await tts.synthesize('Two.');
        await tts.synthesize('Three.');
        await tts.synthesize('One.');
        assert.equal(bodies.length, 4, 'the oldest entry was evicted');
    });
});
