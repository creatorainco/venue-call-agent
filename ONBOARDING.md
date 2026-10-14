# Your first thirty minutes

You have been handed a feature that is further along than it looks. This page is the shortest
honest path from a fresh laptop to changing something real.

Everything in **Part 1** is already done for you. Read it, run it, and if any command fails, that
is a bug in the setup and not in you — open an issue on this repository rather than working
around it. One failure is deliberate: from **2026-11-17** `npm run verify` fails until the pinned
Gemini model moves (Part 4, item 2).

---

## Part 1 — prove the environment (5 minutes)

```bash
# The repository is PUBLIC. Cloning it needs no account, no token and no invitation.
git clone https://github.com/creatorainco/venue-call-agent.git

cd venue-call-agent
nvm install      # reads .nvmrc and fetches the newest Node 22; `nvm use` alone may pick an older 22
nvm use          # Node 22.18 or newer (22 or 24 LTS) works
npm run doctor   # BEFORE npm ci. It works with nothing installed, on purpose.
npm ci
npm run verify
```

No `nvm`? Install it from https://github.com/nvm-sh/nvm, or use any Node 22.18 or newer; the
doctor checks the version either way.

`npm run doctor` is the answer to "what do I need?", and it is a reading of your machine rather
than a claim in a document. It boots the mock backend and asks it a real question, imports a real
`.ts` file to prove type-stripping works, and lists every credential by NAME with what it unlocks
and where it comes from. A missing credential is not a failure there — almost all of them are
absent and that is the expected state.

Expected, and worth reading rather than skimming:

```
no-facts: N file(s) scanned; control tripped 4 rule(s) (...)
no-facts: venue names: the control only (...)
no-facts: EXEMPT src/agent/scriptedStub.ts from [comp] — ...
no-facts: EXEMPT src/eval/fabrication.ts from [comp, money, policy] — ...
no-facts: clean.
doctor: control tripped as designed — ...
...
ℹ fail 0
```

