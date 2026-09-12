#!/usr/bin/env node
/**
 * The no-facts guard.
 *
 * WHY IT EXISTS. This service must never compose a fact. Every sentence a restaurant hears comes
 * back from the CreatoRain backend as a finished string; the model only chooses which one to fetch.
 * That property is the ONLY reason an after-the-call check for invented claims is possible — a
 * checker can compare speech against a finite set of known strings, but it cannot compare speech
 * against a number the model was free to phrase itself.
 *
 * A product noun hardcoded here quietly destroys that property, and it would do so in a way no test
 * would notice. So it is a build failure, not a review comment.
 *
 * 🔴 THIS GUARD SHIPS WITH A POSITIVE CONTROL AND RUNS IT EVERY TIME.
 * A source-scanning guard that finds nothing is indistinguishable from a guard whose patterns are
 * broken, whose file walk reaches an empty directory, or whose regex silently stopped compiling.
 * "It protected everything" and "it never ran" are the same observation from outside. So before
 * reporting a pass, this script scans a synthetic string that MUST match. If the control does not
 * trip, the run fails — a broken guard is treated as worse than a violation, because a violation is
 * at least visible.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCAN_DIRS = ['src'];
const EXTS = new Set(['.ts', '.mts', '.js', '.mjs', '.json']);

/**
 * Each rule is a product noun this repository may not contain.
 *
 * Keep them narrow and specific. A rule broad enough to match ordinary English produces noise, and
 * a noisy guard gets switched off — which is the failure mode that actually loses the property.
 */
/**
 * The venue rule holds SHA-256 digests, never the names themselves, so the list can sit in a public
 * repository without publishing it. A digest is of the name lowercased with everything but a-z
 * removed ("Some Noodle Bar" -> "somenoodlebar"); a line matches when any run of one to three
 * consecutive words hashes to one of them. One entry is the invented venue in CONTROL below, so the
 * positive control exercises this rule too. To add a name:
 *   node -e "console.log(require('crypto').createHash('sha256').update('somenoodlebar').digest('hex'))"
 */
const VENUE_DIGESTS = new Set([
    '2a2038ced28c1b0a2513ddae31aa107218ce15954a65da86969683057a68c086',
    '3b75f9e99c8bda196db96a40531593b51a945526eebdd6d2455d4d330bfe2c1a',
    '468559bccf16155d8d0e35036d2130d3787777dda25d26852deb0f73d61a5215',
    '47a33c7b3416b3defd33f713b2cf375165c1b6bf68759bc150fcbda5e29a4bfd',
    '4983339b83b8b40c5690e04ff1227745c20adbc8e1d3b1ef052d14ec31ed99bb',
    '50832721ade3a6792ce66339594e4d58a385c4f6658213ae207bc30737cc50f6',
    '799acf7c4d38459be3efd9d8c1b3f2cf82b4971ba66cdd8cac3126f56e917f0a',
    '7ef7ec797803041c90f853b7fb22a5cce83e677f827895f1454ce27336abd997',
    '89ffacecede60b8ce07b2fd069a00fff2854f743d32856d282957b705dff344e',
    'a1b5f2b30c26cd5c3acae705cd9fe0011cdd3a17a85591765fabeb060bd65084',
    'a223e1d5fec9dcc9620b61a045acb3d9248fc64bc0d25519fa90c7f04d0962f5',
    'cebfb5f249240bb992a6ad7582d7bf2dd9c42d6a28627cd556cbe399bb1f36a1',
    'd005d76ca5c25f10c54ccc1eb1f417634bf5d82fe4b77446361ed593c981ef6b',
    'ea9a5edcac1880ab3994b1eb70a85a872a476bd76e705ee8b23791974875c1c0',
    'f44bd77da502bc3d393e3f9d9d7427c67e6e8f6edd874802d2c4aa504620d7b9',
]);

function isVenueName(line) {
    const words = line.toLowerCase().split(/[^a-z]+/).filter(Boolean);
    for (let i = 0; i < words.length; i++) {
        let run = '';
        for (let n = 0; n < 3 && i + n < words.length; n++) {
            run += words[i + n];
            if (VENUE_DIGESTS.has(createHash('sha256').update(run).digest('hex'))) return true;
        }
    }
    return false;
}

const RULES = [
  { name: 'a venue or brand name', re: { test: isVenueName } },
  { name: 'a money amount',        re: /(?<![\w.])\$\s?\d/ },
  { name: 'a comp or payment term', re: /\b(comp(?:ed|s|limentary)?\s+(?:meal|dinner|lunch|the\s+bill)|we\s+(?:will\s+)?(?:cover|pay\s+for)\s+(?:the\s+)?(?:meal|bill|food)|on\s+the\s+house)\b/i },
  { name: 'a spoken script line',  re: /\b(hi[, ]+this\s+is|calling\s+(?:on\s+behalf|about\s+a\s+(?:booking|reservation))|i'?m\s+calling\s+from)\b/i },
  { name: 'a policy sentence',     re: /\b(cancellation\s+policy|no[- ]show\s+fee|party\s+size\s+(?:is|of)\s+\d)\b/i },
];

/** The control string. It must trip at least one rule, every run, or the guard is not working. */
const CONTROL = "Hi, this is CreatoRain calling about a booking at Nonesuch Noodles; we will cover the meal up to $60.";

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    let s;
    try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) { if (e !== 'node_modules' && e !== 'dist' && e !== 'fixtures') walk(p, out); }
    else if (EXTS.has(extname(e))) out.push(p);
  }
  return out;
}

// ── positive control, BEFORE any verdict ──────────────────────────────────────
const tripped = RULES.filter(r => r.re.test(CONTROL)).map(r => r.name);
if (tripped.length === 0) {
  console.error('FAIL no-facts: the POSITIVE CONTROL did not trip.');
  console.error('  The guard cannot detect a violation it was built to detect, so a clean result');
  console.error('  from it would mean nothing. Fix the rules before trusting any pass.');
  process.exit(2);
}

// ── the real scan ─────────────────────────────────────────────────────────────
const files = SCAN_DIRS.flatMap(d => walk(join(ROOT, d)));
if (files.length === 0) {
  console.error('FAIL no-facts: scanned ZERO files.');
  console.error('  An empty walk reports "clean" while checking nothing — the same shape as a');
  console.error('  generator that read an empty directory and wrote an empty index. Refusing to pass.');
  process.exit(2);
}

const hits = [];
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;      // prose in comments is allowed
    for (const rule of RULES) {
      if (rule.re.test(line)) {
        hits.push({ file: relative(ROOT, f), line: i + 1, rule: rule.name, text: line.trim().slice(0, 120) });
      }
    }
  });
}

console.log(`no-facts: ${files.length} file(s) scanned; control tripped ${tripped.length} rule(s) (${tripped.join(', ')}).`);

if (hits.length) {
  console.error(`\nFAIL no-facts: ${hits.length} product fact(s) hardcoded in this service.\n`);
  for (const h of hits) console.error(`  ${h.file}:${h.line}  [${h.rule}]\n      ${h.text}`);
  console.error('\nThis service may not author facts. Fetch the finished sentence from the backend');
  console.error('instead — if there is no endpoint for it, the missing endpoint IS the bug.');
  process.exit(1);
}

console.log('no-facts: clean.');
