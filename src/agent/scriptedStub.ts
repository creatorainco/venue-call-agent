/**
 * A REFERENCE AGENT WITH NO MODEL IN IT.
 *
 * 🔴 THIS IS NOT THE DELIVERABLE. TASK-970 replaces it with something that holds a Gemini Live
 * session open and hears actual audio. This one matches keywords, and it would be embarrassing on
 * a real telephone.
 *
 * IT EXISTS FOR THREE REASONS, and they are worth stating because "delete the stub" is otherwise
 * the obvious first move:
 *
 *   1. It makes the harness, the rubric and the fabrication check RUNNABLE TODAY. A test
 *      infrastructure with nothing to run is a test infrastructure nobody has proved.
 *   2. It is an EXECUTABLE SPECIFICATION. Everything the real agent must do — disclosure first,
 *      never deliver the notice to a machine, log before deferring, obey a stop request inside the
 *      same turn — is here in the smallest form that satisfies the rubric. When the real one
 *      fails a check, this file is the answer to "what was it supposed to do".
 *   3. It is the BASELINE. The real agent must score at least what this scores, and if it does
 *      not, a keyword matcher is beating a language model and that is worth knowing before a
 *      restaurant hears it.
 *
 * Keep it passing. When the real agent lands, run both: `npm run eval` takes `--agent=stub` or
 * `--agent=live`, and the day the live one wins on every fixture is the day this stops mattering.
 *
 * NO-FACTS-EXEMPT[comp]: the topic cues must hold the words a manager uses to ask about money.
 * They RECOGNISE a question and are never spoken - every sentence this file says comes from the seam.
 */

import type { AgentTurn, CallAgent, ToolCall } from './contract.ts';
import type { SeamClient } from '../seam/client.ts';
import type { CallContext, FactTopic } from '../seam/types.ts';

/**
 * Question → topic. Crude, and crude is the point: it must be obvious that the mapping is doing
 * the work rather than any understanding, so nobody mistakes a green eval for a working agent.
 */
