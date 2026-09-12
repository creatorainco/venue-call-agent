# Tuning the agent

"Tune the agent" is a phrase, not a task, until somebody names the knobs. This is the register.

Read `src/tuning/liveDefaults.ts` alongside it — the file holds the values and the reasons, this
page holds the ones you may not touch, the measurement protocol, and what each knob costs.

---

## §1 What you may NOT tune

These are not settings. Changing any of them changes what a restaurant is told, and none of them
lives in this repository:

| thing | where it lives | why it is not yours |
|---|---|---|
| the disclosure sentence | backend, `venueCallScript.ts` | it is the first sentence of every call, and it is a legal position, not copy |
| the four opening beats | backend, rendered per call | reordered once already, after an acceptance read found the original structurally identical to a robocall |
| the system instruction | backend, `buildVenueCallInstruction` | arrives in `call-context`. Not a prompt you edit here |
| every factual sentence | backend, `venueOperationsKb.ts` | the model picks *which*; it never phrases one |
| the eight answerable topics | backend, a closed set | an open topic list invites the model to ask for a fact we do not have and fill the gap itself |
| disclosure-before-audio | `src/state.ts` | there is no transition out of `connected` except to `disclosing`. Do not add one |
| the retry cadence and the 3-per-24h cap | backend, `venueCallRecord.ts` | a legal position under FCC 24-17, not a tuning knob |

If tuning seems to require changing one of these, you have found a design question. Raise it; do
not settle it in a config file.

⚠️ `npm run check:no-facts` walks `src` only and skips any directory named `fixtures`. So
`contract/seam4.json`, `test/` and `src/mock/fixtures/scenarios.json` are **not** guarded — which
is correct for the mock (it stands in for the component that owns the words) and is worth knowing
before you put a sentence somewhere convenient.

---

## §2 The register

Everything below is real, tunable, and currently set to a value somebody reasoned about and nobody
has measured.

### Model

| knob | where | value | what it changes |
|---|---|---|---|
| model id | argument to `live.connect`, **not** the config object | `gemini-2.5-flash-native-audio-preview-12-2025` | everything. Put it in the config object and it is silently ignored |

Native-audio versus half-cascade is the first real choice: native audio gives more natural prosody
and expressive speech; half-cascade (a text model plus TTS) is generally steadier under tool use.
This lane is tool-heavy — every fact is a function call — so if tool reliability turns out to be
the failure mode, the half-cascade variant is the experiment to run.

🔴 Pin an explicit version, never a `-latest` alias. An alias that moves under a deployed voice
agent changes what a restaurant hears with no commit and no review.

### Voice

30 prebuilt voices. Google's own telephony sample uses **Puck**, which is the only voice evidence
available that is about telephones rather than demos. **Charon** ("Informative") is the obvious
alternative for a notice-shaped call. Choose with §3.4, not from the adjectives on the docs page.

### Turn-taking — where almost all the audible quality lives

| knob | default | ours | what it changes |
|---|---|---|---|
| `automaticActivityDetection.disabled` | false | false | manual signalling means we decide when a turn ended, from a jittery carrier stream. Harder, not safer |
| `startOfSpeechSensitivity` | **`START_SENSITIVITY_LOW`, documented** | `LOW` | HIGH treats a dropped tray as the manager starting to speak, and the agent stops mid-sentence for nothing |
| `endOfSpeechSensitivity` | **`END_SENSITIVITY_LOW`, documented** | `LOW` | HIGH treats a thinking pause as a finished turn |
| `prefixPaddingMs` | not documented | 300 | how much audio before the detected start is kept. Too low clips first syllables: "…orty-five" |
| `silenceDurationMs` | **~800 ms, documented; 500–800 ms recommended** | 800 | how long a pause must be to end a turn. Up = dead air; down = talking over people |

🔴 **Corrected 2026-09-12. The two sensitivity rows previously said "not documented" and that was
wrong — the Live API REST reference states flatly "The default is START_SENSITIVITY_LOW." and
"The default is END_SENSITIVITY_LOW.", and Google's own Developer-API example sets both to LOW.
So our LOW/LOW is not a cautious deviation from a hair-trigger default; it IS the documented
stock setting, and §3 has one less thing to justify.

One contradiction to know about before leaning on an *unset* default: the SDK's own docstrings
attribute a HIGH default to a surface called "Gemini Live" that appears twice in 17,939 lines of
type declarations and is defined nowhere. Three sources say LOW, one undefined carve-out says
HIGH. Set them explicitly, as this repo does, and the disagreement cannot reach a call.**
| `realtimeInputConfig.turnCoverage` | differs between 2.5 and 3.x | `TURN_INCLUDES_ALL_INPUT` | whether we keep sending audio while the model speaks. Barge-in depends on it. **Not** a top-level field |

