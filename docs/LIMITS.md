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
