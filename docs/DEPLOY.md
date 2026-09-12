# Deploying this service — the definition, and the checklist behind it

🔴 **NOTHING ON THIS PAGE HAS BEEN EXECUTED.** Every flag, role, API and price below was read out
of Google's own documentation on **2026-09-12** and cross-checked by a second pass that was asked
to refute it. Not one line has been run against a real project, because that needs a signed-in
console and that is not an engineer's to do here.

So treat this as **the research already done, not the work already done**. The remaining job is to
open the console and find out which of these is wrong — which is a different afternoon from
starting at a blank page, and it is the honest state of it.

🔴 **A DEPLOYED SERVICE IS NOT A DIALLING SERVICE.** Nothing here places a call, and a green
deploy opens no gate. TASK-973 and Peter's per-act yes are a separate approval that this page
does not touch.

---

## 0. Why you would deploy at all

Read `docs/TEST-ENVIRONMENT.md` first. Tiers 0, 1 and 2 — the whole decision layer, the telephone
layer, and a real model session — all run on a laptop. Hosting buys **one** thing: a public
address a carrier can connect to. That is tier 3.

So the ordering is: settle the carrier question, then deploy. Deploying first produces an
endpoint with nothing to connect to it.

---

## 1. What must exist before the first deploy can succeed

Executable in order, in a console. The ordering is not cosmetic — step 3 creates the account
step 4 grants to.

1. **A project with billing enabled.** Which project is itself an open question: nobody has
   confirmed Cloud Run is enabled in the one that bills our AI usage. That is the approval-gated
   item on TASK-967.
2. **Enable three APIs:** `run.googleapis.com`, `cloudbuild.googleapis.com`,
   `artifactregistry.googleapis.com`.
3. **Grant the deployer** (the human, running gcloud locally): `roles/run.sourceDeveloper`,
   `roles/serviceusage.serviceUsageConsumer`, `roles/iam.serviceAccountUser`.
4. **Grant `roles/run.builder`** to `PROJECT_NUMBER-compute@developer.gserviceaccount.com`.
   ⚠️ **This is the single most likely first-deploy failure**, and it surfaces as a Cloud *Build*
   permission error rather than a Cloud Run one, which sends people looking in the wrong place.
   It is not automatic on organizations created on or after **2024-05-03**. Enabling
   `run.googleapis.com` in step 2 is what creates that service account, so this step cannot come
   first; give it a minute to propagate.
5. **Pick a region** supported by both Artifact Registry and Cloud Build. An Artifact Registry
   repository named `cloud-run-source-deploy` is created automatically on first deploy, so it is
   **not** a prerequisite — one of the few things you can skip.

⚠️ **A human deploying by hand needs `roles/run.sourceDeveloper`. The CI service account, per the
action's own README, needs `roles/run.admin`.** Do not grant `run.admin` to a person because the
CI documentation said so.

---

## 2. The service definition, flag by flag, with the reason for each

```bash
gcloud run deploy venue-call-agent \
  --source . \
  --region "$REGION" \
  --timeout 3600 \
  --concurrency 1 \
  --max-instances 5 \
  --min 0 \
  --cpu-throttling \
  --no-allow-unauthenticated \
  --set-env-vars GOOGLE_NODEJS_VERSION=22.18.0
```

| flag | why, and what it costs to get wrong |
|---|---|
| `--timeout 3600` | A WebSocket on Cloud Run **is an HTTP request** and dies at the service request timeout. The default is **300 s — five minutes — and a venue call can outlive that.** 3600 s is the documented maximum. |
| `--concurrency 1` | One call per connection per instance. Each open socket saturates its instance and Cloud Run starts another for the next call, so there is no queueing logic to write. |
| `--max-instances 5` | With concurrency 1 this **is** the ceiling on simultaneous calls. It is also the blast radius if something ever loops, and a crude spend cap. Set it on purpose; the default is 100. |
| `--min 0` | Accept cold starts and pay nothing between calls. `--min 1` costs roughly **$5–10/month** for a warm instance. Which is right depends on a cold-start figure nobody has measured, because no container exists yet. |
| `--cpu-throttling` | Request-based billing — the default, stated explicitly so nobody "fixes" it. See §3. |
| `GOOGLE_NODEJS_VERSION` | See §4. Without it the buildpack may run a different Node than CI does. |

