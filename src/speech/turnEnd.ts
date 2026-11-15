/**
 * ENDING A TURN ON THE INTERIM (I3P-07, TASK-3749 PERF-A).
 *
 * The slowest stage of a reply was the recogniser calling the venue's turn over: in a loud room
 * Google's endpointer waits for a silence that never comes, and a one-word "Hello?" took up to
 * 10 s to finalise (docs/soak/2026-11-14.md, finding 1). The interim for the same word arrives
 * 0.1-0.3 s after the speech stops. This file decides when a still interim may stand in for the
 * final, and when the final that follows is the same turn.
 *
 * It ends a turn early in two cases only, both after the interim has stood unchanged:
 *
 *   1. A KEYWORD CUE decides it (`keywordIntent`): stop calling, wrong number, a machine, a change
 *      of booking, a question from the closed set.
 *   2. THE HELLO AFTER THE DISCLOSURE: a short turn (at most `TURN_END.shortWords` words) while
 *      the bridge expects one, which the call loop allows only until the first venue turn. This is
 *      SUPERSHORT endpointing done by us, because the telephony model ignores the setting
 *      (cascadeDefaults.ts). Not after a question of ours: the opening ends "any questions?",
 *      which invites a question, and the first soak of this change ended "hang on, who's paying
 *      for the meal?" at "hang on".
 *
 * 🔴 ONLY ON THE VOICE AT THE PHONE, NEVER THE ROOM. The recogniser writes interims for the room's
 * babble too ("happy birthday" from the next table), and the first soak of this change answered
 * them. An early end therefore also needs `ForegroundSpeech`: enough recent frames well above the
 * room's own floor. Measured on the corpus at 9 dB: the bed alone reached at most 2 such frames in
 * any 2 s, every one of the 47 clips at least 13. The recogniser's final needs no such check.
 *
 * NEVER a goodbye (`confirm`), in either case: "thanks" is the head of "thanks, but who's
 * paying?", a goodbye ends the call, and ending it on half of that is the worst miss.
 *
 * 🔴 IT NEVER COMPOSES TEXT. It reads the venue's words to decide WHEN; what is answered is still
 * the agent's, from the backend's sentences.
 */

import { keywordIntent } from '../agent/intent.ts';
import type { Intent } from '../agent/intent.ts';
import { TURN_END } from '../tuning/cascadeDefaults.ts';
import { frameEnergy } from '../carrier/vad.ts';

export interface TurnEndSettings {
    cueSettleMs: number;
    shortSettleMs: number;
    shortWords: number;
    sameTurnExtraWords: number;
    floorFrames: number;
    floorPercentile: number;
    foregroundMarginDb: number;
    foregroundWindowFrames: number;
    foregroundMinFrames: number;
}

/** Lower case, no punctuation, single spaces: the form two transcripts are compared in. */
export function words(text: string): string[] {
    return text.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').split(/\s+/).filter(Boolean);
}

/**
 * How long this interim must stand unchanged before it ends the turn, or null when it must wait
 * for the recogniser's final.
 */
export function earlySettleMs(interim: string, expectShort: boolean, settings: TurnEndSettings = TURN_END): number | null {
    const count = words(interim).length;
    if (count === 0) return null;
    const cue = keywordIntent(interim);
    // A goodbye waits for the final either way: it ends the call, and half of a sentence that
    // starts "thanks" is not one.
    if (cue === 'confirm') return null;
    if (cue !== null) return settings.cueSettleMs;
    if (expectShort && count <= settings.shortWords) return settings.shortSettleMs;
    return null;
}

/** What an early end committed to: the words, and the cue they decided (null for none). */
export interface EarlyTurn {
    words: string[];
    cue: Intent | null;
}

export function earlyTurn(interim: string): EarlyTurn {
    return { words: words(interim), cue: keywordIntent(interim) };
}

/**
 * The final that follows an early end: is it the turn already answered? Yes when it decides the
 * same cue and carries at most `sameTurnExtraWords` words beyond it ("hello" then "hello happy
 * birthday" from the room). Anything more, or a different cue, is something the venue said that
 * was not answered, and it is answered as a turn of its own.
 */
export function sameTurn(early: EarlyTurn, final: string, settings: TurnEndSettings = TURN_END): boolean {
    if (keywordIntent(final) !== early.cue) return false;
    return words(final).length - early.words.length <= settings.sameTurnExtraWords;
}

/** An interim still inside the turn already ended: it begins with the committed words. */
export function continues(early: EarlyTurn, interim: string): boolean {
    const now = words(interim);
    if (now.length < early.words.length) return early.words.slice(0, now.length).join(' ') === now.join(' ');
    return now.slice(0, early.words.length).join(' ') === early.words.join(' ');
}

/**
 * The voice at the phone against the room behind it. The room's floor is a low percentile of the
 * last `floorFrames` frames' energy; a frame `foregroundMarginDb` above it is the person on the
 * line, not the babble. Recomputed every few frames: it only has to follow the room.
 */
export class ForegroundSpeech {
    readonly #settings: TurnEndSettings;
    readonly #energies: number[] = [];
    readonly #foreground: boolean[] = [];
    #floor = 0;
    #sinceFloor = 0;

    constructor(settings: TurnEndSettings = TURN_END) {
        this.#settings = settings;
    }

    push(frame: Uint8Array): void {
        const energy = frameEnergy(frame);
        this.#energies.push(energy);
        if (this.#energies.length > this.#settings.floorFrames) this.#energies.shift();
        if (++this.#sinceFloor >= 5 || this.#energies.length < 5) {
            this.#sinceFloor = 0;
            const sorted = [...this.#energies].sort((a, b) => a - b);
            this.#floor = sorted[Math.floor(sorted.length * this.#settings.floorPercentile)] ?? 0;
        }
        const over = energy > 0 && energy >= this.#floor * 10 ** (this.#settings.foregroundMarginDb / 20);
        this.#foreground.push(over);
        if (this.#foreground.length > this.#settings.foregroundWindowFrames) this.#foreground.shift();
    }

    /** Enough of the last `foregroundWindowFrames` frames were the person at the phone. */
    heard(): boolean {
        let count = 0;
        for (const f of this.#foreground) if (f) count += 1;
        return count >= this.#settings.foregroundMinFrames;
    }
}
