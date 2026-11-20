/**
 * Starting the cascade: the agent, its intent classifier, synthesis and recognition, wired from
 * one token source.
 *
 * 🔴 IT STARTS WITH NO SECRET AND NO KEY. The only credential is the ADC token source: the runtime
 * service account on Cloud Run, `gcloud auth application-default login` on a laptop. This file
 * reads no environment variable at all, so `VENUE_CALL_SECRET`, `GEMINI_API_KEY` and
 * `SPEECH_TO_TEXT_CREDENTIALS` cannot be required by it, and `test/cascade.test.ts` starts it with
 * all three unset. The per-call capability token pb mints arrives in the stream's `start` frame
 * and goes to the seam client, opaque; it is not configuration.
 *
 * Every client is injectable. The tests inject fakes; production passes nothing and gets ADC.
 */

import type { CallAgent } from './contract.ts';
import type { SeamClient } from '../seam/client.ts';
import type { CallContext } from '../seam/types.ts';
import type { TokenSource } from '../google/adc.ts';
import { createAdcTokenSource } from '../google/adc.ts';
import type { IntentClassifier } from './intent.ts';
import { createVertexClassifier, INTENT_ORIGIN } from './intent.ts';
import { createCascadeAgent } from './cascadeAgent.ts';
import type { Tts } from '../speech/tts.ts';
import { createTts, preconnect, TTS_ORIGIN } from '../speech/tts.ts';
import type { SpeechStreamFactory } from '../speech/stt.ts';
import { createAdcSpeechStreamFactory } from '../speech/stt.ts';

export interface CascadeClients {
    tokens?: TokenSource;
    fetchImpl?: typeof fetch;
    speech?: SpeechStreamFactory;
    intents?: IntentClassifier;
    tts?: Tts;
    log?: (line: string) => void;
}

/** The per-process half: credentials and the Google clients, shared by every call. */
export interface CascadeRuntime {
    tts: Tts;
    speech: SpeechStreamFactory;
    intents: IntentClassifier;
    /**
     * Open TLS to the synthesis and intent hosts (one HEAD each, status ignored), so the first
     * call's disclosure and first intent do not pay the handshake. Never throws. PERF-A.
     */
    preconnect?(): Promise<void>;
    /** The per-call half: an agent bound to one call's seam client (and, live, its accepted context). */
    agentFor(seam: SeamClient, context?: CallContext): CallAgent;
}

export async function startCascade(clients: CascadeClients = {}): Promise<CascadeRuntime> {
    const tokens = clients.tokens ?? await createAdcTokenSource();
    const log = clients.log ?? (() => {});
    const fetchOpt = clients.fetchImpl ? { fetchImpl: clients.fetchImpl } : {};
    const intents = clients.intents ?? createVertexClassifier({ tokens, log, ...fetchOpt });
    const tts = clients.tts ?? createTts({ tokens, log, ...fetchOpt });
    // The recogniser's library loads while the project id is read, not after it (PERF-A).
    const speech = clients.speech ?? await (async () => {
        const [projectId] = await Promise.all([tokens.projectId(), import('@google-cloud/speech')]);
        return createAdcSpeechStreamFactory(projectId);
    })();
    return {
        tts,
        speech,
        intents,
        preconnect: () => preconnect(PRECONNECT_ORIGINS, clients.fetchImpl),
        agentFor: (seam, context) => createCascadeAgent({ seam, intents, log, ...(context ? { context } : {}) }),
    };
}


/** The hosts a call reaches over HTTPS: synthesis, and the intent model's endpoint. */
export const PRECONNECT_ORIGINS: readonly string[] = [TTS_ORIGIN, INTENT_ORIGIN];
