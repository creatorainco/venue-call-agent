/**
 * What did the restaurant mean? ONE word from a closed list, and never a sentence.
 *
 * Two stages. The keyword cues the scripted stub has always used run first: free, instant, and the
 * baseline the model has to beat. Only when no cue matches does the turn pay for a model call:
 * Vertex `generateContent` on the pinned Flash-Lite, over REST with an ADC bearer token, with
 * `responseMimeType: 'text/x.enum'` and a `responseSchema` that lists the intents.
 *
 * 🔴 THE MODEL'S REPLY IS NEVER TRUSTED AS TEXT. Anything that is not exactly one of `INTENTS`
 * (a sentence, an empty reply, a blocked candidate, a timeout, an HTTP error) is `unclear`, and
 * `unclear` is handled by logging the question and speaking the backend's honest deferral. The
 * reply never reaches `say`: the cascade agent maps an intent to a seam call, and only the seam's
 * finished sentence is spoken.
 */

import type { TokenSource } from '../google/adc.ts';
import type { FactTopic } from '../seam/types.ts';
import { FACT_TOPICS } from '../seam/types.ts';
import { INTENT_LOCATION, INTENT_MODEL, INTENT_TIMEOUT_MS } from '../tuning/cascadeDefaults.ts';
import {
    CHANGE_CUES,
    DONE_CUES,
    MACHINE_CUES,
    STOP_CUES,
    TOPIC_CUES,
    VOICEMAIL_CUES,
    WRONG_NUMBER_CUES,
} from './cues.ts';

/**
 * The closed set. The design's single `topic` intent is split into one `ask_<topic>` per Seam 4
 * fact topic, so the model picks the topic in the same one-word answer and no second call is
 * needed to learn which fact to fetch.
 */
export type Intent =
    | 'confirm'
    | 'decline'
    | 'stop_calling'
    | 'wrong_number'
    | 'callback_request'
    | 'is_this_ai'
    | 'hold'
    | 'voicemail'
    | 'menu'
    | 'unclear'
    | `ask_${FactTopic}`;

export const INTENTS: readonly Intent[] = [
    'confirm',
    'decline',
    'stop_calling',
    'wrong_number',
    'callback_request',
    'is_this_ai',
    'hold',
    'voicemail',
    'menu',
    'unclear',
    ...FACT_TOPICS.map((t) => `ask_${t}` as const),
];

export function isIntent(value: unknown): value is Intent {
    return typeof value === 'string' && (INTENTS as readonly string[]).includes(value);
}

/** The fact topic an `ask_*` intent names, or null for every other intent. */
export function topicOf(intent: Intent): FactTopic | null {
    if (!intent.startsWith('ask_')) return null;
    const topic = intent.slice(4);
    return (FACT_TOPICS as readonly string[]).includes(topic) ? topic as FactTopic : null;
}

export interface IntentResult {
    intent: Intent;
    /** Which stage decided: the keyword cues, the model, or nothing answered (`fallback`). */
    source: 'keyword' | 'model' | 'fallback';
}

export interface IntentClassifier {
    classify(utterance: string): Promise<IntentResult>;
}

/**
 * The keyword stage alone. Ordered the way the stub orders its checks: a stop request beats
 * everything, a machine beats a question, a question beats a goodbye ("thanks, but who's paying?"
 * is a question).
 */
export function keywordIntent(utterance: string): Intent | null {
    if (STOP_CUES.some((re) => re.test(utterance))) return 'stop_calling';
    if (VOICEMAIL_CUES.some((re) => re.test(utterance))) return 'voicemail';
    if (MACHINE_CUES.some((re) => re.test(utterance))) return 'menu';
    if (WRONG_NUMBER_CUES.some((re) => re.test(utterance))) return 'wrong_number';
    if (CHANGE_CUES.some((re) => re.test(utterance))) return 'callback_request';
    const topic = TOPIC_CUES.find(([re]) => re.test(utterance))?.[1];
    if (topic) return `ask_${topic}`;
    if (DONE_CUES.some((re) => re.test(utterance))) return 'confirm';
    return null;
}

