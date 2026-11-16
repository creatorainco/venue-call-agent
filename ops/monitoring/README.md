# Monitoring: venue-call-agent on Google Cloud Monitoring

Venue-call plan it-08 (TASK-3859). These are the Cloud Run alerts that [docs/RUNBOOK.md](../../docs/RUNBOOK.md)
section 3 points to. pb's own alarm tokens (`VENUE_CALL_*`) live in pb, not here.

Everything here watches. Nothing here places a call, deploys, arms or changes the service.

## Apply

```
bash ops/monitoring/apply.sh all            # DRY RUN (the default): prints every gcloud command
APPLY=1 bash ops/monitoring/apply.sh dev    # the real run, one environment
OFFLINE=1 bash ops/monitoring/apply.sh all  # dry run with no gcloud calls at all
```

- Parameters per environment: `env/dev.env`, `env/prod.env` (service name, budget amount, uptime period).
- Templates: `templates/*.json`, rendered with the service, environment, channel and host filled in.
  `RENDER_DIR=<dir>` keeps the rendered files for review.
- Idempotent: it looks everything up first. Metrics and policies that exist are updated from the file;
  an uptime check, topic or channel that exists is left alone; an existing budget gets its amount set.
  A list call that fails (rate limit, permission) stops a real run rather than create a duplicate.
- Notifications go to the email channel for `NOTIFY_EMAIL` (default peter@creatorain.com), which
  already exists. It is created only if it is missing, and only on a real run.
- Prod: the service `venue-call-agent` does not exist until the release (it-14). Until then the
  script skips the prod uptime check and its policy and says so; rerun it after the first deploy.
- Git Bash: the script sets `MSYS_NO_PATHCONV=1` (else `--path=/health` becomes a Windows path) and,
  because that breaks the gcloud shell wrapper, runs `lib/gcloud.py` directly.

## What the service logs, and what the filters match

The service writes plain text lines to stderr (`process.stderr.write`, src/server/main.ts:122,
src/server/streamServer.ts:163, src/carrier/call.ts:569). On Cloud Run each line lands in
`run.googleapis.com/stderr` as `textPayload`, with no severity. So the filters match
`textPayload`, never `jsonPayload` or `severity`. `test/opsMonitoring.test.ts` fails if a word below
is no longer written by a log call in `src/`.

| word | written by | meaning |
|---|---|---|
| `call_failed` | src/server/streamServer.ts:378 | the call handler threw after the call was accepted |
| `handler_failed` | src/server/streamServer.ts:276 | a socket message handler threw |
| `session_left_line_up` | src/server/streamServer.ts:381 | the call ended with the line still up; we hung up |
| `seam_unavailable` | src/server/streamServer.ts:355, src/carrier/call.ts:639 | pb did not answer (at the start, or mid-call) |
| `internal_error` | src/carrier/supervisor.ts:241 | the supervisor caught our own exception and hung up |
| `exited_without_reason` | src/carrier/supervisor.ts:318 | the call body returned with no reason: a bug |
| `call_ended_record_failed` | src/carrier/supervisor.ts:265 | the end-of-call record could not be built |
| `call_ended_unrecorded` | src/carrier/supervisor.ts:291, src/carrier/supervisor.ts:293 | the end-of-call record never reached pb |
| `cascade_unavailable` | src/server/main.ts:185 (per call), src/server/main.ts:124 (process) | the speech cascade did not start |
| `ALERT_STOP_CALLING_UNRECORDED` | src/seam/client.ts:217 (constant at src/seam/client.ts:97) | a venue said stop calling and pb never recorded it |
| `cascade_warm_failed` | src/server/main.ts:162 | one warm-up attempt failed |

Not counted on purpose: `seam_refused <word>` (pb said no, e.g. `seam_disabled`; pb alarms on
refusals itself) and `busy` (a second call refused at concurrency 1).

