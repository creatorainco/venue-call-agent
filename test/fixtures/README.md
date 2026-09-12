# Recorded conversations

`conversations/*.json` — one file per branch of the call. `npm run eval` runs them all;
`npm run harness -- --fixture=<name>` runs one and prints the transcript.

**No real recording of a real restaurant goes in this folder.** Every venue, creator and brand in
the fixtures is invented. This feature stores transcripts only — never audio — by decision, and a
fixture is checked into a repository while a real booking is somebody's dinner.

## The format

```jsonc
{
  "name": "who-pays",
  "scenario": "happy",          // which mock backend scenario backs the call
  "answerer": "human",          // human | phone_menu | voicemail | automated_system | wrong_number
  "about": "one line saying what this conversation is testing",
  "turns": ["what they say first", "and then this"],
  "latencyMs": 250,             // optional: simulate a slow seam
  "expect": {
    "must_call":       [{ "route": "/call-fact", "body_contains": { "topic": "comp_terms" } }],
    "must_not_call":   [{ "route": "/call-fact" }],
    "must_say_contains":      ["don't want to guess"],
    "must_not_say_matching":  ["\\$", "\\bfree\\b"],
    "must_end_call": true,
    "must_not_speak_at_all": false,   // for the refusal fixtures
    "max_sentences": 9,               // soft
    "max_glue": 2                     // soft
  }
}
```

`scenario` names an entry in `src/mock/fixtures/scenarios.json`. That file is where the canned
backend responses live; this one only says what the venue says and what must be true afterwards.

## Two things the format deliberately does not let you do

**You cannot assert on a sentence the backend did not send.** The list of allowed sentences is
built from the mock's own request journal, not from anything in this folder. A yardstick a person
can edit to make a failing call pass is not a yardstick.

**You cannot assert that a tool was called by trusting the agent.** `must_call` is checked against
the journal — what actually arrived at the backend — not against what the agent said it did. An
agent that believes it logged a question and did not is precisely the failure that ends with a
promise nobody is queued to keep.

## Adding one

1. Write the `.json`. Start from the closest existing file.
2. `npm run harness -- --fixture=<name>` and read the transcript.
3. `npm run eval` — it must be clean.
4. **Then break it**: make the agent fail your new expectation on purpose, confirm the eval catches
   it, restore, confirm it passes. Paste both. See `CONTRIBUTING.md`.

Six deliberately broken agents already live in `test/harness.test.ts`; if your new check is a hard
one, add a seventh there rather than trusting it.
