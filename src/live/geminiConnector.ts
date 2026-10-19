/** SDK transport only. It neither opens a phone leg nor grants permission to play audio.
 * @google/genai 2.22.0 resolves connect after setup and can deliver queued callbacks before
 * returning Session. Buffer those callbacks until the local lifecycle has received its transport.
 */
import { GoogleGenAI, Type } from '@google/genai';
import type { LiveConnectConfig, LiveConnectParameters, Session } from '@google/genai';
import { LIVE_DEFAULTS, LIVE_MODEL } from '../tuning/liveDefaults.ts';
import { ANSWERER_KINDS, CALLBACK_REASONS, FACT_TOPICS } from '../seam/types.ts';
import { geminiEvents } from './geminiMessages.ts';
import type { ConnectSession, SessionEvent, SessionTransport } from './session.ts';

type SdkSession = Pick<Session, 'sendRealtimeInput' | 'sendToolResponse' | 'close'>;
export interface GeminiClient {
    connect(params: LiveConnectParameters): Promise<SdkSession>;
}

export function geminiConfig(systemInstruction: string): LiveConnectConfig {
    if (!systemInstruction.trim()) throw new Error('missing backend instruction');
    const property = (key: string, values?: readonly string[]) => ({
        type: Type.OBJECT,
        properties: { [key]: { type: Type.STRING, ...(values ? { enum: [...values] } : {}) } },
        required: [key],
    });
    return {
        ...structuredClone(LIVE_DEFAULTS), systemInstruction,
        tools: [{ functionDeclarations: [
            { name: 'lookup_booking_fact', parameters: property('topic', FACT_TOPICS) },
            { name: 'log_unanswered_question', parameters: property('question_verbatim') },
            { name: 'request_human_callback', parameters: property('reason', CALLBACK_REASONS) },
            { name: 'report_answerer', parameters: property('answerer', ANSWERER_KINDS) },
        ] }],
    };
}

export function createGeminiConnector(options: {
    apiKey: string;
    systemInstruction: string;
    model?: string;
    client?: GeminiClient;
}): ConnectSession {
    if (!options.apiKey.trim()) throw new Error('missing GEMINI_API_KEY');
    const model = options.model ?? LIVE_MODEL;
    if (!model.trim()) throw new Error('missing model');
    const config = geminiConfig(options.systemInstruction);
    return (signal, receive) => new Promise<SessionTransport>((resolve, reject) => {
        let raw: SdkSession | undefined;
        let closed = false;
        let resolved = false;
        let draining = true;
        let scheduled: ReturnType<typeof setImmediate> | undefined;
        const pending: SessionEvent[][] = [];
        const names = new Map<string, string>();
        const cleanup = () => {
            signal.removeEventListener('abort', abort);
            if (scheduled) clearImmediate(scheduled);
            pending.length = 0;
            names.clear();
            const session = raw;
            raw = undefined;
            try { session?.close(); } catch { /* Do not expose raw SDK connection details. */ }
        };
        const end = (kind: 'error' | 'closed', notify = true) => {
            if (closed) return;
            closed = true;
            cleanup();
            if (!resolved) reject(new Error('Gemini connection ended before ready'));
            else if (notify) receive({ kind });
        };
        const abort = () => end('closed', false);
        const deliver = (events: SessionEvent[]) => {
            for (const event of events) {
                if (closed) return;
                if (event.kind === 'tool_call') {
                    const previous = names.get(event.id);
                    if ((previous && previous !== event.name) || (!previous && names.size >= 256)) {
                        end('error'); return;
                    }
                    names.set(event.id, event.name);
                } else if (event.kind === 'tool_cancel') {
                    for (const id of event.ids) names.delete(id);
                } else if (event.kind === 'closed') {
                    end('closed'); return;
                }
                receive(event);
            }
        };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) { abort(); return; }
        const client = options.client ?? new GoogleGenAI({ apiKey: options.apiKey }).live;
        void Promise.resolve().then(() => {
            if (closed) return undefined;
            return client.connect({
                model, config: { ...structuredClone(config), abortSignal: signal },
                callbacks: {
                    onmessage(message) {
                        if (closed) return;
                        try {
                            const events = geminiEvents(message);
                            if (!events.length) return;
                            if (draining) {
                                if (pending.length >= 32) { end('error'); return; }
                                pending.push(events);
                            } else deliver(events);
                        } catch { end('error'); }
                    },
                    onerror: () => end('error'),
                    onclose: () => end('closed'),
                },
            });
        }).then((session) => {
            if (!session) return;
            if (closed) { try { session.close(); } catch { /* Late cleanup. */ } return; }
            raw = session;
            resolved = true;
            resolve({
                sendAudio(audio) {
                    if (closed || !raw) throw new Error('Gemini connection is closed');
                    raw.sendRealtimeInput({ audio: {
                        data: Buffer.from(audio.data).toString('base64'),
                        mimeType: `audio/pcm;rate=${audio.sampleRate}`,
                    } });
                },
                sendToolResult(id, result) {
                    const name = names.get(id);
                    if (closed || !raw || !name) throw new Error('tool response has no active request');
                    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('invalid tool response');
                    raw.sendToolResponse({ functionResponses: [{ id, name, response: result as Record<string, unknown> }] });
                    names.delete(id);
                },
                close() { end('closed', false); },
            });
            // SDK callbacks can run synchronously before its promise resolves. A macrotask
            // ensures LiveSession's readiness continuation runs before buffered model events.
            scheduled = setImmediate(() => {
                scheduled = undefined;
                try {
                    while (pending.length && !closed) deliver(pending.shift()!);
                    draining = false;
                } catch { end('error'); }
            });
        }).catch(() => end('error'));
    });
}
