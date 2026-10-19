/** Streaming codec boundary; no socket or playback ownership.
 * Output matches the existing whole-buffer decimator, including held edges and floor duration.
 * The symmetric FIR needs half a kernel of lookahead. finish() releases that tail only at a
 * real utterance end; reset() discards it on interruption instead of playing stale audio.
 */
import { CARRIER_AUDIO, MODEL_AUDIO, MULAW_SILENCE } from '../audio/format.ts';
import { decode, encodeSample, pcmToBytes } from '../audio/mulaw.ts';
import { lowPassKernel } from '../audio/resample.ts';
import type { PcmChunk } from './session.ts';

/** Preserve the actual carrier rate. A transport must declare this rate, not MODEL_AUDIO.in. */
export function carrierToPcm(data: Uint8Array): PcmChunk {
    if (!data.length) throw new Error('empty carrier payload');
    return { data: pcmToBytes(decode(data)), encoding: 'pcm_s16le', sampleRate: CARRIER_AUDIO.sampleRate };
}

export class ModelAudioFramer {
    private readonly ratio = MODEL_AUDIO.out.sampleRate / CARRIER_AUDIO.sampleRate;
    private readonly kernel = lowPassKernel(0.45 * CARRIER_AUDIO.sampleRate, MODEL_AUDIO.out.sampleRate);
    private readonly mid = (this.kernel.length - 1) / 2;
    private samples: number[] = [];
    private offset = 0;
    private total = 0;
    private next = 0;
    private first = 0;
    private last = 0;
    private lowByte: number | undefined;
    private frame = Buffer.alloc(CARRIER_AUDIO.bytesPerFrame, MULAW_SILENCE);
    private used = 0;
    private finished = false;

    constructor() {
        if (!Number.isInteger(this.ratio) || this.ratio <= 1) throw new Error('unsupported sample-rate ratio');
    }

    /** Byte chunks may end halfway through a sample. Memory retained is bounded by FIR + frame. */
    push(bytes: Uint8Array, sampleRate = MODEL_AUDIO.out.sampleRate): Buffer[] {
        if (this.finished) throw new Error('audio stream already finished');
        if (sampleRate !== MODEL_AUDIO.out.sampleRate) throw new Error('unexpected model sample rate');
        const frames: Buffer[] = [];
        for (const byte of bytes) {
            if (this.lowByte === undefined) { this.lowByte = byte; continue; }
            const unsigned = this.lowByte | (byte << 8);
            const sample = unsigned >= 0x8000 ? unsigned - 0x10000 : unsigned;
            this.lowByte = undefined;
            if (!this.total) this.first = sample;
            this.last = sample;
            this.samples.push(sample);
            this.total++;
            while (this.next + this.mid < this.total && this.next + this.ratio <= this.total) {
                this.emit(frames);
            }
        }
        return frames;
    }

    /** Final frame is padded with μ-law silence. No extra frame when already aligned. */
    finish(): Buffer[] {
        if (this.finished) return [];
        if (this.lowByte !== undefined) throw new Error('truncated PCM sample');
        const frames: Buffer[] = [];
        while (this.next + this.ratio <= this.total) this.emit(frames);
        if (this.used) frames.push(this.frame);
        this.finished = true;
        this.samples = [];
        this.frame = Buffer.alloc(CARRIER_AUDIO.bytesPerFrame, MULAW_SILENCE);
        this.used = 0;
        return frames;
    }

    /** Start a fresh utterance after discarding every partial sample, filter tail and frame. */
    reset(): void {
        this.samples = [];
        this.offset = this.total = this.next = this.used = 0;
        this.first = this.last = 0;
        this.lowByte = undefined;
        this.finished = false;
        this.frame = Buffer.alloc(CARRIER_AUDIO.bytesPerFrame, MULAW_SILENCE);
    }

    private emit(frames: Buffer[]): void {
        let sum = 0;
        for (let k = 0; k < this.kernel.length; k++) {
            const index = this.next + k - this.mid;
            const value = index < 0 ? this.first : index >= this.total ? this.last : this.samples[index - this.offset]!;
            sum += this.kernel[k]! * value;
        }
        const sample = Math.max(-32768, Math.min(32767, Math.round(sum)));
        this.frame[this.used++] = encodeSample(sample);
        if (this.used === this.frame.length) {
            frames.push(this.frame);
            this.frame = Buffer.alloc(CARRIER_AUDIO.bytesPerFrame, MULAW_SILENCE);
            this.used = 0;
        }
        this.next += this.ratio;
        const discard = Math.max(0, this.next - this.mid - this.offset);
        this.samples.splice(0, discard);
        this.offset += discard;
    }
}
