# Spike: Silero VAD for barge-in (it-22, I3P-09), 2026-11-20

Branch `spike/silero-vad`, off `origin/dev` at 8d98f07. Loopback soak only (`npm run soak:corpus`, fake legs, mock seam, real Google STT, Gemini and TTS). No carrier, no Twilio, no call placed. The JSON of every run sits beside this file.

## What the branch does

Silero v5 runs on the line's 8 kHz audio over onnxruntime-node 1.30.0. It loads only when `VCA_SILERO_MODEL` names the model (`node scripts/fetch-turn-models.mjs <dir>` fetches it and checks its sha256). When loaded, it replaces the energy `TurnDetector` in `CascadeBridge` for barge-in and for the last audible frame. A chunk counts as speech at a Silero score of 0.6 or more, and only when it also stands 9 dB over the room's floor.

## Offline, on the noise corpus (`scripts/compare-vad.mjs`)

Silero alone calls the corpus bed speech: its median score on the bare bed is 0.87, and it counts 97% of the bed as speech. The bed's babble is synthesised speech, so this is correct for Silero and useless for barge-in. With the 9 dB room-floor gate, Silero fires 0 times on 30 s of bed, catches all 47 clips, starts 100 ms (p50) and 120 ms (p90) after the speech, and ends 680 / 740 ms after it.

The level-only control gives the same gate with Silero's score held at 1. On the same corpus its numbers are identical to Silero plus the gate: 0 bed starts, 47 of 47 clips, the same start and end lags. Silero adds nothing over the level gate on this corpus.

The energy detector at the pinned settings never ends a turn in this bed. The bed's RMS (about 820) sits above its end threshold (600). After 3 s of bed it is stuck in speech, and it gives no fresh start on any of the 47 clips (the spike-floor-vad script on `spike/tts-stall`). So on the line today barge-in fires once per call at most.

## Soak: two runs of the branch against three of `origin/dev`

All runs went one after another on one machine. Two other lanes' spikes were also running on it and shared the Google quotas. Two earlier runs were set aside: one overlapped a network outage, and one overlapped a second soak by mistake.

| reading | base-r1 | base-r2 | base-r3 | silero-r1 | silero-r2 |
|---|---|---|---|---|---|
| first audio p50 | 1218 ms | 1309 ms | 1422 ms | 1494 ms | 1466 ms |
| first audio p90 | 2930 ms | 3894 ms | 3618 ms | 4978 ms | 6337 ms |
| dead air p90 | 7560 ms | 8200 ms | 8200 ms | 8200 ms | 7920 ms |
| endpointing_wire p90 | 1971 ms | 2591 ms | 2364 ms | 2645 ms | 1965 ms |
| synthesis max | 10836 ms | 9103 ms | 17511 ms | 12089 ms | 17117 ms |
| cold start to disclosure | 1514 ms | 1661 ms | 1523 ms | 1637 ms | 1501 ms |
| who-pays turn 2 | 895 ms | 872 ms | n/a | 803 ms | 742 ms |
| who-pays-after-comp-clause turn 2 | 689 ms | 606 ms | 609 ms | 642 ms | 648 ms |
| two-questions-then-close turns 2 / 3 | 800 / 647 ms | 332 / 615 ms | 708 / 699 ms | 733 / 736 ms | 810 / 611 ms |
| turns over 2 s / 4 s | 9 / 1 | 12 / 4 | 12 / 4 | 13 / 7 | 9 / 5 |
| unanswered turns | 1 | 3 | 3 | 3 | 2 |
| intent fallbacks | 10 | 8 | 9 | 22 | 9 |
| calls ended by internal_error | 1 | 1 | 2 | 2 | 2 |
| Silero barge-ins | 0 | 0 | 0 | 3 | 3 |

`npm run verify` fails one test: `test/dependencies.test.ts`, "the runtime dependencies are exactly the permitted set". npm writes an optional dependency into the lockfile's root `dependencies`, so moving onnxruntime-node to `optionalDependencies` does not take it out of the shipped set, and the guard catches it. That is the guard working. The branch keeps it red: adding the package to `RUNTIME_DEPENDENCIES` is the PR's decision, with the measured reason. The other 622 tests pass. `npm run call -- --latency=900` gives 1 hard and 6 soft failures on every branch. It runs `ScriptedBridge`, which this spike does not touch, so it cannot tell the branches apart.

## Reading

- The cold-start gate fails on every run, at 1501 to 1669 ms. Loading Silero in the warm-up adds nothing visible.
- The branch's first audio p90 is higher (4978 and 6337 ms). The turns that set it are the recogniser's endpointing (`endpointing_wire` 4061 to 7722 ms on money-minimum-spend and digits-callback-number) and a run with 22 intent fallbacks. Silero does not touch either path, so this is run noise.
- Silero barge-in fires 3 times a run: in voicemail, phone-menu and talks-over-most-of-disclosure. In talks-over-most-of-disclosure it cut the agent's own sentences and removed the reply stall there. In voicemail and phone-menu the machine greeting cut the agent. Both calls then ended with `internal_error TtsUnavailable` in both runs: the agent reached for the 498-character voicemail script, whose render always times out at 4 s (see `spike/tts-stall`). The baseline answered those first turns in about 350 ms, and then lost phone-menu the same way in all three runs and voicemail in one.
- The fact turns do not move. That path is the carried facts' cache, which Silero does not touch.

## Verdict

Do not take Silero. On this corpus a level gate over a floor that follows the room does exactly what Silero plus that gate does, with no fourth runtime dependency. vca `CLAUDE.md:35` asks for a measured gain, and there is none. The real finding is that barge-in is dead in noise today. `spike/tts-stall` fixes that without a dependency. Two open items stand either way. Barge-in must not fire on a machine greeting during voicemail or a phone menu. And a human-voiced corpus could still show Silero ahead where a nearby talker is as loud as the person at the phone (README, I3P-16).
