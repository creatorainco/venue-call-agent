# venue-call-agent — rules for agents working in this repo

This service telephones restaurants. Read `README.md` and `ONBOARDING.md` first; this page is only
the things an agent gets wrong here specifically.

## 🔴 The three that are not negotiable

1. **Never place a call.** Not to a restaurant, not to a colleague, not to a number we own. The
   first dial of any kind is a send switch and needs Peter's explicit yes for that act on that day
   (TASK-973). "It is our own handset" has been tried as an argument and was overturned: whose
   phone rings changes who is inconvenienced, not which switch was flipped.
2. **Never write a product fact into `src/`.** No price, policy, venue name, offer term or spoken
   sentence. If a sentence is missing, the missing backend endpoint is the bug. `npm run
   check:no-facts` enforces it; the two declared exemptions are for code that *detects* that
   language, and they are per-rule.
3. **Never set an environment variable on a deployed service.** Configuration belongs to the
   operator. Surface the value and where they change it.

## What this repo can and cannot see

- It cannot see `platform-backend`. `contract/seam4.json` is a **snapshot** with the commit it came
  from. All three local copies of those shapes can agree perfectly while the real backend has moved
  on. `npm run contract:derive -- <path-to-platform-backend>` is the only thing that can tell you.
- Read that repo with `git -C <path> show <ref>:<file>`. **Never** `git checkout` in it — that
  checkout usually belongs to another session and switching it destroys their work with no reflog.

## Conventions that will bite you

- Node **erases** the TypeScript here rather than compiling it. No `enum`, no `namespace`, no
  `constructor(public x)` parameter properties — all three typecheck and then throw at import.
  `erasableSyntaxOnly` is on so the typechecker catches them first.
- Imports carry the `.ts` extension.
- 4 spaces, single quotes, LF. Copied from platform-backend, not from the frontends.
- No runtime dependencies. Two dev-only packages. Keep it that way unless there is a real reason —
  the three-minute cold start is the point.

## The testing rule, stated once

Every guard ships with a control that must fail, and you run it and paste both outcomes. A green
check proves nothing until you have watched it go red — "it protected everything" and "it never
ran" are the same observation from outside. See `CONTRIBUTING.md`.

If you pin behaviour you believe is wrong, say so in the test name and name the ticket. A test that
quietly defends a bug is worse than no test.

## Where the truth lives

| question | answer |
|---|---|
| what the backend returns | `contract/seam4.json`, verified by `npm run contract:derive` |
| what a call must never do | `src/eval/rubric.ts`, hard checks |
| what "tune it" means | `docs/TUNING.md` and `src/tuning/liveDefaults.ts` |
| what is broken and known | `docs/LIMITS.md` |
| what green does not prove | `docs/WHAT-CANNOT-BE-TESTED.md` |
| the whole feature's state | Jira **TASK-967** |
