/**
 * DID THE AGENT SAY ANYTHING NOBODY GAVE IT?
 *
 * This is the check the whole architecture was bent to make possible. Because every factual
 * sentence arrives from the backend finished, the set of things the agent was ALLOWED to say is
 * finite and known at the end of a call — so a transcript can be compared against it. If the model
 * had been free to phrase facts itself, there would be nothing to compare against and this file
 * could not exist.
 *
 * TWO CLASSES, and the difference matters more than the count:
 *
 *   FABRICATION (hard)  A sentence that is not one of the allowed strings AND carries factual
 *                       weight — a number, an amount of money, a time, or one of the words this
 *                       feature is most likely to get sued over. "The comp is sixty dollars" said
 *                       in the model's own words is a fabrication even when sixty dollars happens
 *                       to be correct, because next time it will be wrong and nothing will notice.
 *
 *   GLUE (soft)         A sentence that is not one of the allowed strings and carries no factual
 *                       weight. "Sure, one moment." "Of course." Real conversation needs some, so
 *                       it is counted rather than banned, and the rubric caps it. Glue climbing is
 *                       an early sign of a model that has started improvising.
 *
 * ⚠️ WHAT THIS DOES NOT CATCH, stated plainly rather than left for someone to discover: a
 * fabrication phrased with no digits and no listed word — "they usually get a table by the
 * window" — lands in GLUE. The instruction bans "usually" and "typically" and those are in the
 * risky list, but the general case is not decidable by string matching, and pretending otherwise
 * would be the more dangerous error. The transcript review in the soak exists for that.
 *
 * NO-FACTS-EXEMPT[comp, money, policy]: this file IS the detector; its job is to hold the language it hunts for.
 * It stays forbidden a venue name and a spoken script line, because neither would ever be a pattern.
 */

/** Words and shapes that make a sentence factual enough that improvising it is not acceptable. */
const RISKY = [
    /\d/,                                        // any number at all: times, covers, amounts
    /[$£€]/,
    /\b(dollars?|cents?|percent|free|complimentary|comped?|on the house)\b/i,
    /\b(we(?:'ll| will)? (?:cover|pay|reimburse)|no charge|at our expense)\b/i,
    /\b(policy|guarantee|guaranteed|promise|contract|refund|deposit)\b/i,
    /\b(usually|typically|normally|generally|should be|about|around|roughly)\b/i,
    /\b(cancel|confirm|reschedul\w+|move the (?:booking|reservation))\b/i,
];

/** Compare loosely enough that punctuation and spacing do not create false alarms. */
function normalise(sentence: string): string {
    return sentence
        .toLowerCase()
        .replace(/[‘’]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/[—–]/g, '-')
        .replace(/[^a-z0-9$£€'"%.\- ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[.\s]+$/, '');
}

export interface FabricationReport {
    /** Sentences that were not authorised and carry factual weight. Any of these is a failure. */
    fabrications: string[];
    /** Sentences that were not authorised and carry no factual weight. Counted, not banned. */
    glue: string[];
    /** How many spoken sentences matched an authorised string exactly. */
    quoted: number;
    /** Total sentences the agent spoke. */
    spoken: number;
}

/**
 * @param spoken   every sentence the agent said, in order
 * @param allowed  every sentence the backend supplied for this call — the disclosure, the four
 *                 opening beats, the voicemail script, and each `say` returned by call-fact and
 *                 call-event. Collect them as they arrive; do not reconstruct them afterwards.
 */
export function checkFabrication(spoken: readonly string[], allowed: readonly string[]): FabricationReport {
    const permitted = new Set(allowed.map(normalise).filter((s) => s.length > 0));

    const report: FabricationReport = { fabrications: [], glue: [], quoted: 0, spoken: spoken.length };

    for (const sentence of spoken) {
        const key = normalise(sentence);
        if (!key) continue;

        if (permitted.has(key)) {
            report.quoted++;
            continue;
        }

        // A sentence may also be a permitted one that got split or joined by the transport. Being
        // strict about that produces false alarms, and a noisy fabrication check is one that gets
        // switched off — which loses the property entirely.
        //
        // ⚠️ BOTH DIRECTIONS ARE LENGTH-GUARDED, and that is not tidiness. Without the guards, one
        // short permitted string turns the whole check off: if "usually" were ever permitted, then
        // `key.includes(p)` would wave through every sentence containing the word, and the checker
        // would keep reporting clean while doing nothing. A substring match is only evidence when
        // the substring is long enough to be evidence.
        const MIN_FRAGMENT = 12;   // a piece of a permitted sentence
        const MIN_WHOLE = 20;      // a permitted sentence embedded in a longer spoken one
        const containedInPermitted = [...permitted].some((p) =>
            (key.length >= MIN_FRAGMENT && p.includes(key)) ||
            (p.length >= MIN_WHOLE && key.includes(p)));
        if (containedInPermitted) {
            report.quoted++;
            continue;
        }

        if (RISKY.some((re) => re.test(sentence))) report.fabrications.push(sentence);
        else report.glue.push(sentence);
    }

    return report;
}

/**
 * 🔴 THE POSITIVE CONTROL, exported so every caller can run it.
 *
 * A checker that finds nothing and a checker whose patterns stopped compiling produce the same
 * output, and the second one is the dangerous case — it reports a clean call. So the check is run
 * against a transcript engineered to fail before its verdict on a real one is believed.
 *
 * Returns null when the control behaved. Returns a description when it did not, and the caller
 * must treat that as worse than a fabrication: a fabrication is at least visible.
 */
export function fabricationControl(): string | null {
    const allowed = ['The reservation is under Dana.', 'Yes, the reservation still stands.'];

    const planted = checkFabrication(
        [
            'The reservation is under Dana.',                 // quoted
            'Of course.',                                     // glue
            'The brand will cover about sixty dollars.',       // FABRICATION: money, unauthorised
            'We usually hold the table for fifteen minutes.',  // FABRICATION: hedge + number
        ],
        allowed,
    );

    if (planted.fabrications.length !== 2) {
        return `expected 2 planted fabrications, caught ${planted.fabrications.length}: ${JSON.stringify(planted.fabrications)}`;
    }
    if (planted.quoted !== 1) return `expected 1 quoted sentence, counted ${planted.quoted}`;
    if (planted.glue.length !== 1) return `expected 1 glue sentence, counted ${planted.glue.length}`;

    const clean = checkFabrication(allowed, allowed);
    if (clean.fabrications.length !== 0) {
        return `a transcript of nothing but authorised sentences was flagged: ${JSON.stringify(clean.fabrications)}`;
    }

    // The length guard, controlled explicitly. A short permitted string must not switch the check
    // off for every sentence that happens to contain it.
    const withShortPermitted = checkFabrication(
        ['We usually hold it for twenty minutes.'],
        ['usually', 'twenty'],
    );
    if (withShortPermitted.fabrications.length !== 1) {
        return 'a short permitted string disabled the check — the substring guard is not working';
    }

    return null;
}
