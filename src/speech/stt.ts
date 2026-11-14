/**
 * Speech to text: carrier μ-law frames in, final transcripts out.
 *
 * Streaming recognition v2 over gRPC (`@google-cloud/speech`: bidirectional streaming has no REST
 * form). The audio is declared, not sniffed: MULAW, 8000 Hz, one channel, explicit decoding.
 *
 * Two things this file does that the obvious version does not:
 *
 *   1. BATCHING. A Twilio frame is 20 ms. One gRPC write per frame is fifty writes a second for no
 *      gain, so frames are gathered into `STT.batchMs` batches (CS-01).
 *   2. ROLLOVER. A streaming session is capped at about five minutes. At `STT.rolloverMs` the
 *      current stream is ended and the next batch opens a fresh one, config first. Results the old
 *      stream still owes are delivered; nothing is dropped at the seam.
 *
 * The gRPC client is injected (`SpeechStreamFactory`), so the tests drive a fake stream and the
 * library is imported only by `createAdcSpeechStreamFactory`, lazily: a clone with nothing
 * installed still runs every test but the stream server's.
 */

import { STT } from '../tuning/cascadeDefaults.ts';
import { CARRIER_AUDIO } from '../audio/format.ts';

/** The slice of a gRPC duplex stream this file uses. */
export interface RecognizeStream {
    write(message: unknown): unknown;
    end(): unknown;
    on(event: 'data', listener: (response: unknown) => void): unknown;
    on(event: 'error', listener: (error: Error) => void): unknown;
    on(event: 'end', listener: () => void): unknown;
    destroy?(error?: Error): unknown;
}

export interface SpeechStreamFactory {
    /** The full recognizer resource name: `projects/<p>/locations/<l>/recognizers/_`. */
    readonly recognizer: string;
    open(): RecognizeStream;
}

export interface StreamingSttOptions {
    factory: SpeechStreamFactory;
    /** A final transcript: one thing the restaurant said, verbatim. */
    onFinal: (text: string) => void;
    /** The recogniser failed. The caller ends the call; there is no silent retry mid-sentence. */
    onError: (error: Error) => void;
    /** Milliseconds since an arbitrary origin. Injected so rollover is testable. */
    clock?: () => number;
    batchMs?: number;
    rolloverMs?: number;
}

/** The first message on every stream: what the audio is and how to recognise it. */
export function streamingConfigRequest(recognizer: string): Record<string, unknown> {
    return {
        recognizer,
        streamingConfig: {
            config: {
                explicitDecodingConfig: {
                    encoding: 'MULAW',
                    sampleRateHertz: CARRIER_AUDIO.sampleRate,
                    audioChannelCount: 1,
                },
                model: STT.model,
                languageCodes: [STT.languageCode],
            },
            streamingFeatures: {
                interimResults: false,
                endpointingSensitivity: STT.endpointingSensitivity,
            },
        },
    };
}

/** Pull the final transcripts out of one v2 `StreamingRecognizeResponse`. */
export function finalTranscripts(response: unknown): string[] {
    const results = (response as { results?: unknown })?.results;
    if (!Array.isArray(results)) return [];
    const out: string[] = [];
    for (const r of results as Array<{ isFinal?: boolean; alternatives?: Array<{ transcript?: string }> }>) {
        if (!r?.isFinal) continue;
        const text = r.alternatives?.[0]?.transcript?.trim();
        if (text) out.push(text);
    }
    return out;
}

export class StreamingStt {
    readonly #options: StreamingSttOptions;
    readonly #clock: () => number;
    readonly #batchBytes: number;
    readonly #rolloverMs: number;
    #stream: RecognizeStream | null = null;
    #openedAt = 0;
    #pending: Uint8Array[] = [];
    #pendingBytes = 0;
    #closed = false;
    /** How many recognition streams this call has opened. The rollover test reads it. */
    streamsOpened = 0;

    constructor(options: StreamingSttOptions) {
        this.#options = options;
        this.#clock = options.clock ?? (() => performance.now());
        const batchMs = options.batchMs ?? STT.batchMs;
        this.#batchBytes = Math.max(1, Math.round((CARRIER_AUDIO.sampleRate * batchMs) / 1000));
        this.#rolloverMs = options.rolloverMs ?? STT.rolloverMs;
    }

    /** One carrier frame from the restaurant. */
    push(frame: Uint8Array): void {
        if (this.#closed) return;
        this.#pending.push(frame);
        this.#pendingBytes += frame.length;
        if (this.#pendingBytes >= this.#batchBytes) this.#flush();
    }

    /** End of call: send what is left and end the stream. Idempotent. */
    close(): void {
        if (this.#closed) return;
        if (this.#pendingBytes > 0) this.#flush();
        this.#closed = true;
        this.#stream?.end();
        this.#stream = null;
    }

    #flush(): void {
        const audio = Buffer.concat(this.#pending, this.#pendingBytes);
        this.#pending = [];
        this.#pendingBytes = 0;
        if (this.#stream && this.#clock() - this.#openedAt >= this.#rolloverMs) {
            this.#stream.end();
            this.#stream = null;
        }
        if (!this.#stream) this.#open();
        this.#stream!.write({ audio });
    }

    #open(): void {
        const stream = this.#options.factory.open();
        this.streamsOpened++;
        this.#openedAt = this.#clock();
        stream.on('data', (response) => {
            for (const text of finalTranscripts(response)) this.#options.onFinal(text);
        });
        stream.on('error', (error) => {
            if (!this.#closed) this.#options.onError(error);
        });
        stream.on('end', () => {});
        stream.write(streamingConfigRequest(this.#options.factory.recognizer));
        this.#stream = stream;
    }
}

/**
 * The real factory: a v2 client on the regional endpoint, authenticated by ADC. No key, no key
 * file: the library finds the runtime service account itself.
 */
export async function createAdcSpeechStreamFactory(projectId: string, location: string = STT.location): Promise<SpeechStreamFactory> {
    const speech = await import('@google-cloud/speech');
    const client = new speech.v2.SpeechClient({ apiEndpoint: `${location}-speech.googleapis.com` });
    const recognizer = `projects/${projectId}/locations/${location}/recognizers/_`;
    return {
        recognizer,
        open: () => client._streamingRecognize() as unknown as RecognizeStream,
    };
}
