/**
 * The disclosure gate, and its sabotage control.
 *
 * These two properties are the reason the state machine exists at all, so they are tested before
 * any behaviour is written. If either goes red, do NOT relax the test — the machine is wrong.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CALL_STATES, canTransition, mayEmitAudio, type CallState } from '../src/state.ts';

describe('the disclosure gate', () => {
    test('connected leads ONLY to disclosing — there is no second door', () => {
        // Every state, read from the machine: a list typed out here would silently miss a new one.
        const reachable = CALL_STATES.filter((s) => canTransition('connected', s));
        assert.deepEqual(reachable, ['disclosing'],
            'a second exit from `connected` would let a restaurant hear us before it is told who we are');
    });

    test('no audio may leave before the disclosure is spoken', () => {
        for (const s of ['notice', 'qa', 'closing', 'voicemail', 'menu'] as CallState[]) {
            assert.equal(mayEmitAudio(s, false), false, `${s} emitted audio with no disclosure`);
            assert.equal(mayEmitAudio(s, true), true, `${s} refused audio after a valid disclosure`);
        }
    });

    test('the disclosure itself is the one thing that may speak first', () => {
        assert.equal(mayEmitAudio('disclosing', false), true);
    });

    test('nothing is heard before the line is answered, while connected, or after the end — whatever the flag says', () => {
        // `mayEmitAudio('ended', true)` was true: a call that had hung up was allowed to talk.
        for (const s of ['idle', 'connected', 'ended'] as CallState[]) {
            assert.equal(mayEmitAudio(s, true), false, `${s} may emit audio once a disclosure was spoken`);
            assert.equal(mayEmitAudio(s, false), false, `${s} may emit audio with no disclosure`);
        }
    });

    test('ended has no exits, and every state is covered by the machine', () => {
        assert.deepEqual(CALL_STATES.filter((s) => canTransition('ended', s)), []);
        assert.deepEqual(
            [...CALL_STATES].sort(),
            ['closing', 'connected', 'disclosing', 'ended', 'idle', 'menu', 'notice', 'qa', 'voicemail'],
        );
    });

    test('a machine is never read the notice, and a menu can hand us back to the disclosure', () => {
        assert.deepEqual(CALL_STATES.filter((s) => canTransition('voicemail', s)), ['ended'],
            'voicemail is one pass and the end: no notice, no questions');
        assert.equal(canTransition('voicemail', 'notice'), false);
        assert.equal(canTransition('disclosing', 'voicemail'), true);
        assert.equal(canTransition('disclosing', 'menu'), true);
        assert.equal(canTransition('menu', 'disclosing'), true,
            'whoever comes off a phone menu has not been told who we are');
        assert.equal(canTransition('menu', 'qa'), false, 'a person off a menu hears the notice before any answer');
    });
});

describe('sabotage control — these MUST fail if the machine is broken', () => {
    test('an illegal transition is rejected', () => {
        assert.equal(canTransition('connected', 'notice'), false,
            'CONTROL FAILED: connected -> notice is exactly the path that skips the disclosure');
        assert.equal(canTransition('ended', 'qa'), false);
    });
});
