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
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * TWO EXEMPTIONS, BOTH NARROW, BOTH ANNOUNCED ON EVERY RUN
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * 1. DIRECTORIES NAMED `fixtures`. Canned backend responses are DATA standing in for the one
 *    component that is allowed to author sentences. A fixture that could not contain a comp clause
 *    would be useless for testing the code that handles one.
 *
 * 2. FILES THAT DECLARE `NO-FACTS-EXEMPT[rule, rule]: reason` IN THEIR FIRST 60 LINES.
 *    Some code in here exists to DETECT this language — the fabrication checker's risky-word list,
 *    the reference agent's question-to-topic cues. Those files necessarily contain the words they
 *    hunt for, and failing them is the false-positive direction that gets a guard switched off
 *    entirely, which loses the property this file exists to defend.
 *
 *    The exemption is per-RULE, not per-file: a detector may be excused from "a comp or payment
 *    term" and still be forbidden a venue's name. It must be declared in the file, so it shows up
 *    in review rather than in a path list nobody reads. Every exempt file and the rules it claimed
 *    are printed on every run, and the count is capped — an exemption list that grows quietly is
 *    the same as no guard.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCAN_DIRS = ['src'];
const EXTS = new Set(['.ts', '.mts', '.js', '.mjs', '.json']);

/** More than this many exempt files means the exemption has become the rule. */
const MAX_EXEMPT_FILES = 4;

/**
 * Each rule is a product noun this repository may not contain.
 *
 * Keep them narrow and specific. A rule broad enough to match ordinary English produces noise, and
 * a noisy guard gets switched off — which is the failure mode that actually loses the property.
 */
/**
 * The venue rule. Real venue names are NOT in this repository in any form — not even hashed: an
 * unsalted digest of a short restaurant name is reversed by hashing a list of restaurants.
 *
 *   - ALWAYS: the invented venue in CONTROL below, so the positive control exercises this rule's
 *     matcher on every run, with or without a list.
 *   - WHEN `VENUE_NAME_LIST_FILE` names a file: one venue name per line, `#` starts a comment. That
 *     is how a CreatoRain engineer runs the full check. The file lives OUTSIDE this repository and
 *     is never committed. An outside contributor never needs it; unset, every other rule still runs.
 *
 * A name is compared lowercased with everything but a-z removed ("Some Noodle Bar" ->
 * "somenoodlebar"); a line matches when any run of consecutive words, up to the longest listed
 * name, spells one. A list that cannot be read, or holds no names, fails the run: a list that
 * loaded nothing checks nothing, and would otherwise report clean.
 */
const CONTROL_VENUE = 'Nonesuch Noodles';
const VENUE_LIST_ENV = 'VENUE_NAME_LIST_FILE';

const venueNames = new Set();
let longestVenueWords = 1;

const wordsOf = (text) => text.toLowerCase().split(/[^a-z]+/).filter(Boolean);

function addVenue(name) {
    const words = wordsOf(name);
    if (!words.length) return false;
    venueNames.add(words.join(''));
    longestVenueWords = Math.max(longestVenueWords, words.length);
    return true;
}

addVenue(CONTROL_VENUE);

