# Known limits and open product questions

Things that are wrong, or unresolved, and are being carried deliberately rather than forgotten.
Each says who it belongs to. None of them blocks TASK-970.

---

## 1. The notice reaches a wrong number before anyone can say so

A phone menu announces itself in its first sentence, so the agent can withhold the notice from one.
A person who is not the restaurant says "hello" exactly like the right person does — so by the time
they say "you've got the wrong number", the creator's first name, the arrival time and the client
brand have already been read out to a stranger.

The `wrong-number` fixture covers what happens *after* they say so: nothing further about the
booking, and the call ends. It cannot cover the exposure before.

The fix, if it is wanted, is a product decision about beat one: confirm the venue before naming the
booking. That was deliberately removed once — an acceptance read found "I'm calling Golden Crane?"
read as a template filling in a field — so putting it back is a trade, not a correction.
**Owner: Peter. Not ticketed.**

---

## 2. A restaurant that says "stop calling" is called again tomorrow

Measured in the backend on 2026-09-12, and the code and its own comment disagree.

`venueCallRecord.ts` says terminal dispositions "must stop us dialling **this number** again". The
only loader, `priorAttemptsByReservation`, filters `WHERE reservation_id = ANY(...)`. So the
suppression is scoped to **one booking**. A venue that asks us to stop on tonight's booking is
dialled again for tomorrow's, and the sentence the agent speaks — "I've taken you off the call
list" — promises something closer to the venue than to either.

Three different scopes in three places: the code says booking, the comment says number, the
spoken sentence implies venue. **Owner: TASK-971.**

The same gap applies to `wrong_number`, and there the argument is already written in the
codebase: "every further attempt reaches an uninvolved stranger — which is a worse act than a
redundant call, not a lesser one."

---

## 3. Every event the agent logs is recorded as "spoke to staff"

`venueCallEvent` writes `disposition = 'spoke_to_staff'` for everything except an explicit
stop-calling request. So a reported **voicemail** is written down as having reached the venue —
and `VENUE_CALL_REACHED = ['spoke_to_staff']` is what the ledger counts as success.

The backend's own header says why that is the wrong way round: a call that lands in voicemail
performs *worse* than no contact at all, and the ledger is this feature's only detector because
voice has no bounce and no complaint webhook. A `wrong_number` is likewise never written as
`wrong_number`, so it never triggers the terminal-disposition suppression at all.

**Owner: a backend ticket. Filed as part of the 2026-09-12 consolidation.**

---

## 4. One conversation can burn the whole daily cap

`attempt_number` is the literal `1` on every row the agent writes, and a row is written **per
event**, not per call. Eligibility counts rows (`priorAttempts.length + 1`) against a cap of three
per rolling 24 hours.

So a single call in which the agent reports what answered, logs one unanswered question and takes
a callback request writes three rows — and the booking is now capped out, as if we had rung three
times. **Owner: the same backend ticket as §3.**

---

## 5. `comp_terms` is wired to nothing, and that is correct today

`campaigns.optional_details` is NULL on all six campaigns holding bookings, and `selling_points` is
product marketing copy. The backend selects `NULL::text` deliberately, so a venue asking "who's
paying?" gets the honest deferral on every call.

⚠️ Do not reach for `selling_points` because it is the only non-empty prose on the row. A bot
telling a restaurant its comp is "an all-in-one system that saves on labor costs" is exactly the
fabrication this design exists to prevent. **Owner: TASK-972.**

---

## 6. The paused-campaign guard is dead on the deployed backend

It refuses on the strings `'archived'` and `'deleted'`. `campaigns.status` is a Postgres enum that
cannot hold either — they belong to the blog post enum, a different table. So pausing a campaign
does not stop its bookings being phoned, and neither does cancelling or closing one.

The mock in this repo serves the **fixed** behaviour by default, because every remaining ticket is
written against a fixed backend. The live bug is reachable as scenario `campaign-paused-today`, and
that scenario should be deleted the day the fix ships. **Owner: TASK-968.**

