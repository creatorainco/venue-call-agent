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
import type { TokenSource } from '../google/adc.ts';
import { createAdcTokenSource } from '../google/adc.ts';
import type { IntentClassifier } from './intent.ts';
import { createVertexClassifier } from './intent.ts';
import { createCascadeAgent } from './cascadeAgent.ts';
import type { Tts } from '../speech/tts.ts';
import { createTts } from '../speech/tts.ts';
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
    /** The per-call half: an agent bound to one call's seam client. */
    agentFor(seam: SeamClient): CallAgent;
}

export async function startCascade(clients: CascadeClients = {}): Promise<CascadeRuntime> {
    const tokens = clients.tokens ?? await createAdcTokenSource();
    const log = clients.log ?? (() => {});
    const fetchOpt = clients.fetchImpl ? { fetchImpl: clients.fetchImpl } : {};
    const intents = clients.intents ?? createVertexClassifier({ tokens, log, ...fetchOpt });
    const tts = clients.tts ?? createTts({ tokens, ...fetchOpt });
    const speech = clients.speech ?? await createAdcSpeechStreamFactory(await tokens.projectId());
    return {
        tts,
        speech,
        intents,
        agentFor: (seam) => createCascadeAgent({ seam, intents, log }),
    };
}