### Session

| knob | ours | why |
|---|---|---|
| `contextWindowCompression` | sliding window | an audio-only session is capped at 15 minutes without it. Our calls are capped at 6, so the cap is not the reason — a session that dies mid-sentence is |
| `sessionResumption` | on | survive a transient disconnect without the restaurant hearing it |
| `inputAudioTranscription` / `outputAudioTranscription` | both on | the output transcript is what the fabrication check reads |

### Audio, and the one correction worth carrying

The Live API takes **raw little-endian 16-bit PCM** and resamples a declared input rate itself, so
you may send 8 kHz as `audio/pcm;rate=8000`. Output is **always 24 kHz** and there is no setting.

🔴 A note in this estate says "only the 24 kHz → 8 kHz outbound leg is ours." Half right. The API
does resample input — but it does not accept **μ-law**, and a telephone hands us μ-law. So the
inbound leg needs a G.711 decode before anything is declared, and that decode is unavoidably ours.
Both legs are ours; only the *resampling* half of the inbound one is theirs. `src/audio/` does all
four operations and `test/audio.test.ts` proves them against the standard's own vectors.

### Not tunable, and it is the thing everyone asks about

**Concurrency.** 🔴 **This section said "the 1,000 concurrent sessions figure is unsourced; the
page it is attributed to does not contain it." That was wrong, and it was wrong in the direction
of dismissing a real limit.** Corrected 2026-09-12 after fetching both pages:

- The **Vertex / Cloud** surface publishes it plainly, under the heading *Maximum concurrent
  sessions*: "You can have up to 1,000 concurrent sessions per project on a pay-as-you-go (PayGo)
  plan. This limit does not apply to customers using Provisioned Throughput."
- The **Gemini Developer API** surface — `ai.google.dev`, the API-key path this repo's
  `GEMINI_API_KEY` uses — publishes **no** Live API concurrency figure at all. Its rate-limits
  page has no Live row; its only "concurrent" entry is the Batch API's.

So the accurate statement is that **which limit binds depends on which credential the agent
ships with**, and that is now a decision this feature has to make on purpose rather than dismiss.
An API key gets you no published ceiling and no guarantee; a Vertex service account gets you a
documented 1,000 per project. Either way the number that finally matters is on our own signed-in
quota page — but "there is no published figure" is no longer a true sentence.

**Barge-in, on the model's side.** The server signals an interruption with
`serverContent.interrupted: true`, and the client must stop playback and discard whatever it has
already buffered. That maps exactly onto `CallLeg.clear()` in `src/carrier/leg.ts`, which is what
`npm run call` exercises against the fake leg. `LiveServerMessage` also carries
`voiceActivityDetectionSignal` and `voiceActivity` — the server's own VAD, which is the channel
worth logging while tuning the two sensitivities above.

**The SDK, pinned.** `@google/genai`, latest **2.22.0** (published 2026-09-10, engines
`node >= 20`). Pin `^2.22.0` **and below 3.0.0**: the 3.x line requires Node 22 — a non-event
here — and removes `LiveConnectConfig.generation_config`, which is not.

⚠️ **The Live API is PREVIEW on both ends.** Google labels it Preview in the docs and the SDK
marks the whole Live surface `@experimental`, including `connect()`, `sendToolResponse()` and
`close()`. There is no deprecation guarantee on any of it. See `docs/LIMITS.md`.

💡 **One cheap guard worth taking on day one.** This page says putting `model` in the config
object gets it "silently ignored". That is only true because `LIVE_DEFAULTS` is an untyped object
literal. Annotate it `: LiveConnectConfig` once the SDK is a dependency and the same mistake
becomes `error TS2353: 'model' does not exist in type 'LiveConnectConfig'` — the whole class of
misplaced-field bug turns from silent into a failed build, for one line.

---

## §3 The measurement protocol

**The first tuning task is a measurement, not a change.** Everything in §2 is a hypothesis.

### 3.1 What to record, every run

Per turn: time from end-of-speech to first outbound audio byte (TTFA), and the seam round trip for
any tool call inside it. Report **p50, p90, p99 and max**. Never a mean — a mean hides exactly the
calls this feature must not make. Record the model id, the full VAD block and the fixture, or two
runs are not comparable.

### 3.2 Settle the model question first

Run the same fixture on the pinned model and on `gemini-3.1-flash-live-preview`. A forum thread
(two posters, no Google reply, last post 2026-09-05) reports the newer one at 9–15 s TTFA against
~2 s for the 2.5 native-audio line. On a telephone nine seconds after "hello" is the call over. It
is not our measurement, and it needs to be before anyone changes the pin in either direction.

