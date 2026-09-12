# The test environment, in four tiers

"Set up a test environment" is a phrase until somebody says what is being tested and what a green
run would prove. There are four tiers here.

**Two are built and need nothing at all. The third is built-and-waiting on one variable the org
already holds. The fourth needs a decision that is not an engineer's to make.** An earlier
version of this line said "three of them are built and need nothing", which its own table
contradicted two rows later — tier 2 needs `GEMINI_API_KEY`, and a lookup is not nothing.

Read this before asking for an account. Most of what looks like it needs one does not.

| tier | what it proves | what it needs | state |
|---|---|---|---|
| **0 — the laptop** | the decision layer, the contract, every refusal, the codec | nothing | ✅ built |
| **1 — the laptop, as a telephone** | turn-taking, dead air, barge-in, the wire | nothing | ✅ built |
| **2 — a real model** | that the adapter works, and what it costs in seconds | `GEMINI_API_KEY` | ⏳ a lookup |
| **3 — a real call** | everything that is actually a telephone | a carrier, and Peter's yes | 🔴 blocked, and correctly |

---

## Tier 0 — the laptop

```bash
npm run doctor      # what YOUR machine can do, by doing it. Run this first.
npm ci
npm run verify      # the guard, the doctor's control, the typechecker, the whole suite
npm run eval        # every recorded conversation, graded as a transcript
```

**What it proves.** Every refusal the backend can return and what the agent does with each. That
the agent never speaks before the disclosure. That it logs a question before promising to come
back on it. That it cannot invent a fact, checked against the sentences the backend actually
returned on that call — read off the mock's journal, not off the fixture, so a person cannot edit
a failing call into a passing one. That the μ-law codec matches the standard's own vectors.

**What it does not prove.** Anything with a clock or a loudspeaker in it. See tier 1.

**Where the pieces are.** `src/mock/` is the backend stand-in: eighteen scenarios, all eleven
refusals, its own journal at `/__mock/journal`. `npm run mock` leaves it running on :8788 for
curl. `npm run mint-token -- --all` produces a valid, an expired and two wrong-scope tokens — it
needs a signing literal, which is a string you invent rather than a credential anybody issues.

**Tier 0½ — the same laptop, pointed at a REAL platform-backend.** Not a tier of its own because
nothing about the agent changes; it is tier 0 with `CREATORAIN_API_BASE_URL` moved and
`VENUE_CALL_SECRET` set to the same literal the backend has. `npm run doctor` prints this as the
`real-backend` class, and this page previously had no row for it, so the doctor sent readers here
for a tier that did not exist. What it buys: proof that `contract/seam4.json` still matches
reality. What it costs: the seam is dark on the deployed backend today — every route refuses
`seam_disabled` — so in practice this means a backend running on your own laptop.

---

## Tier 1 — the laptop, as a telephone

```bash
npm run call                                        # every conversation, as a call
npm run call -- --only=they-interrupt --verbose     # one of them, turn by turn
npm run call -- --sweep=200,400,600,800,1000,1200   # the tuning sweep
npm run call -- --latency=900                       # with a model that takes 900ms
```

🔴 **`--latency=900` EXITS 1 TODAY, AND THAT IS THE INSTRUMENT WORKING.** One of the fifteen
calls — `phone-menu` — reaches 8,680 ms of dead air once the model is assumed to take 900 ms,
and the hard budget is 4,000. Nothing is broken: the command is telling you that at that latency
this feature has a call in it a person would think had dropped. Do not "fix" it by widening the
budget; the budget is the requirement. Expected output, so nobody mistakes it for a setup fault:

```
  phone-menu   2/2   1720ms / 8680ms   0f   HARD: dead_air_within_hard_budget
  1 hard failure(s) · 5 soft failure(s)
```


A real telephone call in every respect except the telephone. G.711 μ-law frames, 20 ms at a time,
through the same codec tier 0 proves. A far end that waits for you to answer before it speaks
again, and interrupts you if the fixture says so. A **virtual clock** — one frame is one tick of
call time regardless of how long it took to compute — so six minutes of call finish in about a
second and the result is identical on every machine.

**What it proves that tier 0 cannot.** How long the restaurant waits between finishing a sentence
and hearing a reply, measured off the wire. Whether we stop talking when somebody interrupts, and
how much we lose when we do. That no frame is the wrong length, that silence is 0xFF rather than
0x00, and that nothing generates audio after the line has closed.

