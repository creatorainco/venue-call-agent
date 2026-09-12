/**
 * The local token minter, pinned against the contract snapshot.
 *
 * `scripts/mint-token.mjs` is a SECOND implementation of a format that lives in another
 * repository. Second implementations drift, and this one drifts silently: a token with the wrong
 * version prefix looks perfectly well-formed here and comes back `token_invalid` over there,
 * which reads like a typo rather than a contract change. So every constant it uses is asserted
 * against `contract/seam4.json`, and that file is re-derived from the backend source by
 * `npm run contract:derive`.
 *
 * What this proves: the shape is right and matches what we last read from the backend.
 * What it cannot prove: that the backend still agrees today. Only the derive run can say that.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';

import { mint, TTL_MS } from '../scripts/mint-token.mjs';

const contract = JSON.parse(
    readFileSync(fileURLToPath(new URL('../contract/seam4.json', import.meta.url)), 'utf8'),
);

const SECRET = 'local-dev-not-a-secret';
const AT = 1_757_000_000_000; // a fixed instant; Date.now() in a test is a flake waiting to happen

describe('the shape matches the contract', () => {
    test('five dot-separated parts, version first', () => {
        const token = mint({ reservationId: 'r1', attemptId: 'a1', secret: SECRET, expiresAt: AT });
        const parts = token.split('.');
        assert.equal(parts.length, contract.token.parts);
        assert.equal(parts[0], contract.token.version_prefix);
        assert.equal(parts[1], 'r1');
        assert.equal(parts[2], 'a1');
        assert.equal(parts[3], String(AT));
    });

    test('the TTL is the one the backend defines', () => {
        assert.equal(TTL_MS, contract.token.ttl_ms);
        assert.equal(TTL_MS, 20 * 60 * 1000, 'twenty minutes — longer than any sane call, shorter than the preview token');
    });

    test('the signature is HMAC-SHA256 base64url over the first three fields, and nothing else', () => {
        const token = mint({ reservationId: 'r1', attemptId: 'a1', secret: SECRET, expiresAt: AT });
        const expected = createHmac('sha256', Buffer.from(SECRET, 'utf8'))
            .update(`r1.a1.${AT}`)
            .digest('base64url');
        assert.equal(token.split('.')[4], expected);
    });

    test('base64url, so it survives a header and a URL unescaped', () => {
        const sig = mint({ reservationId: 'r1', attemptId: 'a1', secret: SECRET, expiresAt: AT }).split('.')[4] ?? '';
        assert.doesNotMatch(sig, /[+/=]/, 'a + or / here would be mangled by something in the path');
    });
});

describe('scoping — the property that makes a leaked token nearly worthless', () => {
    test('a different booking produces a different signature', () => {
        const a = mint({ reservationId: 'r1', attemptId: 'a1', secret: SECRET, expiresAt: AT });
        const b = mint({ reservationId: 'r2', attemptId: 'a1', secret: SECRET, expiresAt: AT });
        assert.notEqual(a, b);
    });

    test('🔴 the SAME booking\'s next attempt also produces a different token', () => {
        // This is the part the attempt id buys and the part that is easy to drop as redundant.
        // Without it, a token leaked from attempt 1 replays onto attempt 2 of the same booking.
        const a = mint({ reservationId: 'r1', attemptId: 'a1', secret: SECRET, expiresAt: AT });
        const b = mint({ reservationId: 'r1', attemptId: 'a2', secret: SECRET, expiresAt: AT });
        assert.notEqual(a, b);
    });

    test('a different secret produces a different signature', () => {
        const a = mint({ reservationId: 'r1', attemptId: 'a1', secret: SECRET, expiresAt: AT });
        const b = mint({ reservationId: 'r1', attemptId: 'a1', secret: 'other', expiresAt: AT });
        assert.notEqual(a, b);
    });
});

describe('it refuses rather than producing something that cannot be verified', () => {
    test('no secret is an error, not an unsigned token', () => {
        assert.throws(
            () => mint({ reservationId: 'r1', attemptId: 'a1', secret: '', expiresAt: AT }),
            /no signing secret/,
        );
    });

    for (const [label, spec] of [
        ['a dot in the reservation id', { reservationId: 'r.1', attemptId: 'a1' }],
        ['a dot in the attempt id', { reservationId: 'r1', attemptId: 'a.1' }],
        ['an empty reservation id', { reservationId: '', attemptId: 'a1' }],
        ['an empty attempt id', { reservationId: 'r1', attemptId: '' }],
    ] as Array<[string, { reservationId: string; attemptId: string }]>) {
        test(`${label} is refused`, () => {
            // The dot is the field separator, so two different pairs could otherwise sign the
            // same payload. The backend refuses this too, for the same reason.
            assert.throws(() => mint({ ...spec, secret: SECRET, expiresAt: AT }), /no dot|present/);
        });
    }
});
