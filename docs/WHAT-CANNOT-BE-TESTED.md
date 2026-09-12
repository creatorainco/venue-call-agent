# What a green build does not prove

Written down once, so the first real call is not mistaken for a formality.

`npm run verify` and `npm run eval` are green on a laptop with no phone, no Google account and no
database. That is worth a great deal and it is not the same as "this works." Everything below is
outside what any test here can reach, with the reason no local substitute exists and who owns it.

---

## The transport

**1. That the credential arrives at all.** The call token travels as a TwiML `<Parameter>` inside
`<Connect><Stream>` and reaches the agent in the WebSocket `start` frame. Nothing enforces that
shape in either repository — the backend's own token header says enforcement is at the dial site,
and there is no dial site. Owner: **TASK-973**.

**2. Answering-machine detection.** Whether the carrier's detector fires before or after our first
word, and how often it is wrong on a busy restaurant. Get this backwards and the disclosure is
spoken to a beep, or a person hears silence. No local substitute: it is a carrier feature with
carrier timing. Owner: **TASK-973**.

**3. DTMF.** Navigating a real phone menu means sending tones. The `phone-menu` fixture tests the
*decision* to ask for a person; it cannot test pressing 2.

**4. Barge-in and half-duplex,** including whether echo cancellation feeds our own voice back to us
as input. On a bad line the agent can hear itself and interrupt itself. Only a real call shows it.

**5. End-to-end latency under jitter and loss.** The mock's `--latency` models the *seam* round
trip and nothing else. There is no carrier, no network, no audio path. Numbers from `docs/TUNING.md`
are a floor.

**6. ASR accuracy against restaurant noise.** The largest single source of a wrong tool call, and
completely unreproducible by typing sentences into a fixture. A kitchen at 6pm is not a quiet room.

---

## The one nobody can test even with a phone

**7. Whether the restaurant thinks this was acceptable.** Nothing in a transcript says whether the
manager found the call useful or found it a nuisance. That is what the ten-call soak and the
one-campaign pilot are for, and it is why both are deliberately not ticketed: each needs a person's
judgement on the day, not a check.

---

## Things a test could cover and does not, yet

**8. When a call may be placed.** The schedule refusals — venue closed, no real opening hours, the
peak-hours exclusion, the 14:00–16:00 lull — are real, well-designed backend code and **no fixture
here touches them.** They decide whether a call happens at all, and on production they would refuse
for every venue today (0 of 13 have real opening hours). The first real call therefore needs a
hand-filled row, which means the timing rule will not have been exercised by anything before it
matters. Owner: the epic; the closest ticket is TASK-966.

**9. Observability.** There is no logging, metric, trace or operator-visible surface for a call
that goes wrong in production. This matters more here than in most features: **voice has no bounce
and no complaint webhook.** The ledger is the only detector, and a call that fails in a way the
ledger does not record is a call nobody will ever know about. Not ticketed. It should be.

**10. Hearing it.** Every test in this repository asserts on transcripts, journals and DFT bins.
Nothing renders a call to a speaker or a `.wav`. Until the Gemini adapter exists there is no audio
to render — but the day it exists, being able to *listen* to a fixture is the fastest debugging
tool available and it should be the first thing built alongside it.

**11. Whether the fabrication check's second witness is independent.** `SPEECH_TO_TEXT_CREDENTIALS`
exists so a transcriber other than the model can say what the model said. It is pinned to Google
Cloud Speech-to-Text — the same vendor, likely the same project. Whether that counts as an
independent witness of a Google model's speech is an open question nobody has asked, and its
per-minute cost against the credit is unmeasured.

---

## Things believed true that are only merged

The whole backend half of this feature is merged and, for most of it, on the production branch —
and **none of it has been observed running.** Every iteration in the plan tops out at "CI green".
The feature is dark on production by a flag that was measured absent, which means the safety
conclusion holds one way only: nothing is happening. It does not tell you that the code works.

That distinction — merged, deployed, flagged off, observed working — is four different states, and
the epic keeps them apart on purpose. Do not collapse them when reporting progress.
