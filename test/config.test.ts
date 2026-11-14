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
} from '../src/config.ts';

describe('the local path boots with nothing configured', () => {
    test('an empty environment yields a usable config pointed at the mock', () => {
        const config = loadConfig({});
        assert.equal(config.apiBaseUrl, DEFAULT_API_BASE_URL);
        assert.equal(config.port, 8787);
    });

    test('🔴 the config carries no secret and no key, even when the environment has them (CORE-A11)', () => {
        const config = loadConfig({
            VENUE_CALL_SECRET: 'planted-secret',
            GEMINI_API_KEY: 'planted-key',
            SPEECH_TO_TEXT_CREDENTIALS: 'planted-credentials',
        });
        assert.deepEqual(Object.keys(config).sort(), ['apiBaseUrl', 'port']);
        assert.doesNotMatch(JSON.stringify(config), /planted/);
    });

    test('the default base url is the port the mock actually listens on', () => {
        // Kept in step by hand; if src/mock/cli.ts moves, this is where it is noticed.
        assert.match(DEFAULT_API_BASE_URL, /:8788$/);
    });

    test('whitespace-only values are treated as absent, not as values', () => {
        const config = loadConfig({ CREATORAIN_API_BASE_URL: ' \t ' });
        assert.equal(config.apiBaseUrl, DEFAULT_API_BASE_URL);
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
