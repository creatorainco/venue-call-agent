/**
 * The speech-format probe's request bodies (TASK-3744 step 4). Pure builders; nothing here talks
 * to Google. The point is the format: μ-law, 8000 Hz, one channel, on both calls.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
    PROBE_STT_MODELS,
    digitsSurvived,
    probeRecognizeRequest,
    probeRecognizeUrl,
    probeSynthesizeRequest,
    recognizeTranscript,
} from '../src/speech/probeRequest.ts';
import { TTS } from '../src/tuning/cascadeDefaults.ts';

describe('probeSynthesizeRequest', () => {
    test('asks Chirp 3 HD for MULAW at 8000 Hz', () => {
        const body = probeSynthesizeRequest('a test sentence') as {
            input: { text: string };
            voice: { name: string };
            audioConfig: { audioEncoding: string; sampleRateHertz: number };
        };
        assert.equal(body.input.text, 'a test sentence');
        assert.equal(body.voice.name, TTS.voice);
        assert.match(body.voice.name, /Chirp3-HD/);
        assert.equal(body.audioConfig.audioEncoding, 'MULAW');
        assert.equal(body.audioConfig.sampleRateHertz, 8000);
    });
});

describe('probeRecognizeRequest', () => {
    test('declares MULAW, 8000 Hz, one channel, and carries the bytes as base64', () => {
        const audio = Buffer.from([0xff, 0x7f, 0x00, 0x80]);
        const body = probeRecognizeRequest(audio, 'telephony') as {
            config: {
                explicitDecodingConfig: { encoding: string; sampleRateHertz: number; audioChannelCount: number };
                model: string;
                languageCodes: string[];
            };
            content: string;
        };
        assert.deepEqual(body.config.explicitDecodingConfig, {
            encoding: 'MULAW',
            sampleRateHertz: 8000,
            audioChannelCount: 1,
        });
        assert.equal(body.config.model, 'telephony');
        assert.deepEqual(body.config.languageCodes, ['en-US']);
        assert.deepEqual(Buffer.from(body.content, 'base64'), audio);
    });

    test('compares the cascade model with chirp_3', () => {
        assert.deepEqual([...PROBE_STT_MODELS], ['telephony', 'chirp_3']);
    });
});

describe('probeRecognizeUrl', () => {
    test('uses the regional endpoint and the default recognizer', () => {
        assert.equal(
            probeRecognizeUrl('p'),
            'https://us-speech.googleapis.com/v2/projects/p/locations/us/recognizers/_:recognize',
        );
    });
});

describe('recognizeTranscript and digitsSurvived', () => {
    test('joins the first alternative of every result', () => {
        const response = { results: [{ alternatives: [{ transcript: 'one two' }] }, { alternatives: [{ transcript: 'three' }] }] };
        assert.equal(recognizeTranscript(response), 'one two three');
        assert.equal(recognizeTranscript({}), '');
        assert.equal(recognizeTranscript(null), '');
    });

    test('accepts the digits as words or numerals', () => {
        assert.equal(digitsSurvived('path, one two three.'), true);
        assert.equal(digitsSurvived('path 1 2 3'), true);
        assert.equal(digitsSurvived('path 1, 2, 3'), true);
        assert.equal(digitsSurvived('path 123'), true);
    });

    test('CONTROL: a transcript that lost a digit is not a pass', () => {
        assert.equal(digitsSurvived('one two'), false);
        assert.equal(digitsSurvived('one three'), false);
        assert.equal(digitsSurvived(''), false);
    });
});