/** Keywords only, `unclear` when none match. The eval's offline cascade uses this. */
export function createKeywordClassifier(): IntentClassifier {
    return {
        async classify(utterance: string): Promise<IntentResult> {
            const hit = keywordIntent(utterance);
            return hit ? { intent: hit, source: 'keyword' } : { intent: 'unclear', source: 'fallback' };
        },
    };
}

/**
 * The instruction the model classifies under. It names labels only; it states no fact about any
 * booking, venue or offer, and nothing in it is ever spoken.
 */
export const INTENT_INSTRUCTION = [
    'You label one thing a restaurant employee said on a phone call about a booking.',
    'Answer with exactly one label from the allowed list and nothing else.',
    'confirm: agreement, acknowledgement, or they are finished. decline: a plain no.',
    'stop_calling: they want no more calls. wrong_number: this is not the business we meant.',
    'callback_request: they want to change, move or cancel the booking, or want a person to call back.',
    'is_this_ai: they ask whether they are talking to a machine or a real person.',
    'hold: they ask us to wait. voicemail: a recorded greeting asking for a message.',
    'menu: an automated phone menu. ask_<topic>: a question about that booking topic.',
    'unclear: anything else, or you are unsure.',
].join('\n');

export function vertexIntentUrl(projectId: string, model: string = INTENT_MODEL, location: string = INTENT_LOCATION): string {
    const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
    return `https://${host}/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:generateContent`;
}

export function intentRequestBody(utterance: string): Record<string, unknown> {
    return {
        systemInstruction: { parts: [{ text: INTENT_INSTRUCTION }] },
        contents: [{ role: 'user', parts: [{ text: utterance }] }],
        generationConfig: {
            responseMimeType: 'text/x.enum',
            responseSchema: { type: 'STRING', enum: [...INTENTS] },
            maxOutputTokens: 16,
        },
    };
}

/** The model's reply, read strictly: exactly one listed intent, or null. */
export function intentFromResponse(payload: unknown): Intent | null {
    const text = (payload as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> })
        ?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== 'string') return null;
    const word = text.trim();
    return isIntent(word) ? word : null;
}

export interface VertexClassifierOptions {
    tokens: TokenSource;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    model?: string;
    /** Called with a one-line reason when the model path fell back. Never with the utterance. */
    log?: (line: string) => void;
}

/** Keywords first, then the model. Any model failure is `unclear`, never a guess. */
export function createVertexClassifier(options: VertexClassifierOptions): IntentClassifier {
    const doFetch = options.fetchImpl ?? fetch;
    const timeoutMs = options.timeoutMs ?? INTENT_TIMEOUT_MS;
    const log = options.log ?? (() => {});
    let url: string | null = null;

    async function ask(utterance: string): Promise<Intent | null> {
        url ??= vertexIntentUrl(await options.tokens.projectId(), options.model ?? INTENT_MODEL);
        const token = await options.tokens.token();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await doFetch(url, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(intentRequestBody(utterance)),
                signal: controller.signal,
            });
            if (!response.ok) {
                log(`intent model HTTP ${response.status}`);
                return null;
            }
            const intent = intentFromResponse(await response.json());
            if (!intent) log('intent model reply outside the enum');
            return intent;
        } finally {
            clearTimeout(timer);
        }
    }

    return {
        async classify(utterance: string): Promise<IntentResult> {
            const hit = keywordIntent(utterance);
            if (hit) return { intent: hit, source: 'keyword' };
            try {
                const intent = await ask(utterance);
                return intent ? { intent, source: 'model' } : { intent: 'unclear', source: 'fallback' };
            } catch (error) {
                log(`intent model unavailable: ${(error as Error)?.name === 'AbortError' ? `no reply in ${timeoutMs}ms` : (error as Error)?.message}`);
                return { intent: 'unclear', source: 'fallback' };
            }
        },
    };
}
