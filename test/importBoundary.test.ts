/**
 * The import boundary (CORE-A11, R7 / DS-1): what `src/` may reach, read and hold.
 *
 *   1. No file under `src/` names a secret or key-shaped environment variable. The agent holds no
 *      signing secret and no API key; Google is reached through ADC only.
 *   2. No file under `src/` imports from `scripts/`. `mint-token` is dev tooling, and the runtime
 *      must not be one import away from a token signer.
 *   3. Only the three adapters may make a network request: the Seam 4 client (the agent reaches pb
 *      only through it), synthesis and the intent model. Everything else is handed a client.
 *   4. Those Google adapters address googleapis.com hosts and nothing else.
 *
 * Each rule is a function over file text, and each has a control that plants a violation and must
 * be caught, so "it found nothing" cannot mean "it never looked".
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');

function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.(ts|mts|js|mjs)$/.test(e)) out.push(p);
    }
    return out;
}

const files = walk(SRC).map((p) => ({ rel: relative(ROOT, p).split(sep).join('/'), text: readFileSync(p, 'utf8') }));

/** Code only: line comments and block comments removed, so prose explaining a rule is allowed. */
const codeOf = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const SECRET_NAME = /\b(?:VENUE_CALL_SECRET|GEMINI_API_KEY|GOOGLE_API_KEY|SPEECH_TO_TEXT_CREDENTIALS|GOOGLE_APPLICATION_CREDENTIALS|TWILIO_AUTH_TOKEN|[A-Z0-9_]*_API_KEY|[A-Z0-9_]*_SECRET)\b/;
const SCRIPTS_IMPORT = /\bfrom\s+['"](?:\.\.\/)+scripts\/|import\(\s*['"](?:\.\.\/)+scripts\//;
const NETWORK = /\bfetch\s*\(|\?\?\s*fetch\b|globalThis\.fetch|\bnode:https?\b|\bhttps?\.request\s*\(/;

const NETWORK_ALLOWED = new Set(['src/seam/client.ts', 'src/speech/tts.ts', 'src/agent/intent.ts']);
/** The mock seam is a SERVER standing in for pb, and the stream server's import of node:http is the listener. */
const NETWORK_SERVERS = new Set(['src/mock/server.ts', 'src/server/streamServer.ts', 'src/server/main.ts']);
const GOOGLE_ADAPTERS = ['src/speech/tts.ts', 'src/agent/intent.ts', 'src/speech/stt.ts', 'src/google/adc.ts'];

const secretReads = (text: string) => SECRET_NAME.test(codeOf(text));
const importsScripts = (text: string) => SCRIPTS_IMPORT.test(codeOf(text));
const makesRequests = (text: string) => NETWORK.test(codeOf(text));
const foreignHosts = (text: string): string[] =>
    [...codeOf(text).matchAll(/https?:\/\/([a-z0-9.${}-]+)/gi)]
        .map((m) => m[1]!)
        .filter((host) => !/(?:^|\.|-)googleapis\.com$/.test(host) && !/^\$\{/.test(host));

describe('the import boundary over src/', () => {
    test('the walk found the files it must police', () => {
        assert.ok(files.length > 30, `only ${files.length} files`);
        for (const f of [...NETWORK_ALLOWED, ...GOOGLE_ADAPTERS]) assert.ok(existsSync(join(ROOT, f)), f);
    });

    test('🔴 no file names a secret or key-shaped environment variable', () => {
        const hits = files.filter((f) => secretReads(f.text)).map((f) => f.rel);
        assert.deepEqual(hits, []);
    });

    test('no file imports from scripts/', () => {
        assert.deepEqual(files.filter((f) => importsScripts(f.text)).map((f) => f.rel), []);
    });

    test('only the seam client, synthesis and the intent model make requests', () => {
        const hits = files
            .filter((f) => !NETWORK_ALLOWED.has(f.rel) && !NETWORK_SERVERS.has(f.rel) && makesRequests(f.text))
            .map((f) => f.rel);
        assert.deepEqual(hits, []);
    });

    test('the Google adapters address googleapis.com and nothing else', () => {
        for (const rel of GOOGLE_ADAPTERS) {
            const f = files.find((x) => x.rel === rel)!;
            assert.deepEqual(foreignHosts(f.text), [], rel);
        }
    });
});

describe('CONTROLS — each rule catches a planted violation', () => {
    test('a secret read, in each shape, is caught; the same words in a comment are not', () => {
        assert.equal(secretReads("const s = process.env.VENUE_CALL_SECRET;"), true);
        assert.equal(secretReads("const k = env['GEMINI_API_KEY'];"), true);
        assert.equal(secretReads("trimmed(env, 'OPENAI_API_KEY')"), true);
        assert.equal(secretReads('// the agent never holds VENUE_CALL_SECRET'), false);
        assert.equal(secretReads('/** no GEMINI_API_KEY here */\nconst x = 1;'), false);
    });

    test('an import from scripts/ is caught', () => {
        assert.equal(importsScripts("import { mint } from '../../scripts/mint-token.mjs';"), true);
        assert.equal(importsScripts("const m = await import('../scripts/mint-token.mjs');"), true);
    });

    test('a request from a file that should be handed a client is caught', () => {
        assert.equal(makesRequests('await fetch(url)'), true);
        assert.equal(makesRequests('const f = options.fetchImpl ?? fetch;'), true);
        assert.equal(makesRequests("import https from 'node:https';"), true);
        assert.equal(makesRequests('fetchImpl?: typeof fetch;'), false);
    });

    test('a non-Google host in an adapter is caught', () => {
        assert.deepEqual(foreignHosts("const u = 'https://generativelanguage.example.com/v1';"), ['generativelanguage.example.com']);
        assert.deepEqual(foreignHosts("const u = 'https://us-speech.googleapis.com';"), []);
    });
});
