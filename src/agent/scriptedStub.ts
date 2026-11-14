/**
 * A REFERENCE AGENT WITH NO MODEL IN IT.
 *
 * 🔴 THIS IS NOT THE DELIVERABLE. The Gemini Live adapter replaces it with something that holds a Gemini Live
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
 */

import type { AgentTurn, CallAgent, ToolCall } from './contract.ts';
import type { SeamClient } from '../seam/client.ts';
import type { CallContext } from '../seam/types.ts';
import { CHANGE_CUES, DONE_CUES, MACHINE_CUES, STOP_CUES, TOPIC_CUES, VOICEMAIL_CUES, WRONG_NUMBER_CUES } from './cues.ts';
import { ASK_FOR_STAFF, CLOSE_AFTER_ANSWERS, CLOSE_THANKS, SORRY_WRONG_NUMBER } from './phrases.ts';


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
                return turn({ toolCalls: [call], say: [ASK_FOR_STAFF] });
            }

            if (WRONG_NUMBER_CUES.some((re) => re.test(utterance))) {
                await seam.callEvent({ kind: 'answerer_reported', answerer: 'wrong_number' });
                return turn({
                    toolCalls: [{ name: 'report_answerer', args: { answerer: 'wrong_number' } }],
                    // Nothing about the booking is said to somebody who is not the restaurant.
                    say: [SORRY_WRONG_NUMBER],
                    endCall: true,
                });
            }

            if (answererReported && !noticeDelivered && MACHINE_CUES.some((re) => re.test(utterance))) {
                staffAttempts++;
                if (staffAttempts >= 2) {
                    return turn({ say: [context.voicemail_script], endCall: true, note: 'two attempts, no person' });
                }
                return turn({ say: [ASK_FOR_STAFF] });
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
                    say: closing ? [answer.say, CLOSE_AFTER_ANSWERS] : [answer.say],
                    endCall: closing,
                });
            }

            // ── 6. They are done. ────────────────────────────────────────────────────────
            if (DONE_CUES.some((re) => re.test(utterance))) {
                return turn({ say: [CLOSE_THANKS], endCall: true });
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
