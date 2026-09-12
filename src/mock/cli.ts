/**
 * `npm run mock` — the local Seam 4 on a fixed port, for poking at by hand.
 *
 * Tests should call `startMockSeam({ port: 0 })` directly instead, so two of them can run at once
 * without fighting over a port. This entry point exists for the other half of development: curl,
 * a browser, and watching what the agent actually asked for while you change a prompt.
 */

import { startMockSeam, scenarioNames, scenarioSummary } from './server.ts';

function flag(name: string, fallback?: string): string | undefined {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
}

const port = Number.parseInt(flag('port', process.env.MOCK_PORT ?? '8788') as string, 10);
const latencyMs = Number.parseInt(flag('latency', process.env.MOCK_LATENCY_MS ?? '0') as string, 10);
const forceRefusal = flag('refuse');

const mock = await startMockSeam({ port, latencyMs, ...(forceRefusal ? { forceRefusal } : {}) });

console.log(`mock Seam 4 listening on ${mock.baseUrl}`);
console.log('It dials nobody, reads no database, and holds no credential.\n');
if (latencyMs) console.log(`Every response delayed by ${latencyMs}ms.\n`);
if (forceRefusal) console.log(`🔴 Every route forced to refuse: ${forceRefusal}\n`);

console.log('Point the agent at it:');
console.log(`  CREATORAIN_API_BASE_URL=${mock.baseUrl}`);
console.log('  Authorization: Bearer mock:<scenario>\n');

console.log('Scenarios:');
for (const name of scenarioNames()) {
    console.log(`  ${name.padEnd(22)} ${scenarioSummary(name)}`);
}

console.log('\nTry it:');
console.log(`  curl -s -XPOST ${mock.baseUrl}/reservations/call-context -H "Authorization: Bearer mock:happy"`);
console.log(`  curl -s -XPOST ${mock.baseUrl}/reservations/call-fact -H "Authorization: Bearer mock:happy" \\`);
console.log('       -H "Content-Type: application/json" -d \'{"topic":"comp_terms"}\'');
console.log(`  curl -s ${mock.baseUrl}/__mock/journal`);
console.log('\nCtrl-C to stop.');
