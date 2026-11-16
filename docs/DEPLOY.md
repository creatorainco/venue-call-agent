# Deploying this service — the definition, and the checklist behind it

🔴 **THE DEV SERVICE EXISTS; THE PRODUCTION SERVICE IS WRITTEN DOWN BUT NOT CREATED.** Its build
file and workflow (`cloudbuild-prod.yaml`, `.github/workflows/deploy-main.yml`) landed on `dev` on
2026-11-15 (venue-call plan it-09); the identities, the federation change and the service itself
are created at the release, in the order of §7. The research behind this page was read
out of Google's own documentation on **2026-09-12**. §1, §2 and §5 were rewritten on **2026-11-09**
(TASK-3748) against what the project actually holds. On **2026-11-14** (TASK-3748 step 4) the
identities, the Artifact Registry repository and `venue-call-agent-dev` were created, and the
federation provider now trusts this repository for pushes to `dev` only. From then on a push to
`dev` deploys through `.github/workflows/deploy-dev.yml` and `cloudbuild.yaml`, whose every flag
`test/deployConfig.test.ts` holds.

🔴 **A DEPLOYED SERVICE IS NOT A DIALLING SERVICE.** Nothing here places a call, and a green
deploy opens no gate. The carrier and first-dial work, and the repository owner's per-act yes, are a separate
approval that this page does not touch.

---

## 0. Why you would deploy at all

Read `docs/TEST-ENVIRONMENT.md` first. Tiers 0, 1 and 2 — the whole decision layer, the telephone
layer, and a real model session — all run on a laptop. Hosting buys **one** thing: a public
address a carrier can connect to. That is tier 3.

So the ordering is: settle the carrier question, then deploy. Deploying first produces an
endpoint with nothing to connect to it.

---

## 1. What must exist before the first deploy can succeed

