/**
 * The loopback call driver (TASK-3749, I3P-02) against the real stream server on 127.0.0.1 and the
 * mock seam, with a scripted far side in place of the cascade: it speaks a "disclosure" at start,
 * then answers each venue turn a fixed time after the venue stops. Needs `ws`.
 *
 * 🔴 CONTROLS (CONTRIBUTING.md):
 *   - SABOTAGE: an agent that answers 5 s after the venue stops must read as first audio above the
 *     4.0 s gate, not inside it (the plan's sabotage for the soak report);
 *   - an agent that never answers must leave first audio null on every turn, and the turn is charged
 *     the venue's whole wait, never zero;
 *   - a silent clip is no venue speech: the agent (which answers speech) never answers it.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

import { createStreamServer } from '../src/server/streamServer.ts';
import type { AuthorizedCall } from '../src/server/streamServer.ts';
import { startMockSeam } from '../src/mock/server.ts';
import type { MockSeam } from '../src/mock/server.ts';
import { longestSilence, rank, runCorpusCall } from '../src/soak/corpus.ts';
import type { CorpusTurn } from '../src/soak/corpus.ts';
import type { Connect } from '../src/soak/driver.ts';
import { speechFrame } from '../src/carrier/fakeLeg.ts';
import { CARRIER_AUDIO, MULAW_SILENCE } from '../src/audio/format.ts';
import { isSpeechFrame } from '../src/carrier/vad.ts';
import { VAD } from '../src/tuning/liveDefaults.ts';
import { summarise } from '../src/soak/report.ts';

const connect: Connect = (url, options) => new WebSocket(url, options);
const cleanups: Array<() => Promise<void>> = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });

let mock: MockSeam | null = null;
async function seam(): Promise<MockSeam> {
    if (!mock) {
        mock = await startMockSeam({ port: 0 });
        const m = mock;
        cleanups.push(async () => { await m.close(); });
    }
    return mock;
}

const audible = (frames: number): Uint8Array[] => Array.from({ length: frames }, (_, i) => speechFrame(i));

/**
 * The far side: `disclosureFrames` of speech at start, then, `replyMs` after each venue turn ends
 * (300 ms of quiet after speech), `replyFrames` of speech. `replyMs: null` never answers.
 */
function scriptedAgent(replyMs: number | null, disclosureFrames = 25, replyFrames = 15, hangUpInsteadMs: number | null = null) {
    return async (call: AuthorizedCall): Promise<void> => {
        const leg = call.leg;
        for (const f of audible(disclosureFrames)) leg.write(f);
        let speaking = false;
        let quiet = 0;
        let replies = 0;
        await new Promise<void>((resolve) => {
            leg.on('hangup', () => resolve());
            leg.on('inbound', (frame) => {
                if (isSpeechFrame(frame, VAD)) {
                    speaking = true;
                    quiet = 0;
                    return;
                }
                if (!speaking) return;
                quiet += 1;
                if (quiet * CARRIER_AUDIO.frameMs < 300) return;
                speaking = false;
                if (hangUpInsteadMs !== null) {
                    setTimeout(() => { void leg.hangup('agent_ended'); }, hangUpInsteadMs);
                    return;
                }
                if (replyMs === null) return;
                replies += 1;
                setTimeout(() => { for (const f of audible(replyFrames)) leg.write(f); }, Math.max(0, replyMs - 300));
            });
        });
        void replies;
    };
}

async function server(replyMs: number | null, hangUpInsteadMs: number | null = null): Promise<string> {
    const s = await seam();
    const stream = createStreamServer({ apiBaseUrl: s.baseUrl, startCall: scriptedAgent(replyMs, 25, 15, hangUpInsteadMs), log: () => {} });
    const port = await stream.listen(0, '127.0.0.1');
    cleanups.push(async () => { await stream.drain(0, 0); });
    return `ws://127.0.0.1:${port}/stream`;
}

/** A venue turn: `speechMs` of speech and 200 ms of silence after it. */
function turn(speechMs: number): CorpusTurn {
    const speech = audible(Math.round(speechMs / CARRIER_AUDIO.frameMs));
    const tail = new Uint8Array(10 * CARRIER_AUDIO.bytesPerFrame).fill(MULAW_SILENCE);
    return { audio: Buffer.concat([...speech, tail]), speechEndMs: speechMs };
}

