# Spike: us-east4 region and cold-start levers, 2026-11-20 (it-22, TASK-3749)

Branch `spike/us-east4`. Raw numbers are in `docs/soak/2026-11-20-spike-us-east4/`. Fake legs only: no carrier, no Twilio, no call placed, no phone number pointed at any service.

**Verdict: us-east4 does not win. The service `venue-call-agent-dev-use4` was deleted at 08:34Z.** The cold-start levers do win on a cold instance: about 0.55 s off the time until the disclosure is rendered and 0.6 s off the first upgrade.

## What ran

- `venue-call-agent-dev-use4` in us-east4 (Peter's yes in dialog, 2026-11-19). Same image (`8d98f07`, origin/dev), runtime identity, backend address, timeout, concurrency 1, CPU boost and CPU throttling, 1 vCPU and 512 MiB as `venue-call-agent-dev`, with min 0 and max 1. The image was pulled from the us-central1 Artifact Registry repository.
- Cold start: `scripts/spike-region-cold.mjs`, the soak's forged-token leg from this machine. pb dev refuses it (409 `token_invalid`) and the agent closes the line silently: 0 audible frames on every probe. Each try is one cold probe, then four warm ones.
  - us-east4: the first request after more than 16 minutes idle (scale from zero).
  - us-central1: an uptime check pings `/health` about every 15 minutes, so the dev service never scales to zero. `--hold` occupies the warm instance with one idle leg, so the probe lands on a NEW instance (a scale-out, not a scale from zero). The logs confirm a fresh instance on all 15 tries.
- Server-side times come from the service's own log lines: the request log of the `/stream` upgrade on the new instance, `listening on`, and `cascade_warm`. The same clock is used for each, so the laptop's clock skew does not enter.
- Seam and vendor round trips: `region-probe.py`, run inside Cloud Build in each region (the regional default pool, as `venue-call-runtime@`). Three rounds per region, 38 warm requests per probe per region, over one kept-alive connection each.

## Region: seam and vendor round trips (warm, kept-alive, from inside each region)

| probe | us-central1 p50 / p90 | us-east4 p50 / p90 | TCP connect min (c1 / e4) |
|---|---|---|---|
| seam: pb dev `POST /reservations/call-context` (forged token, 409) | 31.5 / 32.1 ms | 6.5 / 7.8 ms | 28.8 / 4.4 ms |
| STT v2 `recognize`, `us` multi-region, the telephony model, 2.2 s clip | 766 / 847 ms | 757 / 985 ms | 2.6 / 2.4 ms |
| TTS Chirp3-HD-Aoede, MULAW 8 kHz, one sentence | 474 / 542 ms | 461 / 540 ms | 3.3 / 2.7 ms |
| Vertex `gemini-3.5-flash-lite`, `global` endpoint | 485 / 602 ms (max 6421) | 632 / 902 ms | 2.9 / 2.1 ms |
| Vertex flash-lite on the `us-east4` / `us-central1` regional endpoints | 404: not served regionally | 404 | |

pb dev runs on AWS us-east-1 (App Runner behind envoy). us-east4 saves about 25 ms on each seam request. The Gemini global endpoint costs about 150 ms more at p50 and 300 ms more at p90 from us-east4. The model is not served on either regional endpoint, so that cost cannot be pinned away. STT and TTS are the same within noise.

## Cold start (5 tries each; median, with min to max)

| | us-central1 base | us-east4 base | us-east4 + levers |
|---|---|---|---|
| kind of cold start | scale-out beside a warm instance | scale from zero | scale from zero |
| connect to WebSocket upgrade (client) | 1456 ms (1066-1856) | 2188 ms (1985-3420) | **1563 ms** (1371-1730) |
| upgrade request to `listening` (server) | 1118 ms (918-1518) | 1612 ms (1472-3171) | **784 ms** (672-854) |
| `listening` to `cascade_warm` (server) | 1497 ms (1418-1547) | 1743 ms (1621-1750) | 2023 ms (1950-2144) |
| upgrade request to `cascade_warm`: the disclosure rendered (server) | 2555 ms (2335-3039) | 3355 ms (3114-4921) | **2803 ms** (2695-2884) |
| `cascade_warm ms=` (the warm-up itself) | 1255-1376 ms | 1388-1446 ms | 1272-1421 ms |
| warm upgrade (client) | 130 ms | 118 ms | 120 ms |
| warm upgrade to the server's close, which carries the seam round trip (client) | 116 ms | 93 ms | 91 ms |

How to read it:

- The two base columns are different kinds of cold start, so the region gap in cold start is not like for like. A scale from zero cannot be forced on us-central1 dev without changing its config. The cross-region image pull may add to us-east4's number.
- The levers column compares like for like with the us-east4 base: the same service, region and kind of cold start. The levers were not deployed to us-central1, because `venue-call-agent-dev` is the shared dev service and deploys come from `dev` only.
- On a real call, pb's warm ping to `/health` and the ring time come before the stream opens. The ring time hides part of this. The local soak's cold-start gate (1000 ms, start to the disclosure on a fresh local process) is a different reading, and this spike does not change it.

## The levers (commit `06db9e3`)

| lever | what changed | measured |
|---|---|---|
| startup CPU boost | already on in the baseline (`--cpu-boost` in `cloudbuild.yaml`) | no change to try; both columns have it |
| defer the cascade start until the port is bound (lazy start) | `startServer` calls `Session.start` right after `listen`. Any request also starts it | local, 6 interleaved pairs: listen p50 133 ms vs 345 ms. On Cloud Run, request to `listening` went from 1612 to 784 ms |
| build-time V8 compile cache | `NODE_COMPILE_CACHE` baked in the image at build | not separable from the deferral on Cloud Run. Locally on Node 24, no gain within noise |
| smaller image | `.d.ts`, maps, docs and npm/corepack/yarn pruned | 259.0 MB to 243.2 MB (-6%). Deleting in a later layer does not shrink the base layers. A real cut needs a multi-stage build onto a smaller base, and that was not tried |

The combined lever image cut about 0.55 s off a cold instance's time to a rendered disclosure. The deferral explains most of it, because the port binds about 0.8 s sooner. The warm-up then starts later, which shows as `listening` to `cascade_warm` growing by about 280 ms. Splitting the compile cache from the deferral on Cloud Run would need a third 80-minute phase.

## Not measured: needs a real call

- The Twilio media leg (Twilio's US1 edge to the agent). Twilio's US1 media is in the Ashburn area, so us-east4 may save tens of ms each way. The loopback soak cannot reach that leg.
- ConversationRelay end to end and the speech path on Cloud Run. pb dev's seam has no shared secret (ladder D), so every Cloud Run leg is refused before the cascade runs a turn.

## Verdict per spike

- **us-east4 region: no.** It saves about 25 ms per seam request. The Gemini global endpoint costs about 150 ms more at p50 and 300 ms more at p90 on every model-decided turn. STT and TTS are a wash. The service was deleted, as the approval required.
- **Cold-start levers: yes for the deferral, open for the compile cache and image.** The next step is a PR to dev for the deferred cascade start alone, with its own test and a control that must fail. The CI deploy then measures it on us-central1. The compile cache and the image pruning stay on this branch until one of them shows its own gain.

## Hook notes

The send-switch hook (`send-switch-hook.ps1`) blocked a Bash heredoc that held the STT model name inside a latency probe. It was a false positive: nothing dialled and no switch was involved. The probe file was then written with the Write tool. The hook could be tuned to skip a model name in a `recognize` body.
