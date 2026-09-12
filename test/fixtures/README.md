# Recorded conversations

One fixture per branch of the call script. These are the acceptance cases of TASK-970.

| File | The floor manager… | What must happen |
|---|---|---|
| `plain.json` | says "fine, noted" | notice delivered, polite close, transcript written |
| `who-pays.json` | asks who is paying | the comp answer, verbatim from the backend (TASK-972) |
| `unknown.json` | asks something we cannot answer | escalates, offers follow-up, **never improvises** |
| `stop-calling.json` | says stop calling us | do-not-call written **before** the reply returns (TASK-971) |
| `hangup.json` | hangs up mid-sentence | partial transcript written, no crash, no retry storm |

Assert on the transcript, never the audio.

**No real recording of a real restaurant goes in this folder.** These are synthetic or
self-recorded. A real call would be customer audio, and this feature stores transcripts only —
never audio — by decision.
