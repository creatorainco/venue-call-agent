/**
 * CORE-A16: the seam client refuses a blank sentence wherever the agent would speak it.
 *
 * `call-event` may return an empty `say` only for `answerer_reported`, which says nothing to the
 * venue. Everywhere else, and in every sentence of `call-context`, blank is `SeamUnavailable`,
 * so the call stops instead of playing silence where a restaurant expects words.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createSeamClient, SeamUnavailable } from '../src/seam/client.ts';
import type { EventKind } from '../src/seam/types.ts';

const replying = (body: unknown) =>
    createSeamClient({
        baseUrl: 'http://seam.invalid',
        token: 't',
        fetchImpl: (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch,
    });

const context = (over: Record<string, unknown> = {}) => ({
    reservation_id: 'r', attempt_id: 'a', still_active: true,
    venue: { name: null, city_state: null }, brand: { name: null },
    creator: { spoken_name: 'c' }, when: { spoken_time: 't', local_date: null },
    disclosure_sentence: 'Disclosure.', opening_script: ['One.', 'Two.'], voicemail_script: 'Voicemail.',
    system_instruction: '', answerable_topics: [], script_version: 'v4',
    ...over,
});

describe('call-event: empty say only where nothing is spoken', () => {
    for (const kind of ['unanswered_question', 'human_callback'] as EventKind[]) {
        test(`${kind} with an empty or blank say is refused`, async () => {
            for (const say of ['', '   ']) {
                await assert.rejects(
                    replying({ recorded: true, say, do_not_call: false }).callEvent({ kind }),
                    (e: unknown) => e instanceof SeamUnavailable && /empty sentence/.test(e.message),
                );
            }
        });
    }

    test('answerer_reported with an empty say is accepted: nothing is said to the venue', async () => {
        const r = await replying({ recorded: true, say: '', do_not_call: false }).callEvent({ kind: 'answerer_reported', answerer: 'human' });
        assert.equal(r.say, '');
    });

    test('a result with no say field at all is refused, for every kind', async () => {
        await assert.rejects(replying({ recorded: true, do_not_call: false }).callEvent({ kind: 'answerer_reported', answerer: 'human' }), SeamUnavailable);
    });

    test('CONTROL — a real sentence passes', async () => {
        const r = await replying({ recorded: true, say: 'Someone will follow up.', do_not_call: false }).callEvent({ kind: 'unanswered_question', question_verbatim: 'q' });
        assert.equal(r.say, 'Someone will follow up.');
    });
});

describe('call-context: every sentence the agent may read is non-blank', () => {
    for (const [name, over] of [
        ['a blank disclosure', { disclosure_sentence: '  ' }],
        ['a blank beat in the opening', { opening_script: ['One.', ''] }],
        ['an empty opening', { opening_script: [] }],
        ['a blank voicemail script', { voicemail_script: '' }],
        ['a non-string voicemail script', { voicemail_script: null }],
    ] as Array<[string, Record<string, unknown>]>) {
        test(`${name} is refused`, async () => {
            await assert.rejects(replying(context(over)).callContext(), SeamUnavailable);
        });
    }

    test('CONTROL — a complete context passes', async () => {
        assert.equal((await replying(context()).callContext()).disclosure_sentence, 'Disclosure.');
    });
});
