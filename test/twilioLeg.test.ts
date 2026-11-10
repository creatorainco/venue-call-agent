/**
 * The Twilio leg, driven by a fake Twilio in-process: no socket, no network, a clock the test owns.
 *
 * 🔴 SABOTAGES RUN BY HAND AND PASTED IN THE PR: (e) make `clear()` forget which marks were
 * pending at Twilio (delete the two lines that move `sentMarks` into `swallow`), so the echoes
 * Twilio sends for them are forwarded. "an echo after clear is not a played mark" and the
 * OutputGate test that depends on it must go red: the gate would believe a cleared disclosure was
 * heard. (f) hand inbound media on before `accept()`, and the drop test goes red.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

import { TwilioLeg } from '../src/carrier/twilioLeg.ts';
import type { StreamStart } from '../src/carrier/twilioLeg.ts';
import type { HangupReason } from '../src/carrier/leg.ts';
import { OutputGate } from '../src/carrier/outputGate.ts';
import { CARRIER_AUDIO, MULAW_SILENCE } from '../src/audio/format.ts';
import { speechFrame } from '../src/carrier/fakeLeg.ts';

const FRAME = CARRIER_AUDIO.bytesPerFrame;
const TOKEN = 'opaque-token-for-one-attempt';

interface Sent { event: string; streamSid?: string; media?: { payload: string }; mark?: { name: string } }

/** A leg on a fake socket, with a clock and a pacer the test drives. */
function rig(leadFrames = 2) {
    const sent: Sent[] = [];
    const closes: number[] = [];
    const logs: string[] = [];
    let clock = 0;
    const leg = new TwilioLeg({
        id: 'leg-under-test',
        socket: {
            send: (text) => { sent.push(JSON.parse(text) as Sent); },
            close: (code) => { closes.push(code); },
        },
        log: (line) => { logs.push(line); },
        now: () => clock,
        every: () => () => {},
        leadFrames,
    });
    const starts: StreamStart[] = [];
    const inbound: Uint8Array[] = [];
    const hangups: HangupReason[] = [];
    const marked: string[] = [];
    leg.onStart((s) => { starts.push(s); });
    leg.on('inbound', (f) => { inbound.push(f); });
    leg.on('hangup', (r) => { hangups.push(r); });
    leg.on('marked', (n) => { marked.push(n); });
    const twilio = {
        connected: () => leg.receive(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' })),
        start: (overrides: Record<string, unknown> = {}) => leg.receive(JSON.stringify({
            event: 'start',
            sequenceNumber: '1',
            streamSid: 'MZstream',
            start: {
                streamSid: 'MZstream',
                callSid: 'CAcall',
                accountSid: 'ACaccount',
                tracks: ['inbound'],
                mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
                customParameters: { token: TOKEN },
                ...overrides,
            },
        })),
        media: (bytes: Uint8Array) => leg.receive(JSON.stringify({
            event: 'media',
            streamSid: 'MZstream',
            media: { track: 'inbound', chunk: '1', timestamp: '0', payload: Buffer.from(bytes).toString('base64') },
        })),
        echo: (name: string) => leg.receive(JSON.stringify({ event: 'mark', streamSid: 'MZstream', mark: { name } })),
        stop: () => leg.receive(JSON.stringify({ event: 'stop', streamSid: 'MZstream', stop: { callSid: 'CAcall' } })),
    };
    const live = () => { twilio.connected(); twilio.start(); leg.accept(); };
    const advance = (ms: number) => { clock += ms; leg.tick(); };
    return { leg, sent, closes, logs, starts, inbound, hangups, marked, twilio, live, advance };
}

const media = (sent: Sent[]) => sent.filter((m) => m.event === 'media');
const frames = (n: number) => Array.from({ length: n }, (_, i) => speechFrame(i));

describe('TwilioLeg: start and the token', () => {
    it('hands the token to onStart, opaque, and keeps it out of every log line', () => {
        const r = rig();
        r.twilio.connected();
        r.twilio.start();
        assert.deepEqual(r.starts, [{ streamSid: 'MZstream', callSid: 'CAcall', token: TOKEN }]);
        assert.ok(r.logs.every((l) => !l.includes(TOKEN)));
    });

    it('a start with no token, an empty token or an oversize token never reaches onStart', () => {
        for (const customParameters of [{}, { token: '' }, { token: '   ' }, { token: 'x'.repeat(5000) }, { token: 7 }]) {
            const r = rig();
            r.twilio.connected();
            r.twilio.start({ customParameters });
            assert.equal(r.starts.length, 0, JSON.stringify(customParameters));
            assert.deepEqual(r.hangups, ['transport_failed']);
            assert.deepEqual(r.closes, [1000]);
        }
    });

    it('a start in any format but μ-law 8 kHz mono is refused', () => {
        for (const mediaFormat of [
            { encoding: 'audio/l16', sampleRate: 8000, channels: 1 },
            { encoding: 'audio/x-mulaw', sampleRate: 16000, channels: 1 },
            { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 2 },
        ]) {
            const r = rig();
            r.twilio.start({ mediaFormat });
            assert.equal(r.starts.length, 0);
            assert.deepEqual(r.hangups, ['transport_failed']);
        }
    });

    it('media before start, a second start, a binary frame and unparseable text each close the line', () => {
        const cases: Array<(r: ReturnType<typeof rig>) => void> = [
            (r) => r.twilio.media(frames(1)[0]!),
            (r) => { r.twilio.start(); r.twilio.start(); },
            (r) => r.leg.receiveBinary(),
            (r) => r.leg.receive('{not json'),
            (r) => r.leg.receive('null'),
        ];
        for (const plant of cases) {
            const r = rig();
            plant(r);
            assert.deepEqual(r.hangups, ['transport_failed']);
            assert.deepEqual(r.closes, [1000]);
        }
    });
});

describe('TwilioLeg: nothing flows before accept()', () => {
    it('inbound media between start and accept is dropped, never handed on', () => {
        const r = rig();
        r.twilio.connected();
        r.twilio.start();
        r.twilio.media(frames(1)[0]!);
        r.twilio.media(frames(1)[0]!);
        assert.equal(r.inbound.length, 0);
        assert.equal(r.leg.droppedBeforeAccept, 2);
        r.leg.accept();
        r.twilio.media(frames(1)[0]!);
        assert.equal(r.inbound.length, 1);
    });

    it('a write or a mark before accept throws: it is a bug in our code, not a line condition', () => {
        const r = rig();
        r.twilio.start();
        assert.throws(() => r.leg.write(frames(1)[0]!), /before the backend accepts/);
        assert.throws(() => r.leg.mark('m'), /before the call is accepted/);
        assert.equal(r.sent.length, 0);
    });

    it('accept() is refused before start and after the end', () => {
        const r = rig();
        assert.throws(() => r.leg.accept(), /awaiting_start/);
        r.twilio.start();
        r.twilio.stop();
        assert.throws(() => r.leg.accept(), /ended/);
    });
});

describe('TwilioLeg: inbound audio', () => {
    it('re-chunks any payload size into whole frames and carries the remainder', () => {
        const r = rig();
        r.live();
        const bytes = Uint8Array.from({ length: 400 }, (_, i) => i % 256);
        r.twilio.media(bytes.subarray(0, 240));
        assert.equal(r.inbound.length, 1);
        r.twilio.media(bytes.subarray(240, 400));
        assert.equal(r.inbound.length, 2);
        assert.ok(r.inbound.every((f) => f.length === FRAME));
        assert.deepEqual([...r.inbound[0]!, ...r.inbound[1]!], [...bytes.subarray(0, 320)]);
    });

    it('stop is the far end hanging up, once', () => {
        const r = rig();
        r.live();
        r.twilio.stop();
        r.twilio.stop();
        r.leg.socketClosed();
        assert.deepEqual(r.hangups, ['far_end_hung_up']);
        assert.deepEqual(r.closes, [1000]);
    });

    it('a socket that closes without stop is a transport failure', () => {
        const r = rig();
        r.live();
        r.leg.socketClosed();
        assert.deepEqual(r.hangups, ['transport_failed']);
    });

    it('a key press reaches onDtmf, and never a log line', () => {
        const r = rig();
        const digits: string[] = [];
        r.leg.onDtmf((d) => { digits.push(d); });
        r.live();
        r.leg.receive(JSON.stringify({ event: 'dtmf', streamSid: 'MZstream', dtmf: { track: 'inbound_track', digit: '7' } }));
        assert.deepEqual(digits, ['7']);
        assert.ok(r.logs.every((l) => !l.includes('7')));
    });
});

describe('TwilioLeg: outbound audio is paced at one frame per 20 ms', () => {
    it('sends the lead at once, then one frame per frame of real time, never a burst', () => {
        const r = rig(2);
        r.live();
        for (const f of frames(10)) r.leg.write(f);
        assert.equal(media(r.sent).length, 2, 'only the lead leaves immediately');
        assert.equal(r.leg.queuedFrames(), 8);
        r.advance(20);
        assert.equal(media(r.sent).length, 3);
        r.advance(60);
        assert.equal(media(r.sent).length, 6);
        r.advance(1000);
        assert.equal(media(r.sent).length, 10);
        assert.equal(r.leg.queuedFrames(), 0);
        assert.ok(media(r.sent).every((m) => m.streamSid === 'MZstream'));
        assert.equal(Buffer.from(media(r.sent)[0]!.media!.payload, 'base64').length, FRAME);
    });

    it('a pause between sentences is not owed back as a burst, and is not cut short either', () => {
        const r = rig(2);
        r.live();
        for (const f of frames(4)) r.leg.write(f);
        r.advance(40);
        assert.equal(media(r.sent).length, 4);
        // Still playing at Twilio (4 frames = 80 ms): a new sentence joins the same run.
        r.advance(20);
        for (const f of frames(3)) r.leg.write(f);
        assert.equal(media(r.sent).length, 5, 'audio queued behind a run still playing went out early');
        // A long silence: the run has played out, so the next sentence starts a fresh run.
        r.advance(2000);
        assert.equal(media(r.sent).length, 7);
        r.advance(2000);
        for (const f of frames(5)) r.leg.write(f);
        assert.equal(media(r.sent).length, 9, 'a fresh run sends its lead, not a catch-up burst');
    });

    it('re-chunks a write of any size, and a mark pads the partial frame with μ-law silence', () => {
        const r = rig(100);
        r.live();
        r.leg.write(new Uint8Array(200).fill(0x10));
        assert.equal(media(r.sent).length, 1);
        r.leg.mark('end-of-sentence');
        const out = media(r.sent);
        assert.equal(out.length, 2);
        const padded = Buffer.from(out[1]!.media!.payload, 'base64');
        assert.equal(padded.length, FRAME);
        assert.deepEqual([...padded.subarray(0, 40)], new Array(40).fill(0x10));
        assert.ok([...padded.subarray(40)].every((b) => b === MULAW_SILENCE));
        assert.equal(r.sent.at(-1)!.event, 'mark');
    });

    it('a write after the end is counted and sends nothing', () => {
        const r = rig();
        r.live();
        r.twilio.stop();
        const before = r.sent.length;
        r.leg.write(frames(1)[0]!);
        assert.equal(r.leg.writtenAfterHangup, 1);
        assert.equal(r.sent.length, before);
    });
});

describe('TwilioLeg: marks and clear', () => {
    it('a mark leaves only after every frame before it, and fires on the echo', () => {
        const r = rig(1);
        r.live();
        for (const f of frames(3)) r.leg.write(f);
        r.leg.mark('s1');
        assert.equal(r.sent.filter((m) => m.event === 'mark').length, 0, 'mark sent ahead of its audio');
        r.advance(100);
        const order = r.sent.map((m) => m.event);
        assert.deepEqual(order, ['media', 'media', 'media', 'mark']);
        assert.deepEqual(r.marked, []);
        r.twilio.echo('s1');
        assert.deepEqual(r.marked, ['s1']);
        r.twilio.echo('s1');
        assert.deepEqual(r.marked, ['s1'], 'a duplicate echo fires nothing');
    });

    it('clear drops the local queue, tells Twilio, and queued marks are never sent', () => {
        const r = rig(1);
        r.live();
        for (const f of frames(5)) r.leg.write(f);
        r.leg.mark('queued');
        r.leg.clear();
        assert.equal(r.leg.queuedFrames(), 0);
        assert.equal(r.leg.cleared, 4);
        assert.equal(r.sent.at(-1)!.event, 'clear');
        r.advance(1000);
        assert.equal(r.sent.filter((m) => m.event === 'mark').length, 0);
    });

    it('🔴 an echo after clear is not a played mark', () => {
        const r = rig(10);
        r.live();
        for (const f of frames(3)) r.leg.write(f);
        r.leg.mark('pending-at-twilio');
        assert.equal(r.sent.at(-1)!.event, 'mark');
        r.leg.clear();
        // Twilio echoes every pending mark when it receives clear.
        r.twilio.echo('pending-at-twilio');
        assert.deepEqual(r.marked, []);
        assert.equal(r.leg.swallowedEchoes, 1);
    });

    it('hangup is idempotent: one close, one hangup event, every call recorded', async () => {
        const r = rig();
        r.live();
        await r.leg.hangup('agent_ended');
        await r.leg.hangup('internal_error');
        assert.deepEqual(r.closes, [1000]);
        assert.deepEqual(r.hangups, ['agent_ended']);
        assert.deepEqual(r.leg.hangupsSent, ['agent_ended', 'internal_error']);
        assert.equal(r.leg.endedBecause, 'agent_ended');
    });
});

describe('TwilioLeg under the OutputGate: the carrier mark is what releases the disclosure', () => {
    function gated() {
        const r = rig(1000);
        r.live();
        const gate = new OutputGate(r.leg, { isSpeech: () => false, log: () => {} });
        gate.connect();
        return { ...r, gate };
    }

    it('audio after the disclosure is held until Twilio echoes the disclosure mark', () => {
        const g = gated();
        g.gate.beginDisclosure();
        for (const f of frames(4)) g.gate.write(f);
        g.gate.endDisclosure();
        g.gate.enter('notice');
        for (const f of frames(3)) g.gate.write(f);
        assert.equal(media(g.sent).length, 4, 'held audio leaked before the mark came back');
        const mark = g.sent.find((m) => m.event === 'mark')!.mark!.name;
        g.twilio.echo(mark);
        assert.equal(media(g.sent).length, 7);
        g.gate.enter('ended');
        assert.equal(g.gate.disclosure().heard, true);
    });

    it('🔴 a disclosure cleared at Twilio is not reported heard, though Twilio echoes its mark', () => {
        const g = gated();
        g.gate.beginDisclosure();
        for (const f of frames(4)) g.gate.write(f);
        g.gate.endDisclosure();
        const mark = g.sent.find((m) => m.event === 'mark')!.mark!.name;
        // Something cleared the leg underneath the gate (the bug class leg.ts warns about).
        g.leg.clear();
        g.twilio.echo(mark);
        g.gate.enter('ended');
        assert.equal(g.gate.disclosure().heard, false);
    });
});