let listedVenues = 0;
const venueListPath = process.env[VENUE_LIST_ENV];
if (venueListPath) {
    let listText;
    try {
        listText = readFileSync(venueListPath, 'utf8');
    } catch {
        console.error(`FAIL no-facts: ${VENUE_LIST_ENV} is set but the file cannot be read.`);
        console.error('  Unset it to skip real venue names, or point it at the list. Refusing to report clean.');
        process.exit(2);
    }
    for (const raw of listText.split(/\r?\n/)) {
        const name = raw.replace(/#.*$/, '').trim();
        if (name && addVenue(name)) listedVenues += 1;
    }
    if (!listedVenues) {
        console.error(`FAIL no-facts: ${VENUE_LIST_ENV} names a file with no venue names in it.`);
        console.error('  A list that loaded nothing checks nothing. Refusing to report clean.');
        process.exit(2);
    }
}

function isVenueName(line) {
    const words = wordsOf(line);
    for (let i = 0; i < words.length; i++) {
        let run = '';
        for (let n = 0; n < longestVenueWords && i + n < words.length; n++) {
            run += words[i + n];
            if (venueNames.has(run)) return true;
        }
    }
    return false;
}

const RULES = [
  { id: 'venue',  name: 'a venue or brand name', re: { test: isVenueName } },
  { id: 'money',  name: 'a money amount',        re: /(?<![\w.])\$\s?\d/ },
  { id: 'comp',   name: 'a comp or payment term', re: /\b(comp(?:ed|s|limentary)?\s+(?:meal|dinner|lunch|the\s+bill)|we\s+(?:will\s+)?(?:cover|pay\s+for)\s+(?:the\s+)?(?:meal|bill|food)|on\s+the\s+house)\b/i },
  { id: 'script', name: 'a spoken script line',  re: /\b(hi[, ]+this\s+is|calling\s+(?:on\s+behalf|about\s+a\s+(?:booking|reservation))|i'?m\s+calling\s+from)\b/i },
  { id: 'policy', name: 'a policy sentence',     re: /\b(cancellation\s+policy|no[- ]show\s+fee|party\s+size\s+(?:is|of)\s+\d)\b/i },
];

const RULE_IDS = new Set(RULES.map((r) => r.id));

/** The control string. It must trip at least one rule, every run, or the guard is not working. */
const CONTROL = "Hi, this is CreatoRain calling about a booking at Nonesuch Noodles; we will cover the meal up to $60.";

/** `NO-FACTS-EXEMPT[comp, money]: why` — declared in the file, near the top, with a reason. */
const EXEMPT_RE = /NO-FACTS-EXEMPT\[([a-z, ]+)\]:\s*(.+)/;

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
const exemptions = [];
let badDeclaration = null;

for (const f of files) {
  const text = readFileSync(f, 'utf8');
  const rel = relative(ROOT, f);

  // A declaration must appear near the top, where a reviewer reads it.
  const header = text.split(/\r?\n/).slice(0, 60).join('\n');
  const declared = EXEMPT_RE.exec(header);
  let excused = new Set();
  if (declared) {
    const ids = declared[1].split(',').map((s) => s.trim()).filter(Boolean);
    const unknown = ids.filter((id) => !RULE_IDS.has(id));
    if (unknown.length) {
      badDeclaration = `${rel} claims exemption from rule(s) that do not exist: ${unknown.join(', ')}`;
    }
    if (!declared[2].trim()) badDeclaration = `${rel} declares an exemption with no reason`;
    excused = new Set(ids);
    exemptions.push({ file: rel, rules: ids, reason: declared[2].trim() });
  }

  text.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;      // prose in comments is allowed
    for (const rule of RULES) {
      if (excused.has(rule.id)) continue;
      if (rule.re.test(line)) {
        hits.push({ file: rel, line: i + 1, rule: rule.name, text: line.trim().slice(0, 120) });
      }
    }
  });
}

console.log(`no-facts: ${files.length} file(s) scanned; control tripped ${tripped.length} rule(s) (${tripped.join(', ')}).`);
console.log(listedVenues
    ? `no-facts: venue names: ${listedVenues} from ${VENUE_LIST_ENV}, plus the control.`
    : `no-facts: venue names: the control only (${VENUE_LIST_ENV} unset; a CreatoRain engineer sets it).`);

for (const e of exemptions) {
  console.log(`no-facts: EXEMPT ${e.file} from [${e.rules.join(', ')}] — ${e.reason}`);
}

if (badDeclaration) {
  console.error(`\nFAIL no-facts: ${badDeclaration}`);
  console.error('  An exemption nobody can read is an exemption nobody reviewed.');
  process.exit(2);
}

if (exemptions.length > MAX_EXEMPT_FILES) {
  console.error(`\nFAIL no-facts: ${exemptions.length} files claim an exemption; the cap is ${MAX_EXEMPT_FILES}.`);
  console.error('  Past that the exemption is the rule and the guard is decoration. Either the');
  console.error('  rules are too broad and should be narrowed, or something belongs in fixtures/.');
  process.exit(2);
}

if (hits.length) {
  console.error(`\nFAIL no-facts: ${hits.length} product fact(s) hardcoded in this service.\n`);
  for (const h of hits) console.error(`  ${h.file}:${h.line}  [${h.rule}]\n      ${h.text}`);
  console.error('\nThis service may not author facts. Fetch the finished sentence from the backend');
  console.error('instead — if there is no endpoint for it, the missing endpoint IS the bug.');
  console.error('\nIf this file exists to DETECT that language rather than to speak it, declare it:');
  console.error('  NO-FACTS-EXEMPT[comp, money]: this is the fabrication checker\'s pattern list');
  process.exit(1);
}

console.log('no-facts: clean.');
