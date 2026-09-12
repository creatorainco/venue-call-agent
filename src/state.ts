/**
 * The call state machine.
 *
 * 🔴 THE LOAD-BEARING PROPERTY: no outbound audio may leave before the disclosure has been spoken.
 * There is deliberately NO transition from `connected` to anything except `disclosing`. A
 * restaurant has to be told what this call is before it hears anything else, and the machine — not
 * a reviewer's diligence — is what makes that true.
 *
 * TASK-970 fills in the behaviour. This file exists so the shape, and the one rule that must not be
 * negotiated away, are in place before anyone writes the interesting part.
 */

export type CallState =
    | 'idle'
    | 'connected'
    | 'disclosing'
    | 'notice'
    | 'qa'
    | 'closing'
    | 'ended';

const LEGAL: Readonly<Record<CallState, readonly CallState[]>> = Object.freeze({
    idle: ['connected'],
    // The ONLY move out of `connected`. Do not add a second one.
    connected: ['disclosing'],
    disclosing: ['notice', 'ended'],
    notice: ['qa', 'closing', 'ended'],
    qa: ['qa', 'closing', 'ended'],
    closing: ['ended'],
    ended: [],
});

export function canTransition(from: CallState, to: CallState): boolean {
    return LEGAL[from].includes(to);
}

/** True only once the disclosure has actually been spoken. Gate every outbound frame on this. */
export function mayEmitAudio(state: CallState, disclosureSpoken: boolean): boolean {
    if (state === 'disclosing') return true;   // the disclosure itself
    return disclosureSpoken;
}