### Two flags NOT to set, and why they look right

**`--session-affinity`. Do not.** It sounds necessary for WebSockets and is not: a single
WebSocket is inherently pinned to one instance for its whole life — *"the client will stay
connected to the same container on Cloud Run throughout the lifespan of the connection."*
Affinity only influences where a **new** connection lands, it is best-effort, it works through a
30-day cookie that a telephony media client does not carry, and — the part that bites — **it
takes precedence over traffic splitting**, so it silently disables canary deploys.

🔴 An earlier version of the epic said "session affinity must be on". That was wrong, and it is
corrected here and there.

**An external load balancer, to get a longer connection.** It does not work. For backend services
with serverless NEG backends the timeout is a fixed, non-configurable 60 minutes, and setting
`timeoutSec` is a hard error: *"Timeout sec is not supported for a backend service with
Serverless network endpoint groups."* If a call ever needs more than 60 minutes, Cloud Run is the
wrong host — that is an architecture change, not a config one. (Our cap is six minutes, so this
is a fence, not a problem.)

⚠️ **The docs contradict themselves on whether 3600 is inclusive.** One page says "can be extended
up to 60 minutes (3600 seconds)", another says "must be less than 60 minutes", and the console
says "1 to 3600". Write 3600; if the API refuses it, use 3599 and do not go looking for a bug in
our configuration.

⚠️ **`--concurrency 1` is the opposite of what Google's WebSockets page recommends**, and a future
reader will "fix" it back to 80. It is written down here so they read this first. Their example is
chat: many idle sockets on one instance. Ours is a call: continuous CPU-bound audio, one human on
the line, and one bad neighbour is a restaurant hearing stutter.

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
| request-based, `--min 1`, fully idle | $9.86 | **$4.64** |
| instance-based, always on | $49.93 | $44.71 |

**The break-even duty cycle is ~71%.** Below that, request-based wins; above it, instance-based
does. At this feature's expected load — say thirty five-minute calls a day, about a 10% duty
cycle — request-based with a warm instance lands near **$16/month**, and `--min 0` makes it
roughly nothing plus cold starts.

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

## 4. Three things in this repository that would break the first deploy

Found by reading the container contract against what is actually here. None is hard to fix and
all three are silent until the deploy fails.

**1. There is no `start` script and no Procfile.** The Node buildpack's entrypoint is
`scripts.start`, falling back to `npm start`. `package.json` has neither, so
`gcloud run deploy --source` cannot produce a runnable container today. The cheapest fix is a
**Procfile** — `web: node src/<entrypoint>.ts` — because it leaves the test-facing scripts alone
and bypasses npm at runtime. It is deliberately not committed yet: there is no service entrypoint
to point it at until TASK-970 writes one.

**2. `engines.node` is `">=22.18"`, and Google explicitly says avoid `>` specifiers.** The
buildpack reads `engines.node` (or `GOOGLE_NODEJS_VERSION`, which wins) and may resolve that to
Node 24 or 26 — a silent drift between the runtime CI tests on and the runtime production runs.
Hence the env var in §2. Do not narrow `engines.node` itself; a developer with Node 24 should
still be able to work here.

**3. The only HTTP server in the repo binds `127.0.0.1:8788`.** That is correct for
`src/mock/server.ts`, which must never be reachable. It is also exactly the `listen()` call
somebody will copy into the real service, and Cloud Run requires **`0.0.0.0` on `$PORT`**
(default 8080), listening within four minutes of start. Whatever entrypoint gets written must
read `process.env.PORT ?? 8080` and bind all interfaces.

