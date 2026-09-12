# Your first thirty minutes

You have been handed a feature that is further along than it looks. This page is the shortest
honest path from a fresh laptop to changing something real.

Everything in **Part 1** is already done for you. Read it, run it, and if any command fails, that
is a bug in the setup and not in you — say so rather than working around it.

---

## Part 1 — prove the environment (5 minutes)

```bash
git clone git@github.com:creatorainco/venue-call-agent.git
cd venue-call-agent
nvm use          # 22.18.0; any Node >= 22.18 works
npm ci
npm run verify
```

Expected, and worth reading rather than skimming:

```
no-facts: N file(s) scanned; control tripped 4 rule(s) (...)
no-facts: EXEMPT src/agent/scriptedStub.ts from [comp] — ...
no-facts: EXEMPT src/eval/fabrication.ts from [comp, money, policy] — ...
no-facts: clean.
# tests 118
# pass 118
```

Then the conversations:

```bash
npm run eval
# 14/14 conversations clean · 0 hard failure(s) · 0 soft failure(s)
```

**You now have a complete test environment for a telephone feature, on a laptop, with no phone, no
Google account and no database.** That is the point of the last day's work. Nothing below needs an
account either, until the very last ticket.

---

## Part 2 — see it work (10 minutes)

Watch one call, turn by turn:

```bash
npm run eval -- --only=who-pays --verbose
```

Then poke the backend stand-in by hand:

```bash
npm run mock          # leaves a server on http://127.0.0.1:8788 — read what it prints
```

In another terminal:

```bash
curl -s -XPOST http://127.0.0.1:8788/reservations/call-context \
  -H "Authorization: Bearer mock:happy" | python -m json.tool

curl -s -XPOST http://127.0.0.1:8788/reservations/call-fact \
  -H "Authorization: Bearer mock:happy" -H "Content-Type: application/json" \
  -d '{"topic":"comp_terms"}'

# the same booking, with the campaign paused
curl -s -XPOST http://127.0.0.1:8788/reservations/call-context \
  -H "Authorization: Bearer mock:campaign-paused"

curl -s http://127.0.0.1:8788/__mock/journal | python -m json.tool
```

Read `src/mock/fixtures/scenarios.json` for the full list of 18 scenarios and what each one is for.

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

### 1. Research what the repo still needs from GitHub and Google Cloud

Findings so far are in TASK-967 and they are uncomfortable: this GitHub org is on a plan where
branch protection, rulesets and required status checks all return **403 on private repos**, so CI is
the only gate that will ever exist here and nothing mechanically stops a red merge. Two controls
that *are* available and simply are not switched on: Dependabot alerts (free, one toggle) and
secret scanning (a paid SKU on Team). Confirm both against the live pricing and API before anyone
spends money — the docs and the API's own error strings disagree with each other, and one of them
is stale.

Then the deploy identity. Nothing in this estate uses Workload Identity Federation today; every
deploy authenticates with a long-lived key in a repo secret. For a Cloud Run deploy from Actions,
work out exactly what must be created on each side, and write it down as a runnable checklist.
**Do not create anything in Google Cloud** — that needs a signed-in console and is not yours.

### 2. Tune the agent

Start at `src/tuning/liveDefaults.ts`. Every value there is a value somebody chose with a reason,
and **none of them has been measured on a real call**. `docs/TUNING.md` §3 is the protocol.

The first task is a measurement, not a change: time to first audio, on the pinned model and on the
one it is pinned *away* from. There is a forum report that the newer model regressed from ~2 s to
9–15 s, from two strangers with no reply from Google. On a telephone that is the call over, so it
matters — and it is not our measurement yet.

### 3. Test the agent

The harness, the rubric, the fabrication check and 14 conversations already exist and pass against
the reference stub. Your job is to make the **real** agent pass the same ones, then add the
branches the stub cannot reach.

The rule for anything new: **it must be able to fail.** See CONTRIBUTING.md.

---

## What you should NOT do

- **Do not place a call.** Not to a restaurant, not to a colleague, not to your own mobile. That is
  TASK-973 and it needs Peter's yes on the day. "It is our own handset" was tried as an argument
  and overturned.
- **Do not set an environment variable on a deployed service.** That is a configuration change and
  it belongs to the operator.
- **Do not hardcode a sentence** the restaurant might hear. If there is nowhere to fetch it from,
  the missing endpoint is the bug — say so and it gets added over there.
- **Do not delete `src/agent/scriptedStub.ts`** when the real agent works. It is the baseline; if a
  language model scores below a keyword matcher, that is the single most useful thing you could
  find out, and you can only find it out by keeping both.

---

## When you are stuck

- The whole feature's state, including what is merged and what is only merged-not-deployed, is on
  **TASK-967**. It is written to be read cold.
- What the backend actually returns: `contract/seam4.json`, and `npm run contract:derive -- <path>`
  to check it is still true.
- Something in this repo contradicts something in a ticket: the repo is not automatically right.
  Both have been wrong this week. Check `origin`, and say which one you checked.
