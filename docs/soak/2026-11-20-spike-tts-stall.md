# Spike: the 8 s synthesis stall (it-22), 2026-11-20

Branch `spike/tts-stall`, off `origin/dev` at 8d98f07. Loopback soak only (`npm run soak:corpus`, fake legs, mock seam, real Google STT, Gemini and TTS). No carrier, no Twilio, no call placed. The JSON of every run sits beside this file.

## Where the 8 s went

The first commit adds numbers-only log lines: each TTS request's token, headers and body time, cache hits, how long a reply waited behind sentences already on the leg (`speak_wait`), and each sentence's synthesis time (`synth_ms`).

The `synthesis` stage in the soak runs from the decision to the reply's audio. It includes any wait behind sentences still playing. The 8 s readings on 2026-11-19 (8002, 8076 and 8577 ms on talks-over-most-of-disclosure, 14002 ms on talks-over-disclosure-200ms) were that wait. No vendor call was slow there. The instrumented run (first commit only, `2026-11-20-spike-tts-stall-diag.json`) shows it. Every synthesis reading over 1.5 s equals the reply's wait behind a sentence already playing. talks-over-disclosure-200ms waited 17533 ms, plain 15616 ms, talks-over-most-of-disclosure 9958 ms and wants-to-cancel 2514 ms, all `behind=sentence`. The slowest vendor render of a reply in that run took 1534 ms. The chain behind the wait has three links.

1. The venue says "Hello? Hello, who is this? ..." over the disclosure. The bridge ends the turn early on the interim "Hello?" (shortSettleMs 600).
2. The agent answers that early half with the opening, four sentences of 3 to 5 s each. The recogniser's final then comes back as a new turn (`final_new_turn`), and its answer queues behind the whole opening.
3. Barge-in cannot cut the opening. The pinned energy detector never ends a turn in the corpus bed: the bed's RMS (about 820) sits above the end threshold (600). After the venue's first word it stays in speech for the rest of the call, so `speech_started` never fires again. After 3 s of bed it gives no fresh start on any of the 47 corpus clips (`scripts/spike-floor-vad.mjs`).

A second cause is a vendor timeout with no retry. Chirp 3 HD takes 4.9 to 5.1 s to render the mock's 498-character voicemail script (`scripts/spike-tts-time.mjs`; 33.6 s of audio). The flat 4000 ms ceiling (`TTS.timeoutMs`) aborts it every time. Every baseline call logs `prerender_failed TtsUnavailable`, and a failure is not cached. A call that then needs the script ends with `internal_error TtsUnavailable`: phone-menu in all three baseline runs, and voicemail in one.

## The fix, two commits

- `TurnDetector` takes an optional `floorMarginDb`. A frame starts or holds a turn only when it is also that many dB over the 20th percentile of the last 3 s. `CascadeBridge` passes 9 dB, the margin `ForegroundSpeech` uses, for barge-in. `ScriptedBridge` and `OutputGate` keep the fixed thresholds. On the corpus, after 3 s of bed: 0 starts on 30 s of bare bed, 47 of 47 clips started, start lag 20 ms (p50) and 60 ms (p90), and every clip ended. With the fixed thresholds: 47 of 47 missed.
- The TTS ceiling grows with the sentence: max(4000 ms, 1500 ms + 12 ms a character). The voicemail script gets 7476 ms, and every sentence of 208 characters or fewer keeps 4000 ms.
- When a final turns out to be a new turn after an early end and the agent is still speaking, the early reply's sentences that are not yet on the leg are dropped. The sentence playing finishes, and the disclosure is never dropped. The bridge logs `superseded_early_reply`.

## Soak: two runs of the branch against three of `origin/dev`

All runs went one after another on one machine. Two other lanes' spikes were also running on it and shared the Google quotas.

| reading | base-r1 | base-r2 | base-r3 | stall-r1 | stall-r2 |
|---|---|---|---|---|---|
| first audio p50 | 1218 ms | 1309 ms | 1422 ms | 1247 ms | 1344 ms |
| first audio p90 | 2930 ms | 3894 ms | 3618 ms | 2347 ms | 3432 ms |
| dead air p90 | 7560 ms | 8200 ms | 8200 ms | 7540 ms | 7560 ms |
| endpointing_wire p90 | 1971 ms | 2591 ms | 2364 ms | 1532 ms | 2740 ms |
| synthesis max | 10836 ms | 9103 ms | 17511 ms | 2382 ms | 11702 ms |
| talks-over-most-of-disclosure, synthesis max | 10836 ms | 9103 ms | 10694 ms | 245 ms | 1383 ms |
| talks-over-disclosure-200ms, synthesis max | 3945 ms | 2587 ms | 17511 ms | 1323 ms | 3134 ms |
| cold start to disclosure | 1514 ms | 1661 ms | 1523 ms | 1591 ms | 1669 ms |
| who-pays turn 2 | 895 ms | 872 ms | n/a | 1817 ms | 337 ms |
| who-pays-after-comp-clause turn 2 | 689 ms | 606 ms | 609 ms | 633 ms | 618 ms |
| two-questions-then-close turns 2 / 3 | 800 / 647 ms | 332 / 615 ms | 708 / 699 ms | 643 / 626 ms | 725 / 691 ms |
| turns over 2 s / 4 s | 9 / 1 | 12 / 4 | 12 / 4 | 9 / 2 | 12 / 3 |
| unanswered turns | 1 | 3 | 3 | 0 | 1 |
| intent fallbacks | 10 | 8 | 9 | 12 | 18 |
| prerender_failed | 20 | 20 | 20 | 0 | 0 |
| calls ended by internal_error | 1 | 1 | 2 | 0 | 0 |
| superseded early replies | 0 | 0 | 0 | 5 | 5 |

`npm run verify` passes (623 tests, 0 failures). `npm run call -- --latency=900` gives 1 hard and 6 soft failures on every branch. It runs `ScriptedBridge`, so it cannot tell the branches apart.

## Reading

- The talk-over stalls are gone: 245 and 1383 ms against 9.1 to 10.8 s on talks-over-most-of-disclosure. No call ends on a TTS timeout any more, against 1 or 2 per baseline run. phone-menu now answers both turns (321 / 347 and 322 / 358 ms), where every baseline run lost its second turn. voicemail answers in 348 and 360 ms, as before.
- stall-r2's 11702 ms is a third shape that this branch does not fix. On digits-party-size the recogniser returned a second final for "Golden Crane, Marcus speaking." 6.4 s after the speech, with no early end before it. Its reply queued 11.7 s behind the opening. A rule that drops the queued tail of any reply when a new venue turn arrives would cover it. Whether an opening beat may go unsaid is a product call, so it is not in this spike.
- First audio p90 sits inside the baseline's own spread (2930 to 3894 ms). The turns that set it are recogniser endpointing (`endpointing_wire` 3.7 to 7.9 s on they-interrupt and money-minimum-spend), which this branch does not touch.
- The cold-start gate still fails, at 1591 and 1669 ms against 1000 ms.
- Real calls carry no synthetic bed. Whether the 9 dB floor holds against a real kitchen, echo of our own voice and a carrier's comfort noise needs a real call, and was not measured.

## Verdict

Take the three changes, as one PR to dev after review. They need no new dependency. The barge-in floor and the per-sentence ceiling each fix a measured failure. The supersede rule removes the 8 s class. Before the PR: unit tests for the floor (bed, a clip after bed, the fixed-threshold control going red), for the ceiling, and for the supersede. The Silero spike showed that barge-in can fire on a machine greeting; the floor detector did not cut voicemail or phone-menu in these runs, but a test should hold that.
