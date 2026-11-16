/**
 * it-05: pb's POST /reservations/call-answerer, as the mock serves it, as the client reads it, and
 * what the agents do with a person the carrier detected after they took the line for a voicemail.
 *
 * The live-call cut-in (nothing of the voicemail script reaches speak() or the wire) is tested on
 * the fake leg in test/cascadeBridge.test.ts; this file holds the pieces underneath it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { answererVerdictFor, startMockSeam } from '../src/mock/server.ts';
import { createSeamClient } from '../src/seam/client.ts';
import { createCascadeAgent } from '../src/agent/cascadeAgent.ts';
import { createScriptedStub } from '../src/agent/scriptedStub.ts';
import { createKeywordClassifier } from '../src/agent/intent.ts';
import type { AgentTurn, CallAgent } from '../src/agent/contract.ts';
import type { SeamClient } from '../src/seam/client.ts';
import { nextState } from '../src/carrier/call.ts';

const contract = JSON.parse(readFileSync(new URL('../contract/seam4.json', import.meta.url), 'utf8'));
const route = contract.routes.find((r: { path: string }) => r.path === '/reservations/call-answerer');

const GREETING = 'you have reached Test Venue, please leave a message after the tone';

async function post(baseUrl: string, token: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${baseUrl}/reservations/call-answerer`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: '{}',
    });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
}

describe('the call-answerer route in the contract', () => {
    test('is in the snapshot with the four fields pb serves (VenueCallAnswerer)', () => {
        assert.ok(route, 'contract/seam4.json carries /reservations/call-answerer');
        assert.equal(route.method, 'POST');
        assert.deepEqual([...route.response_fields].sort(), ['answered_by', 'machine', 'message_end', 'reported_at']);
    });
});

describe('the mock call-answerer route', () => {
    test('serves exactly the contract fields, built as pb builds them', async () => {
        const mock = await startMockSeam({ port: 0, amd: ['machine_start'] });
        try {
            const { status, body } = await post(mock.baseUrl, 'mock:happy');
            assert.equal(status, 200);
            assert.deepEqual(Object.keys(body).sort(), [...route.response_fields].sort());
            assert.deepEqual(body, answererVerdictFor('machine_start'));
            assert.equal(body.machine, true);
            assert.equal(body.message_end, false, 'machine_start is not the end of the greeting');
        } finally {
            await mock.close();
        }
    });

    test('pb rule, value by value: machine_* is a machine, only machine_end_* ends the greeting', () => {
        const cases: Array<[string | null, boolean, boolean]> = [
            [null, false, false],
            ['human', false, false],
            ['fax', false, false],
            ['unknown', false, false],
            ['machine_start', true, false],
            ['machine_end_beep', true, true],
            ['machine_end_silence', true, true],
            ['machine_end_other', true, true],
        ];
        for (const [v, machine, end] of cases) {
            const got = answererVerdictFor(v);
            assert.equal(got.machine, machine, String(v));
            assert.equal(got.message_end, end, String(v));
            assert.equal(got.answered_by, v);
            assert.equal(got.reported_at === null, v === null, `reported_at only once a verdict is on record (${String(v)})`);
        }
    });

    test('walks the voicemail scenario sequence per booking, the last value repeating', async () => {
        const mock = await startMockSeam({ port: 0 });
        try {
            const a = 'mock:voicemail:seq-a';
            assert.equal((await post(mock.baseUrl, a)).body.answered_by, null);
            assert.equal((await post(mock.baseUrl, a)).body.answered_by, 'machine_end_beep');
            assert.equal((await post(mock.baseUrl, a)).body.answered_by, 'machine_end_beep');
            // Another booking starts its own sequence.
            assert.equal((await post(mock.baseUrl, 'mock:voicemail:seq-b')).body.answered_by, null);
            // A scenario with no `amd` is undecided forever, as pb is with AMD off.
            assert.equal((await post(mock.baseUrl, 'mock:happy')).body.answered_by, null);
        } finally {
            await mock.close();
        }
    });

    test('refuses a token that is not one, like every seam route', async () => {
        const mock = await startMockSeam({ port: 0 });
        try {
            const { status, body } = await post(mock.baseUrl, 'not-a-token');
            assert.equal(status, 409);
            assert.equal(body.reason, 'token_invalid');
        } finally {
            await mock.close();
        }
    });

    test('the client reads it: answered_by and message_end', async () => {
        const mock = await startMockSeam({ port: 0, amd: ['human'] });
        try {
            const seam = createSeamClient({ baseUrl: mock.baseUrl, token: 'mock:happy' });
            assert.deepEqual(await seam.callAnswerer!(), { answered_by: 'human', message_end: false });
            const entry = mock.journal.find((e) => e.route === '/reservations/call-answerer');
            assert.ok(entry, 'the read went through the mock route');
        } finally {
            await mock.close();
        }
    });
});

describe('nextState never takes the cut-in edge itself', () => {
    const turn = (over: Partial<AgentTurn>): AgentTurn => ({ say: [], toolCalls: [], endCall: false, ...over });
    test('an agent turn in voicemail stays in voicemail, whatever it says', () => {
        assert.equal(nextState('voicemail', turn({ say: ['hello'] })), 'voicemail');
        assert.equal(nextState('voicemail', turn({ say: ['hello'], endCall: true })), 'voicemail');
        assert.equal(nextState('voicemail', turn({
            toolCalls: [{ name: 'report_answerer', args: { answerer: 'human' } }],
            say: ['hello'],
        })), 'voicemail');
    });
});

describe('an agent told the carrier detected a person', () => {
    const makers: Array<[string, (seam: SeamClient) => CallAgent]> = [
        ['cascade', (seam) => createCascadeAgent({ seam, intents: createKeywordClassifier() })],
        ['stub', (seam) => createScriptedStub({ seam })],
    ];
    for (const [name, make] of makers) {
        test(`${name}: re-reports the answerer as human once, never the voicemail script, and gives the notice`, async () => {
            const mock = await startMockSeam({ port: 0 });
            try {
                const seam = createSeamClient({ baseUrl: mock.baseUrl, token: 'mock:voicemail' });
                const context = await seam.callContext();
                const agent = make(seam);
                await agent.open();
                const first = await agent.hear(GREETING);
                assert.deepEqual(first.say, [context.voicemail_script], 'CONTROL: the greeting is first taken for a machine');
                assert.equal(first.toolCalls[0]?.args.answerer, 'voicemail');

                const again = await agent.hear(GREETING, { person: true });
                assert.ok(!again.say.includes(context.voicemail_script));
                assert.deepEqual(again.toolCalls[0], { name: 'report_answerer', args: { answerer: 'human' } });
                assert.deepEqual(again.say, [...context.opening_script]);
                assert.equal(again.endCall, false);

                // Never a machine again, and the person is reported only once.
                const later = await agent.hear(GREETING, { person: true });
                assert.ok(!later.say.includes(context.voicemail_script));
                assert.ok(!later.toolCalls.some((c) => c.name === 'report_answerer'));
                const reports = mock.journal
                    .filter((e) => (e.body as { kind?: string }).kind === 'answerer_reported')
                    .map((e) => (e.body as { answerer?: string }).answerer);
                assert.deepEqual(reports, ['voicemail', 'human']);
            } finally {
                await mock.close();
            }
        });
    }
});
