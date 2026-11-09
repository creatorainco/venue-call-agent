/**
 * The call state machine.
 *
 * 🔴 THE LOAD-BEARING PROPERTY: no outbound audio may leave before the disclosure has been spoken.
 * There is deliberately NO transition from `connected` to anything except `disclosing`. A
 * restaurant has to be told what this call is before it hears anything else, and the machine — not
 * a reviewer's diligence — is what makes that true.
 *
 * `src/carrier/outputGate.ts` is the one caller. It moves through these states and asks
 * `mayEmitAudio` before every outbound frame reaches the leg, so the rule is enforced on the wire
 * rather than stated in a comment.
 *
 * `voicemail` and `menu` are states, not flags in an agent: a machine is never read the notice,
 * and a phone menu may hand us to a person who then has to hear the disclosure again.
 *
 * 🔴 A HANGUP IS NOT A TRANSITION. `ended` is reachable from every state through
 * `OutputGate.end()`, because the far end can put the phone down at any instant and that is a
 * fact, not a choice. The edges below are the moves the CALL may choose, which is why `connected`
 * still has exactly one of them.
 */

export type CallState =
    | 'idle'
    | 'connected'
    | 'disclosing'
    | 'notice'
    | 'qa'
    | 'closing'
    /** A machine answered. One pass of the backend's message for a machine, then the end. */
    | 'voicemail'
    /** A phone menu answered. We ask for a person; a person who picks up is disclosed to again. */
    | 'menu'
    | 'ended';

const LEGAL: Readonly<Record<CallState, readonly CallState[]>> = Object.freeze({
    idle: ['connected'],
    // The ONLY move out of `connected`. Do not add a second one.
    connected: ['disclosing'],
    disclosing: ['notice', 'voicemail', 'menu', 'ended'],
    // `disclosing` again is the replay: whoever comes off a menu has not been told who we are.
    menu: ['disclosing', 'notice', 'voicemail', 'ended'],
    voicemail: ['ended'],
    notice: ['qa', 'closing', 'ended'],
    qa: ['qa', 'closing', 'ended'],
    closing: ['ended'],
    ended: [],
});

export function canTransition(from: CallState, to: CallState): boolean {
    return LEGAL[from].includes(to);
}

/** Every state, so a test walks the whole machine rather than the states somebody remembered. */
export const CALL_STATES: readonly CallState[] = Object.freeze(Object.keys(LEGAL) as CallState[]);

/**
 * True only once the disclosure has actually been spoken. Gate every outbound frame on this.
 *
 * `idle`, `connected` and `ended` are false whatever the flag says: nothing may be heard before
 * the disclosure starts, and nothing may be written after the end. The old version returned the
 * flag for every state but `disclosing`, so `mayEmitAudio('ended', true)` was true: by this
 * function, a call that had hung up was allowed to keep talking.
 */
export function mayEmitAudio(state: CallState, disclosureSpoken: boolean): boolean {
    if (state === 'idle' || state === 'connected' || state === 'ended') return false;
    if (state === 'disclosing') return true;   // the disclosure itself
    return disclosureSpoken;
}
