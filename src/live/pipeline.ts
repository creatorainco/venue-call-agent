/** Offline integration of session, codec and tools. Not a runnable agent or carrier adapter.
 * A caller must supply the conversation policy and explicitly authorize every output frame.
 * The default denies audio: session readiness alone does not prove disclosure or allowed speech.
 * Tests inject simulated model events; no model, credential or phone is opened here.
 */
import { carrierToPcm, ModelAudioFramer } from './audio.ts';
import { LiveSession } from './session.ts';
import type { ConnectSession, Scheduler, SessionEvent } from './session.ts';
import { ToolRouter } from './tools.ts';
import type { ToolFailure } from './tools.ts';
import type { SeamClient } from '../seam/client.ts';

export interface Playback {
    write(frame: Buffer): void;
    clear(): void;
}

export interface PipelineOptions {
    connect: ConnectSession;
    seam: SeamClient;
    playback: Playback;
    /** Must enforce conversation policy, including disclosure. Never use readiness as permission. */
    authorizeAudio?: () => boolean;
    clock?: Scheduler;
    timeoutMs?: number;
    transcript?: (event: Extract<SessionEvent, { kind: 'transcript' }>) => void;
}

export class LivePipeline {
    private readonly session: LiveSession;
    private readonly router: ToolRouter;
    private readonly framer = new ModelAudioFramer();
    private readonly options: PipelineOptions;
    private ended = false;
    private pendingTools = 0;
    private tasks = new Set<Promise<void>>();
    private problem: ToolFailure | { kind: 'audio_not_authorized' | 'input_failed' | 'stopped' } | undefined;

    constructor(options: PipelineOptions) {
        this.options = options;
        this.session = new LiveSession(options.connect, {
            audio: (chunk) => {
                if (!this.audioAllowed()) return;
                this.write(this.framer.push(chunk.data, chunk.sampleRate));
            },
            clear: () => this.clear(),
            event: (event) => this.receive(event),
        }, {
            ...(options.clock ? { clock: options.clock } : {}),
            ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        });
        this.router = new ToolRouter(options.seam, {
            result: (id, response) => this.session.sendToolResult(id, response),
            stopped: () => { this.problem = { kind: 'stopped' }; this.close(); },
            failed: (failure) => { this.problem = failure; this.close(); },
        });
    }

    get state(): string { return this.session.state; }
    get failure(): typeof this.problem { return this.problem; }

    connect(): Promise<void> { return this.session.connect(); }

    /** Far-end hangup is close(), never a flush that emits buffered audio after disconnect. */
    pushCarrier(data: Uint8Array): void {
        if (this.ended) return;
        try { this.session.sendAudio(carrierToPcm(data)); } catch {
            this.problem = { kind: 'input_failed' };
            this.close();
        }
    }

    close(): void {
        if (this.ended) return;
        this.ended = true;
        this.router.close();
        this.session.close();
    }

    /** Offline synchronization only; production code must never block input on a backend turn. */
    async settled(): Promise<void> {
        while (this.tasks.size) await Promise.all([...this.tasks]);
    }

    private clear(): void {
        this.framer.reset();
        this.options.playback.clear();
    }

    private write(frames: readonly Buffer[]): void {
        for (const frame of frames) {
            if (!this.audioAllowed()) return;
            this.options.playback.write(frame);
        }
    }

    private audioAllowed(): boolean {
        if (this.ended) return false;
        if (this.pendingTools || !this.options.authorizeAudio?.()) {
            this.problem = { kind: 'audio_not_authorized' };
            this.close();
            return false;
        }
        return true;
    }

    private receive(event: Exclude<SessionEvent, { kind: 'audio' }>): void {
        if (event.kind === 'closed') { this.close(); return; }
        if (this.ended) return;
        switch (event.kind) {
            case 'turn_complete':
                this.write(this.framer.finish());
                this.framer.reset();
                break;
            case 'tool_call': {
                this.pendingTools++;
                const task = this.router.dispatch(event).finally(() => {
                    this.pendingTools--;
                    this.tasks.delete(task);
                });
                this.tasks.add(task);
                break;
            }
            case 'tool_cancel': this.router.cancel(event.ids); break;
            case 'transcript': this.options.transcript?.(event); break;
            // LiveSession has already cleared playback on interruption.
            case 'interrupted': break;
        }
    }
}
