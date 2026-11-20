# Iteration-22 engine spikes: Gemini Live on Vertex and ConversationRelay (2026-11-20)

Both spikes ran on the loopback only. No carrier, no Twilio endpoint, no call of any kind. The baseline is the cascade on origin/dev, script v7 (`docs/soak/2026-11-19.md`).

Raw reports:

- Gemini Live, repo VAD values: `docs/soak/2026-11-20-spike-live-vertex-defaults.{md,json}` (branch `spike/live-vertex`).
- Gemini Live, fastest end of turn: `docs/soak/2026-11-20-spike-live-vertex-fast.{md,json}` (branch `spike/live-vertex`).
- ConversationRelay, our half: `docs/soak/2026-11-20-spike-conversationrelay.{md,json}` (branch `spike/conversationrelay`).

## Gemini Live on Vertex (`gemini-3.8-live`, us-central1)

`scripts/spike-live-vertex.mjs` puts a Twilio-shaped bridge in front of one Live session per call and plays the same 20-call corpus through the same `runCorpusCall` driver as the cascade soak. Each call reads its context from the mock seam. The system instruction is the backend's own, plus its disclosure, opening lines and static facts. The bridge has no tool calls, no hangup, no output gate and no AMD, so these numbers flatter Live.

| measure (ms) | cascade v7 (11-19) | Live, repo VAD | Live, fast VAD |
|---|---|---|---|
| first audio p50, unanswered charged 8000 | 1413 | 1359 | 1154 |
| first audio p90, unanswered charged 8000 | 2584 | 8000 | 8000 |
| first audio p50 / p90, answered turns only | 1413 / 2584 (45 of 46) | 1192 / 1922 (34 of 47) | 1098 / 1462 (37 of 47) |
| venue turns with no answer | 1 of 46 | 13 of 47 | 10 of 47 |
| turns where the model began while the venue was still talking | n/a | 1 | 4 |
| model interruptions (barge-in) | n/a | 2 | 8 |
| dead air p90 | 7560 | 14040 | 14020 |
| cold start, `start` to disclosure, first call | 1374 | 3403 (2415 of it the first ADC token) | 7006 (6121 of it the first ADC token) |
| cold start less the token fetch | n/a | 988 | 885 |
| warm calls, `start` to disclosure p50 / p90 / max | 3 / 4 / 6 | 870 / 994 / 1092 | 877 / 1065 / 1206 |
| disclosure word recall, lowest | 0.93 | 0.91 | 0.91 |

Where the start-to-disclosure time goes on a warm call (repo VAD, p50): WebSocket connect 226, setup 119, setup to the first model audio 487.

Findings:

- Vertex Live accepted `audio/pcm;rate=8000` and then heard nothing. The bridge upsamples to 16 kHz, and only then does the model hear the venue. The repo comment in `src/audio/format.ts` that Live resamples 8 kHz input does not hold on this model.
- `gemini-3.8-live` exists in us-central1 only for this project. us-east4 and global return close code 1008, model not found.
- The silent turns include real questions (`unknown-question` turn 2, `money-covered-amount` turn 2 under repo VAD) and short openers such as "Hello?". In `who-pays` the model ended the venue's turn at the pause in "Hang on - who's paying for this meal?", replied to "Hang on" and never heard the question.
- Every call pays connect, setup and generation before the disclosure (about 0.85 s). The cascade plays a pre-rendered disclosure in 3 ms. Live cannot meet the 1000 ms cold-start gate with margin unless the session is opened before the call starts, and that is not measured here.
- Live phrases every sentence itself. The cascade speaks only backend sentences, which the no-facts rule and the fabrication check depend on.

Verdict: do not adopt. On the turns it answers, Live is faster than the cascade (p90 1462 to 1922 ms against 2584 ms). It leaves a fifth to a quarter of venue turns unanswered, and talks over the venue more as the end of turn is made faster. The gate fails on p90 and on cold start. A next run, if one is wanted, is `START_SENSITIVITY_HIGH` for the short openers, and a session opened before the `start` event.

