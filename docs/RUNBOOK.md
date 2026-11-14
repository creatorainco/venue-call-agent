# Runbook: stopping calls, reading a call, and the alerts

What a person on call does when something about venue calls is wrong. The data each step touches
is mapped in [`DATA-FLOW.md`](DATA-FLOW.md); the service definition is in [`DEPLOY.md`](DEPLOY.md).

This service places no calls. platform-backend (pb) decides every call, places it through the
carrier, and owns the controls. This service only answers the media socket the carrier opens, and
it can speak only after pb has accepted the call's token. So every way of stopping calls below
works by making pb refuse, or by making this service unreachable.

## 1. Kill: stop every call now

**Anyone may stop calls, at once, without asking.** Pausing is always allowed: a staff member or an
agent that sees a critical problem stops calls first and tells the operator after. **Only the
operator turns calls back on, by hand, on the admin screen.** No agent clears a kill, re-arms,
or restores anything below, even with a yes.

Use the first rung that exists and works. Each one is enough on its own.

| rung | what you do | what it stops | undone by |
|---|---|---|---|
| 1. Platform kill (once TASK-3746 ships) | Admin, **Voice calls** screen, **Kill**. An agent may call pb `POST /kill` on the voice-call controls with a staff token. | The dispatcher places no new call (`PLATFORM_KILLED`), and every seam operation refuses, which ends a live call within one turn (section 1.1). | The operator, on the same screen. Never an agent. |
| 2. Seam off | Remove `VENUE_CALL_SECRET` from the pb service environment and let it redeploy. | Every seam operation refuses `seam_disabled` before it reads the database, so no call can be authorised and a live one ends at its next seam operation. | The operator restores the key. |
| 3. Agent unreachable | `gcloud run services update venue-call-agent-dev --project creatorain-27e9e --region us-central1 --ingress internal` | The carrier can no longer open a media socket. pb's TwiML has nothing after `</Connect>`, so a call whose stream cannot open ends without a word. Live sockets end when the revision rolls (SIGTERM, then a drain of `DRAIN_GRACE_MS` in `src/server/main.ts`). | The operator, `--ingress all`. |
| 4. End one live call | The Twilio Calls API: update that call SID with `Status=completed` (pb holds the carrier credentials; the call SID is on the ledger row). | That one call, immediately. | Nothing to undo. |

Rung 3 and rung 4 work today. Rung 2 works today on any pb environment where the key is set. Rung 1
arrives with TASK-3746 (`platform_feature_controls`), and pb's tests for it (any staff may kill,
a non-operator clear gets 403 `not_operator`, an unreadable kill row refuses `PLATFORM_KILLED`)
land in that pull request.

### 1.1 What a kill does to a call already in progress

A kill does not reach into this service; the seam refuses. This service treats every refusal the
same way, whatever its reason word, and that is what makes the kill safe:

- The agent says nothing more. No sentence is queued after the refusal.
- The line is hung up exactly once, with reason `seam_stopped`.
- No audio is written down the closed line, and the seam is asked for nothing more.
- A call refused before it spoke never starts the disclosure.

`test/killPath.test.ts` forces a kill at every seam operation of every recorded conversation, with
both agents, and checks all four. Its sabotage control (let the refusal branch of `guard()` in
`src/carrier/call.ts` carry on instead of ending the call) turns it red. A refused token at the
socket edge opens no session and sends no audio: `test/server.test.ts`, "the edge: the token and
the backend".

### 1.2 After a kill

1. Say what you stopped and why, in the venue-call ticket and to the operator.
2. Find every call that was live at the moment of the kill (section 2) and confirm each one ended.
3. Leave the kill in place. Clearing it is the operator's decision, made on the screen.

## 2. Read one call

Every call has three records, joined by the ledger row's id and the carrier call SID.

1. **The ledger row** in pb: who was called, for which booking, when, the disposition, whether the
   disclosure was heard in full. Kept for 4 years. Read it on the admin Voice calls screen, or
   with a `SELECT ... LIMIT` on the dev database (it is production data: read only).
2. **The transcript** in pb `reservation_call_transcripts` (TASK-3753): what each side said, as
   text. Deleted 90 days after the call by pb's purge worker. This is the only place the words
   of a call live (section 4).
3. **The carrier record** in the Twilio console, by call SID: ring time, answer, duration, who hung
   up, carrier errors. There is no recording: pb's TwiML asks for none, and this service stores no audio.

This service's own log lines (Cloud Logging, project `creatorain-27e9e`, service
`venue-call-agent-dev`) carry the socket id, event words, counts and error class names, never a
word of the call. Filter on the socket id to follow one call through `accepted`, the supervisor's
events and the hangup.

## 3. The alerts and the first three checks

pb writes one upper-case token per condition (`VENUE_CALL_ALARM_TOKENS` in pb
`src/helpers/location/venueCallConstants.ts`). Wiring them to alarms that email a person is
TASK-3750 slice 1b; until then, search the pb log group for the token.

| token | means | first three checks |
|---|---|---|
| `VENUE_CALL_DIAL_FAILED` | the carrier refused or errored on a dial | Twilio call log for the error code; the pb ledger row; the carrier account balance and number status |
| `VENUE_CALL_UNKNOWN_OUTCOME` | a dial had no end, and the reaper closed it | Twilio call status by SID; this service's log for that socket; whether the revision was rolling at that minute |
| `VENUE_CALL_UNDISCLOSED` | a call ended before the venue heard the full AI disclosure | the transcript's first lines; this service's `output-gate` events for that socket; the far end's hangup time. **Kill first if it repeats.** |
| `VENUE_CALL_SUPPRESSED_DIALED` | a suppressed number was dialled. Must never happen | **Kill first (section 1).** Then the suppression row and the dispatcher's gate log for that booking |
| `VENUE_CALL_SEAM_REFUSALS` | the seam refused this service more than a normal call would | the refusal words in this service's log (`seam_refused <word>`); the pb deploy at that minute; whether a kill was set |
| `VENUE_CALL_PURGE_FAILED` | the daily transcript purge failed | the purge worker log; rows past `expires_at` still present (`SELECT count(*) ... LIMIT`); the database connection |

Cloud Run conditions (service errors, a crash loop, slow first audio, a session open with no pb
acceptance) become alert policies under `ops/monitoring/` in slice 1b. Until then, read the
service's error rate on the Cloud Run page and search its log for `call_failed`,
`handler_failed` and `internal_error`.

## 4. What must never appear in a log

No log line, in this service or in pb, carries a word anybody said on a call: not the venue's,
not the agent's, not a sentence pb handed over to be spoken (those name the creator and the
booking). Cloud Logging keeps lines for 30 days and nothing purges one early, so a transcript in a
log would outlive the 90-day rule and be readable by everyone with log access.

`test/logRedaction.test.ts` enforces it here, two ways: it runs every recorded conversation with
both agents and checks every captured log line against everything said, and it scans every log call
site in the runtime source for an interpolated variable named for speech. If you find a call's
words in a log anyway, treat it as an incident: say so in the ticket, and fix the line before the
next call.

## 5. The first calls

For the first calls to real venues, a person reads every transcript in full, and an independent
speech recogniser checks the same calls (TASK-3749). Record each read in the ticket.
