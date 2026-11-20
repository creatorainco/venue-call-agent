# Spike: Smart Turn v3 ends a turn on the interim (it-22, I3P-10), 2026-11-20

Branch `spike/smart-turn`, off `origin/dev` at 8d98f07. Loopback soak only (`npm run soak:corpus`, fake legs, mock seam, real Google STT, Gemini and TTS). No carrier, no Twilio, no call placed. The JSON of every run sits beside this file.

## What the branch does

Silero v5, with a 9 dB room-floor gate, marks a pause in the venue's speech. Smart Turn v3.2 (CPU ONNX, BSD-2) then reads up to 8 s of the turn's audio, upsampled from 8 to 16 kHz. Above the threshold, the turn ends on the recogniser's interim once that interim has stood 150 ms. It never ends on a goodbye cue, and only with the voice at the phone heard. The final that follows goes through the existing same-turn check. Barge-in stays on the energy detector, so the effect measured is Smart Turn's own.

The Whisper log-mel features are computed in TypeScript. Pure tones land on the expected mel bins (1 kHz on bin 26, 3 kHz on bin 54), but no Python reference run was possible here. On the 47 corpus clips the model said "complete" on 35 whole clips. Cut at the middle of the speech, it said "incomplete" on 19. Most of the misses were one- or two-word turns. A reading takes 58 to 88 ms at p50 and 78 to 115 ms at p90, about 40 ms of it the features. That work blocks the event loop.

Two settings were soaked. The default, from Pipecat, uses a 200 ms pause and a 0.5 threshold. The strict one (`VCA_SMART_TURN_PAUSE_MS=400 VCA_SMART_TURN_THRESHOLD=0.8`) uses a 400 ms pause and 0.8.

## Soak: two runs of each setting against three of `origin/dev`

All runs went one after another on one machine. Two other lanes' spikes were also running on it and shared the Google quotas.

| reading | base-r1 | base-r2 | base-r3 | default r1 | default r2 | strict r1 | strict r2 |
|---|---|---|---|---|---|---|---|
| first audio p50 | 1218 ms | 1309 ms | 1422 ms | 1101 ms | 1078 ms | 1317 ms | 1311 ms |
| first audio p90 | 2930 ms | 3894 ms | 3618 ms | 1875 ms | 2114 ms | 2119 ms | 1635 ms |
| dead air p90 | 7560 ms | 8200 ms | 8200 ms | 7560 ms | 7560 ms | 7560 ms | 7560 ms |
| endpointing_wire p90 | 1971 ms | 2591 ms | 2364 ms | 1120 ms | 1226 ms | 1144 ms | 1200 ms |
| synthesis p90 | 971 ms | 825 ms | 1073 ms | 3722 ms | 2749 ms | 1558 ms | 1775 ms |
| synthesis max | 10836 ms | 9103 ms | 17511 ms | 16388 ms | 15825 ms | 13403 ms | 11136 ms |
| cold start to disclosure | 1514 ms | 1661 ms | 1523 ms | 1665 ms | 1616 ms | 1728 ms | 1794 ms |
| who-pays turn 2 | 895 ms | 872 ms | n/a | 2398 ms | 2045 ms | 456 ms | 565 ms |
| who-pays-after-comp-clause turn 2 | 689 ms | 606 ms | 609 ms | 455 ms | 360 ms | 543 ms | 531 ms |
| two-questions-then-close turns 2 / 3 | 800 / 647 ms | 332 / 615 ms | 708 / 699 ms | 322 / 326 ms | 391 / 379 ms | 321 / 566 ms | 599 / 528 ms |
| turns over 2 s / 4 s | 9 / 1 | 12 / 4 | 12 / 4 | 3 / 2 | 6 / 3 | 5 / 1 | 4 / 1 |
| unanswered turns | 1 | 3 | 3 | 1 | 2 | 1 | 1 |
| intent fallbacks | 10 | 8 | 9 | 12 | 13 | 15 | 17 |
| venue turns played (of 47) | 47 | 47 | 46 | 44 | 42 | 47 | 44 |
| calls ended by internal_error | 1 | 1 | 2 | 1 | 2 | 2 | 2 |
| early ends: cue / Smart Turn | 29 / 0 | 29 / 0 | 28 / 0 | 9 / 30 | 10 / 28 | 14 / 24 | 13 / 23 |
| final answered as a new turn | 4 | 4 | 5 | 11 | 13 | 4 | 6 |

`npm run verify` fails one test: `test/dependencies.test.ts`, "the runtime dependencies are exactly the permitted set". npm writes an optional dependency into the lockfile's root `dependencies`, so moving onnxruntime-node to `optionalDependencies` does not take it out of the shipped set, and the guard catches it. That is the guard working. The branch keeps it red: adding the package to `RUNTIME_DEPENDENCIES` is the PR's decision, with the measured reason. The other 622 tests pass. `npm run call -- --latency=900` gives 1 hard and 6 soft failures on every branch. It runs `ScriptedBridge`, which this spike does not touch, so it cannot tell the branches apart.

## Reading

- Smart Turn cuts the recogniser's endpointing wait. `endpointing_wire` p90 falls from 1971 to 2591 ms to 1120 to 1226 ms in all four runs. First audio p90 falls from 2930 to 3894 ms to 1635 to 2119 ms. The turns over 4 s fall from 1 to 4 per run to 1 to 3.
- The default setting splits turns. When the venue pauses between two sentences ("Is it 7:15 or 7:45? We've got a 7 o'clock and an 8:30 already."), it ends the turn after the first one. The agent answers that half, then answers the second half again (`final_new_turn` 11 and 13 against 4 or 5). It also ends calls a turn early: digits-party-size, digits-callback-number, digits-time, money-covered-amount and money-minimum-spend lost their last turn in one or both runs. The extra replies then queue behind each other, so synthesis p90 rises to 2.7 to 3.7 s, and who-pays turn 2 doubles.
- The strict setting keeps most of the latency gain and fewer of the splits. Strict r1 played all 47 turns, with 4 new-turn finals, the same as the baseline. Strict r2 still lost two calls' last turns. On money-minimum-spend it split "We have a $25 per person minimum on Fridays ... Is that okay?". On digits-party-size the intent model read "confirm" on the turn after an early "Golden Crane, Marcus speaking." and closed the call.
- The fact turns stay at 320 to 600 ms. They were fast already from the carried facts.
- The cold-start gate fails on every run. The strict runs read 1728 and 1794 ms: loading two ONNX sessions in the warm-up adds about 100 to 200 ms to a path that is already over its 1000 ms limit.
- The 8 kHz risk is real but small on this corpus. The model was trained at 16 kHz and the line has nothing over 4 kHz, yet it separated whole from half sentences on multi-word turns. It is weakest on one- or two-word turns, where the existing short-turn and cue rules already decide.
- Not measured: how it does with human voices, real kitchens and real carrier audio. That needs the human-voiced corpus (I3P-16) and then a real call.

## Verdict

Smart Turn is the only spike here that moves first audio p90 outside the baseline's own spread. It is not ready to ship. A split turn makes the agent answer twice and can end a call early, which is a behaviour regression against the baseline. Next step: put the strict setting on top of `spike/tts-stall`, whose supersede rule drops the reply to a split turn's first half, and soak that pair. It would also need the human-voiced corpus before any PR. The fourth runtime dependency (onnxruntime-node) has a measured latency gain here. Whether that gain justifies the dependency, given the cold-start cost, is a call for the PR, not this spike.
