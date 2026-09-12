/**
 * The disclosure gate, and its sabotage control.
 *
 * These two properties are the reason the state machine exists at all, so they are tested before
 * any behaviour is written. If either goes red, do NOT relax the test — the machine is wrong.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { canTransition, mayEmitAudio, type CallState } from '../src/state.ts';

describe('the disclosure gate', () => {
    test('connected leads ONLY to disclosing — there is no second door', () => {
        const all: CallState[] = ['idle', 'connected', 'disclosing', 'notice', 'qa', 'closing', 'ended'];
        const reachable = all.filter((s) => canTransition('connected', s));
        assert.deepEqual(reachable, ['disclosing'],
            'a second exit from `connected` would let a restaurant hear us before it is told who we are');
    });

    test('no audio may leave before the disclosure is spoken', () => {
        for (const s of ['notice', 'qa', 'closing'] as CallState[]) {
            assert.equal(mayEmitAudio(s, false), false, `${s} emitted audio with no disclosure`);
            assert.equal(mayEmitAudio(s, true), true, `${s} refused audio after a valid disclosure`);
        }
    });

    test('the disclosure itself is the one thing that may speak first', () => {
        assert.equal(mayEmitAudio('disclosing', false), true);
    });
});

describe('sabotage control — these MUST fail if the machine is broken', () => {
    test('an illegal transition is rejected', () => {
        assert.equal(canTransition('connected', 'notice'), false,
            'CONTROL FAILED: connected -> notice is exactly the path that skips the disclosure');
        assert.equal(canTransition('ended', 'qa'), false);
    });
});
