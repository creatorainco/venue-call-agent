# Gemini Live transport status

The official `@google/genai` SDK is pinned exactly to `2.22.0`. The connector and its offline
fake-client tests cover SDK message conversion, tool response IDs, interruption, cancellation,
connection errors and cleanup. The model pin and tuning values are unchanged.

The implementation is in `src/live/geminiConnector.ts`; it composes with `src/live/session.ts`,
`src/live/audio.ts`, `src/live/tools.ts` and `src/live/pipeline.ts`. Connection readiness does
not authorize playback: the pipeline denies output unless a caller supplies an explicit
conversation policy. This is not yet an implementation of the complete `SpeechBridge` or
`CallAgent`, and `--agent=live` remains unavailable. Offline tests do not measure model latency.

## Reviewed SDK behavior

The connector passes `model` separately from `config`, and uses the backend-provided system
instruction. The defaults are checked with the SDK's `LiveConnectConfig` type. Audio is sent as
PCM at its actual rate; model output is validated before conversion. SDK convenience getters
are avoided because they can log content. No session audio is recorded to disk.

The SDK may call `onmessage` with queued messages before `connect()` returns the session.
The connector buffers these messages and drains them after the local lifecycle becomes ready.
The buffer is bounded; overflow ends the connection. `generationComplete` is not treated as
`turnComplete`. A server `goAway` ends the local session; reconnection/resumption is not implemented.

## Known limitation before setup completes

In the reviewed `2.22.0` SDK, `live.connect()` waits for socket open and then setup completion.
That implementation does not actively consume `config.abortSignal` to close the socket while
waiting. Our wrapper rejects local cancellation promptly, drops callbacks and closes a session
that resolves late. It cannot guarantee immediate closure of an SDK socket that never finishes
setup. This remains a transport limitation to settle before treating connection timeouts as
complete network-resource cleanup; no real session has verified this behavior here.

## Work still required

- Implement the conversation flow and disclosure playback control against the existing baseline.
- Add a deliberate measurement entry point that requires a model key while keeping independent
  witness credentials required for the full fabrication acceptance path.
- Measure both specified models with identical inputs/settings, recording per-turn timings and
  tool durations, without recording session audio. Model availability failures are findings.
- Verify SDK behavior against a real session, including setup cancellation and interruption.

Official sources reviewed for this transport:
- [SDK source at v2.22.0](https://github.com/googleapis/js-genai/blob/v2.22.0/src/live.ts)
- [Live API capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities)
- [Live tool use](https://ai.google.dev/gemini-api/docs/live-api/tools)
