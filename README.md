# venue-call-agent

The voice that telephones a restaurant before a creator's booking.

**Nothing here dials anybody.** There is no phone-carrier code in this repository and adding it is a
separate, approval-gated piece of work (TASK-973). During TASK-970 this service's only client is the
local harness in `src/harness/`, which plays recorded audio at it.

Ticket: **TASK-970**. Parent epic with the full picture: **TASK-967**. Read the epic first.

---

## Start here — five minutes

```bash
npm install
npm test            # unit tests, no network, no cloud account
npm run harness     # a full scripted conversation against recorded audio
```

If `npm test` passes you have a working environment. You need **no Google account, no phone carrier
account and no AWS access** to do the bulk of TASK-970.

---

## The one rule that shapes this whole service

**This service never composes a fact.**

Every sentence a restaurant hears arrives from the CreatoRain backend as a finished string. The model
chooses *which* fact to fetch; it never writes the wording of one. That is the only reason an
after-the-call check for invented claims is possible at all — a checker can compare speech against a
finite set of known strings, but it cannot compare speech against a number the model was free to
phrase itself.

In practice: **no price, no policy, no venue name, no offer terms and no copy deck in this
repository.** `npm run check:no-facts` greps the source for product nouns and fails the build. If you
ever feel you need to hardcode a sentence here, that means a backend endpoint is missing — add the
endpoint instead.

---

## Layout

```
src/
  index.ts            service entry — refuses to start if config is missing
  config.ts           every environment variable, each one fail-closed
  state.ts            the call state machine
  tools/              the five handlers — the ONLY way a fact enters a call
  transcript.ts       writes the transcript. Audio is never stored.
  harness/            plays recorded audio at the service. Dials nobody.
test/fixtures/        one recorded conversation per branch of the script
```

---

## The five conversation branches you must cover

One recorded fixture each. These are the acceptance cases in TASK-970, not suggestions.

| Fixture | The manager… | What must happen |
|---|---|---|
| `plain.json` | says "fine, noted" | notice delivered, polite close, transcript written |
| `who-pays.json` | asks who is paying | the comp answer, verbatim from the backend — see TASK-972 |
| `unknown.json` | asks something we have no answer for | escalates and offers follow-up. **Never improvises** |
| `stop-calling.json` | says stop calling us | do-not-call written **before** the reply returns — TASK-971 |
| `hangup.json` | hangs up mid-sentence | partial transcript written, no crash, no retry storm |

Assert on the **transcript**, never the audio, and assert that no sentence appears which the backend
did not supply.

---

## Testing discipline — a sabotage control is required

A green test proves nothing until you have watched it go red.

For every guard you add: break the code it protects on purpose, confirm the test fails, restore it,
confirm the test passes. Paste both outcomes in the pull request. This is not ceremony — a test on
this feature was recently found asserting a condition the database can never produce, and it passed
happily for a week.

---

## Talking to the backend

The backend API this service calls is built and merged on `platform-backend`'s `dev` branch:
`venueCall.service.ts` plus three routes on `reservations.routes.ts`.

- Run platform-backend locally on `dev`, set `VENUE_CALL_SECRET` **in your own shell only**, and
  point this service at it.
- 🔴 Setting an environment variable on a *deployed* service is a configuration change and is
  Peter's call. Ask; do not do it.
- The credential you present is scoped to **one booking and one attempt** and expires in twenty
  minutes. Test an expired one and one issued for a different booking — both must be refused.

---

## Deployment

Google Cloud Run, eventually. **Not part of TASK-970.** When it happens:

- raise the request timeout off its 5-minute default (a call outlives it),
- allow high concurrency so one instance holds many calls,
- turn session affinity on.

Two facts are still unknown and are noted in TASK-967: whether Cloud Run is enabled in the project
that bills our AI usage, and what our real concurrency ceiling is. Neither blocks local work.

---

## Absolute limits

- **Never place a real call** to any number, including one we own, without Peter's explicit yes for
  that act on that day. An earlier plan exempted a self-call on the grounds that the handset was
  ours. That reasoning was overturned: whose phone rings changes who is inconvenienced, not which
  switch was flipped.
- **Transcripts only, never recorded audio.**
- **No route may write to a booking.** A stranger on a telephone cannot move, cancel or confirm a
  reservation. The single permitted write is the do-not-call record.
- **The first outbound audio is gated on the disclosure being spoken.** The state machine must have
  no path that reaches the notice without it.
