/**
 * THE CASCADE: the first-call brain, with a closed mouth.
 *
 * A `CallAgent` like the scripted stub, with the same order of checks (stop first, the notice
 * never read to a machine, log before deferring), but the decision of what was meant comes from
 * an `IntentClassifier`: keyword cues first, then the pinned Flash-Lite with an enum schema.
 *
 * 🔴 THE MODEL NEVER SPEAKS. An intent is one word from `INTENTS`; this file turns it into a seam
 * call, and what is said is the seam's finished sentence, the context's scripts, or one of the
 * four fixed phrases in `phrases.ts`. There is no path from a classifier reply to `say`, and
 * `test/cascade.test.ts` plants an out-of-enum reply to prove it.
 *
 * Speech in and out (STT, TTS) sit outside this interface on purpose, as `contract.ts` explains:
 * every property that matters in front of a restaurant is a claim about the transcript, so the
 * cascade is checked by the same harness, rubric and fabrication check as the stub.
 */

import type { AgentTurn, CallAgent, ToolCall } from './contract.ts';
import type { SeamClient } from '../seam/client.ts';
import type { CallContext } from '../seam/types.ts';
import type { IntentClassifier } from './intent.ts';
import { topicOf } from './intent.ts';
import { ASK_FOR_STAFF, CLOSE_AFTER_ANSWERS, CLOSE_THANKS, SORRY_WRONG_NUMBER } from './phrases.ts';

export interface CascadeAgentDeps {
    seam: SeamClient;
    intents: IntentClassifier;
    /** One line per turn: the intent and which stage decided it. Never the utterance. */
    log?: (line: string) => void;
}

export function createCascadeAgent(deps: CascadeAgentDeps): CallAgent {
    const { seam, intents } = deps;
    const log = deps.log ?? (() => {});

    let context: CallContext | null = null;
    let noticeDelivered = false;
    let answererReported = false;
    let questionsAnswered = 0;
    let staffAttempts = 0;

    const turn = (over: Partial<AgentTurn> = {}): AgentTurn =>
        ({ say: [], toolCalls: [], endCall: false, ...over });

    async function logUnanswered(utterance: string): Promise<AgentTurn> {
        const result = await seam.callEvent({ kind: 'unanswered_question', question_verbatim: utterance });
        return turn({
            toolCalls: [{ name: 'log_unanswered_question', args: { question_verbatim: utterance } }],
            say: [result.say],
        });
    }

    return {
        async open(): Promise<AgentTurn> {
            context = await seam.callContext();
            return turn({ say: [context.disclosure_sentence], note: 'disclosure only; listening before the notice' });
        },

        async hear(utterance: string): Promise<AgentTurn> {
            if (!context) throw new Error('hear() before open() — there is no context to speak from');
            const { intent, source } = await intents.classify(utterance);
            log(`intent ${intent} (${source})`);

            // ── 1. STOP. Before anything else. ─────────────────────────────────────────────
            if (intent === 'stop_calling') {
                const result = await seam.callEvent({ kind: 'human_callback', reason: 'asked_to_stop_calling' });
                const call: ToolCall = { name: 'request_human_callback', args: { reason: 'asked_to_stop_calling' } };
                return turn({ toolCalls: [call], say: [result.say], endCall: true });
            }

            const machine = intent === 'voicemail' || intent === 'menu';

            // ── 2. A machine. The notice is never read to one. ──────────────────────────────
            if (!answererReported && machine) {
                answererReported = true;
                const answerer = intent === 'voicemail' ? 'voicemail' as const : 'phone_menu' as const;
                await seam.callEvent({ kind: 'answerer_reported', answerer });
                const call: ToolCall = { name: 'report_answerer', args: { answerer } };
                if (answerer === 'voicemail') {
                    return turn({ toolCalls: [call], say: [context.voicemail_script], endCall: true });
                }
                staffAttempts++;
                return turn({ toolCalls: [call], say: [ASK_FOR_STAFF] });
            }

            if (intent === 'wrong_number') {
                await seam.callEvent({ kind: 'answerer_reported', answerer: 'wrong_number' });
                return turn({
                    toolCalls: [{ name: 'report_answerer', args: { answerer: 'wrong_number' } }],
                    say: [SORRY_WRONG_NUMBER],
                    endCall: true,
                });
            }

            if (answererReported && !noticeDelivered && machine) {
                staffAttempts++;
                if (staffAttempts >= 2) {
                    return turn({ say: [context.voicemail_script], endCall: true, note: 'two attempts, no person' });
                }
                return turn({ say: [ASK_FOR_STAFF] });
            }

            // ── 3. A person. Deliver the notice, once. ─────────────────────────────────────
            if (!noticeDelivered) {
                noticeDelivered = true;
                return turn({ say: [...context.opening_script] });
            }

            // ── 4. They want the booking changed, or a person to ring back. ────────────────
            if (intent === 'callback_request') {
                const reason = /cancel/i.test(utterance)
                    ? 'wants_to_cancel' as const
                    : source === 'keyword' ? 'wants_to_change_time' as const : 'other' as const;
                const result = await seam.callEvent({ kind: 'human_callback', reason });
                return turn({ toolCalls: [{ name: 'request_human_callback', args: { reason } }], say: [result.say] });
            }

            // ── 5. A question from the closed set. "Is this a robot?" is answered by who we are,
            //       from the backend, on top of the disclosure they already heard. ─────────────
            const topic = intent === 'is_this_ai' ? 'who_we_are' as const : topicOf(intent);
            if (topic) {
                const answer = await seam.callFact(topic);
                questionsAnswered++;
                const closing = questionsAnswered >= 2;
                return turn({
                    toolCalls: [{ name: 'lookup_booking_fact', args: { topic } }],
                    say: closing ? [answer.say, CLOSE_AFTER_ANSWERS] : [answer.say],
                    endCall: closing,
                });
            }

            // ── 6. They are done, or asked us to wait. ─────────────────────────────────────
            if (intent === 'confirm' || intent === 'decline') {
                return turn({ say: [CLOSE_THANKS], endCall: true });
            }
            if (intent === 'hold') return turn({ note: 'asked to hold; listening' });

            // ── 7. Anything else: log the question verbatim, THEN speak the deferral. ──────
            return logUnanswered(utterance);
        },
    };
}
