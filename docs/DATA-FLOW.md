# Data flow: where a call's audio and words go

Every hop a venue call's data takes, where it runs, how long it is kept and who holds the
credential for it. What to do when something goes wrong is in [`RUNBOOK.md`](RUNBOOK.md).

The short version: **audio is never stored, anywhere. The words of a call are stored in exactly
one place, platform-backend's transcript table, for 90 days. Logs carry no words.**

## 1. The path of one call

```
pb dispatcher ──dial──▶ Twilio ──media socket (μ-law, 8 kHz)──▶ this service (Cloud Run)
                                                                  │
                         ┌────────────────────────────────────────┤
                         ▼                                        ▼
               Google Speech-to-Text                 pb seam (call-context, call-fact, call-event)
               (venue audio ▶ text)                   returns finished sentences
                         │                                        │
                         ▼                                        ▼
               intent step (keywords, then           Google Text-to-Speech
               Vertex Gemini; returns one word)       (pb's sentence ▶ audio) ──▶ Twilio ──▶ venue
```

| hop | what crosses it | where it runs | kept | credential held by |
|---|---|---|---|---|
| pb ▶ Twilio | the dial request: venue number, the stream URL, a per-call token | pb (AWS) to Twilio | Twilio's call log (metadata only) | pb: the Twilio account credentials. This service holds none |
| Twilio ▶ this service | the call's audio both ways, as a WebSocket | Cloud Run, `creatorain-27e9e`, `us-central1` | not stored: frames live in memory for the length of a turn | Twilio presents the per-call token; this service checks it with pb before any audio (`test/server.test.ts`) |
| this service ▶ Speech-to-Text | the venue's audio | Google Speech v2, location `us` (`STT.location` in `src/tuning/cascadeDefaults.ts`) | not stored by this service | the runtime service account, through Application Default Credentials |
| this service ▶ intent step | the text of one venue turn | keywords in process; then Vertex Gemini on the `global` endpoint (`INTENT_LOCATION`) | not stored by this service | the runtime service account, ADC |
| this service ▶ pb seam | the per-call token, a fact topic word, a call event (for example a stop-calling request) | pb (AWS App Runner) | pb's ledger and transcript (section 2) | the per-call token only. pb's seam secret never leaves pb |
| pb seam ▶ this service | finished sentences to speak: the disclosure, the creator's spoken name, the booking facts | in memory for the call | not stored by this service | as above |
| this service ▶ Text-to-Speech | a sentence pb wrote | Google Text-to-Speech | not stored by this service | the runtime service account, ADC |
| this service ▶ Cloud Logging | event words, socket ids, counts, error class names. **Never a word of the call** (`test/logRedaction.test.ts`) | Cloud Logging, `creatorain-27e9e` | 30 days (the default bucket) | the runtime service account (`roles/logging.logWriter`) |

The runtime service account is `venue-call-runtime@creatorain-27e9e.iam.gserviceaccount.com`
([`DEPLOY.md`](DEPLOY.md) §1). It holds no carrier credential, no backend secret and no API key.

## 2. What is kept, and for how long

All of it is in platform-backend. This service keeps nothing after a call ends.

| record | holds | kept | deleted by |
|---|---|---|---|
| ledger row | who was called, for which booking, when, the disposition, whether the disclosure was heard | 4 years | not purged in v1; the first expiry is years away |
| transcript (`reservation_call_transcripts`, TASK-3753) | what each side said, as text | 90 days (`VENUE_CALL_TRANSCRIPT_RETENTION_DAYS`) | pb's daily purge worker (TASK-3750 slice 2) |
| suppression | a number that asked not to be called again | 5 years | not purged in v1 |
| audio | nothing | never stored | n/a |

## 3. What would break this map

Any change that stores audio, writes a call's words anywhere but the pb transcript, logs a word
of a call, or gives this service a credential of its own changes this page, and needs the change
reviewed against it. The two tests that hold the line today are `test/logRedaction.test.ts`
(no words in logs) and `test/killPath.test.ts` (a refusal ends the call, which is how the
platform kill reaches a live call).