describe('the loopback call driver, on the wire', () => {
    it('times the disclosure from start, and each answer from the end of the venue\'s speech', async () => {
        const url = await server(800);
        const out = await runCorpusCall(connect, url, { token: 'mock:happy', turns: [turn(600), turn(400)], endWaitMs: 500, replyWaitMs: 4000 });
        assert.equal(out.upgraded, true);
        assert.ok(out.startToFirstAudioMs !== null && out.startToFirstAudioMs < 1000, `start to first audio ${out.startToFirstAudioMs}`);
        assert.equal(out.disclosurePlayedMs >= 25 * 20, true, `disclosure played ${out.disclosurePlayedMs} ms`);
        assert.equal(out.disclosureAudio.length, out.disclosurePlayedMs / 20 * CARRIER_AUDIO.bytesPerFrame);
        assert.equal(out.turns.length, 2);
        for (const t of out.turns) {
            assert.ok(t.firstAudioMs !== null, 'a turn went unanswered');
            assert.ok(t.firstAudioMs >= 700 && t.firstAudioMs <= 1600, `first audio ${t.firstAudioMs} ms, expected about 800`);
        }
        assert.equal(out.framesAfterStop, 0);
        assert.equal(out.closedBy, 'client', 'the scripted agent never hangs up, so the venue does');
    });

    it('SABOTAGE CONTROL: an agent 5 s slow reads above the 4.0 s gate, and the summary fails it', async () => {
        const url = await server(5000);
        const out = await runCorpusCall(connect, url, { token: 'mock:happy', turns: [turn(400)], endWaitMs: 300, replyWaitMs: 8000 });
        const first = out.turns[0]!.firstAudioMs;
        assert.ok(first !== null && first > 4000, `first audio ${first}`);
        const summary = summarise([{ id: 'slow', outcome: out }], { p50FirstAudioMs: 2000, p90FirstAudioMs: 4000, coldStartMs: 1000 });
        assert.equal(summary.gate.pass, false);
        assert.ok(summary.gate.failures.some((f) => f.startsWith('p90 first audio')));
    });

    it('CONTROL: an agent that never answers leaves every turn null and charges the wait', async () => {
        const url = await server(null);
        const out = await runCorpusCall(connect, url, { token: 'mock:happy', turns: [turn(400), turn(400)], endWaitMs: 200, replyWaitMs: 1500 });
        assert.equal(out.turns.length, 2, 'the venue gave up instead of carrying on');
        assert.ok(out.turns.every((t) => t.firstAudioMs === null));
        assert.ok(out.turns.every((t) => !t.endedByServer), 'a line the agent kept open was marked as ended');
        assert.ok(out.longestSilenceMs >= 1400, `longest silence ${out.longestSilenceMs}`);
        const summary = summarise([{ id: 'deaf', outcome: out }], { p50FirstAudioMs: 2000, p90FirstAudioMs: 4000, coldStartMs: 1000 }, { replyWaitMs: 1500 });
        assert.equal(summary.unansweredTurns, 2);
        assert.equal(summary.firstAudio.p50, 1500, 'an unanswered turn must count as the whole wait, not vanish');
    });

    it('a call the server ends before an answer is due is not dead air: marked, and left out of first audio', async () => {
        const url = await server(null, 400);
        const out = await runCorpusCall(connect, url, { token: 'mock:happy', turns: [turn(400), turn(400)], endWaitMs: 200, replyWaitMs: 3000 });
        assert.equal(out.closedBy, 'server');
        assert.equal(out.turns.length, 1);
        assert.equal(out.turns[0]!.endedByServer, true);
        const summary = summarise([{ id: 'ended', outcome: out }], { p50FirstAudioMs: 2000, p90FirstAudioMs: 4000, coldStartMs: 1000 }, { replyWaitMs: 3000 });
        assert.equal(summary.endedByServerTurns, 1);
        assert.equal(summary.unansweredTurns, 0);
        // CONTROL: the deaf agent above, which keeps the line open, is NOT marked.
    });

    it('CONTROL: a silent clip is not speech, so the agent does not answer it', async () => {
        const url = await server(500);
        const silent: CorpusTurn = { audio: new Uint8Array(30 * CARRIER_AUDIO.bytesPerFrame).fill(MULAW_SILENCE), speechEndMs: 600 };
        const out = await runCorpusCall(connect, url, { token: 'mock:happy', turns: [silent], endWaitMs: 200, replyWaitMs: 1500 });
        assert.equal(out.turns[0]!.firstAudioMs, null);
    });

    it('a refused token: no upgrade-time audio, the server ends it, nothing is timed', async () => {
        const url = await server(500);
        const out = await runCorpusCall(connect, url, { token: 'not-a-token', turns: [turn(400)], replyWaitMs: 500, endWaitMs: 200 });
        assert.equal(out.startToFirstAudioMs, null);
        assert.equal(out.audibleFramesOut, 0);
        assert.equal(out.closedBy, 'server');
    });
});

describe('the arithmetic', () => {
    it('longestSilence counts slots with neither side speaking, after the agent first spoke', () => {
        // Agent speaks 0-100 ms, venue 300-500 ms, call ends at 1000 ms: gaps 100-300 and 520-1000.
        const agent = new Set([0, 1, 2, 3, 4]);
        assert.equal(longestSilence(agent, [[300, 500]], 0, 1000), 480 - 0);
        assert.equal(longestSilence(agent, [], null, 1000), 0);
    });

    it('rank is nearest-rank over present values', () => {
        assert.equal(rank([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
        assert.equal(rank([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
        assert.equal(rank([null, 7], 50), 7);
        assert.equal(rank([null], 50), null);
    });
});
