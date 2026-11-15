# The loopback soak's audio corpus

What the restaurant says, as 8 kHz μ-law, for `npm run soak:corpus` (TASK-3749, I3P-16). Data, not
code: nothing in `src/` reads these words, and the agent never says them.

| file | what it is |
|---|---|
| `scripts.json` | The source: which conversation fixture each call replays, the five new digit and money scripts, the voices, the babble lines, the noise settings, and the one clip expected to go unheard. Edit this, then re-render. |
| `manifest.json` | Generated. Per clip: the text, where the speech starts and ends, its length, and (with `--verify`) what Speech-to-Text v2 heard on the runtime's own model. |
| `<call>-<n>.ulaw` | Generated. One venue turn: 200 ms of room, the speech, 300 ms of room. |
| `noise-bed.ulaw` | Generated. 30 s of restaurant room, played under and between the turns. |

Render: `npm run soak:render` (Application Default Credentials, billed to `creatorain-27e9e`, a few
cents). It fails if Speech-to-Text hears nothing in a clip that is not listed in `expect_unheard`,
and if a listed clip is heard after all.

## Where the sound comes from

- **Speech:** Google Text-to-Speech v1, LINEAR16 at 8 kHz, in seven voices that are not Chirp (the
  agent speaks Chirp 3 HD, so it never hears its own voice). Levelled to -20 dBFS.
- **Noise:** made by `scripts/render-corpus.mjs` from a fixed seed: pink noise, a babble of eight
  generic dining-room lines in four of the voices, and dish clinks, mixed 12 dB under the speech. No
  third-party recording is used, so there is no licence to track.

## What it cannot tell you

Synthetic speech flatters recognition: the word recall in `manifest.json` is labelled synthetic and
is an upper bound. The human-voiced set (`docs/soak/README.md`) is what the accuracy and the
latency gate are finally held to.