## ConversationRelay (TASK-3791)

ConversationRelay moves the recogniser, the end of turn and the voice to Twilio. Our service trades text over a WebSocket (`setup` and `prompt` in; `text` and `end` out). Without a Twilio call only our half exists. `scripts/spike-conversationrelay.mjs` speaks the protocol on 127.0.0.1 with the cascade brain unchanged behind it (`createCascadeAgent`, keyword cues, then `gemini-3.5-flash-lite` on Vertex with its 900 ms timeout). A fake Twilio side plays each corpus turn as a `prompt` whose text is what Google STT telephony heard in that clip.

| our side (ms), measured | n | p50 | p90 | p99 | max |
|---|---|---|---|---|---|
| `setup` to the first `text` token (the disclosure) | 20 | 1 | 2 | 5 | 5 |
| `prompt` (last) to the first `text` token | 44 | 607 | 906 | 914 | 914 |
| `prompt` (last) to the last `text` token | 30 | 741 | 907 | 914 | 914 |
| WebSocket loopback round trip | 100 | 0.06 | 0.13 | 0.19 | 1.2 |

With the script text in place of the STT transcript: 586 / 794 / 913 ms for the first token (scratchpad run, not committed).

Needs a real call, not measured: the wait before Twilio sends `last: true`, Twilio's transcription, the time from our first token to Twilio's first audio, the network between Twilio and our service, and Twilio's own set-up time before `setup`.

Estimate from vendor documentation, not a measurement:

| stage | p50 estimate | p90 estimate | source |
|---|---|---|---|
| end of speech to `last: true` | ~400 | ~1000 | `turnMinSilence` default 300 ms, `eotThreshold` 0.8, `speechTimeout` 600-5000 ms; STT final "typically within 100ms" for English |
| network, both ways | ~60 | ~80 | not published; Twilio us1 to us-central1, a guess |
| our side | 607 | 906 | measured above |
| first audio from the voice | ~125 | ~150 | ElevenLabs Flash, North America TTFB 100-150 ms |
| end to end | ~1.2 s | ~2.1 s | sum; cascade v7 is 1413 / 2584 |

Twilio's own claim is a median under 0.5 s and a 95th percentile under 0.725 s for its pipeline, with no method given. Added to our side, that is about 1.1 s at p50 and 1.6 s at p95.

Sources, read 2026-11-20:

- https://www.twilio.com/docs/voice/conversationrelay/websocket-messages
- https://www.twilio.com/docs/voice/twiml/connect/conversationrelay
- https://www.twilio.com/docs/voice/voice-insights/conversation-relay-insights-dashboard
- https://www.twilio.com/en-us/blog/insights/low-latency-layer-conversational-ai
- https://elevenlabs.io/docs/best-practices/latency-optimization

Verdict: keep as the contingency, not decided. Our half adds only the intent stage, the same stage the cascade already runs, and the disclosure text leaves in 1-5 ms. The estimate puts ConversationRelay at about 1.2 s p50 and 2.1 s p90, which beats the cascade's 2.6 s p90. It would also remove our own endpointing wait (p90 1674 ms) and the 8 s synthesis stall from our code. Twilio's voice would then speak the disclosure, and our disclosure check, output gate and beep gate would lose the audio they read today. None of the Twilio half is measured.

## Recommendation

Neither engine replaces the cascade on this evidence. Gemini Live is faster on the turns it answers, but it leaves 10 to 13 of 47 venue turns silent and cannot meet the cold-start gate. Stop that spike unless a VAD and pre-opened session run changes the silence count. ConversationRelay is the better challenger on paper. Our half measured 607 / 906 ms, and the vendor numbers put the whole loop near 1.2 / 2.1 s. Its Twilio half needs a real call and is not measured. The intent stage is 607 / 906 ms on both paths, held at p90 by the 900 ms timeout, and it is now the largest stage the cascade owns. It is the lever to pull first whichever engine wins.
