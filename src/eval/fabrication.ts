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
    const residueOf = residueBy(allowed);

    const report: FabricationReport = { fabrications: [], glue: [], quoted: 0, spoken: spoken.length };

    for (const sentence of spoken) {
        if (!normalise(sentence)) continue;

        // What the agent said in its own words. For a sentence that quotes nothing that is the
        // whole sentence; for one that embeds a permitted sentence it is what is left around it,
        // and that leftover is judged exactly as a sentence of its own would be (CORE-A9).
        const residue = residueOf(sentence);
        if (residue === '') {
            report.quoted++;
            continue;
        }

        if (RISKY.some((re) => re.test(residue))) report.fabrications.push(residue);
        else report.glue.push(residue);
    }

    return report;
}

/**
 * Every sentence the agent said that is NOT one the backend supplied, by the same yardstick
 * `checkFabrication` uses. A fixture's `must_not_improvise_matching` reads this: a word such as
 * "complimentary" may be spoken inside a backend sentence and never in the agent's own words.
 */
export function unquotedSentences(spoken: readonly string[], allowed: readonly string[]): string[] {
    const residueOf = residueBy(allowed);
    return spoken
        .filter((sentence) => normalise(sentence) !== '')
        .map(residueOf)
        .filter((residue) => residue !== '');
}

/**
 * What the agent said that `allowed` does not cover: '' when the sentence is one of `allowed`,
 * verbatim or split/joined by the transport; the sentence itself when it quotes nothing; and,
 * when it embeds one or more permitted sentences, the (normalised) text left once they are cut out.
 *
 * 🔴 THE LEFTOVER IS THE POINT (CORE-A9). The embedding rule used to answer only "does a permitted
 * sentence appear inside this one?", so "The reservation is under Dana, and the brand will cover
 * sixty dollars." was waved through as quoted: the permitted half vouched for the invented half.
 * Now a permitted sentence vouches only for its own words, and what is appended (or prepended) to
 * it is graded as if it had been said alone. Leftover with no letters or digits — the full stop
 * between two joined sentences — is nothing said.
 */
function residueBy(allowed: readonly string[]): (sentence: string) => string {
    const permitted = new Set(allowed.map(normalise).filter((s) => s.length > 0));
    // Longest first, so a permitted sentence that contains a shorter permitted one is cut whole.
    const embeddable = [...permitted].filter((p) => p.length >= MIN_WHOLE).sort((a, b) => b.length - a.length);
    return (sentence) => {
        const key = normalise(sentence);
        if (key === '' || permitted.has(key)) return '';
        if (key.length >= MIN_FRAGMENT && [...permitted].some((p) => p.includes(key))) return '';

        let rest = key;
        for (const p of embeddable) if (rest.includes(p)) rest = rest.split(p).join(' ');
        if (rest === key) return sentence;
        return /[a-z0-9$£€%]/.test(rest) ? rest.replace(/\s+/g, ' ').trim() : '';
    };
}

// A sentence may also be a permitted one that got split or joined by the transport. Being strict
// about that produces false alarms, and a noisy fabrication check is one that gets switched off —
// which loses the property entirely.
//
// ⚠️ BOTH DIRECTIONS ARE LENGTH-GUARDED, and that is not tidiness. Without the guards, one short
// permitted string turns the whole check off: if "usually" were ever permitted, every sentence
// containing the word would be cut down to its remainder or waved through as a fragment, and the
// checker would keep reporting clean while doing nothing. A substring match is only evidence when
// the substring is long enough to be evidence.
/** A piece of a permitted sentence, split off by the transport, is quoted if it is this long. */
const MIN_FRAGMENT = 12;
/** A permitted sentence embedded in a longer spoken one is cut out only if it is this long. */
const MIN_WHOLE = 20;

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

    // CORE-A9, the appended clause. A permitted sentence must vouch only for its own words: an
    // invention glued onto it in the same breath is still an invention. And the guard must not
    // over-fire: two permitted sentences the transport joined are still nothing but quotation.
    const appended = checkFabrication(
        ['The reservation is under Dana, and the brand will cover sixty dollars.'],
        allowed,
    );
    if (appended.fabrications.length !== 1) {
        return `an invented clause appended to a permitted sentence was not caught: ${JSON.stringify(appended)}`;
    }
    if (appended.fabrications[0]?.includes('dana')) {
        return `the permitted half was graded with the invented half: ${JSON.stringify(appended.fabrications[0])}`;
    }
    const joined = checkFabrication(['The reservation is under Dana. Yes, the reservation still stands.'], allowed);
    if (joined.quoted !== 1 || joined.fabrications.length + joined.glue.length !== 0) {
        return `two permitted sentences joined by the transport were not read as quotation: ${JSON.stringify(joined)}`;
    }

    return null;
}
