/** Offline-testable session lifecycle. No SDK, credentials, carrier or model policy here.
 * A future transport maps its messages to these events. This is not SpeechBridge yet:
 * audio conversion, tool authorization and real-time playback belong to separate layers.
 */
export interface PcmChunk {
    data: Uint8Array;
    sampleRate: number;
    encoding: 'pcm_s16le';
}

export type SessionEvent =
    | { kind: 'audio'; audio: PcmChunk }
    | { kind: 'interrupted' }
    | { kind: 'turn_complete' }
    | { kind: 'transcript'; direction: 'input' | 'output'; text: string }
    | { kind: 'tool_call'; id: string; name: string; args: unknown }
    | { kind: 'tool_cancel'; ids: readonly string[] }
    | { kind: 'error' }
    | { kind: 'closed' };

export interface SessionTransport {
    sendAudio(audio: PcmChunk): void;
    sendToolResult(id: string, result: unknown): void;
    /** Releases the socket and its listeners; must tolerate repeated cleanup. */
    close(): void;
}

/** Resolves only after protocol setup is complete. Must honor abort and release listeners.
 * The lifecycle also closes any transport that resolves after cancellation.
 */
export type ConnectSession = (
    signal: AbortSignal,
    receive: (event: SessionEvent) => void,
) => Promise<SessionTransport>;

export interface Scheduler {
    after(ms: number, callback: () => void): () => void;
}

const scheduler: Scheduler = {
    after(ms, callback) {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
    },
};

export interface SessionSink {
    /** Receives PCM only; it must not claim that queued audio has already played. */
    audio(chunk: PcmChunk): void;
    clear(): void;
    event(event: Exclude<SessionEvent, { kind: 'audio' }>): void;
}

export class LiveSession {
    private phase: 'idle' | 'connecting' | 'ready' | 'closed' = 'idle';
    private readonly connectSession: ConnectSession;
    private readonly sink: SessionSink;
    private readonly clock: Scheduler;
    private readonly timeoutMs: number;
    private readonly abort = new AbortController();
    private transport: SessionTransport | undefined;
    private cancelTimeout: (() => void) | undefined;
    private rejectConnect: ((error: Error) => void) | undefined;
    private interrupted = false;

    constructor(connect: ConnectSession, sink: SessionSink, options: { clock?: Scheduler; timeoutMs?: number } = {}) {
        this.connectSession = connect;
        this.sink = sink;
        this.clock = options.clock ?? scheduler;
        this.timeoutMs = options.timeoutMs ?? 10_000;
        if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
            throw new Error('session timeout must be positive and finite');
        }
    }

    get state(): string { return this.phase; }

    connect(): Promise<void> {
        if (this.phase !== 'idle') return Promise.reject(new Error('session already started'));
        this.phase = 'connecting';
        return new Promise<void>((resolve, reject) => {
            this.rejectConnect = reject;
            this.cancelTimeout = this.clock.after(this.timeoutMs, () => this.close());
            // Promise indirection also catches a synchronous connector exception.
            void Promise.resolve().then(() => {
                if (this.phase === 'closed') return undefined;
                return this.connectSession(this.abort.signal, (event) => this.receive(event));
            }).then((transport) => {
                if (!transport) return;
                if (this.phase === 'closed') {
                    transport.close();
                    return;
                }
                this.transport = transport;
                this.phase = 'ready';
                this.cancelTimeout?.();
                this.cancelTimeout = undefined;
                this.rejectConnect = undefined;
                resolve();
            }).catch(() => this.close());
        });
    }

    sendAudio(audio: PcmChunk): void {
        const transport = this.ready();
        validatePcm(audio);
        this.send(() => transport.sendAudio(copyPcm(audio)));
    }

    /** Routing/validation of tool names, arguments and duplicate IDs is not implemented here. */
    sendToolResult(id: string, result: unknown): void {
        const transport = this.ready();
        if (!id.trim()) throw new Error('tool result requires an id');
        this.send(() => transport.sendToolResult(id, result));
    }

    close(): void {
        if (this.phase === 'closed') return;
        this.phase = 'closed';
        this.cancelTimeout?.();
        this.cancelTimeout = undefined;
        this.rejectConnect?.(new Error('session closed before ready'));
        this.rejectConnect = undefined;
        const transport = this.transport;
        this.transport = undefined;
        // All cleanup is attempted even if a transport or playback implementation throws.
        for (const cleanup of [
            () => this.abort.abort(),
            () => transport?.close(),
            () => this.sink.clear(),
            () => this.sink.event({ kind: 'closed' }),
        ]) {
            // A failed cleanup must not skip another resource or escape a transport callback.
            // Closed state remains terminal even if an injected implementation is defective.
            try { cleanup(); } catch { /* No raw transport errors in caller-visible output. */ }
        }
    }

    private ready(): SessionTransport {
        if (this.phase !== 'ready' || !this.transport) throw new Error('session is not ready');
        return this.transport;
    }

    private send(action: () => void): void {
        try { action(); } catch {
            this.close();
            // Transport errors can contain connection details. Do not propagate raw messages.
            throw new Error('session send failed');
        }
    }

    private receive(event: SessionEvent): void {
        if (this.phase === 'closed') return;
        if (event.kind === 'closed' || event.kind === 'error') {
            this.close();
            return;
        }
        // Audio before setup completion is a protocol failure, not an opening utterance.
        if (this.phase !== 'ready') {
            this.close();
            return;
        }
        try {
            if (event.kind === 'interrupted') {
                this.interrupted = true;
                this.sink.clear();
            } else if (event.kind === 'turn_complete') {
                this.interrupted = false;
            } else if (event.kind === 'audio') {
                validatePcm(event.audio);
                // Connector must preserve order: completion ends the interrupted turn.
                if (!this.interrupted) this.sink.audio(copyPcm(event.audio));
                return;
            }
            this.sink.event(event);
        } catch {
            this.close();
        }
    }
}

function validatePcm(audio: PcmChunk): void {
    if (audio.encoding !== 'pcm_s16le' || !Number.isSafeInteger(audio.sampleRate)
        || audio.sampleRate <= 0 || !audio.data.length || audio.data.length % 2 !== 0) {
        throw new Error('invalid PCM chunk');
    }
}

function copyPcm(audio: PcmChunk): PcmChunk {
    return { ...audio, data: new Uint8Array(audio.data) };
}
