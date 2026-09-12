#!/usr/bin/env node
/**
 * Mint a call-scoped capability token locally, with no backend running.
 *
 *     npm run mint-token -- --reservation=abc --attempt=1
 *     npm run mint-token -- --reservation=abc --attempt=1 --expired
 *     npm run mint-token -- --all          # one of each shape, for a test fixture
 *
 * WHY THIS EXISTS. The token is the only credential the agent ever holds, and every interesting
 * refusal is about it: a forged one, an aged-out one, one minted for a different booking. Before
 * this script, producing any of those meant a running platform-backend with a database behind it,
 * so in practice they were reasoned about rather than exercised. The format is fifteen lines of
 * `node:crypto` and is fully specified in the backend's own header, so there is no reason for it
 * to be hard to produce.
 *
 *     v1.<reservation_id>.<attempt_id>.<expiry_ms>.<HMAC-SHA256 base64url of the first three>
 *
 * ⚠️ THIS IS A SECOND IMPLEMENTATION OF SOMEBODY ELSE'S FORMAT, which is a thing that goes stale.
 * `test/token.test.ts` pins the shape, and `contract/seam4.json` records the commit it was read
 * from. If the backend changes the version prefix or the TTL, the tokens this mints will verify
 * as `invalid` over there and as fine over here — so treat a mysterious `token_invalid` against a
 * real backend as a drift signal, not a typo.
 *
 * 🔴 IT DIALS NOTHING AND REACHES NOTHING. A token is a string. Handing one to a service that can
 * place calls is TASK-973, and that is where the approval gate lives.
 */

import { createHmac } from 'node:crypto';

/** 20 minutes — the backend's VENUE_CALL_TTL_MS. Longer than the longest sane call, much shorter
 *  than the preview token's 30, because this one crosses a cloud boundary. */
export const TTL_MS = 20 * 60 * 1000;
const VERSION = 'v1';

export function mint({ reservationId, attemptId, secret, expiresAt }) {
    if (!secret) {
        throw new Error(
            'mint-token: no signing secret. Set VENUE_CALL_SECRET (any throwaway string locally — ' +
            'it is a shared literal, not an issued credential) or pass --secret=…',
        );
    }
    if (!reservationId || !attemptId || reservationId.includes('.') || attemptId.includes('.')) {
        // The dot is the field separator. Two different pairs could otherwise sign the same
        // payload — the backend refuses this too, and for the same reason.
        throw new Error('mint-token: reservation and attempt must be present and contain no dot');
    }
    const payload = `${reservationId}.${attemptId}.${expiresAt}`;
    const sig = createHmac('sha256', Buffer.from(secret, 'utf8')).update(payload).digest('base64url');
    return `${VERSION}.${payload}.${sig}`;
}

const flag = (name) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
};
const has = (name) => process.argv.includes(`--${name}`);

if (process.argv[1] && process.argv[1].endsWith('mint-token.mjs')) {
    const secret = flag('secret') ?? process.env.VENUE_CALL_SECRET ?? '';
    const reservationId = flag('reservation') ?? 'mock-reservation-0001';
    const attemptId = flag('attempt') ?? 'mock-attempt-0001';
    const now = Number(flag('now') ?? Date.now());

    if (!secret) {
        console.error('mint-token: VENUE_CALL_SECRET is unset and --secret was not passed.');
        console.error('');
        console.error('  It is a SHARED LITERAL, not something anybody issues you. For local work,');
        console.error('  invent one and set the same value on platform-backend:');
        console.error('');
        console.error('      VENUE_CALL_SECRET=local-dev-not-a-secret npm run mint-token');
        console.error('');
        console.error('  Against the in-repo mock you need none of this — use `Bearer mock:<scenario>`.');
        process.exit(64);
    }

    const shapes = has('all')
        ? [
            ['valid', { reservationId, attemptId, expiresAt: now + TTL_MS }],
            ['expired', { reservationId, attemptId, expiresAt: now - 1000 }],
            ['other booking', { reservationId: `${reservationId}-other`, attemptId, expiresAt: now + TTL_MS }],
            ['next attempt', { reservationId, attemptId: `${attemptId}-2`, expiresAt: now + TTL_MS }],
        ]
        : [[has('expired') ? 'expired' : 'valid', {
            reservationId,
            attemptId,
            expiresAt: has('expired') ? now - 1000 : now + TTL_MS,
        }]];

    for (const [label, spec] of shapes) {
        const token = mint({ ...spec, secret });
        if (shapes.length > 1) console.log(`# ${label}`);
        console.log(token);
    }

    if (has('all')) {
        console.error('');
        console.error('The last two verify perfectly and are still refused: a token is scoped to ONE');
        console.error('attempt at ONE booking, so it cannot be replayed onto another booking, and it');
        console.error('cannot be replayed onto the same booking\'s next attempt either.');
    }
}
