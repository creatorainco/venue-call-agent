/**
 * The beep gate (it-05), on a fake clock: the message waits for the end of the greeting, a person
 * cancels it, the bound speaks anyway, and a failing poll is never read as a verdict.
 *
 * 🔴 POSITIVE CONTROL: the "speaks at the beep" case also asserts it did NOT return on the polls
 * before the beep, so a gate that returned on the first poll would fail here.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { awaitVoicemailBeep, type AnswererVerdict } from '../src/carrier/beepGate.ts';

function clock() {
    let t = 0;
    return {
        now: () => t,
        sleep: async (ms: number) => { t += ms; },
    };
}

const verdicts = (list: Array<AnswererVerdict | Error>) => {
    let i = 0;
    return async () => {
        const v = list[Math.min(i++, list.length - 1)]!;
        if (v instanceof Error) throw v;
        return v;
    };
};
const UNDECIDED: AnswererVerdict = { answered_by: null, message_end: false };

describe('awaitVoicemailBeep', () => {
    it('holds through the greeting and speaks at machine_end_beep', async () => {
        const c = clock();
        const r = await awaitVoicemailBeep({
            poll: verdicts([UNDECIDED, UNDECIDED, { answered_by: 'machine_start', message_end: false }, { answered_by: 'machine_end_beep', message_end: true }]),
            intervalMs: 1000, timeoutMs: 30_000, ...c,
        });
        assert.equal(r.outcome, 'message_end');
        assert.equal(r.polls, 4, 'it did not speak before the beep');
        assert.equal(r.waitedMs, 3000);
    });

    it('a person answering cancels the voicemail message', async () => {
        const c = clock();
        const r = await awaitVoicemailBeep({ poll: verdicts([UNDECIDED, { answered_by: 'human', message_end: false }]), intervalMs: 1000, ...c });
        assert.equal(r.outcome, 'human');
    });

    it('no verdict inside the bound: speak anyway at the timeout', async () => {
        const c = clock();
        const r = await awaitVoicemailBeep({ poll: verdicts([UNDECIDED]), intervalMs: 1500, timeoutMs: 30_000, ...c });
        assert.equal(r.outcome, 'timeout');
        assert.equal(r.waitedMs, 30_000);
        assert.equal(r.polls, 20, 'a poll at 0 and every 1.5 s up to 28.5 s; inside the seam limiter');
    });

    it('a failing poll keeps waiting: an error is not a verdict', async () => {
        const c = clock();
        const r = await awaitVoicemailBeep({
            poll: verdicts([new Error('seam down'), new Error('seam down'), { answered_by: 'machine_end_silence', message_end: true }]),
            intervalMs: 1000, ...c,
        });
        assert.equal(r.outcome, 'message_end');
        assert.equal(r.pollErrors, 2);

        const c2 = clock();
        const never = await awaitVoicemailBeep({ poll: verdicts([new Error('seam down')]), intervalMs: 1000, timeoutMs: 5000, ...c2 });
        assert.equal(never.outcome, 'timeout', 'errors all the way: the bound still speaks');
    });

    it('an aborted call stops at once and polls nothing more', async () => {
        const c = clock();
        const ac = new AbortController();
        let polls = 0;
        const r = await awaitVoicemailBeep({
            poll: async () => { polls++; if (polls === 2) ac.abort(); return UNDECIDED; },
            intervalMs: 1000, signal: ac.signal, ...c,
        });
        assert.equal(r.outcome, 'aborted');
        assert.equal(polls, 2);

        const pre = new AbortController();
        pre.abort();
        assert.equal((await awaitVoicemailBeep({ poll: verdicts([UNDECIDED]), signal: pre.signal, ...clock() })).outcome, 'aborted');
    });

    it('machine_start alone is not the end of the greeting', async () => {
        const c = clock();
        const r = await awaitVoicemailBeep({
            poll: verdicts([{ answered_by: 'machine_start', message_end: false }]), intervalMs: 1000, timeoutMs: 3000, ...c,
        });
        assert.equal(r.outcome, 'timeout');
    });
});
