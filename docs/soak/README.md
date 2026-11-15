# Loopback soak reports

Each `<date>.md` here is one run of `npm run soak:corpus` (`scripts/soak-corpus.mjs`), with its
numbers in `<date>.json` beside it. Fake legs only: the driver (`src/soak/corpus.ts`) opens the
media WebSocket the way Twilio does and plays a recorded venue into it. No carrier, no call placed.

```
npm run soak:render                       # once, or after soak/fixtures/scripts.json changes
npm run soak:corpus -- --dev-url https://<venue-call-agent-dev> \
    --out docs/soak/<date>.json --md docs/soak/<date>.md
```

What a run measures, and where each number comes from, is in the header of
`scripts/soak-corpus.mjs`. The thresholds are in `soak/soak.config.json`.

## Two stages, and why the turn path is local today

- **venue-call-agent-dev**: cold start (connect to upgrade on an instance scaled to zero) and the warm
  edge, with a forged token the backend refuses. The speech path cannot be reached there yet: a
  session is authorised by a token platform-backend mints on a dial, and pb dev's seam stays off
  until the owner sets its shared secret by hand at ladder D.
- **Local runtime**: `node src/server/main.ts` exactly as the container runs it, seam pointed at the
  repo's mock seam, with the real Google STT, Gemini and TTS. This is the turn path: first audio,
  dead air, intent latency and disclosure integrity. A local user login needs a billing-project
  header that the service account on Cloud Run does not, so the soak preloads
  `scripts/soak-local-quota.mjs` into that process only.

When pb dev's seam is on (stage S2 in the TASK-3749 plan), the same corpus runs against
venue-call-agent-dev end to end and the seam's share of the delay is added.

## Corpus: synthetic now, human-voiced next

| set | status | where |
|---|---|---|
| Synthetic: 20 calls (15 conversation fixtures + 5 digit and money scripts), 47 clips, Google TTS non-Chirp voices over a procedural restaurant bed | in use | `soak/fixtures/` |
| **Human-voiced: 20 calls voiced by Peter and staff, with a restaurant-noise bed** | **slot open: not recorded yet** | add as `soak/fixtures/human/` with its own `manifest.json` in the same shape, then run the soak with it and commit the report here |

Recording notes for the human set, so it drops into the same driver: the same 20 scripts as
`soak/fixtures/scripts.json`, one file per venue turn, 8 kHz mono μ-law, 200 ms of room before and
300 ms after each turn, `speech_start_ms` and `speech_end_ms` marked. Synthetic speech flatters
recognition; the human set is what the latency gate and the digit and money accuracy are finally
held to (I3P-16).