**And one thing that is already right:** Node 22 runs this repository's TypeScript with no build
step, verified by running it rather than by reading release notes. So there is no compile stage,
no `dist/`, no two-stage Dockerfile, and `typescript` and `@types/node` are genuinely dev-only.

⚠️ **Node 22 buildpack support has an end date: 2027-04-30 (deprecation), 2027-10-31
(decommission).** That is inside the plausible life of this service. Written here so it is a
calendar item rather than a surprise.

---

## 5. Deploying from GitHub Actions

Pin the current majors — `google-github-actions/auth@v3` and
`google-github-actions/deploy-cloudrun@v3`. The action shells out to `gcloud run deploy`, so
everything in §2 goes through its `flags:` input and the definition stays one YAML block.

⚠️ **Do not copy Google's own example workflow for this.** The published example still pins
`auth@v0`, `deploy-cloudrun@v0` and `checkout@v2` — three majors stale. Use the README usage block
from `deploy-cloudrun@v3` instead. The example file's *header comment* is still worth reading: it
is the most compact statement of the APIs and roles a from-source deploy needs.

### The credential: a key, or federation

By Google's own step counts: a **service-account JSON key** is 3 steps, **direct Workload Identity
Federation** is 5, and **WIF through a service account** — the configuration the action's own
README documents — is 7.

**Recommend WIF through a service account, and not primarily because of the secret.** On any
Google Cloud organization created on or after **2024-05-03**, service-account key creation is
blocked by default by an enforced org policy. The "3-step fast path" may simply not be available,
and planning around a key we may be unable to mint is how a deploy day gets lost. If the org turns
out to predate that and the operator wants the fast path, the key variant is a three-line diff.

WIF needs four **more** APIs on top of §1: `iam.googleapis.com`,
`cloudresourcemanager.googleapis.com`, `iamcredentials.googleapis.com`, `sts.googleapis.com`. The
person configuring it needs `roles/iam.workloadIdentityPoolAdmin`.

🔴 **Forgetting `sts.googleapis.com` is the classic first-WIF failure** and it produces an opaque
token-exchange error rather than a "please enable this API" message.

🔴 **The provider MUST carry an attribute condition, and this is not a lint nit.** Without it, any
GitHub repository on earth can enter the pool:

```
--attribute-condition="assertion.repository_owner == 'creatorainco'"
```

and the IAM binding must be scoped to this repository alone:

```
principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL/attribute.repository/creatorainco/venue-call-agent
```

---

## 6. What is still genuinely unknown

Not hedges — questions with no answer available from documentation, each with what would settle it.

| question | what settles it |
|---|---|
| Is Cloud Run enabled in the project that bills our AI usage? | one console read. **This is the approval-gated item on TASK-967.** |
| Was the org created on or after 2024-05-03? | one console read. Decides whether SA keys are mintable and whether `roles/run.builder` must be granted by hand. |
| Cold-start latency for this container | a first deploy. Decides whether `--min 1` (~$5–10/mo) is needed or `--min 0` is fine. |
| Does a liveness probe consume the single concurrency slot? | an empirical test on a real service. Nothing in the docs says. |
| Is direct WIF (no service account) enough for `deploy-cloudrun`? | a real deploy. The auth README implies a service account is required for OAuth tokens; the action's example sets one. |
| Does the eventual carrier need a custom domain, a static egress IP, or IP allowlisting? | picking a carrier. Cloud Run gives a `*.run.app` URL; anything beyond that is extra deploy surface. |
| Would Cloud Run **worker pools** — which take TCP connections rather than HTTP requests — suit a media stream better? | unresearched. It may change the 60-minute ceiling entirely. |

**Do not create anything in Google Cloud to answer these.** Surface them; the console is Peter's.
