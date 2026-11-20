#!/usr/bin/env node
/**
 * SPIKE (it-22): fetch the turn-taking models the spikes load, and check their sha256.
 *
 *     node scripts/fetch-turn-models.mjs <dir>
 *     VCA_SILERO_MODEL=<dir>/silero_vad.onnx VCA_SMART_TURN_MODEL=<dir>/smart-turn-v3.2-cpu.onnx npm run soak:corpus -- ...
 *
 * The models are not committed: 11 MB of binaries on a spike branch. Licences: Silero VAD MIT,
 * Smart Turn BSD-2 (competitive.md, GitHub prior art line).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MODELS = [
    {
        file: 'silero_vad.onnx',
        url: 'https://raw.githubusercontent.com/snakers4/silero-vad/master/src/silero_vad/data/silero_vad.onnx',
        sha256: '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3',
    },
    {
        file: 'smart-turn-v3.2-cpu.onnx',
        url: 'https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.2-cpu.onnx',
        sha256: '2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f',
    },
];

const dir = process.argv[2];
if (!dir) throw new Error('usage: node scripts/fetch-turn-models.mjs <dir>');
mkdirSync(dir, { recursive: true });
for (const m of MODELS) {
    const path = join(dir, m.file);
    if (!existsSync(path)) {
        const res = await fetch(m.url);
        if (!res.ok) throw new Error(`${m.file}: HTTP ${res.status}`);
        writeFileSync(path, Buffer.from(await res.arrayBuffer()));
    }
    const sum = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (m.sha256 && sum !== m.sha256) throw new Error(`${m.file}: sha256 ${sum} is not ${m.sha256}`);
    process.stdout.write(`${m.file} ${sum}\n`);
}