**What it still does not prove**, and this list is short and load-bearing:

- **It is not Google's turn detector.** `src/carrier/vad.ts` has the same four parameter names and
  the same units as the Live API's, and a different algorithm — theirs is unpublished and runs on
  their side. A sweep tells you how a setting behaves against a known pause structure. It does not
  predict theirs.
- **There is no speech recognition.** The far end's audio envelope is real; its words are injected
  once a turn ends. Turn-taking and transport are measured; recognition is not.
- **The audio is a tone.** Nothing here says anything about how a voice sounds.

`docs/WHAT-CANNOT-BE-TESTED.md` carries the full list.

---

## Tier 2 — a real model

**This needs one environment variable and no new account.** `GEMINI_API_KEY` already exists in the
org, under exactly that name, in the context hub's `.env`. It is a lookup, not a signup, and
nobody had written that down until 2026-09-12.

```bash
GEMINI_API_KEY=... npm run call -- --agent=live      # once TASK-970 lands one
```

**What it proves.** That the adapter opens a session, that audio survives the round trip, that
function calls route, and what the model's first-byte latency really is. That last one is the
first tuning measurement in `docs/TUNING.md` §3.2 and it is the number the whole feature's
tolerability turns on.

**Do the arithmetic before you measure.** What the restaurant waits is:

```
silenceDurationMs  +  the model's first-byte latency  +  the seam round trip
```

The detector's 800 ms is spent before the model has been asked anything. `--latency=` lets you
put a figure in and see the sum today, with no key at all.

⚠️ **The second credential in `.env.example` is a different story.**
`SPEECH_TO_TEXT_CREDENTIALS`, for the fabrication check's independent transcript, **exists nowhere
in this org** and no ticket asks anyone to provision it. See `docs/LIMITS.md` §9. That is the only
missing thing on this page that will stop work rather than merely be wrong.

---

## Tier 3 — a real call

**Blocked, and it should be.** Two things are missing and neither is a build task.

**A carrier.** Nothing in this repository dials, and the frame shape it assumes — G.711 μ-law,
8 kHz, 20 ms — is marked as an assumption in `src/audio/format.ts` rather than a decision.
`CallLeg` in `src/carrier/leg.ts` exists so that picking one is a small adapter rather than a
rewrite: it knows four things, and three of the four are true of a telephone rather than of a
vendor. The fourth — that a frame is μ-law — holds for Twilio, Telnyx's default and Plivo, and
breaks on Vonage, which sends raw binary linear PCM and offers no μ-law at all. That leak is
written at the interface with its fix, rather than left for whoever picks Vonage to discover.

What is worth knowing before that conversation, because it changes its shape:

- **The org already holds Twilio credentials** — `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
  `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, and a `TWILIO_TEST_ACCOUNT_SID`. So "we have no
  carrier" is not the situation.
- **Twilio is banned — for MESSAGING.** The product ledger's words are "Twilio banned for
  messaging — Claw Messenger rail only" (Peter, 2026-07-07). Voice is not mentioned. This lane
  would be the org's first Twilio **voice** use, and whether the messaging ban reaches it has
  never been asked. It is a one-line question with a yes/no answer, and asking it is cheaper than
  evaluating a second vendor.

**Peter's explicit yes, on the day, for that call.** This is not a formality and it has already
been tested once: an earlier plan exempted a call to a handset we own, on the grounds that it was
ours. That was overturned — whose phone rings changes who is inconvenienced, not which switch was
flipped. Owner: **TASK-973**.

---

## What "hosted" means here, and what it would buy

A hosted service is **not** on the path to tiers 0, 1 or 2. All three run on a laptop, and tier 2
reaches Gemini by dialling out, which needs no inbound address.

Hosting buys exactly one thing: **a public address a carrier can connect to.** That is tier 3 and
nothing else. So the honest ordering is: settle the carrier question, then host; hosting first
produces an endpoint with nothing to connect to it.

The deployment target is Google Cloud Run, and two facts about it are still unread — whether the
API is enabled in the project that bills our AI usage, and what our concurrency ceiling actually
is. Both need one signed-in console read. They are on **TASK-967** as the approval-gated item, and
`docs/DEPLOY.md` carries the runnable checklist and the deploy definition itself.

**Do not create anything in Google Cloud.** That needs a signed-in console and it is not an
engineer's to do here.