Project **`creatorain-27e9e`**, region **`us-central1`** by default (a soak compares `us-east4`,
nearer the carrier's Ashburn edge). In order; the ordering is not cosmetic, because each identity
is granted on the one before it.

1. **APIs.** `run`, `cloudbuild`, `artifactregistry`, `speech`, `texttospeech`, `aiplatform`,
   `iamcredentials` and `sts` are enabled (`speech` since TASK-3744; a streaming recognition of
   8 kHz μ-law has been run against it).
2. **The runtime identity, `venue-call-runtime@creatorain-27e9e.iam.gserviceaccount.com`.** It
   exists. It holds `roles/speech.client` and `roles/aiplatform.user`, and the deploy step adds
   `roles/logging.logWriter` and `roles/monitoring.metricWriter`. Nothing else: it holds no carrier
   credential, no backend secret and no API key, because the design gives the agent none.
3. **A build identity, `venue-call-build@`, and one Artifact Registry repository** for the image,
   `us-central1-docker.pkg.dev/creatorain-27e9e/venue-call-agent`. Both exist (2026-11-14), with
   the dispatch identity `ci-dispatch-vca@` that the workflow acts as (§5).
4. **The default compute service account is disabled in this project, and stays disabled.** Every
   build names its service account explicitly. A build that does not fails with "Provided service
   account ... is disabled", which looks like a Cloud Build fault and is not.

---

## 2. The service definition, flag by flag, with the reason for each

The image is built from a `Dockerfile` in this repository (Node pinned by digest, a non-root
user, `npm ci --omit=dev`), not from `--source` buildpacks: the Node version and the user are then
pinned in a reviewed file instead of resolved on the day of the build.

```bash
gcloud run deploy venue-call-agent-dev \
  --project creatorain-27e9e \
  --region us-central1 \
  --image "$IMAGE" \
  --service-account venue-call-runtime@creatorain-27e9e.iam.gserviceaccount.com \
  --allow-unauthenticated \
  --timeout 600 \
  --concurrency 1 \
  --max-instances 5 \
  --min-instances 0 \
  --cpu-boost \
  --cpu-throttling \
  --labels env=dev
```

| flag | why, and what it costs to get wrong |
|---|---|
| `--service-account` | The runtime identity from §1, so the service never runs as a default account. Speech, synthesis and the intent model authenticate through it with Application Default Credentials; there is no key in the container. |
| `--allow-unauthenticated` | The carrier connects with a plain WebSocket and **cannot present a Google identity token**, so an IAM-gated service refuses every call at the edge. Authentication is the application's instead — see below. |
| `--timeout 600` | A WebSocket on Cloud Run **is an HTTP request** and dies at the service request timeout. The default is 300 s, which a call can outlive; 600 s clears the call cap (`MAX_CALL_SECONDS` in `src/tuning/liveDefaults.ts`) with room for the close, and a socket that somehow outlives the cap is cut rather than billed for an hour. `test/docs.test.ts` holds it above the cap. |
| `--concurrency 1` | One call per instance. Each open socket saturates its instance and Cloud Run starts another for the next call, so there is no queueing logic to write. |
| `--max-instances 5` | With concurrency 1 this is the ceiling on simultaneous calls — a **soft** one; see below. Also the blast radius if something ever loops. |
| `--min-instances 0` | Accept cold starts and pay nothing between calls. A warm instance is a monthly cost (§3), so it waits for the owner's yes; the soak measures the cold start that decides it. |
| `--cpu-boost` | Extra CPU while an instance starts, which is when the disclosure has to be ready. Cuts the cold start without paying for a warm instance. |
| `--cpu-throttling` | Request-based billing — the default, stated explicitly so nobody "fixes" it. See §3. |
| `--labels env=dev` | The cost label (`env=prod` on the production service). The monthly budget in `ops/monitoring/` counts only spend that carries `env=<env>`, so without it the budget reads 0 USD and never alerts. |

### Why a public service is still not an open one

Every gate is in the application, and every one closes by default:

- The only WebSocket path is `/stream`, with no query string; anything else gets no upgrade.
  `GET /health` answers 200 with no detail (`/healthz` too, locally: Cloud Run's front end reserves
  `/healthz` on run.app URLs and answers it with its own 404, so the deployed check is `/health`).
- The backend mints a per-attempt token and hands it to the carrier inside the stream
  instructions. It arrives in the stream's `start` message as a custom parameter. The agent never
  reads it: it passes it, opaque, to the backend's call-context endpoint.
- A socket that has not been accepted by the backend within **3 s** is closed. At most **2** such
  unaccepted sockets per instance, and a **64 KB** frame ceiling.
- **No speech, synthesis or model session opens before the backend accepts the token.** A stranger
  who finds the URL costs one short socket and nothing on the Google bill.

If an organization policy ever refuses the public binding (`run.managed.requireInvokerIam`), the
fallback is `--no-invoker-iam-check` on this one service, not a token-minting proxy. The probe
recorded in TASK-3744 found the binding allowed.

The public binding (`allUsers` as invoker) is set **once**, by an owner, not by CI: the deploy
identity in §5 can deploy revisions but cannot change who may invoke the service, and the binding
survives every later revision.

### Two flags NOT to set, and why they look right

**`--session-affinity`. Do not.** It sounds necessary for WebSockets and is not: a single
WebSocket is inherently pinned to one instance for its whole life — *"the client will stay
connected to the same container on Cloud Run throughout the lifespan of the connection."*
Affinity only influences where a **new** connection lands, it is best-effort, it works through a
30-day cookie that a telephony media client does not carry, and — the part that bites — **it
takes precedence over traffic splitting**, so it silently disables canary deploys.

**An external load balancer, to get a longer connection.** It does not work. For backend services
with serverless NEG backends the timeout is a fixed, non-configurable 60 minutes, and setting
`timeoutSec` is a hard error: *"Timeout sec is not supported for a backend service with
Serverless network endpoint groups."* If a call ever needs more than 60 minutes, Cloud Run is the
wrong host — that is an architecture change, not a config one.

⚠️ **`--concurrency 1` is the opposite of what Google's WebSockets page recommends** — verbatim,
*"Google recommends that you increase the maximum concurrency setting for your container to a
higher value than the default"* — and a future reader will "fix" it back to 80. It is written
down here so they read this first. Their example is chat: many idle sockets on one instance.
Ours is a call: continuous CPU-bound audio, one human on the line, and one bad neighbour is a
restaurant hearing stutter.

🔴 **`--max-instances` is a SOFT ceiling, not a hard cap.** The max-instances documentation says
Cloud Run may briefly exceed it during traffic spikes. So it is a scaling limit and a cost
damper — useful, and not a guarantee about the number of simultaneous calls or about spend. The
documented mechanism for a genuine hard stop is a **Cloud Billing budget spend cap** (Preview),
which pauses the workload.

⚠️ Do not add an aggressive liveness probe alongside `--concurrency 1`. Probes always get CPU and
are billed but carry no request charge; whether one **consumes the single concurrency slot** is
not stated anywhere in the documentation, and with concurrency 1 that is the difference between a
healthy service and one that never accepts a call. Settle it empirically before configuring one.

---

## 3. What it costs, and the intuition that is wrong

us-central1 list prices, read 2026-09-12:

| | CPU (per vCPU-second) | Memory (per GiB-second) | Requests |
|---|---|---|---|
| **instance-based** | $0.000018 | $0.000002 | — |
| **request-based** | $0.000024 active, $0.0000025 idle (min instances only) | $0.0000025 | $0.40 / million |

One warm 1 vCPU / 512 MiB instance for a month:

| | gross | after free tier |
|---|---|---|
| request-based, `--min 1`, fully idle | $9.86 | **~$8.51** |
| instance-based, always on | $49.93 | $44.71 |

🔴 **The net figure in the first row was $4.64 in an earlier draft and that was wrong.** The free
tier is a quantity of vCPU-seconds and GiB-seconds, so what it is *worth* depends on the rate
those seconds would have billed at. An idle min-instance bills at $0.0000025/vCPU-second, so the
free tier is worth about **$1.35** there — not the $5.22 it is worth against active CPU. Valuing
a free allowance at the wrong rate is an easy way to understate a bill by half, and it did.

**The break-even duty cycle is ~71%** — below that request-based wins, above it instance-based
does. ⚠️ That figure assumes busy time bills at the request-based *active* rate, which for a
WebSocket service means the entire open-connection time, not just the moments the CPU is busy.
Take it as the right order of magnitude and re-derive it against real call durations before
quoting it at anyone.

At this feature's expected load — say thirty five-minute calls a day, about a 10% duty cycle —
request-based with a warm instance lands near **$16/month**, and `--min 0` makes it roughly
nothing plus cold starts. Either way this is not where the money goes: the model is.

🔴 **The usual intuition is wrong in the details.** Request-based CPU is **33% more expensive per
active second** than instance-based. It wins on duty cycle, not on rate. Anyone who says
"request-based is cheaper" without saying "at this duty cycle" has not done the arithmetic.

**And the one real fear about request-based is unfounded here.** An instance holding an open
WebSocket bills as *active* for the whole connection — the cheap idle rate never applies during a
call — but CPU is therefore *allocated* for that whole time too, so **there is no mid-call
throttling risk**. The only reason to switch to `--no-cpu-throttling` would be work that must run
*after* the socket closes — writing the call outcome, uploading a transcript. Do that work before
closing the socket instead.

---

## 4. What in this repository the first deploy depends on

**1. The entrypoint.** The container's command runs Node on the server entrypoint,
`src/server/main.ts`, directly, with no npm in between, and `npm start` points at the same file.
Until the cascade agent lands (TASK-3748 step 3) a call the backend accepts is hung up at once
with no audio sent: the server is complete, the voice is not.

**2. The Node version is pinned by the image, not by `engines.node`.** `engines.node` is
`">=22.18"` so a developer on Node 24 can still work here; do not narrow it. The `Dockerfile` pins
a Node 22 base image by digest, which is what makes the runtime the same one CI tests on (`.nvmrc`).
The buildpack-era workaround (`GOOGLE_NODEJS_VERSION`) is not needed and not set.

**3. Two HTTP servers, two different binds.** `src/mock/server.ts` binds `127.0.0.1:8788` and
must never be reachable. `src/server/main.ts` binds **`0.0.0.0` on `$PORT`**, which Cloud Run
requires (it sets `PORT`, 8080 by default, and wants a listener within four minutes of start).
Without `PORT` it falls back to 8787, the local default in `src/config.ts`. Do not copy the mock's
`listen()` into the service, or the service the other way.

**4. Three runtime dependencies, pinned exactly.** `ws` (Node 22 has a WebSocket client and no
server), `@google-cloud/speech` (streaming recognition is gRPC only) and `google-auth-library`
(Application Default Credentials for the REST calls). Synthesis and the intent model go over REST
with `fetch`. `test/dependencies.test.ts` keeps the set closed and the lockfile in step; the image
installs them with `npm ci --omit=dev`.

**And one thing that is already right:** Node 22 runs this repository's TypeScript with no build
step, verified by running it rather than by reading release notes. So there is no compile stage,
no `dist/`, no two-stage Dockerfile, and `typescript` and the `@types/*` packages are genuinely
dev-only.

⚠️ **Node 22 reaches end of life on 2027-04-30.** That is inside the plausible life of this
service. Written here so it is a calendar item rather than a surprise.

---

## 5. Deploying from GitHub Actions

A workflow on push to `dev` only authenticates through Workload Identity Federation and runs
`gcloud builds submit` with the build identity named; the build pushes the image and deploys
`venue-call-agent-dev`. That is the same shape as the other CreatoRain repositories' Cloud Build
gates. The workflow and the build file are TASK-3748 step 4.

**No key, and no second pool.** Service-account keys are blocked by default on organizations
created on or after 2024-05-03, and the project already has the `github-ci` pool with its
`creatorainco` provider. That provider lists the repositories it trusts, and this one is not on
the list yet: adding it, and pinning the condition to pushes to `dev`, is an owner's change. Done on 2026-11-14: the condition admits
`creatorainco/venue-call-agent` only when `assertion.ref == 'refs/heads/dev'`, and the dispatch
account is `ci-dispatch-vca@`. Production has its own dispatch account, bound to the one workflow
file `deploy-main.yml` on `refs/heads/main` only; §7.2 step 5.

🔴 **The provider MUST carry an attribute condition, and this is not a lint nit.** Without it, any
GitHub repository on earth can enter the pool. The existing provider conditions on the owner id
and a repository list; the binding below is then scoped to this repository alone:

```
principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github-ci/attribute.repository/creatorainco/venue-call-agent
```

### Who holds what

Each identity holds only what its one job needs, granted on the narrowest resource that works.

| identity | role | granted on | why |
|---|---|---|---|
| this repository, via the pool | `roles/iam.workloadIdentityUser` | the dispatch account | lets a `dev` push act as that account and nothing else |
| the dispatch account | `cloudbuild.builds.create` (the project's custom build-starter role) | the project | starts a build; cannot change one |
| the dispatch account | `roles/cloudbuild.builds.viewer` | the project | reads the build's status, so the workflow fails when the deploy does (`--suppress-logs`: it cannot read the log itself) |
| the dispatch account | `roles/iam.serviceAccountUser` | `venue-call-build@` only | names the build identity on the build |
| `venue-call-build@` | `roles/artifactregistry.writer` | the one repository | pushes the image |
| `venue-call-build@` | `roles/run.developer` | the one service | deploys a revision; **cannot** change who may invoke it |
| `venue-call-build@` | `roles/iam.serviceAccountUser` | `venue-call-runtime@` only | runs the revision as the runtime identity |
| `venue-call-build@` | `roles/logging.logWriter` | the project | build logs |

No identity here gets project-wide Cloud Run administration, and no identity can act as any
account other than the one named in its row. The one-time public binding in §2 is an owner's.

🔴 **Forgetting `sts.googleapis.com` is the classic first-federation failure** and it produces an
opaque token-exchange error rather than a "please enable this API" message. It is enabled here.

---

## 6. What is still genuinely unknown

Not hedges — questions with no answer available from documentation, each with what would settle it.

| question | what settles it |
|---|---|
| Cold-start latency for this container, and whether it delays the disclosure | the soak (TASK-3749). Decides whether a warm instance is worth its monthly cost; that spend is the owner's yes. |
| Does a liveness probe consume the single concurrency slot? | an empirical test on a real service. Nothing in the docs says. |
| Does closing the socket end the call, or does the carrier run what follows the stream? | a test call. Decides whether the agent's hang-up needs a carrier write it does not hold. |
| Would Cloud Run **worker pools** — which take TCP connections rather than HTTP requests — suit a media stream better? | unresearched. It may change the 60-minute ceiling entirely. |

---

## 7. Production: `venue-call-agent`, deployed from `main`

**The yes.** Peter, 2026-11-15 (venue-call plan it-09): a production Cloud Run service for this
repository, deployed on every push to `main`, keyless federation for it, `--min-instances 0` with
pb's free warm ping at dial time first. It is **dark until Arm**: the service answers the media
socket only for a call pb has accepted, and pb refuses every call until the operator arms the
Voice calls screen and the production seam is wired. A green production deploy places no call.

**What is in the repository (2026-11-15) and what is not.** `cloudbuild-prod.yaml` and
`.github/workflows/deploy-main.yml` are on `dev`; `test/deployConfig.test.ts` holds every flag in
both and fails if the production files name one value that is dev's. The production deploy job
`needs` a `verify` job that runs `verify.yml` on the commit being deployed, so a red commit never
ships even when an owner merges past the required check (`enforce_admins` is off). Nothing in
Google Cloud exists for production yet, and the provider still admits this repository for
`refs/heads/dev` only, so a push to `main` before the steps below fails at the federation step and
deploys nothing.

**Who runs the steps, and when.** They are infrastructure writes, so each is ask-then-run: the
agent asks in the dialog, gets the yes, and runs it; nobody is handed a command. They belong to
the venue-call plan's release iteration, `iterations/venue-call-agent-investigate-every-remai-2026-11-14/iteration-14.md`
in the hub, which lists them in its change set ahead of the `venue-call-agent` `dev -> main`
promote. Until they run, it-09's own verification (below, "What done looks like") is open, and the
plan's `progress.md` says so. They are written out in order so the release is a reading exercise,
not a design one.

### 7.1 The definition, and how it differs from dev

The flags are §2's, unchanged, for the same reasons. Only the values that must be production's
own differ:

| | dev | production |
|---|---|---|
| service | `venue-call-agent-dev` | `venue-call-agent` |
| backend (`CREATORAIN_API_BASE_URL`, the only variable) | `https://datadev.creatorain.com` | `https://data.creatorain.com` |
| branch, workflow, build file | `dev`, `deploy-dev.yml`, `cloudbuild.yaml` | `main`, `deploy-main.yml`, `cloudbuild-prod.yaml` |
| image repository | `venue-call-agent` | `venue-call-agent-prod` |
| runtime identity | `venue-call-runtime@` | `venue-call-runtime-prod@` |
| build identity | `venue-call-build@` | `venue-call-build-prod@` |
| dispatch identity | `ci-dispatch-vca@` | `ci-dispatch-vca-prod@` |

🔴 **Why every identity is new, not the dev one with one more grant.** The dev dispatch account can
start any build that names `venue-call-build@`. If that build identity could also deploy
`venue-call-agent`, a workflow edited on a feature branch and merged to `dev` could ship a
production revision without `main` ever moving. With separate identities, nothing a `dev` push can
act as holds a single permission on anything production. The same goes for the image repository:
the dev build cannot write a tag the production deploy reads.

**No secret, by design.** The service holds no secret and no key (`src/config.ts`, CORE-A11): pb
mints each call's token and the Google calls use the runtime identity. So there is no
`--set-secrets` and no Secret Manager reference. If one is ever needed, it is added as a Secret
Manager reference (`--set-secrets NAME=secret:version`), never a literal, and the test's allowed
flag list is changed in the same pull request so a reviewer sees it.

**The environment is rewritten on every deploy** (`--set-env-vars`). That is intended: the build
file is the only place the environment lives, so a variable set by hand on the service is gone at
the next deploy. Nothing belongs there by hand.

### 7.2 The owner's steps at the release, in order

Each one is an IAM or infrastructure write: an owner runs it, at the release, after the recorded
review of the `dev` commits. None was run on 2026-11-15.

1. **The image repository.** `gcloud artifacts repositories create venue-call-agent-prod
   --repository-format=docker --location=us-central1 --project=creatorain-27e9e`.
2. **The runtime identity** `venue-call-runtime-prod@`, with `roles/speech.client`,
   `roles/aiplatform.user`, `roles/logging.logWriter` and `roles/monitoring.metricWriter` on the
   project. Nothing else.
3. **The build identity** `venue-call-build-prod@`, with `roles/artifactregistry.writer` on
   `venue-call-agent-prod` only, `roles/iam.serviceAccountUser` on `venue-call-runtime-prod@`
   only, and `roles/logging.logWriter` on the project. Its `roles/run.developer` on the one service
   comes in step 6, once the service exists.
4. **The dispatch identity** `ci-dispatch-vca-prod@`, with the project's custom `ciBuildStarter`
   role (`cloudbuild.builds.create` only), `roles/cloudbuild.builds.viewer`, and
   `roles/iam.serviceAccountUser` on `venue-call-build-prod@` only.
5. **Federation.** On the `github-ci` pool's `creatorainco` provider, in this order, so that no
   moment exists in which a `main` push is admitted while the dev dispatcher still answers to the
   whole repository:
   1. add the mapping `attribute.workflow_ref = assertion.job_workflow_ref`. For a job defined in
      the workflow file itself, GitHub sets that claim to
      `creatorainco/venue-call-agent/.github/workflows/<file>@<ref>`;
   2. **re-run one `pb-ci` job and one `demo-ci` job** (the provider is shared, and a mapping is
      evaluated on every token it exchanges). Both must still authenticate before going on. The
      size limit is not the risk: Google caps all mapped attributes of one token at 8,192 bytes
      together (IAM quotas page, "Mapped attributes total size", read 2026-11-15), and this value is
      a repository name, a workflow path and a ref, a few hundred bytes at most;
   3. narrow the dev dispatch account's binding: grant `roles/iam.workloadIdentityUser` on
      `ci-dispatch-vca@` to
      `principalSet://iam.googleapis.com/projects/204616170539/locations/global/workloadIdentityPools/github-ci/attribute.workflow_ref/creatorainco/venue-call-agent/.github/workflows/deploy-dev.yml@refs/heads/dev`,
      then remove its `attribute.repository/creatorainco/venue-call-agent` member, and re-run
      `deploy-dev` once to prove the dev deploy still authenticates;
   4. grant `roles/iam.workloadIdentityUser` on `ci-dispatch-vca-prod@` to
      `principalSet://iam.googleapis.com/projects/204616170539/locations/global/workloadIdentityPools/github-ci/attribute.workflow_ref/creatorainco/venue-call-agent/.github/workflows/deploy-main.yml@refs/heads/main`
      and to nothing else;
   5. only now widen this repository's clause of the attribute condition from
      `assertion.ref == 'refs/heads/dev'` to
      `assertion.ref in ['refs/heads/dev', 'refs/heads/main']`.

   From then on a `main` push can act as the production dispatcher only from `deploy-main.yml`,
   and a `dev` push as the dev one only from `deploy-dev.yml`. Another workflow file merged to
   `main` (or to `dev`) can exchange a token but holds no binding on either account, and so can
   act as neither.

   ⚠️ **Why a mapped attribute and not the subject.** This repository's OIDC subject uses
   GitHub's immutable form (`repo:creatorainco@<owner id>/venue-call-agent@<repo id>:ref:...`,
   read from the repository's sub-claim setting on 2026-11-15), not the `repo:owner/name:...`
   form most examples bind. A binding written in the familiar form matches nothing and fails as
   an opaque permission error. The sub-claim setting changes only `sub`; `job_workflow_ref` keeps
   its name-based shape, which is what the bindings above are written in.
6. **The service, once, by an owner.** `venue-call-build-prod@` can deploy revisions of the one
   service but cannot create it or set who may invoke it. So the owner creates it with §2's flags
   and the production values from 7.1, from the image of the commit being promoted (built once
   with `gcloud builds submit --no-source --config=cloudbuild-prod.yaml
   --substitutions=_COMMIT_SHA=<sha>` after step 3: the image is pushed, and its deploy step fails
   as expected because the service does not exist yet), then grants `venue-call-build-prod@`
   `roles/run.developer` on `venue-call-agent`, then sets the one public binding (`allUsers` as
   `roles/run.invoker`; §2 says why a public service is not an open one).
7. **Then merge `dev` into `main`.** From here every push to `main` deploys through the workflow.

**What "done" looks like** (it-09's verification, open until steps 1 to 6 run at it-14): `GET /health` on the production URL answers
200; a stream with a made-up token is refused and opens no speech session (pb answers
`seam_disabled` until the production seam is wired, after the one-switch change ships there); and
there is no traffic, because no Twilio number points at it. Repointing a number is a separate
ask-then-run at the release, and the first production call is the operator's Arm.

### 7.3 Stopping it, and going back

The kill rungs are `docs/RUNBOOK.md` §1; the production ones name `venue-call-agent`. A bad
revision goes back with `gcloud run services update-traffic venue-call-agent
--to-revisions=<previous revision>=100 --region us-central1 --project creatorain-27e9e`; the next
push to `main` deploys forward again.

**Cold start.** `--min-instances 0` stays. pb is to call `GET /health` on this service when it
starts a dial (it-04; not on pb `dev` on 2026-11-15), which warms an instance during the seconds
the phone is ringing, for nothing. A warm
instance (§3: about $8.51 to $16 a month) is raised only if the soak shows the warm ping misses
the 1000 ms first-audio gate, and that spend is Peter's.