---

## 7. Nothing here can see the backend

`contract/seam4.json` is a snapshot. All three copies of the shapes in this repo can agree with
each other perfectly while the backend has moved on. `npm run contract:derive -- <path>` is the
only thing that can tell you, and it is a person's job — CI here has no checkout of that repo and
should not be given credentials to fetch one.

---

## 8. The second transcriber may not be independent

The post-call fabrication check is supposed to compare what the agent said against what it was
allowed to say, using a transcript from something other than the model itself. The pinned
transcriber is Google Cloud Speech-to-Text — same vendor, probably the same project. Whether that
is a genuinely independent witness has not been asked, and its cost per minute against the credit
has not been measured. **Owner: unassigned.**

---

## 9. Two credentials are needed sooner than the docs used to say, and one does not exist

`README.md` and `ONBOARDING.md` both said no account was needed "until the very last ticket".
That was wrong and is corrected. The accurate line:

- Everything in this repository today, and **building** the Gemini Live adapter against the
  harness, needs nothing.
- **Running a real session** — which the first tuning measurement in `docs/TUNING.md` §3.2
  requires — needs `GEMINI_API_KEY`. The org already holds one, so this is a lookup rather than
  a signup, and nobody had written that down either.
- The anti-fabrication check's **independent transcriber** needs `SPEECH_TO_TEXT_CREDENTIALS`.
  That value exists **nowhere** in the org today. No ticket asks for it, and it is a
  prerequisite for the acceptance criterion that a second witness confirms what the agent said.
  See also §8 — whether a same-vendor transcriber counts as independent is separately unsettled.

**Owner: unassigned, and it should not be.** It is the only item on this page that will stop
work rather than merely be wrong.

---

## 10. The Live API is in PREVIEW, on both ends, and nothing guarantees it

Google labels the Live API *Preview* in its own documentation, and `@google/genai` marks the
entire Live surface `@experimental` in the published type declarations — `connect()`,
`sendToolResponse()` and `close()` included. There is no deprecation guarantee on any of it.

Two concrete consequences rather than a general worry:

- **Pin `@google/genai` to `^2.22.0` and below `3.0.0`.** The 3.x line removes
  `LiveConnectConfig.generation_config`. (It also requires Node 22, which is a non-event here.)
- **A breaking change arrives as a broken call, not as a warning.** The eval and `npm run call`
  both run against a fake, so neither would go red. The only detector is a real session, which
  makes the first tuning measurement something to repeat rather than do once.

**Owner: TASK-970**, and it should carry a line saying which SDK version was last exercised.

---

## 11. No carrier can carry the model's own audio quality

Gemini Live always returns **24 kHz** and there is no setting for it. Twilio caps at **8 kHz**
and offers no alternative; Telnyx and Plivo top out at 16 kHz; Vonage's own two pages disagree
about whether 24 kHz exists.

So the 24 kHz → 8 kHz decimation in `src/audio/resample.ts` is **permanent infrastructure**
rather than a stopgap, and a restaurant will never hear this model at the quality it produces.
That is not fixable by us and is only worth knowing so nobody spends a week trying.

One real choice hides in it: on **Telnyx with L16/16 kHz** the G.711 codec leaves the call path
entirely and the model receives 16 kHz instead of 8 — Telnyx's own docs recommend exactly that
for AI voice agents. That is an argument about carriers for **TASK-973**, not a reason to delete
`src/audio/mulaw.ts`, which is mandatory and on the hot path if Twilio wins.

---

## 12. Dependabot alerts are OFF on this repository, and the org is not triaging the ones it has

Measured 2026-09-12 through the API, with a positive control so the reading means something:
`GET /repos/{repo}/vulnerability-alerts` returns **204** when enabled and **404 "Vulnerability
alerts are disabled."** when not.

- **404** on venue-call-agent — and on platform-backend, demo, crm-service, creator, admin and
  creatorain-mcp.
