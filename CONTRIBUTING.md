# Contributing

Three rules, and one piece of process at the bottom.

The three rules are enforced socially rather than mechanically. The process at the bottom is
enforced mechanically: `main` and `dev` are protected branches, so they refuse a red merge and an
unreviewed one.

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
`npm run eval` refuses to print a score if it fails; `test/harness.test.ts` drives a set of
deliberately broken agents through the rubric and requires each to be caught.

This is not theory. Writing the current test suite, controls caught four real defects in one day —
including a μ-law table that was wrong in a way every round-trip test would have happily confirmed,
because a round trip against your own encoder passes when both halves are wrong the same way.

---

## 2. A test must never quietly defend a bug

If you pin behaviour you believe is wrong, say so **in the test name and in a comment**, name the
open work that fixes it, and make it obvious that the fix rewrites the test rather than reverting
it.

The shape: a test name that starts with `🔴` and says the behaviour is a defect, a comment naming
what fixes it, and an assertion that fix will turn red. A reader who finds that in six weeks knows
immediately that it is a defect on record, not a decision. There is no such test here today — the
last one pinned a backend campaign-status guard that could never fire, and it was rewritten when
the backend fixed the guard, which is exactly the ending this rule is for.

The mock does the same thing at a larger scale: where the deployed backend and the planned one
differ, it serves both and says which is which. `contract/seam4.json` lists each case under
`known_divergences` — today only `comp-clause`, where scenario `happy` is the deployed behaviour
and `comp-known` is the planned one.

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
npm run verify        # guard + doctor control + typecheck + the whole suite
npm run eval          # every recorded conversation, as a transcript
npm run call          # the same ones as telephone calls — dead air, barge-in, the wire
```

**CreatoRain engineers only**, and an outside contributor never needs it:

```bash
npm run contract:derive -- ../platform-backend    # has the backend moved under us?
```

It needs a platform-backend checkout and is a **person's job, not CI's** — CI here has no copy of
that repository and should not be given credentials to fetch one. A diff from it is a
conversation with whoever owns that file, not a merge conflict to resolve locally. The same goes
for running platform-backend locally to test against a real backend.

🔴 **Read the pull request's CI result before merging.** Branch protection will stop a red merge
on `main` and `dev` now, but it will not stop you merging something green and wrong, and it does
not apply to anyone's fork.

---

## Branches and pull requests

```
main   released. Protected. Only ever reached by a pull request from dev.
dev    the integration branch, and the default. Protected. Everything lands here first.
```

Both branches require **a pull request, one approving review, and a green `verify`**. Force-pushing
and deleting them is refused. Administrators can override, which means the guard is real for
contributors and advisory for owners — that asymmetry is deliberate.

If you do not have write access here — which is the normal case, and the repository being public is
what makes it workable — fork it one of two ways.

With the GitHub CLI. `gh repo fork --clone` clones your fork **and** adds this repository as
`upstream` for you, so there is no `git remote add` step:

```bash
gh repo fork creatorainco/venue-call-agent --clone
cd venue-call-agent
git fetch upstream
git checkout -b feat/the-thing upstream/dev
# ... work, and run the three commands above ...
git push -u origin feat/the-thing
gh pr create --repo creatorainco/venue-call-agent --base dev --fill
```

With the web UI. Press **Fork** on GitHub, then clone your fork and add `upstream` yourself:

```bash
git clone https://github.com/<you>/venue-call-agent.git
cd venue-call-agent
git remote add upstream https://github.com/creatorainco/venue-call-agent.git
git fetch upstream
git checkout -b feat/the-thing upstream/dev
# ... work, and run the three commands above ...
git push -u origin feat/the-thing
# then open the pull request on GitHub, against dev
```

`--base dev` matters. `dev` is this repository's default branch, so the web UI and `gh` should
pick it for you, but a fork's own default can be stale — check the base before you submit.

On a first pull request from a new contributor, GitHub holds the workflow run until a maintainer
approves it. Nothing is wrong; it is the default for public repositories and it only happens once.

Keeping a fork current: `git fetch upstream && git rebase upstream/dev`. Never merge `upstream/main`
into a feature branch — `main` is downstream of `dev` here, not upstream of it.