**Independent second signal, found 2026-09-12 and older than the latency thread.**
`google-gemini/cookbook` issue **#1197** (opened 2026-04-16, still open, no Google response)
reports four production voice-call defects on `gemini-3.1-flash-live-preview`, the first being
**greeting stuttering when interrupted** — a barge-in defect, which is the exact mechanism this
lane depends on and the one `npm run call` grades. Two unrelated reports, months apart, both
against the newer model, both on things a telephone call cannot tolerate. That strengthens the
2.5 pin beyond "we have not measured it yet" — but it is still two strangers' reports, and the
measurement is still the deciding move.

### 3.3 Sweep silence duration around the documented default

**This one is now a command rather than a plan, and it needs no credential:**

```bash
npm run call -- --sweep=200,400,600,800,1000,1200
```

It runs all fourteen conversations as telephone calls at each setting and prints, per setting: the
dead-air percentiles, how many frames we spent talking over the far end, and how many utterances
got split in two. The reading on 2026-09-12, against a 500 ms mid-utterance thinking pause:

| silence | p50 dead air | talk-over | over-segmented |
|---|---|---|---|
| 200 ms | 220 ms | 30 frames | 7 |
| 400 ms | 420 ms | 30 frames | 7 |
| **600 ms** | 620 ms | 0 | **0** |
| 800 ms | 820 ms | 0 | 0 |
| 1000 ms | 1020 ms | 0 | 0 |
| 1200 ms | 1220 ms | 0 | 0 |

So the trade is visible: below 600 ms the detector cuts through a thinking pause, the agent
answers half a question, and it talks over the rest of it. **Bracket 800 and do not sit below it**
— the pinned value has a margin over the knee, which is the right place to be when the pause
length is a property of a stranger and not of us.

**What Google says about the same knob**, fetched 2026-09-12 and worth putting beside our own
numbers: *"Recommended (500ms–800ms): Provides a good balance… The server's internal default is
approximately 800ms. Too low (e.g., 100ms–200ms): The system ends speech turns during natural
pauses, splitting a single utterance into multiple small audio fragments… losing cross-fragment
context and resulting in lower transcription and response quality. Too high (e.g., 2000ms+):
increasing perceived latency."*

Two things follow. Their "too low" is about **transcription quality**, not only politeness — a
cost our sweep cannot see at all, because there is no recogniser in it. And their harm example is
100–200 ms; they say nothing about 400. **So keep the 400 rung.** It is below the recommended
band and above the documented harm example, which makes it the one rung that measures where the
edge actually is rather than assuming the band's lower bound is a cliff.

⚠️ **What this sweep is NOT.** The detector it sweeps is ours, not Google's — same parameter
names, same units, different algorithm, and theirs is unpublished. Read the header of
`src/carrier/vad.ts` before quoting any of these numbers. What transfers is the SHAPE: a setting
shorter than a human's thinking pause cuts through it, wherever the detector runs. What does not
transfer is the knee's exact position, and nothing here sees transcription quality.

And the knee is a property of the fixture's pause length, which is 500 ms and is chosen, not
measured — `DEFAULT_INTERNAL_PAUSE_MS` in `src/carrier/fakeLeg.ts`. Change it and re-run to ask
about a slower speaker. Score each setting with the eval too: a call that stays inside the
detector's budget and breaks a hard check has got worse.

### 3.4 Choose the voice by listening, once

Two voices, three fixtures, over a real handset if one is available and over a laptop speaker if
not. This is the one place a subjective read is the right instrument, and it should be done once
and written down rather than relitigated per pull request.

### 3.5 Re-run the eval AND the calls after every change

```bash
npm run eval          # what was said and done — the transcript
npm run call          # what it sounded like — dead air, interrupts, the wire
```

A tuning change that improves latency and breaks a hard check has made things worse. The rubric's
hard checks are not a quality bar to trade against — they are things the call must never do.

---

## §4 What a tuning run cannot tell you

Latency measured against the local mock is the **seam** round trip only. It contains no carrier, no
jitter, no packet loss, no answering-machine detection and no restaurant kitchen. See
`docs/WHAT-CANNOT-BE-TESTED.md`. Numbers from here are a floor, and the gap between that floor and
a real call is the whole reason the ten-call soak exists.

### §4.1 The one sum nobody had added up

Dead air is not the model's latency. It is:

```
what the restaurant waits  =  silenceDurationMs  +  the model's first-byte latency  +  the seam round trip
```

The detector's share is fixed by the setting — 800 ms today, and it is spent before the model has
been asked anything. So a model at the forum-reported 9–15 s does not produce a 9-second pause; it
produces a **ten-second** one. And a model at ~2 s produces nearly three.

You can put a figure in and see the whole sum without a Google account:

```bash
npm run call -- --latency=900     # assume 900ms to first audio byte
```

That is the number to walk into the model comparison (§3.2) holding, because it decides what
"acceptable" means before anybody measures anything.
