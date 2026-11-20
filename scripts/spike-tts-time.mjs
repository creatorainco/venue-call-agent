// SPIKE it-22 (stall): time a cold Chirp 3 HD render of every sentence a mock call prerenders.
//     node --import ./scripts/soak-local-quota.mjs scripts/spike-tts-time.mjs src/mock/fixtures/scenarios.json [timeoutMs]
import { readFileSync } from 'node:fs';
import { createTts } from '../src/speech/tts.ts';
import { createAdcTokenSource } from '../src/google/adc.ts';
import { FIXED_PHRASES } from '../src/agent/phrases.ts';
const fx = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const ctx = fx.default_context;
const facts = Object.values(fx.default_facts).map((f) => f.say).filter(Boolean);
const texts = [...(ctx.opening_script ?? []), ctx.closing_sentence, ctx.voicemail_script, ...FIXED_PHRASES, ...facts].filter((t) => typeof t === 'string' && t.trim());
const tokens = await createAdcTokenSource();
await tokens.token();
const timeoutMs = Number(process.argv[3] ?? 4000);
for (let round = 1; round <= 2; round += 1) {
    const tts = createTts({ tokens, timeoutMs, log: (l) => process.stdout.write(`  ${l}\n`) });
    for (const [i, t] of texts.entries()) {
        const t0 = Date.now();
        try { const a = await tts.synthesize(t); console.log(`r${round} #${i} chars=${t.length} ms=${Date.now() - t0} audio_ms=${a.length / 8}`); }
        catch (e) { console.log(`r${round} #${i} chars=${t.length} ms=${Date.now() - t0} FAILED ${e.message}`); }
    }
}
