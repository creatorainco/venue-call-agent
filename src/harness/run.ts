/**
 * `npm run harness` — play one recorded conversation and print the transcript. Dials nobody.
 *
 *     npm run harness                       the plain call, against the reference agent
 *     npm run harness -- --fixture=who-pays
 *     npm run harness -- --fixture=phone-menu --latency=250
 *     npm run harness -- --list
 *
 * This is the debugging view. `npm run eval` is the scoring view — same machinery, same fixtures,
 * different question. Use this one when you want to read what happened; use that one when you
 * want to know whether it was allowed.
 *
 * Every sentence is marked with where it came from, and that marking is the whole point:
 *
 *     [seam]  the backend supplied this string, finished
 *     [glue]  the agent said it and nobody supplied it — harmless conversational filler
 *     [🔴 INVENTED]  the agent said it, nobody supplied it, and it carries a fact
 *
 * A single red line is a bug, not a style note. See src/eval/fabrication.ts.
 */

import { replay, type Fixture } from './replay.ts';
import { checkFabrication } from '../eval/fabrication.ts';
import { createScriptedStub } from '../agent/scriptedStub.ts';
import { loadFixtures } from './fixtures.ts';

const arg = (name: string): string | undefined => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit?.slice(name.length + 3);
};

if (process.argv.includes('--list')) {
    for (const f of loadFixtures()) console.log(`${f.name.padEnd(26)} ${f.about}`);
    process.exit(0);
}

const wanted = arg('fixture') ?? 'plain';
const found = loadFixtures().find((f) => f.name === wanted);
if (!found) {
    console.error(`No fixture named "${wanted}". Try --list.`);
    process.exit(64);
}

const latency = arg('latency');
const fixture: Fixture = latency ? { ...found, latencyMs: Number(latency) } : found;

const result = await replay(fixture, ({ seam }) => createScriptedStub({ seam }));
const report = checkFabrication(result.transcript.spoken, result.allowedSentences);
const invented = new Set(report.fabrications);
const glue = new Set(report.glue);

console.log(`\n── ${fixture.name} ─────────────────────────────────────────────`);
console.log(fixture.about);
console.log(`scenario: ${fixture.scenario} · answered by: ${fixture.answerer}\n`);

for (const line of result.transcript.lines) {
    if (line.who === 'venue') {
        console.log(`  VENUE   ${line.text}`);
    } else if (line.who === 'system') {
        console.log(`          · ${line.text}`);
    } else {
        const tag = invented.has(line.text) ? '🔴 INVENTED' : glue.has(line.text) ? '[glue]' : '[seam]';
        console.log(`  AGENT   ${line.text}\n          ${tag}`);
    }
}

console.log(`\n  ended: ${result.transcript.endedBecause}${result.transcript.refusalReason ? ` (${result.transcript.refusalReason})` : ''}`);
console.log(`  ${report.quoted}/${report.spoken} sentences quoted verbatim · ${report.glue.length} glue · ${report.fabrications.length} invented`);
console.log(`  ${result.journal.length} request(s) to the backend · ${result.elapsedMs.toFixed(0)}ms\n`);

if (report.fabrications.length) {
    console.error('🔴 This call said something nobody gave it. That is the one thing this feature');
    console.error('   must never do — see docs/LIMITS.md and src/eval/fabrication.ts.\n');
    process.exit(1);
}
