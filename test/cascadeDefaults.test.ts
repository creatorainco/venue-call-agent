/**
 * The intent model pin has a date on it, and the build knows the date.
 *
 * Same shape as `test/liveDefaults.test.ts` (TASK-3741 handed this test to the cascade, VCA-8): the
 * build goes red on the pin's earliest retirement day, so somebody re-reads the Vertex model page
 * before a restaurant hears a dead model's silence.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
    INTENT_LOCATION,
    INTENT_MODEL,
    INTENT_MODEL_EARLIEST_RETIREMENT,
    INTENT_MODEL_RETIREMENTS,
    STT,
    TTS,
} from '../src/tuning/cascadeDefaults.ts';

const outlived = (pin: string, today: string): boolean => {
    const deadline = INTENT_MODEL_RETIREMENTS[pin];
    return deadline !== undefined && today >= deadline;
};

describe('the intent model pin (gemini-3.5-flash-lite, dated)', () => {
    test('the pin is the model the design names, an explicit version and not an alias', () => {
        assert.equal(INTENT_MODEL, 'gemini-3.5-flash-lite');
        assert.doesNotMatch(INTENT_MODEL, /latest/);
        assert.equal(INTENT_LOCATION, 'global');
    });

    test('the pin has a dated earliest retirement, from its own row', () => {
        assert.match(INTENT_MODEL_EARLIEST_RETIREMENT, /^\d{4}-\d{2}-\d{2}$/);
        assert.equal(INTENT_MODEL_EARLIEST_RETIREMENT, INTENT_MODEL_RETIREMENTS[INTENT_MODEL]);
    });

    test('CONTROL — the pin is caught on its own retirement day, and a day before is not', () => {
        assert.equal(outlived(INTENT_MODEL, INTENT_MODEL_EARLIEST_RETIREMENT), true);
        assert.equal(outlived(INTENT_MODEL, '2027-07-20'), false);
    });

    test('CONTROL — a re-pin to a model with no dated row has no deadline, which the row test catches', () => {
        assert.equal(INTENT_MODEL_RETIREMENTS['gemini-9-imaginary'], undefined);
    });

    test('🔴 today is before the pin\'s earliest retirement; when this fails, re-read the Vertex model page and re-pin', () => {
        const today = new Date().toISOString().slice(0, 10);
        assert.equal(outlived(INTENT_MODEL, today), false,
            `${INTENT_MODEL} may retire from ${INTENT_MODEL_EARLIEST_RETIREMENT}; today is ${today}`);
    });
});

describe('speech pins', () => {
    test('STT batches inside the 100-200 ms band and rolls before the five-minute cap', () => {
        assert.ok(STT.batchMs >= 100 && STT.batchMs <= 200);
        assert.ok(STT.rolloverMs < 300_000);
    });

    test('TTS is a Chirp 3 HD voice at 8 kHz, with the 5,000-byte cap (CS-04)', () => {
        assert.match(TTS.voice, /Chirp3-HD/);
        assert.equal(TTS.sampleRateHertz, 8000);
        assert.equal(TTS.maxInputBytes, 5000);
    });
});
