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

## 4. Fixed: one call is one ledger row, and the end of a call is reported

The backend writes **one** ledger row per call, keyed by the `attempt_id` inside the token; every
later event of that call folds into it, and the attempt number counts calls, not events. A re-dial
must therefore carry a token minted with a **new** `attempt_id` — reuse one and the second call
folds into the first and the daily attempt count never sees it.

The end of a call now has a route. Since backend 9db9c705f (TASK-3753 s4) `call-event` takes a
fourth kind, `call_ended`, carrying `seq`, `end_reason`, `disclosure_heard` and the `turns`; the
turns go to a staff-only transcript table that expires 90 days out, and the same or an older `seq`
is a no-op (`replay: true`). Its shape is `call_ended` in `contract/seam4.json`. The **duration**
and **who answered** come from the carrier, on the backend's signed `/webhooks/twilio/voice-status`,
not from this repository. The **number dialled** and the **consent jurisdiction** belong to the
dial: the backend stamps them when it places the call (a DB CHECK requires both on a live row), so
nothing here reports them either. What is still open on
this side: the runtime does not post `call_ended` yet (that is the next step, from the supervisor's
`finally`), so until it does a live call's ledger row carries no transcript and no `end_reason`.

The seam routes are rate-limited, and the previous version of this page said they were not. All
three carry the backend's `publicTenantReadRateLimiter`: 120 requests per IP per 15 minutes, then a
429. One call makes one `call-context`, a handful of `call-fact` and `call-event` posts and one
`call_ended`, so a single call is nowhere near it; a burst of calls from one egress IP is what
would reach it, and a 429 reads to the client as `SeamUnavailable` (`HTTP 429`), handled exactly
like a backend outage. A limiter keyed by attempt rather than by IP is planned on the backend
(TASK-3753 s5). **Owner: the backend.**

---

## 5. `comp_terms` has no clause to return, and that is correct today

The backend does not yet hold an authored comp clause for any campaign, so a venue asking "who's
paying?" gets the honest deferral on every call. The mock's default scenario reproduces that; the
`comp-known` scenario is the world after the clause exists. `contract/seam4.json` records it under
`known_divergences` as `comp-clause`.

`venue-precall/v4` (backend C-225) put ONE fixed comp sentence, written in the backend, into the
opening's third beat and the voicemail. `venue-precall/v5` (TASK-3753 C4) dropped it again: the
third beat is now only "We wanted your team to know ahead of time...", and the opening says nothing
about who pays. The `comp_terms` answer still defers either way. The mock copies the opening
verbatim from the backend's builders and nothing in `src/` or the fixtures holds it; the fixtures
still allow comp words only inside a backend sentence (`must_not_improvise_matching`), which under
v5 means never, since no backend sentence on the default path carries one.

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

**The cascade needs neither (2026-11-13, CORE-A11 / C2).** The first-call brain is the cascade
(`src/agent/cascade.ts`), and it authenticates every Google call with Application Default
Credentials: the runtime service account on Cloud Run, `gcloud auth application-default login` on
a laptop. `src/config.ts` no longer reads `VENUE_CALL_SECRET`, `GEMINI_API_KEY` or
`SPEECH_TO_TEXT_CREDENTIALS`, and `test/importBoundary.test.ts` fails the build if anything under
`src/` names one again. The two keys above belong to the Live challenger and the independent
transcriber only; `VENUE_CALL_SECRET` belongs to `scripts/mint-token.mjs`, which is dev tooling.

---

## 10. The Live API is in PREVIEW, on both ends, and nothing guarantees it

Google labels the Live API *Preview* in its own documentation, and `@google/genai` marks the
entire Live surface `@experimental` in the published type declarations — `connect()`,
`sendToolResponse()` and `close()` included. There is no deprecation guarantee on any of it, and
the pinned model has no announced shutdown date, only Google's earliest retirement day, and the
build fails on that day: see `docs/TUNING.md` §3.2.

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

## 12. The cascade's own limits

- **Four fixed sentences.** `src/agent/phrases.ts` holds the only words an agent says that the
  backend did not send: ask for a member of staff, apologise for a wrong number, and two closes.
  None states a fact. Moving them behind the seam is open work for the contract, not this repo.
- **Synthesis request size and rate (CS-04).** Google refuses a synthesis input over 5,000 bytes
  and Chirp 3 HD takes no SSML; `src/speech/tts.ts` refuses both locally, before any request.
  Chirp 3 HD voices allow 200 requests a minute per project. The sha256 cache and the
  pre-rendered disclosure keep a call to a handful of requests, so at concurrency 1 and five
  instances the cap is not reached, but nothing here enforces it.
- **The intent model can only be measured with ADC.** `test/cascade.test.ts` has one test that
  talks to real Google, skipped unless `CASCADE_ADC_TEST=1`; it spends, so it is run by hand, never
  in CI. The eval runs the cascade offline on its keyword stage (`npm run eval -- --agent=cascade`).

---

## 13. Merge rules

`main` and `dev` both require a pull request, one approving review and the `verify` check, and
refuse force-pushes and deletion. Read your own diff for keys before you push.
