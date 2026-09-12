# Contributing

Three rules. They are short because they are the only ones that are enforced socially rather than
mechanically, and this repository has no mechanical enforcement to fall back on — branch protection
and required status checks are unavailable on this GitHub plan, so a red pull request can be merged
by anyone who does not look.

---

## 1. Every guard ships with a control that must fail

A green check proves nothing until you have watched it go red. "It protected everything" and "it
never ran" are the same observation from outside, and the second one is the dangerous case.

So for every check you add:

1. Break the thing it protects, on purpose.
2. Confirm the check fails, and read the message — it should say what is wrong, not just that
   something is.
3. Restore it, confirm the check passes.
4. **Paste both outputs in the pull request.**

Where a check can carry its own control, it must: `scripts/check-no-facts.mjs` scans a synthetic
violation before it will report clean; `scripts/derive-contract.mjs` runs every extractor against a
fragment with known contents; `src/eval/fabrication.ts` exports `fabricationControl()` and
`npm run eval` refuses to print a score if it fails; `test/harness.test.ts` drives six deliberately
broken agents through the rubric and requires each to be caught.

This is not theory. Writing the current test suite, controls caught four real defects in one day —
including a μ-law table that was wrong in a way every round-trip test would have happily confirmed,
because a round trip against your own encoder passes when both halves are wrong the same way.

---

## 2. A test must never quietly defend a bug

If you pin behaviour you believe is wrong, say so **in the test name and in a comment**, name the
ticket, and make it obvious that the fix rewrites the test rather than reverting it.

There is a live example in the sibling repo: a test asserting that a paused campaign does **not**
stop a call, headed `🔴 campaign_not_active — a DEAD guard, pinned deliberately (TASK-968)`. A
reader who finds that in six weeks knows immediately that it is a defect on record, not a decision.

The mock does the same thing at a larger scale: it serves the **fixed** backend by default and the
deployed bug only under a scenario you ask for by name (`campaign-paused-today`), because every
remaining ticket is specified against the fixed backend.

---

## 3. Nothing in `src/` may contain a product fact

No price, no policy, no venue name, no offer terms, no spoken sentence. `npm run check:no-facts`
fails the build. If you need a sentence that does not exist, the missing backend endpoint is the
bug — raise it there.

Two narrow exemptions exist, declared **in the file** so they appear in review:

```
NO-FACTS-EXEMPT[comp, money]: this file is the fabrication detector; ...
```

Per-rule, never per-file-blanket: a detector may be excused the words it hunts for and is still
forbidden a venue's name. The guard prints every exemption on every run and fails if there are more
than four — an exemption list that grows quietly is the same as no guard.

---

## House conventions

- **4 spaces, single quotes, LF.** `.editorconfig` and `.prettierrc.json` carry it; they are copied
  from platform-backend, not from the frontends.
- **No `enum`, no `namespace`, no `constructor(public x)` parameter properties.** Node runs the
  `.ts` files here by *erasing* types, not compiling them, and those three are the constructs
  erasure cannot express. They typecheck perfectly and throw at import. `tsconfig.json` sets
  `erasableSyntaxOnly` so the typechecker refuses them instead.
- **Imports carry the `.ts` extension** — that is what Node resolves at runtime.
- **No runtime dependencies.** There are none today and adding one should be a conversation: the
  whole suite running on a clone with two dev-only packages is why an intern can start in three
  minutes. `node:` built-ins cover everything so far, including the HTTP mock and the codec.
- **No lint step**, deliberately, and this is a stated deviation from the two reference repos. The
  strict typechecker plus `erasableSyntaxOnly` plus the guards cover what a lint config would catch
  here, and an untuned lint config produces noise that ends with the whole step being disabled. If
  the repo grows past a couple of contributors, revisit it.

---

## Before you open a pull request

```bash
npm run verify        # guard + typecheck + 118 tests
npm run eval          # 14 conversations
npm run contract:derive -- ../platform-backend    # has the backend moved under us?
```

The last one needs a platform-backend checkout and is a **person's job, not CI's** — CI here has no
copy of that repository and should not be given credentials to fetch one. A diff from it is a
conversation with whoever owns that file, not a merge conflict to resolve locally.

🔴 **Read the pull request's CI result before merging.** Nothing else will stop you.
