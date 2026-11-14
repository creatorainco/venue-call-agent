/**
 * The keyword cues: what a restaurant said, recognised by pattern rather than understood.
 *
 * Shared by the scripted stub (which is nothing but these) and the cascade's keyword fast path
 * (which tries these before it pays for a model call). One list, so the cascade's offline
 * behaviour and the stub's baseline cannot drift apart without a test noticing.
 *
 * NO-FACTS-EXEMPT[comp]: the topic cues must hold the words a manager uses to ask about money.
 * They RECOGNISE a question and are never spoken - every sentence an agent says comes from the seam.
 */

import type { FactTopic } from '../seam/types.ts';

/**
 * Question → topic. Crude, and crude is the point: it must be obvious that the mapping is doing
 * the work rather than any understanding, so nobody mistakes a green eval for a working agent.
 */
export const TOPIC_CUES: Array<[RegExp, FactTopic]> = [
    [/\b(who'?s paying|who pays|paying for|comp|free|on the house|the bill|cover the)\b/i, 'comp_terms'],
    [/\b(how many|party size|covers|people|guests)\b/i, 'party_size'],
    [/\b(what time|when are they|when do they|arriv)\b/i, 'arrival_time'],
    [/\b(who'?s (?:the|it) (?:booking|reservation)|whose name|under what name|which name)\b/i, 'creator_name'],
    [/\b(who are you|what company|what is creatorain|who is this)\b/i, 'who_we_are'],
    [/\b(what will they do|filming|photos|video|content|post)\b/i, 'what_the_creator_will_do'],
    [/\b(still on|still coming|still happening|cancelled|is it confirmed)\b/i, 'still_active'],
    [/\b(email|contact|reach you|get hold of)\b/i, 'contact_email'],
];

export const MACHINE_CUES = [
    /\bpress \d\b/i,
    /\bmain menu\b/i,
    /\bfor (?:hours|directions|reservations), press\b/i,
    /\bleave a message\b/i,
    /\bafter the (?:tone|beep)\b/i,
    /\bnot available (?:right now|at the moment)\b/i,
    /\bthis is an automated\b/i,
];

export const VOICEMAIL_CUES = [/\bleave a message\b/i, /\bafter the (?:tone|beep)\b/i];

export const STOP_CUES = [
    /\b(stop calling|don'?t call|do not call|take us off|remove us|no more calls)\b/i,
];

export const CHANGE_CUES = [
    /\b(cancel|move|reschedul\w+|change the (?:time|booking|reservation)|different time)\b/i,
];

/**
 * They are finished.
 *
 * Ordered AFTER the topic match on purpose: "thanks, but who's paying?" is a question, not a
 * goodbye, and treating a polite question as a close is how a call ends with the thing they
 * actually rang about unanswered.
 */
export const DONE_CUES = [
    /\b(that'?s (?:all|it|fine|great|grand)|no,? (?:thanks|that'?s all)|nope|we'?re good|all good)\b/i,
    /\b(thanks|thank you|cheers|got it|understood|noted|will do|sounds good|appreciate it|perfect|lovely)\b/i,
];

export const WRONG_NUMBER_CUES = [/\b(wrong number|no such (?:place|restaurant)|you'?ve got the wrong)\b/i];
