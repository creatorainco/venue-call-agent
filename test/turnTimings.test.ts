/**
 * The optional per-turn stage timings (I3P-03, I3P-13), held to the contract snapshot.
 *
 * Three claims, each with a control that must fail:
 *   1. the types and `contract/seam4.json` name the same wire fields, the same seven stage fields
 *      and the same intent sources, in order;
 *   2. the backend shape refuses a turn carrying a stage field (the mock does what pb's Joi does),
 *      so posting them would lose the transcript: CONTROL, the same turn without them is a 200;
 *   3. the supervisor posts the wire fields only and logs the timings as numbers, never text:
 *      CONTROL, a report built the old way (`...turn`) is the 400 of claim 2.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
    INTENT_SOURCES,
    TURN_STAGE_FIELDS,
    TURN_WIRE_FIELDS,
    stageTimings,
    wireTurn,
} from '../src/seam/types.ts';
import type { Turn } from '../src/seam/types.ts';
import { startMockSeam } from '../src/mock/server.ts';
import { createSeamClient } from '../src/seam/client.ts';
import { CallSupervisor } from '../src/carrier/supervisor.ts';
import type { Hangable } from '../src/carrier/supervisor.ts';
import type { HangupReason } from '../src/carrier/leg.ts';

const contract = JSON.parse(readFileSync(fileURLToPath(new URL('../contract/seam4.json', import.meta.url)), 'utf8')) as {
    call_ended: { turns: { fields: string[]; stage_fields: string[]; intent_sources: string[] } };
    known_divergences: Array<{ id: string }>;
};

/** Every optional field set: if a name drifts in the type, this stops compiling. */
const TIMED: Turn = {
    speaker: 'agent',
    text: 'A sentence that must never reach a log line.',
    at_ms: 4000,
    venue_end_ms: 3100,
    stt_final_ms: 3400,
    intent_ms: 210,
    intent_source: 'model',
    seam_ms: 90,
    tts_first_byte_ms: 3900,
    first_frame_out_ms: 3905,
};

describe('the stage timings in the contract', () => {
    it('the wire fields, the stage fields and the intent sources match the types, in order', () => {
        assert.deepEqual([...TURN_WIRE_FIELDS], contract.call_ended.turns.fields);
        assert.deepEqual([...TURN_STAGE_FIELDS], contract.call_ended.turns.stage_fields);
        assert.deepEqual([...INTENT_SOURCES], contract.call_ended.turns.intent_sources);
        // Every stage field is set on TIMED, and none of them is a wire field.
        for (const f of TURN_STAGE_FIELDS) {
            assert.ok(TIMED[f] !== undefined, `${f} is not settable on Turn`);
            assert.ok(!(TURN_WIRE_FIELDS as readonly string[]).includes(f), `${f} is also a wire field`);
        }
    });

    it('the divergence that keeps them off the wire is declared', () => {
        assert.ok(contract.known_divergences.some((d) => d.id === 'turn-stage-timings'));
    });

    it('wireTurn keeps the wire fields only; stageTimings keeps the stage fields only', () => {
        assert.deepEqual(Object.keys(wireTurn(TIMED)), ['speaker', 'text', 'at_ms']);
        const timings = stageTimings(TIMED)!;
        assert.deepEqual(Object.keys(timings), [...TURN_STAGE_FIELDS]);
        assert.equal((timings as Record<string, unknown>).text, undefined);
        // A turn with no timings carries none, rather than an empty object.
        assert.equal(stageTimings({ speaker: 'venue', text: 'x' }), null);
        // An untimed turn keeps at_ms absent rather than inventing one.
        assert.deepEqual(wireTurn({ speaker: 'venue', text: 'x' }), { speaker: 'venue', text: 'x' });
    });
});

async function post(baseUrl: string, turns: unknown[]): Promise<number> {
    const res = await fetch(`${baseUrl}/reservations/call-event`, {
        method: 'POST',
        headers: { authorization: 'Bearer mock:happy', 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'call_ended', seq: 1, end_reason: 'completed', disclosure_heard: true, turns }),
    });
    await res.text();
    return res.status;
}

describe('🔴 the backend shape refuses a stage field on a turn', () => {
    it('a turn carrying intent_ms is a 400; CONTROL: the same turn with wire fields only is a 200', async () => {
        const mock = await startMockSeam({ port: 0 });
        try {
            assert.equal(await post(mock.baseUrl, [TIMED]), 400, 'the mock accepted a key pb\'s Joi refuses');
            assert.equal(await post(mock.baseUrl, [wireTurn(TIMED)]), 200);
            for (const field of TURN_STAGE_FIELDS) {
                assert.equal(await post(mock.baseUrl, [{ speaker: 'venue', text: 'x', [field]: field === 'intent_source' ? 'model' : 1 }]), 400, field);
            }
        } finally {
            await mock.close();
        }
    });
});

function leg(): Hangable {
    const handlers: Array<(reason: HangupReason) => void> = [];
    let over = false;
    return {
        id: 'timed-call',
        on: (_event, handler) => { handlers.push(handler); },
        hangup: async (reason) => {
            if (over) return;
            over = true;
            for (const h of handlers) h(reason);
        },
    };
}

describe('🔴 the supervisor posts the wire fields and logs the timings', () => {
    it('call_ended is recorded (200) with wire-only turns, and one turn_timing line carries no text', async () => {
        const mock = await startMockSeam({ port: 0 });
        try {
            const logs: string[] = [];
            const venue: Turn = { speaker: 'venue', text: 'Hello, who is this?', at_ms: 3500, venue_end_ms: 3100, stt_final_ms: 3400 };
            const sup = new CallSupervisor(leg(), {
                clock: () => 0,
                capTimer: null,
                log: (line) => { logs.push(line); },
                report: createSeamClient({ baseUrl: mock.baseUrl, token: 'mock:happy' }),
                record: () => ({ turns: [venue, TIMED, { speaker: 'agent', text: 'untimed' }], disclosureHeard: true }),
            });
            await sup.run(async () => { sup.stop('agent_ended'); });

            const ended = mock.journal.filter((e) => (e.body as { kind?: string } | undefined)?.kind === 'call_ended');
            assert.equal(ended.length, 1);
            assert.equal(ended[0]!.status, 200, 'the report was refused: a stage field reached the wire');
            const posted = (ended[0]!.body as { turns: Array<Record<string, unknown>> }).turns;
            for (const t of posted) {
                for (const k of Object.keys(t)) assert.ok((TURN_WIRE_FIELDS as readonly string[]).includes(k), `posted ${k}`);
            }

            const timing = logs.filter((l) => l.includes(' turn_timing '));
            assert.equal(timing.length, 2, 'one line per timed turn, none for the untimed one');
            assert.match(timing[0]!, /turn_timing i=0 speaker=venue venue_end_ms=3100 stt_final_ms=3400$/);
            assert.match(timing[1]!, /turn_timing i=1 speaker=agent venue_end_ms=3100 stt_final_ms=3400 intent_ms=210 intent_source=model seam_ms=90 tts_first_byte_ms=3900 first_frame_out_ms=3905$/);
            for (const line of logs) {
                assert.ok(!line.includes('never reach') && !line.includes('who is this'), `a transcript reached a log line: ${line}`);
            }
        } finally {
            await mock.close();
        }
    });
});
