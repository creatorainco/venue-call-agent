# Known limits and open product questions

Things that are wrong, or unresolved, and are being carried deliberately rather than forgotten.
Each says who it belongs to. None of them blocks the Gemini Live adapter.

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
**Owner: the repository owner.**

---

## 2. A wrong number is suppressed for one booking, not for the number

A venue that asks us to stop calling is now stopped as a **venue**: any booking at the same
restaurant that asked to stop makes every other booking there refuse `venue_stopped` (scenario
`venue-stopped-by-another-booking`). That matches the sentence the agent speaks.

`wrong_number` is still scoped to the **one booking** it was recorded on. A number that reached a
stranger tonight is dialled again for tomorrow's booking at the same venue, and there the argument
against it is already written in the backend: "every further attempt reaches an uninvolved
stranger — which is a worse act than a redundant call, not a lesser one."

The fix is a do-not-call list keyed by phone number, which the backend does not have yet.
**Owner: the do-not-call-by-number backend work.**

---

## 3. Fixed: the ledger records what the event reported

The backend now takes the disposition from the event (a voicemail is written as `left_voicemail`,
a wrong number as `wrong_number`), and a disposition only moves **up** `disposition_rank` in
`contract/seam4.json`, so a late, weaker event cannot undo a stop. Kept here so the history of the
number is readable; `npm run contract:derive` is what holds it true.

---

## 4. Fixed: one call is one ledger row. Three fields are still not recorded

The backend writes **one** ledger row per call, keyed by the `attempt_id` inside the token; every
later event of that call folds into it, and the attempt number counts calls, not events. A re-dial
must therefore carry a token minted with a **new** `attempt_id` — reuse one and the second call
folds into the first and the daily attempt count never sees it.

Still not written, because nothing reports them: the **number actually dialled**, the **call's
duration** and the **consent jurisdiction** the call was placed under. All three are known only
when a call ends, and the backend has no call-complete route to receive them. The missing endpoint
is the bug; this repository should not invent a place to keep them. The seam routes also have no
rate limit of their own yet. **Owner: the backend.**

---

## 5. `comp_terms` has no clause to return, and that is correct today

The backend does not yet hold an authored comp clause for any campaign, so a venue asking "who's
paying?" gets the honest deferral on every call. The mock's default scenario reproduces that; the
`comp-known` scenario is the world after the clause exists. `contract/seam4.json` records it under
`known_divergences` as `comp-clause`.

⚠️ Do not reach for other prose on the campaign because it is the only text available. A bot
telling a restaurant its comp is a line of product marketing copy is exactly the fabrication this
design exists to prevent. **Owner: the comp-clause backend change.**

---

## 6. Fixed: a paused campaign is still called; a closed one is not

The backend's campaign rule is in `contract/seam4.json` as `campaign_rule`: `active` and `paused`
proceed, every other status refuses `campaign_not_active`, compared case-insensitively. A pause
stops new bookings, not the notice to a venue about a visit already arranged. The mock serves
the same rule (`campaign-paused` proceeds, `campaign-closed` refuses).

---

## 7. Nothing here can see the backend

`contract/seam4.json` is a snapshot. All three copies of the shapes in this repo can agree with
each other perfectly while the backend has moved on. `npm run contract:derive -- <path>` is the
only thing that can tell you, and it is a CreatoRain engineer's job — CI here has no checkout of
that repo and should not be given credentials to fetch one.

---

## 8. The second transcriber may not be independent

The post-call fabrication check is supposed to compare what the agent said against what it was
allowed to say, using a transcript from something other than the model itself. The pinned
transcriber is Google Cloud Speech-to-Text — same vendor, probably the same project. Whether that
is a genuinely independent witness has not been asked, and its cost per minute has not been
measured. **Owner: unassigned.**

---

## 9. Two credentials are needed sooner than the docs used to say, and one does not exist

`README.md` and `ONBOARDING.md` both used to say no account was needed until the end of the
work. That was wrong and is corrected. The accurate line:

- Everything in this repository today, and **building** the Gemini Live adapter against the
  harness, needs nothing.
- **Running a real session** — which the first tuning measurement in `docs/TUNING.md` §3.2
  requires — needs `GEMINI_API_KEY`. Open an issue and a CreatoRain engineer mints one.
- The anti-fabrication check's **independent transcriber** needs `SPEECH_TO_TEXT_CREDENTIALS`.
  That value has not been provisioned, and it is a prerequisite for the acceptance criterion that
  a second witness confirms what the agent said. See also §8 — whether a same-vendor transcriber
  counts as independent is separately unsettled.

**Owner: unassigned, and it should not be.** It is the only item on this page that will stop
work rather than merely be wrong.

---

## 10. The Live API is in PREVIEW, on both ends, and nothing guarantees it

Google labels the Live API *Preview* in its own documentation, and `@google/genai` marks the
entire Live surface `@experimental` in the published type declarations — `connect()`,
`sendToolResponse()` and `close()` included. There is no deprecation guarantee on any of it, and
the pinned model has a published shutdown date: see `docs/TUNING.md` §3.2.

Two concrete consequences rather than a general worry:

- **Pin `@google/genai` to `^2.22.0` and below `3.0.0`.** The 3.x line removes
  `LiveConnectConfig.generation_config`. (It also requires Node 22, which is a non-event here.)
- **A breaking change arrives as a broken call, not as a warning.** The eval and `npm run call`
  both run against a fake, so neither would go red. The only detector is a real session, which
  makes the first tuning measurement something to repeat rather than do once.

**Owner: the Gemini Live adapter**, and it should carry a line saying which SDK version was last
exercised.

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
for AI voice agents. That is an argument for the carrier work, not a reason to delete
`src/audio/mulaw.ts`, which is mandatory and on the hot path if Twilio wins.

---

## 12. Merge rules

`main` and `dev` both require a pull request, one approving review and the `verify` check, and
refuse force-pushes and deletion. Read your own diff for keys before you push.