const TOPIC_CUES: Array<[RegExp, FactTopic]> = [
    [/\b(who'?s paying|who pays|paying for|comp|free|on the house|the bill|cover the)\b/i, 'comp_terms'],
    [/\b(how many|party size|covers|people|guests)\b/i, 'party_size'],
    [/\b(what time|when are they|when do they|arriv)\b/i, 'arrival_time'],
    [/\b(who'?s (?:the|it) (?:booking|reservation)|whose name|under what name|which name)\b/i, 'creator_name'],
    [/\b(who are you|what company|what is creatorain|who is this)\b/i, 'who_we_are'],
    [/\b(what will they do|filming|photos|video|content|post)\b/i, 'what_the_creator_will_do'],
    [/\b(still on|still coming|still happening|cancelled|is it confirmed)\b/i, 'still_active'],
    [/\b(email|contact|reach you|get hold of)\b/i, 'contact_email'],
];

const MACHINE_CUES = [
    /\bpress \d\b/i,
    /\bmain menu\b/i,
    /\bfor (?:hours|directions|reservations), press\b/i,
    /\bleave a message\b/i,
    /\bafter the (?:tone|beep)\b/i,
    /\bnot available (?:right now|at the moment)\b/i,
    /\bthis is an automated\b/i,
];

const VOICEMAIL_CUES = [/\bleave a message\b/i, /\bafter the (?:tone|beep)\b/i];

const STOP_CUES = [
    /\b(stop calling|don'?t call|do not call|take us off|remove us|no more calls)\b/i,
];

const CHANGE_CUES = [
    /\b(cancel|move|reschedul\w+|change the (?:time|booking|reservation)|different time)\b/i,
];

/**
 * They are finished.
 *
 * Ordered AFTER the topic match on purpose: "thanks, but who's paying?" is a question, not a
 * goodbye, and treating a polite question as a close is how a call ends with the thing they
 * actually rang about unanswered.
 */
const DONE_CUES = [
    /\b(that'?s (?:all|it|fine|great|grand)|no,? (?:thanks|that'?s all)|nope|we'?re good|all good)\b/i,
    /\b(thanks|thank you|cheers|got it|understood|noted|will do|sounds good|appreciate it|perfect|lovely)\b/i,
];

const WRONG_NUMBER_CUES = [/\b(wrong number|no such (?:place|restaurant)|you'?ve got the wrong)\b/i];

export function createScriptedStub(deps: { seam: SeamClient }): CallAgent {
    const seam = deps.seam;

    let context: CallContext | null = null;
    let noticeDelivered = false;
    let answererReported = false;
    let questionsAnswered = 0;
    let staffAttempts = 0;

    const turn = (over: Partial<AgentTurn> = {}): AgentTurn =>
        ({ say: [], toolCalls: [], endCall: false, ...over });

    return {
        async open(): Promise<AgentTurn> {
            // Every refusal happens here and the harness turns it into a silent hang-up. Nothing
            // is spoken before this returns, which is the whole reason the context read is first.
            context = await seam.callContext();
            return turn({ say: [context.disclosure_sentence], note: 'disclosure only; listening before the notice' });
        },

        async hear(utterance: string): Promise<AgentTurn> {
            if (!context) throw new Error('hear() before open() — there is no context to speak from');

            // ── 1. STOP. Before anything else, including finishing a sentence. ────────────
            if (STOP_CUES.some((re) => re.test(utterance))) {
                const result = await seam.callEvent({ kind: 'human_callback', reason: 'asked_to_stop_calling' });
                const call: ToolCall = { name: 'request_human_callback', args: { reason: 'asked_to_stop_calling' } };
                return turn({ toolCalls: [call], say: [result.say], endCall: true });
            }

            // ── 2. Is this a person? The notice is never read to a machine. ───────────────
            if (!answererReported && MACHINE_CUES.some((re) => re.test(utterance))) {
                answererReported = true;
                const isVoicemail = VOICEMAIL_CUES.some((re) => re.test(utterance));
                const answerer = isVoicemail ? 'voicemail' as const : 'phone_menu' as const;
                await seam.callEvent({ kind: 'answerer_reported', answerer });
                const call: ToolCall = { name: 'report_answerer', args: { answerer } };

                if (isVoicemail) {
                    // One pass, no questions, nothing asked back. A voicemail measures worse than
                    // no contact, so it states the fact and stops.
                    return turn({ toolCalls: [call], say: [context.voicemail_script], endCall: true });
                }
                staffAttempts++;
                return turn({ toolCalls: [call], say: ['Could you connect me with a member of staff?'] });
            }

            if (WRONG_NUMBER_CUES.some((re) => re.test(utterance))) {
                await seam.callEvent({ kind: 'answerer_reported', answerer: 'wrong_number' });
                return turn({
                    toolCalls: [{ name: 'report_answerer', args: { answerer: 'wrong_number' } }],
                    // Nothing about the booking is said to somebody who is not the restaurant.
                    say: ['Sorry to have bothered you.'],
                    endCall: true,
                });
            }

            if (answererReported && !noticeDelivered && MACHINE_CUES.some((re) => re.test(utterance))) {
                staffAttempts++;
                if (staffAttempts >= 2) {
                    return turn({ say: [context.voicemail_script], endCall: true, note: 'two attempts, no person' });
                }
                return turn({ say: ['Could you connect me with a member of staff?'] });
            }

            // ── 3. A person. Deliver the notice, once. ───────────────────────────────────
            if (!noticeDelivered) {
                noticeDelivered = true;
                return turn({ say: [...context.opening_script] });
            }

            // ── 4. They want the booking changed. We cannot, and must not imply we can. ──
            if (CHANGE_CUES.some((re) => re.test(utterance))) {
                const reason = /cancel/i.test(utterance) ? 'wants_to_cancel' as const : 'wants_to_change_time' as const;
                const result = await seam.callEvent({ kind: 'human_callback', reason });
                return turn({
                    toolCalls: [{ name: 'request_human_callback', args: { reason } }],
                    say: [result.say],
                });
            }

            // ── 5. A question we can answer from the closed set. ─────────────────────────
            const topic = TOPIC_CUES.find(([re]) => re.test(utterance))?.[1];
            if (topic) {
                const answer = await seam.callFact(topic);
                questionsAnswered++;
                const call: ToolCall = { name: 'lookup_booking_fact', args: { topic } };
                // Two questions is the close condition; the third is where a busy person regrets
                // picking up.
                const closing = questionsAnswered >= 2;
                return turn({
                    toolCalls: [call],
                    say: closing ? [answer.say, "That's everything — the details are in the email. Thanks for your time."] : [answer.say],
                    endCall: closing,
                });
            }

            // ── 6. They are done. ────────────────────────────────────────────────────────
            if (DONE_CUES.some((re) => re.test(utterance))) {
                return turn({ say: ['Thanks for your time.'], endCall: true });
            }

            // ── 7. A question nothing answers. Log it, THEN promise the follow-up. ───────
            const result = await seam.callEvent({ kind: 'unanswered_question', question_verbatim: utterance });
            return turn({
                toolCalls: [{ name: 'log_unanswered_question', args: { question_verbatim: utterance } }],
                say: [result.say],
            });
        },
    };
}
