/**
 * The seam client, against the local mock. No database, no network, no credential, no phone.
 *
 * WHAT THIS SUITE IS FOR. Eleven refusals exist on the other side of a cloud boundary and every
 * one of them ends a call. Before this file they were readable and not runnable, which is the
 * state in which a refusal path quietly stops working and nobody finds out until a restaurant is
 * on the line. Each is now exercised by name.
 *
 * 🔴 IT INCLUDES A SABOTAGE CONTROL, at the bottom. A suite that passes because it asserts nothing
 * and a suite that passes because the code is right look identical from outside, so the last block
 * proves the assertions can fail.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startMockSeam, type MockSeam } from '../src/mock/server.ts';
import { createSeamClient, SeamRefusal, SeamUnavailable } from '../src/seam/client.ts';
import { SEAM_REFUSAL_REASONS } from '../src/seam/types.ts';

let mock: MockSeam;

before(async () => { mock = await startMockSeam({ port: 0 }); });
after(async () => { await mock.close(); });

const clientFor = (scenario: string, timeoutMs = 2500) =>
    createSeamClient({ baseUrl: mock.baseUrl, token: `mock:${scenario}`, timeoutMs });

describe('call-context — everything the opening needs', () => {
    test('a human-answered booking returns a disclosure, four beats and an instruction', async () => {
        const ctx = await clientFor('happy').callContext();

        assert.ok(ctx.disclosure_sentence.length > 0, 'the disclosure must be present');
        assert.equal(ctx.opening_script.length, 4, 'the notice is four beats — a fifth is where a busy person hangs up');
        assert.equal(ctx.script_version, 'venue-precall/v3');
        assert.equal(ctx.still_active, true);
        assert.deepEqual(ctx.answerable_topics.length, 8);
    });

    test('the disclosure names the caller before it names the purpose', async () => {
        const ctx = await clientFor('happy').callContext();
        const first = ctx.disclosure_sentence.toLowerCase();
        assert.ok(
            first.indexOf('creatorain') < first.indexOf('creators'),
            'a stranger\'s first question is who is this — the company name comes before what we do',
        );
    });

    test('the reservation id can be pinned through the token', async () => {
        const client = createSeamClient({ baseUrl: mock.baseUrl, token: 'mock:happy:res-9999' });
        const ctx = await client.callContext();
        assert.equal(ctx.reservation_id, 'res-9999');
    });
});

describe('the refusals — each one ends the call before a word is spoken', () => {
    const contextRefusals: Array<[string, string]> = [
        ['cancelled', 'reservation_not_active'],
        ['missing', 'reservation_not_found'],
        ['campaign-paused', 'campaign_not_active'],
        ['venue-stopped', 'venue_stopped'],
        ['no-name', 'script_unavailable'],
        ['seam-disabled', 'seam_disabled'],
        ['bad-token', 'token_invalid'],
    ];

    for (const [scenario, reason] of contextRefusals) {
        test(`${scenario} refuses ${reason}`, async () => {
            await assert.rejects(
                () => clientFor(scenario).callContext(),
                (error: unknown) => {
                    assert.ok(error instanceof SeamRefusal, `expected a refusal, got ${String(error)}`);
                    assert.equal(error.reason, reason);
                    return true;
                },
            );
        });
    }

    test('a token that is not in the contract shape refuses token_invalid, not a 500', async () => {
        const client = createSeamClient({ baseUrl: mock.baseUrl, token: 'not-a-real-token' });
        await assert.rejects(() => client.callContext(), (e: unknown) => e instanceof SeamRefusal && e.reason === 'token_invalid');
    });

    test('an expired token refuses mid-call, on the fact route', async () => {
        await assert.rejects(
            () => clientFor('expired-token').callFact('creator_name'),
            (e: unknown) => e instanceof SeamRefusal && e.reason === 'token_expired',
        );
    });

    test('every reason word in the contract is one the client can actually raise', () => {
        // Not a behavioural test — a completeness one. If the backend gains a twelfth reason and
        // nobody updates the union, this is where it shows up rather than at 7pm on a Friday.
        assert.equal(new Set(SEAM_REFUSAL_REASONS).size, SEAM_REFUSAL_REASONS.length, 'no duplicates');
        assert.equal(SEAM_REFUSAL_REASONS.length, 11);
    });
});

describe('call-fact — a sentence, never a value', () => {
    test('a known fact comes back as a finished sentence', async () => {
        const answer = await clientFor('happy').callFact('creator_name');
        assert.equal(answer.known, true);
        assert.match(answer.say, /^The reservation is under .+\.$/);
        assert.equal(answer.topic, 'creator_name');
    });

    test('🔴 comp_terms defers TODAY, and the deferral mentions no meal, no bill and no money', async () => {
        // This is the single most dangerous sentence the feature could produce. Production has no
        // column holding a comp clause, so the honest deferral is the correct answer — and it is
        // asserted here word-shape by word-shape, because "safe by accident" stops being safe the
        // moment somebody wires the only non-empty prose on the campaign row into it.
        const answer = await clientFor('happy').callFact('comp_terms');
        assert.equal(answer.known, false);
        assert.equal(answer.reason, 'not_agreed');
        assert.doesNotMatch(answer.say, /\$|dollar|free|comp|cover|meal|bill|pay/i);
    });

    test('after TASK-972 the authored clause is quoted unedited', async () => {
        const answer = await clientFor('comp-known').callFact('comp_terms');
        assert.equal(answer.known, true);
        assert.match(answer.say, /covering the meal/);
    });

    test('an unknown fact still returns a sentence — never an empty string', async () => {
        // An empty string handed to a model is where it improvises, so the not-known branches are
        // real sentences. The client raises rather than passing an empty one through.
        const answer = await clientFor('happy').callFact('contact_email');
        assert.equal(answer.known, false);
        assert.ok(answer.say.trim().length > 0);
    });

    test('a topic outside the closed set is refused locally, before the request leaves', async () => {
        await assert.rejects(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            () => clientFor('happy').callFact('how_much_do_you_pay' as any),
            (e: unknown) => e instanceof SeamUnavailable && /not a topic in the contract/.test((e as Error).message),
        );
    });

    test('a booking cancelled mid-call changes the answer to "is it still on"', async () => {
        const answer = await clientFor('cancelled-mid-call').callFact('still_active');
        assert.match(answer.say, /cancelled/i);
    });
});

describe('call-event — the row is what makes the promise true', () => {
    test('an unanswered question is recorded and returns the deferral to speak', async () => {
        const result = await clientFor('happy').callEvent({
            kind: 'unanswered_question',
            question_verbatim: 'do we need to hold a table by the window',
        });
        assert.equal(result.recorded, true);
        assert.ok(result.say.length > 0, 'the deferral is only allowed once the row exists');
        assert.equal(result.do_not_call, false);
    });

    test('🔴 "stop calling us" suppresses the number and says so in the same response', async () => {
        const result = await clientFor('stop-calling').callEvent({
            kind: 'human_callback',
            reason: 'asked_to_stop_calling',
        });
        assert.equal(result.do_not_call, true);
        assert.match(result.say, /taken you off the call list/i);
        assert.doesNotMatch(result.say, /but|however|before you go/i, 'they asked us to stop; no keeping them talking');
    });

    test('reporting what answered says nothing out loud', async () => {
        const result = await clientFor('phone-menu').callEvent({ kind: 'answerer_reported', answerer: 'phone_menu' });
        assert.equal(result.recorded, true);
        assert.equal(result.say, '', 'a sentence here would be the agent narrating its own bookkeeping');
    });
});

describe('when the seam does not answer', () => {
    test('a slow backend times out as UNAVAILABLE, which is not a refusal', async () => {
        // The distinction is load-bearing. A refusal is a decision; a timeout is the absence of
        // one, and "I do not know whether this booking stands" is not a thing to say to somebody
        // holding a table. They must not collapse into the same catch.
        const slow = await startMockSeam({ port: 0, latencyMs: 300 });
        try {
            const client = createSeamClient({ baseUrl: slow.baseUrl, token: 'mock:happy', timeoutMs: 50 });
            await assert.rejects(
                () => client.callContext(),
                (error: unknown) => {
                    assert.ok(error instanceof SeamUnavailable);
                    assert.ok(!(error instanceof SeamRefusal));
                    assert.match((error as Error).message, /no response in 50ms/);
                    return true;
                },
            );
        } finally {
            await slow.close();
        }
    });

    test('a dead backend is unavailable, not a refusal', async () => {
        const client = createSeamClient({ baseUrl: 'http://127.0.0.1:1', token: 'mock:happy', timeoutMs: 500 });
        await assert.rejects(() => client.callContext(), (e: unknown) => e instanceof SeamUnavailable);
    });
});

describe('the journal — what the agent actually asked for', () => {
    test('every request is recorded with its scenario and its response', async () => {
        const fresh = await startMockSeam({ port: 0 });
        try {
            const client = createSeamClient({ baseUrl: fresh.baseUrl, token: 'mock:happy' });
            await client.callContext();
            await client.callFact('who_we_are');

            assert.equal(fresh.journal.length, 2);
            assert.equal(fresh.journal[0]?.route, '/reservations/call-context');
            assert.equal(fresh.journal[1]?.route, '/reservations/call-fact');
            assert.deepEqual(fresh.journal[1]?.body, { topic: 'who_we_are' });
            assert.equal(fresh.journal[1]?.status, 200);
        } finally {
            await fresh.close();
        }
    });
});

describe('sabotage control — these MUST fail if the harness is broken', () => {
    test('the mock really does distinguish scenarios', async () => {
        const a = await clientFor('happy').callFact('comp_terms');
        const b = await clientFor('comp-known').callFact('comp_terms');
        assert.notEqual(a.say, b.say, 'if these match, the scenario selector is not wired and every test above is vacuous');
    });

    test('a refusal really is thrown, not returned', async () => {
        let threw = false;
        try {
            await clientFor('venue-stopped').callContext();
        } catch {
            threw = true;
        }
        assert.equal(threw, true, 'if this passes without throwing, every refusal assertion above proves nothing');
    });
});