The call-failed metric filter (`templates/metric-call-failed.json`, `@SERVICE@` filled in):

```
resource.type="cloud_run_revision" AND resource.labels.service_name="@SERVICE@"
AND log_id("run.googleapis.com/stderr")
AND (textPayload=~"^(stream|call-supervisor|live-call) \S+ (call_failed|handler_failed|internal_error|seam_unavailable|session_left_line_up|exited_without_reason|cascade_unavailable|call_ended_record_failed|call_ended_unrecorded)( |$)"
     OR textPayload:"ALERT_STOP_CALLING_UNRECORDED")
```

## The alerts, and what to do

Every policy is named `vca-<env> ...` and labelled `env=<env>`, `service=venue-call-agent`.

**Call ended badly** (`vca_call_failed_<env>` > 0 in 5 min, one incident per word).
- `ALERT_STOP_CALLING_UNRECORDED`: a venue asked us to stop and it is not on record. Kill first
  (RUNBOOK section 1), then record the suppression by hand in pb.
- Anything else: open Logs Explorer on the service, search the word, take the socket id
  (`stream-N`) and follow that socket from `accepted` to its end (RUNBOOK section 2). The error
  class name is on the same line. `seam_unavailable`: check pb's health and its deploy at that minute.
  `internal_error` or `exited_without_reason`: a bug here; file it with the socket's lines.

**Speech cascade not warming** (`vca_cascade_warm_failed_<env>`): `cascade_unavailable` once, or
`cascade_warm_failed` more than 4 times in 30 min. A cold start normally writes up to two
`cascade_warm_failed TtsUnavailable` lines before `cascade_warm ms=...` (seen on dev 2026-11-15), so
one cold start does not fire it. Check: the runtime service account still has its speech roles, the
Text-to-Speech and Speech-to-Text APIs are enabled, and the quota pages for both.

**5xx responses** (Cloud Run `request_count`, `5xx` > 2 in 5 min). A 503 on `/health` is an
instance draining; at concurrency 1 a second call is refused, which shows as busy, not 5xx. Check the
revision list (a bad rollout: roll traffic back to the previous revision), then the service logs.

**Crash loop** (`vca_container_exit_<env>` > 2 in 15 min). Counts Cloud Run's own system log lines
at ERROR (failed startup probe, task errors) and `Container called exit(N)` with N > 0; a clean
`exit(0)` is INFO and is not counted. Check the latest revision's logs just before the exit, then
roll traffic back to the previous revision.

**/health uptime failing** (HTTPS GET `/health` from 3 US regions every 15 min; fires when 2 or
more fail). `/healthz` is not used: Cloud Run's front end answers it with a Google 404
(src/server/streamServer.ts:42). Check the service URL by hand, then the revision and its logs.
Cost note: with min instances 0 and concurrency 1 a check can start an instance, and each start
runs the speech warm-up; at 15 minutes that is at most a few starts an hour.

## The budget

Per environment: a Pub/Sub topic `vca-budget-<env>` and a monthly budget alert of `BUDGET_USD`
(50 for both, Peter 2026-11-13 B3 for dev; prod uses the same until someone changes `env/prod.env`).
A budget spends nothing: it emails the channel at 50%, 90%, 100% and forecast 100%, and publishes
each update to the topic for anything that wants to act on it.

The budget is filtered on the project and the label `env=<env>`. It counts only cost from resources
that carry that label, and today neither Cloud Run service has one: the deploy steps in
`cloudbuild.yaml` and `cloudbuild-prod.yaml` need `--labels=env=dev` / `--labels=env=prod` before
these budgets count anything. Speech and Vertex API calls are not labelled resources at all; the
existing project budget `venue-call-speech-gross` (Speech-to-Text and Text-to-Speech, 50 USD)
covers those and is not touched here.

## Not covered here

Slow first audio and a session open with no pb acceptance (RUNBOOK section 3) need numbers the
service does not log as a metric yet.
