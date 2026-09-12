/**
 * Boot behaviour, asserted rather than described.
 *
 * The old version of `config.ts` carried its two most important properties as prose in a comment:
 * that it fails closed, and that the string 'false' is truthy in JavaScript. A property stated in
 * a comment is a property nobody is checking, and the first of the two turned out to be pointed
 * at the wrong door — it blocked a laptop with no Google account from running tests that need no
 * Google account. Both are assertions now.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULT_API_BASE_URL,
    loadConfig,
    readFlag,
    requireLiveSession,
    requireRealBackend,
} from '../src/config.ts';

describe('the local path boots with nothing configured', () => {
    test('an empty environment yields a usable config pointed at the mock', () => {
        const config = loadConfig({});
        assert.equal(config.apiBaseUrl, DEFAULT_API_BASE_URL);
        assert.equal(config.port, 8787);
        assert.equal(config.venueCallSecret, '');
    });

    test('the default base url is the port the mock actually listens on', () => {
        // Kept in step by hand; if src/mock/cli.ts moves, this is where it is noticed.
        assert.match(DEFAULT_API_BASE_URL, /:8788$/);
    });

    test('whitespace-only values are treated as absent, not as values', () => {
        const config = loadConfig({ CREATORAIN_API_BASE_URL: '   ', VENUE_CALL_SECRET: '\t' });
        assert.equal(config.apiBaseUrl, DEFAULT_API_BASE_URL);
        assert.equal(config.venueCallSecret, '');
    });
});

describe('PORT', () => {
    test('a real value is used', () => {
        assert.equal(loadConfig({ PORT: '  9001 ' }).port, 9001);
    });

    for (const bad of ['abc', '0', '-1', '70000']) {
        test(`${JSON.stringify(bad)} is refused rather than coerced`, () => {
            assert.throws(() => loadConfig({ PORT: bad }), /not a usable port/);
        });
    }
});

describe("🔴 the string 'false' is truthy, and readFlag is the only sanctioned reader", () => {
    test("only '1' is true", () => {
        assert.equal(readFlag({ X: '1' }, 'X'), true);
    });

    for (const value of ['false', 'true', 'yes', 'no', '0', '', 'FALSE']) {
        test(`${JSON.stringify(value)} is false`, () => {
            assert.equal(readFlag({ X: value }, 'X'), false);
        });
    }

    test('the naive read this guards against would get it wrong', () => {
        // The positive control for the trap itself: if this assertion ever fails, JavaScript has
        // changed and the whole warning can go.
        assert.equal(Boolean('false'), true);
    });
});

describe('the live-session gate refuses BEFORE a session opens, and names what is missing', () => {
    test('an empty environment refuses and names both credentials', () => {
        assert.throws(() => requireLiveSession({}), (error: unknown) => {
            const message = (error as Error).message;
            assert.match(message, /GEMINI_API_KEY/);
            assert.match(message, /SPEECH_TO_TEXT_CREDENTIALS/);
            return true;
        });
    });

    test('one present and one missing still refuses, naming only the missing one', () => {
        assert.throws(
            () => requireLiveSession({ GEMINI_API_KEY: 'x' }),
            (error: unknown) => {
                const message = (error as Error).message;
                assert.match(message, /SPEECH_TO_TEXT_CREDENTIALS/);
                assert.doesNotMatch(message, /Missing: GEMINI_API_KEY/);
                return true;
            },
        );
    });

    test('both present returns them, and the model override is optional', () => {
        const live = requireLiveSession({ GEMINI_API_KEY: 'a', SPEECH_TO_TEXT_CREDENTIALS: 'b' });
        assert.equal(live.geminiApiKey, 'a');
        assert.equal(live.geminiLiveModel, '', 'empty means "use the pin in liveDefaults"');
    });

    test('it does NOT block the local path — loadConfig succeeded on the same empty environment', () => {
        // The regression this whole split exists to prevent.
        assert.doesNotThrow(() => loadConfig({}));
    });
});

describe('the real-backend gate is a different failure with a different fix', () => {
    test('no signing literal refuses, and says the mock does not need one', () => {
        assert.throws(() => requireRealBackend(loadConfig({})), /VENUE_CALL_SECRET is unset/);
    });

    test('a literal — any literal — satisfies it, because it is shared, not issued', () => {
        assert.doesNotThrow(() => requireRealBackend(loadConfig({ VENUE_CALL_SECRET: 'anything' })));
    });
});
