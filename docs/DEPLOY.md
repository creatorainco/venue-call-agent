# Deploying this service — the definition, and the checklist behind it

🔴 **THE DEV SERVICE EXISTS; NO PRODUCTION SERVICE DOES.** The research behind this page was read
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
  --cpu-throttling
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
account is `ci-dispatch-vca@`.

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