- **204** on creatorainco/social-scheduler and creatorainco/website, both private. That is the
  control: it proves the feature is available on this plan and that 404 means *off*, not
  *unavailable*.

It is free on the Free plan for private repositories and it is one toggle:
Settings → Advanced Security → Dependabot alerts, or `PUT /repos/creatorainco/venue-call-agent/
vulnerability-alerts`.

⚠️ Separately, and larger than this repository: the first page of the org's open alerts (100 of
an unread total) already contains **6 critical and 57 high** across five repositories, and
`automated-security-fixes` is `false` even on the repos where alerting is on. **The true count is
higher and nobody has read it.** That is its own ticket, not this one.

---

## 13. This GitHub org is on the FREE plan, so on a PRIVATE repo nothing can be made required — and this repo is no longer private

🔴 **Rewritten 2026-09-16.** The measurement below was taken while this repository was private and
every line of it was correct then. It is still correct for every *other* repository in this org.
It is no longer correct here, and the reason is the one variable nobody varied: on GitHub's free
plan, protected branches are unavailable on private repositories and **available on public ones**.
This repository was published on 2026-09-16 with a rewritten history, and the same endpoint that
returned 403 the week before now returns a protection object.

Live here, verified by reading it back after writing it:

| branch | pull request required | approving reviews | required check | force-push / delete |
|---|---|---|---|---|
| `main` | yes | 1 | `verify` | refused |
| `dev` | yes | 1 | `verify` | refused |

`enforce_admins` is **false**, so an organisation owner can still merge past all of it. The guard
binds contributors, not owners. Do not read the table as "a red merge is impossible"; read it as
"a red merge is now a deliberate act by someone with admin rights", which is a different and much
smaller failure mode than the one described below.

What has NOT changed: this is a single public repository inside a private estate. The 403s below
are the live state of platform-backend, crm-service, demo, creator, admin and the other 60-odd,
and buying the guarantee for them is still a Team purchase. Publishing a repository to obtain a
security control is not a general strategy — it worked here only because the contents were audited
and scrubbed for exactly that purpose.

### The measurement, as taken 2026-09-12, on private repositories

Measured: `GET /orgs/creatorainco` returns `plan.name: "free"`, 3 filled seats, 66 private repos.

Everything that would make `verify.yml` a *gate* rather than a *signal* is behind a purchase:

| control | status | what it needs |
|---|---|---|
| branch protection | **403** "Upgrade to GitHub Pro" | Team, ~$4/user/month → ~$12/month at 3 seats |
| repository rulesets | **403** same | as above |
| org rulesets | **403** "Upgrade to GitHub Team" | as above |
| required status checks | unreachable — a sub-field of protection | as above |
| CODEOWNERS | inert on private repos on Free | as above |
| secret scanning | **404** "Secret scanning is disabled" | Team **first**, then Secret Protection at $19/active committer/month |

403, not 404 — the endpoints exist and the token has `admin:org`; the block is purely billing.
The same 403 comes back for platform-backend, so it is org-wide and not a quirk of this repo.

**So the accurate sentence, for every private repository in this org, is: nothing mechanically
stops a red pull request being merged, and a human not merging red is the entire enforcement
story.** An earlier version of TASK-967 implied the org was on Team and that secret scanning was
one purchase away. It is two.

The one row above that visibility changes is branch protection. Secret scanning on a public repo
is free too, and is the next thing to turn on here.

⚠️ Do not add a CODEOWNERS file as a review control on this plan. On Free it will not even
auto-request reviewers, and there is no protection to make it required — a file that looks like
a guard and guards nothing is worse than no file.

Three org switches that ARE free and are currently off, all of which bear on a repository about
to hold telephony and model credentials: **two-factor is not required** across a 3-seat org with
66 private repositories; **members can fork private repos** — the cheapest exfiltration path
there is; and **members can create public repos**. All three are operator settings on Peter's
side, so they are surfaced here and not written. **Owner: Peter.**
