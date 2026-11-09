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
    LIVE_MODEL_EARLIEST_RETIREMENT,
    MAX_CALL_SECONDS,
    RETIRED_LIVE_MODELS,
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

/**
 * The day `pin` stops being safe to ship: Google's shutdown date for a retired model, or the
 * earliest retirement Google gives for the current pin. Undefined for a model with neither.
 */
function deadlineOf(pin: string): string | undefined {
    return RETIRED_LIVE_MODELS[pin] ?? (pin === LIVE_MODEL ? LIVE_MODEL_EARLIEST_RETIREMENT : undefined);
}

/**
 * True when `pin` has a known deadline and `today` is on or past it. Pure, so the controls below
 * can hand it a date this build has not reached yet.
 */
function pinOutlivedItsModel(pin: string, today: string): boolean {
    const deadline = deadlineOf(pin);
    return deadline !== undefined && today >= deadline;
}

describe('🔴 the pinned model has a published deadline', () => {
    test('CONTROL — the day after the 2026-11-17 shutdown, the old pin is caught', () => {
        // Without this the check below could be a no-op that passes on every date. The old pin is
        // a literal here, not LIVE_MODEL: that is the model this control must keep catching.
        assert.equal(pinOutlivedItsModel('gemini-2.5-flash-native-audio-preview-12-2025', '2026-11-18'), true);
        assert.equal(pinOutlivedItsModel('gemini-3.1-flash-live-preview', '2026-11-18'), true);
        assert.equal(pinOutlivedItsModel(LIVE_MODEL, '2026-11-18'), false);
    });

    test('CONTROL — the current pin is caught on its own earliest retirement day', () => {
        assert.equal(pinOutlivedItsModel(LIVE_MODEL, LIVE_MODEL_EARLIEST_RETIREMENT), true);
    });

    test('the current pin is not on Google\'s shutdown list and has a dated deadline', () => {
        assert.equal(RETIRED_LIVE_MODELS[LIVE_MODEL], undefined, `${LIVE_MODEL} is on the shutdown list`);
        assert.match(LIVE_MODEL_EARLIEST_RETIREMENT, /^\d{4}-\d{2}-\d{2}$/);
    });

    test('the build fails once the pinned model\'s deadline passes', () => {
        // DELIBERATE, and a required gate, never a warning: from the deadline (a UTC calendar day)
        // this fails `npm run verify`, and so CI, on every pull request until somebody re-reads
        // Google's two pages (docs/TUNING.md §3.2) and re-pins, hotfixes included.
        const today = new Date().toISOString().slice(0, 10);
        assert.equal(
            pinOutlivedItsModel(LIVE_MODEL, today),
            false,
            `${LIVE_MODEL} reached its deadline ${deadlineOf(LIVE_MODEL)}; re-read Google's deprecations and model-versions pages and re-pin`,
        );
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