⚠️ **The `fail 0` line is the one to read (`ℹ fail 0` in a terminal, `# fail 0` in CI's log),
and this page deliberately does not print a test count.**
A count in a document is false by the next contribution — that has already happened here twice —
so `test/docs.test.ts` now fails the build if one reappears.

Then the conversations, twice — once as transcripts, once as telephone calls:

```bash
npm run eval
# 15/15 conversations clean · 0 hard failure(s) · 0 soft failure(s)

npm run call
#   across 15 call(s), ...
# 0 hard failure(s) · N soft failure(s)
```

The line to read in both is `0 hard failure(s)`. A soft failure is a judgement, not a defect, and
its count on this default run is whatever the command prints today — this page does not copy it,
for the same reason it does not copy the test count. (The one block that does carry counts, the
`--latency=900` output in Part 4, is recomputed and compared by `test/docs.test.ts` on every run.)

The second one is a real telephone call in every respect except the telephone: G.711 μ-law frames,
20 ms at a time, a far end that waits for you to answer before it speaks again, and a clock that
is virtual so six minutes of call finish in about a second. It grades what a transcript cannot
show — how long the restaurant waits, whether you talk over an interruption, whether you keep
generating audio after the line closes.

**You now have a complete test environment for a telephone feature, on a laptop, with no phone, no
Google account, no GitHub account and no database.** That is the point of this repository, and
`docs/TEST-ENVIRONMENT.md` says exactly where it stops.

⚠️ **Two credentials are needed before the end of the work, and an earlier version of this page
said otherwise.** Everything in Parts 1–3, and building the adapter itself, needs nothing.
*Opening a real Gemini session* — which the first tuning measurement in Part 4 item 2 requires —
needs `GEMINI_API_KEY`; open an issue on this repository and a CreatoRain engineer mints one for
you. `SPEECH_TO_TEXT_CREDENTIALS`, for the independent transcriber, has **not** been provisioned
yet and somebody has to do it. Open that issue early rather than on the day you need it.

---

## Part 2 — see it work (10 minutes)

Watch one call, turn by turn:

```bash
npm run harness -- --fixture=who-pays
```

The `--fixture=` is required: a bare `npm run harness -- who-pays` ignores the name and plays the
`plain` call. To see how that call was graded, check by check, run
`npm run eval -- --only=who-pays --verbose` (`--only` matches every fixture whose name contains
the text, so that one grades two calls).

Then poke the backend stand-in by hand:

```bash
npm run mock          # leaves a server on http://127.0.0.1:8788 — read what it prints
```

In another terminal:

```bash
curl -s -XPOST http://127.0.0.1:8788/reservations/call-context \
  -H "Authorization: Bearer mock:happy"

curl -s -XPOST http://127.0.0.1:8788/reservations/call-fact \
  -H "Authorization: Bearer mock:happy" -H "Content-Type: application/json" \
  -d '{"topic":"comp_terms"}'

# the same booking, with the campaign closed: refused before a word is spoken.
# (A PAUSED campaign is still called — try mock:campaign-paused and compare.)
curl -s -XPOST http://127.0.0.1:8788/reservations/call-context \
  -H "Authorization: Bearer mock:campaign-closed"

curl -s http://127.0.0.1:8788/__mock/journal
```

And produce the credentials the real backend would want, with no backend:

```bash
VENUE_CALL_SECRET=local-dev-not-a-secret npm run mint-token -- --all
```

```powershell
$env:VENUE_CALL_SECRET='local-dev-not-a-secret'; npm run mint-token -- --all
```

That prints four tokens: a valid one, an expired one, one for the wrong booking and one for the
wrong attempt. The last two verify perfectly and the backend **honours** both — it answers about
the other booking, or writes the other attempt's ledger row. Keeping each call on its own token
is the dialler's job, which is the property worth understanding before you write anything that
holds one.

Read `src/mock/fixtures/scenarios.json` for the full list of scenarios and what each one is for.

---

## Part 3 — the four things worth reading, in this order (15 minutes)

1. **`src/seam/types.ts`** — the whole contract with the backend, and the one sentence that makes
   this feature safe: every word a restaurant hears is a finished string from over there.
2. **`src/agent/contract.ts`** — the interface you are going to implement. Text in, tool calls and
   text out. No audio in the interface, on purpose.
3. **`src/agent/scriptedStub.ts`** — a working agent with no model in it. This is your
   specification: whatever you build must do everything this does.
4. **`docs/WHAT-CANNOT-BE-TESTED.md`** — the honest list of what a green build does not prove.

Skim `docs/TUNING.md` when you get to the model; do not read it yet.

---

## Part 4 — your actual job

Three things, in this order. Nothing else on this repository is open work.

Items 2 and 3 both need the one missing component, and building it is yours: the Gemini Live
adapter, a class implementing `SpeechBridge` in `src/carrier/bridge.ts` (README, "Not here yet").
Build it against the harness first; it needs a key only once it opens a real session.

### 1. Research what the repo still needs from Google Cloud

This repository's own merge rules are settled: `main` and `dev` both require a pull request, one
approving review and a green `verify` (`docs/LIMITS.md` §12).

What is open is the deploy identity. Nothing deploys this service yet. For a Cloud Run deploy from
Actions, work out exactly what must be created on each side — `docs/DEPLOY.md` §5 is the start —
and write it down as a runnable checklist. **Do not create anything in Google Cloud** — that needs
a signed-in console and is not yours.

### 2. Tune the agent

Start at `src/tuning/liveDefaults.ts`. Every value there is a value somebody chose with a reason,
and **none of them has been measured on a real call**. `docs/TUNING.md` §3 is the protocol.

One part of it no longer needs anybody's account. The turn-detector sweep is a command:

```bash
npm run call -- --sweep=200,400,600,800,1000,1200
npm run call -- --latency=900     # and what the model's own delay adds on top
```

🔴 **`--latency=900` EXITS 1 TODAY, AND THAT IS THE INSTRUMENT WORKING.** One of the fifteen
calls — `phone-menu` — reaches 8,680 ms of dead air once the model is assumed to take 900 ms,
and the hard budget is 4,000. Nothing is broken: the command is telling you that at that latency
this feature has a call in it a person would think had dropped. Do not "fix" it by widening the
budget; the budget is the requirement. Expected output, so nobody mistakes it for a setup fault:

```
  phone-menu                  2/2     1720ms / 8680ms    0f         HARD: dead_air_within_hard_budget
1 hard failure(s) · 5 soft failure(s)
```


Do that first — it costs a second and it tells you what "acceptable" has to mean before you
measure the model. Read the top of `src/carrier/vad.ts` before quoting a number from it: the
detector it sweeps is ours, not Google's.

The first task is a measurement, not a change, and it has a deadline: Google has scheduled the
pinned model, and the one it is pinned *away* from, for shutdown on **2026-11-17**, with
`gemini-3.8-live` named as the replacement. So measure time to first audio on the pinned model and
on the replacement; re-pinning is what that measurement decides. `docs/TUNING.md` §3.2 has the
sources, and `test/liveDefaults.test.ts` fails the build on that date if the pin has not moved.

### 3. Test the agent

The harness, the rubric, the fabrication check and every recorded conversation already exist and
pass against the reference stub. Your job is to make the **real** agent pass the same ones, then add the
branches the stub cannot reach.

The rule for anything new: **it must be able to fail.** See CONTRIBUTING.md.

---

## How your work gets back here

You do not push to this repository and you are not expected to ask for access to it. Read
**[CONTRIBUTING.md](CONTRIBUTING.md) § Branches and pull requests** once; the short version is:

1. Fork it to your own account and clone the fork, with this repo as `upstream` —
   CONTRIBUTING.md shows the `gh` path and the web path.
2. Branch off `dev`, and open your pull request **against `dev`** — never `main`.
3. `dev` requires a green `verify` and one approving review, so nothing you open can merge itself
   and nothing red can merge at all. The first time CI runs on a pull request from a new
   contributor, GitHub waits for one of us to approve the run. That is normal; comment on the pull
   request if it sits there longer than a working day.

**Open a pull request early, and keep something moving on `dev` every week.** It does not have to
be finished and it does not have to be big. A pull request that says "this is what I measured, here is what it means, here is
what I am doing next" is a perfectly good week. Silence is the only bad outcome, because it is the
one thing nobody can help with.

---

## What you should NOT do

- **Do not place a call.** Not to a restaurant, not to a colleague, not to your own mobile. That is
  the carrier and first-dial work, and it needs the repository owner's yes on the day. A number
  we own is no exception: whose phone rings changes who is inconvenienced, not which switch was
  flipped.
- **Do not set an environment variable on a deployed service.** That is a configuration change and
  it belongs to the operator.
- **Do not hardcode a sentence** the restaurant might hear. If there is nowhere to fetch it from,
  the missing endpoint is the bug — open an issue and it gets added over there.
- **Do not delete `src/agent/scriptedStub.ts`** when the real agent works. It is the baseline; if a
  language model scores below a keyword matcher, that is the single most useful thing you could
  find out, and you can only find it out by keeping both.

---

## When you are stuck

- What is still wrong or open, and who owns it: `docs/LIMITS.md`. What a green build does not
  prove: `docs/WHAT-CANNOT-BE-TESTED.md`.
- What the backend actually returns: `contract/seam4.json`, and `npm run contract:derive -- <path>`
  to check it is still true.
- Something in this repo contradicts the task description you were given: the repo is not
  automatically right, and either can be wrong. Check `origin`, and say which one you checked.
