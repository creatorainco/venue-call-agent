# venue-call-agent

The voice that telephones a restaurant before a creator's booking.

**Nothing here dials anybody.** There is no phone-carrier code in this repository and adding it is a
separate, approval-gated piece of work (TASK-973). Until then this service's only clients are the
local mock backend and the replay harness, both in this repo.

Ticket: **TASK-970**. Parent epic with the full picture: **TASK-967**.
New here? Read **[ONBOARDING.md](ONBOARDING.md)** — it is the thirty-minute version.

---

## Start here — three minutes, no accounts

```bash
nvm use             # or any Node >= 22.18; type stripping is unflagged from there
npm ci
npm run verify      # the guard, the typechecker and 118 tests
npm run eval        # 14 recorded conversations, scored
```

Both should be green on a fresh clone. **You need no Google account, no phone carrier and no AWS
access** for any of it, and none of the remaining work on TASK-970 needs one either until the very
last step.

If something asks you for a credential before TASK-973, that is a defect. Say so.

---

## The one rule that shapes this whole service

**This service never composes a fact.**

Every sentence a restaurant hears arrives from the CreatoRain backend as a finished string. The model
chooses *which* fact to fetch; it never writes the wording of one. That is the only reason an
after-the-call check for invented claims is possible at all — a checker can compare speech against a
finite set of known strings, but it cannot compare speech against a number the model was free to
phrase itself.

In practice: **no price, no policy, no venue name, no offer terms and no copy deck in this
repository.** `npm run check:no-facts` fails the build on any of them. If you ever feel you need to
hardcode a sentence here, a backend endpoint is missing — add the endpoint instead.

Two files are exempt and say so in their own headers (`NO-FACTS-EXEMPT[...]`), because their job is
to *detect* that language rather than speak it. The guard prints every exemption on every run and
refuses if there are more than four.

---

## Layout

```
contract/seam4.json     the backend's shapes, snapshotted, with the commit they came from
src/
  config.ts             three classes of setting; the local path needs none of them
  state.ts              the call state machine. No path reaches audio before the disclosure.
  seam/                 types + client for the three backend routes. The only way a fact enters.
  mock/                 a local stand-in for those three routes. 18 scenarios, every refusal.
  agent/
    contract.ts         the interface a real agent implements: text in, tool calls + text out
    scriptedStub.ts     a reference agent with NO MODEL. The baseline and the executable spec.
  audio/                μ-law, resampling, formats. The carrier side, provable with no carrier.
  tuning/liveDefaults.ts every Gemini Live knob, with the reason for each value
  harness/replay.ts     runs one recorded conversation end to end
  eval/                 the rubric, the fabrication check, and `npm run eval`
scripts/
  check-no-facts.mjs    the build guard, with a positive control it runs every time
  derive-contract.mjs   re-reads the backend and diffs it against contract/seam4.json
  mint-token.mjs        produce a valid / expired / wrong-booking token locally
test/fixtures/conversations/   14 recorded conversations
docs/                   TUNING.md · LIMITS.md · WHAT-CANNOT-BE-TESTED.md
```

**Not here yet, and that is TASK-970:** the Gemini Live adapter — the thing that opens a session,
turns audio into `hear()` calls and turns the returned turns back into audio. Everything on this
side of that interface is built and tested.

---

## What each command does

| command | what it proves | needs |
|---|---|---|
| `npm test` | 118 unit tests: the state machine, the seam client, every refusal, the codec, the config, the token, the rubric's own sabotage controls | nothing |
| `npm run eval` | 14 whole conversations scored against the rubric | nothing |
| `npm run mock` | a local Seam 4 on :8788 you can curl | nothing |
| `npm run mint-token -- --all` | a valid, an expired and two wrong-scope tokens | nothing |
| `npm run check:no-facts` | no product fact is hardcoded here | nothing |
| `npm run contract:derive -- ../platform-backend` | the snapshot still matches the real backend | a platform-backend checkout |
| `npm run typecheck` | types, and that no syntax Node cannot erase has crept in | nothing |

---

## The conversations that must work

`test/fixtures/conversations/`. One file per branch; `npm run eval` runs them all.

| fixture | the manager… | what must happen |
|---|---|---|
| `plain` | says "noted, thanks" | notice delivered, short close |
| `who-pays` | asks who is paying | today's honest deferral — **no meal, no bill, no money** |
| `who-pays-after-task-972` | asks the same, once a comp clause exists | the authored clause, quoted unedited |
| `unknown-question` | asks something no tool answers | logged **first**, then the deferral |
| `stop-calling` | says stop calling us | do-not-call written before the reply, call ends |
| `phone-menu` | is a menu | notice withheld, two tries for a person, then voicemail |
| `voicemail` | is a machine | one pass of the voicemail line, nothing asked back |
| `wrong-number` | is not the restaurant | nothing further about the booking, call ends |
| `wants-to-cancel` | wants the booking moved | a callback logged; the agent never implies it can |
| `booking-cancelled`, `campaign-paused` | — | refused **before a word is spoken** |
| `credential-expires` | — | the seam refuses mid-call; the agent ends |
| `they-hang-up` | hangs up mid-notice | partial transcript, no crash, no retry |
| `two-questions-then-close` | asks two things | both answered, then the close |

Assert on the **transcript**, never the audio.

---

## Testing discipline — a sabotage control is required

A green test proves nothing until you have watched it go red. See
[CONTRIBUTING.md](CONTRIBUTING.md); it is one paragraph and it is not optional.

This is not ceremony. Building this repository, the controls caught four real defects in the same
day: a μ-law segment table with the wrong run lengths, a contract check that could not read a
one-line interface, a rubric check that could only detect a promise that had already been logged,
and a `.gitignore` line that hid the environment template from every clone.

---

## Talking to a real backend

The routes are merged on `platform-backend`'s `dev` branch. Against the local mock you need none of
this; against a real backend:

- run platform-backend locally (it listens on **4400**, `API_PORT`), set `VENUE_CALL_SECRET` **in
  your own shell** to any throwaway string, and set the same value here,
- `npm run mint-token` produces the credential,
- 🔴 setting an environment variable on a *deployed* service is a configuration change and is
  Peter's call. Ask; do not do it.

The credential is scoped to **one booking and one attempt** and expires in twenty minutes. Test an
expired one and one minted for a different booking — both must be refused.

---

## Deployment

Google Cloud Run, eventually. **Not part of TASK-970.** When it happens: raise the request timeout
off its 5-minute default, allow high concurrency, turn session affinity on. Two things are still
unknown and are on the epic — whether Cloud Run is enabled in the project that bills our AI usage,
and our real concurrency ceiling. Neither blocks any local work.

---

## Absolute limits

- **Never place a real call** to any number, including one we own, without Peter's explicit yes for
  that act on that day. An earlier plan exempted a self-call because the handset was ours. That was
  overturned: whose phone rings changes who is inconvenienced, not which switch was flipped.
- **Transcripts only, never recorded audio.**
- **No route may write to a booking.** A stranger on a telephone cannot move, cancel or confirm a
  reservation. The single permitted write is the do-not-call record.
- **The first outbound audio is gated on the disclosure being spoken**, and the state machine has no
  path that reaches the notice without it.

What a green build does *not* cover is written down in
[docs/WHAT-CANNOT-BE-TESTED.md](docs/WHAT-CANNOT-BE-TESTED.md). Read it before the first real call.
