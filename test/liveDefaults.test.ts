/**
 * The three ways a latency pass quietly breaks something, turned into assertions.
 *
 * None of these is about whether a value is GOOD — nobody has measured that yet and a test cannot
 * decide it. They are about the shapes that fail silently: a field in the wrong place that the
 * API drops without complaint, a timing value that has drifted past a limit somewhere else, and a
 * knob that got deleted rather than changed.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
    LATENCY_PERCENTILES,
    LIVE_DEFAULTS,
    LIVE_MODEL,
    MAX_CALL_SECONDS,
    SEAM_TIMEOUT_MS,
    VAD,
} from '../src/tuning/liveDefaults.ts';

const contract = JSON.parse(
    readFileSync(fileURLToPath(new URL('../contract/seam4.json', import.meta.url)), 'utf8'),
);

describe('🔴 fields that are silently ignored in the wrong place', () => {
    test('the model is NOT inside the session config', () => {
        // `model` is an argument to live.connect, not a LiveConnectConfig property. Put it in the
        // config and the API drops it without a word, and you get whatever the default model is.
        assert.equal((LIVE_DEFAULTS as Record<string, unknown>).model, undefined);
        assert.equal(typeof LIVE_MODEL, 'string');
        assert.ok(LIVE_MODEL.length > 0);
    });

    test('turnCoverage lives under realtimeInputConfig, not at the top level', () => {
        // Same failure mode, and worse: the default differs between the 2.5 and 3.x lines, so a
        // misplaced value works until somebody changes the model.
        assert.equal((LIVE_DEFAULTS as Record<string, unknown>).turnCoverage, undefined);
        assert.equal(LIVE_DEFAULTS.realtimeInputConfig.turnCoverage, 'TURN_INCLUDES_ALL_INPUT');
    });

    test('the pinned model is an explicit version, never a floating alias', () => {
        // An alias that moves under a deployed voice agent changes what a restaurant hears with
        // no commit and no review.
        assert.doesNotMatch(LIVE_MODEL, /-latest$/);
    });
});

describe('every timing and safety field is present, deliberately', () => {
    const vad = LIVE_DEFAULTS.realtimeInputConfig.automaticActivityDetection;

    for (const field of [
        'disabled',
        'startOfSpeechSensitivity',
        'endOfSpeechSensitivity',
        'prefixPaddingMs',
        'silenceDurationMs',
    ] as const) {
        test(`${field} is set explicitly`, () => {
            // Not because no default exists — one is documented for silenceDurationMs — but
            // because a value nobody chose is a value nobody can review, and these five are the
            // ones an audible complaint traces back to.
            assert.notEqual(vad[field], undefined);
        });
    }

    test('automatic VAD is ON', () => {
        assert.equal(vad.disabled, false, 'manual activity signalling from a jittery carrier stream is harder, not safer');
    });

    test('silence duration starts at the documented server default, not below it', () => {
        // Starting below stock while arguing for caution is the mistake this pins against: a
        // smaller number makes the agent interrupt SOONER.
        assert.equal(VAD.silenceDurationMs, 800);
    });

    test('both transcripts are enabled — the fabrication check reads one of them', () => {
        assert.ok(LIVE_DEFAULTS.inputAudioTranscription);
        assert.ok(LIVE_DEFAULTS.outputAudioTranscription);
    });

    test('the session cannot hit the 15-minute audio-only limit mid-sentence', () => {
        assert.ok(LIVE_DEFAULTS.contextWindowCompression, 'compression is what makes that impossible rather than unlikely');
    });
});

describe('the numbers agree with limits set elsewhere', () => {
    test('a call cannot outlive its credential', () => {
        // The token is minted for 20 minutes and a call is capped at 6. If this ever inverts,
        // calls start refusing at the seam mid-conversation and it reads as a backend fault.
        assert.ok(
            MAX_CALL_SECONDS * 1000 < contract.token.ttl_ms,
            `a ${MAX_CALL_SECONDS}s call against a ${contract.token.ttl_ms}ms token`,
        );
    });

    test('the seam timeout is short enough to be a silence somebody tolerates', () => {
        assert.ok(SEAM_TIMEOUT_MS <= 3000, 'past about three seconds of nothing, the caller starts saying "hello?"');
        assert.ok(SEAM_TIMEOUT_MS >= 1000, 'below a second this fires on ordinary network noise');
    });

    test('latency is reported at the percentiles that show the bad calls', () => {
        assert.deepEqual([...LATENCY_PERCENTILES], [50, 90, 99]);
        // A mean would hide exactly the calls this feature must not make.
        assert.ok(!LATENCY_PERCENTILES.includes(0));
    });
});
