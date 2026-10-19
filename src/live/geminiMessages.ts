/** Translate the official SDK's server-message shape into the local event stream.
 * Reviewed against @google/genai 2.22.0 declarations. No SDK import or network here.
 * Parse the entire envelope before delivery so a malformed trailing part cannot leave a
 * partially delivered response. Do not read SDK convenience getters that may log raw content.
 */
import { MODEL_AUDIO } from '../audio/format.ts';
import type { SessionEvent } from './session.ts';

export function geminiEvents(message: unknown): SessionEvent[] {
    const root = object(message);
    if (root.goAway !== undefined) return [{ kind: 'closed' }];
    const events: SessionEvent[] = [];
    if (root.toolCallCancellation !== undefined) {
        const ids = object(root.toolCallCancellation).ids;
        if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !id.trim())) invalid();
        events.push({ kind: 'tool_cancel', ids: [...ids] as string[] });
    }
    if (root.toolCall !== undefined) {
        const calls = object(root.toolCall).functionCalls;
        if (!Array.isArray(calls)) invalid();
        for (const item of calls) {
            const call = object(item);
            const id = nonempty(call.id);
            const name = nonempty(call.name);
            events.push({ kind: 'tool_call', id, name, args: call.args ?? {} });
        }
    }
    if (root.serverContent !== undefined) {
        const content = object(root.serverContent);
        for (const flag of ['interrupted', 'turnComplete', 'generationComplete']) {
            if (content[flag] !== undefined && typeof content[flag] !== 'boolean') invalid();
        }
        if (content.interrupted === true) events.push({ kind: 'interrupted' });
        for (const [key, direction] of [['inputTranscription', 'input'], ['outputTranscription', 'output']] as const) {
            if (content[key] === undefined) continue;
            const transcript = object(content[key]);
            if (transcript.text !== undefined) {
                if (typeof transcript.text !== 'string') invalid();
                events.push({ kind: 'transcript', direction, text: transcript.text });
            }
        }
        if (content.modelTurn !== undefined) {
            const parts = object(content.modelTurn).parts;
            if (!Array.isArray(parts)) invalid();
            for (const item of parts) {
                const part = object(item);
                // Interrupted envelopes must never queue their discarded output tail.
                if (part.inlineData === undefined || part.thought === true || content.interrupted === true) continue;
                const inline = object(part.inlineData);
                const expected = `audio/pcm;rate=${MODEL_AUDIO.out.sampleRate}`;
                if (inline.mimeType !== expected) invalid();
                const data = nonempty(inline.data);
                // Buffer.from(base64) alone accepts invalid/truncated data silently.
                if (data.length > MAX_AUDIO_BASE64 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) invalid();
                const bytes = Buffer.from(data, 'base64');
                if (!bytes.length || bytes.length % 2 || bytes.toString('base64') !== data) invalid();
                events.push({ kind: 'audio', audio: {
                    data: bytes, encoding: 'pcm_s16le', sampleRate: MODEL_AUDIO.out.sampleRate,
                } });
            }
        }
        // generationComplete is not a playback boundary: turnComplete is the turn boundary.
        if (content.turnComplete === true) events.push({ kind: 'turn_complete' });
    }
    return events;
}

const MAX_AUDIO_BASE64 = 1_400_000;
function invalid(): never { throw new Error('invalid Gemini server message'); }
function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
    return value as Record<string, unknown>;
}
function nonempty(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) invalid();
    return value;
}
