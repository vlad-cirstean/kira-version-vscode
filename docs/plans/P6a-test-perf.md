# P6a — Making the suites fast enough to run on every change

Plan for a **test/dev-infrastructure change**, not for one of `docs/SPEC.md` §10's numbered
phases. It sits after P6 and is named `P6a` for the same reason `P4b` and `P4c` were: P0–P13
describe what v1 builds, and this unit of work changes only how fast v1 is *verified*. Written
before implementation per `AGENTS.md`. It gets **no row in §10's phasing table** — see the open
questions.

**The directive, in the user's own framing:** "make te tests run faster. Much much faster." It was
issued after a full `bun run test` was killed twice in one session for taking too long. P7 and the
FlatBuffers IPC migration are both blocked behind this landing.

**The boundary, stated once:** the same guarantees, much less wall-clock time. No suite is deleted,
no theme variant is dropped to make a number look better, no assertion is weakened. Every item
below either stops the toolchain repeating work it has already done, or runs work that was already
serial in parallel. Where a change *could* narrow coverage, this plan says so explicitly and either
declines it (W8) or pairs it with the proof that the coverage is preserved (W6).

---

## What is actually true — measured at planning time, in this container

4 vCPU / 15 GB, Linux, root, `git 2.43.0`, `bun 1.3.11`, `typescript 7.0.2` (the native compiler),
`@playwright/test 1.62.1`, `axe-core 4.13.0`. Load average during measurement was ~1.2 — the five
sibling worktrees under `.claude/worktrees/` had no agent running, so these are essentially
uncontended numbers. Nothing here is estimated:

| Command | Wall time | Content |
|---|---|---|
| `bun run check` | **7.3 s** | `format:check` 0.24 s, `lint` 0.44 s, **`check:types` 6.2 s**, three generator checks 0.17 s total |
| `bun run test` | **50.9 s** | 1,069 tests, 90 files, 43,190 assertions |
| ├ `bun test packages tests/fixtures tests/unit` | **5.4 s** | 868 tests, 70 files |
| └ `bun test tests/integration` | **34.3 / 40.5 / 46.3 s** | 201 tests, 20 files — three separate runs, the spread is real |
| `bun run test:e2e` (`harness`) | **140.5 s** | 182 tests, 2 workers (Playwright's default here), 263 s of test CPU-time |
| `bun run test:e2e` at `--workers=4` | **109.6 s** | same 182 tests, 416 s of test CPU-time |
| `bun run test:e2e:vscode` | not re-measured | 3 tests, `serial` by construction (P4c Findings), downloads a ~130 MB VS Code |

So the whole verification loop is `7.3 + 50.9 + 140.5` ≈ **3 min 20 s**, of which the Playwright
harness project is 70%. That is the shape of the problem, and it is not the shape the task
description assumed.

### Three premises this plan had to falsify before it could be written

Saying so plainly is more useful than quietly planning around them.

**1. The suite is not 405 test files. It is 90.** Measured: 90 `*.test.ts` (35 in `packages`, 32 in
`tests/unit`, 20 in `tests/integration`, 3 in `tests/fixtures`) and 15 `*.spec.ts` (13 under
`tests/e2e/harness/`, plus `tests/e2e/vscode/`). The received figures — ~405, ~89, ~44 — are
reproduced *exactly* by a filesystem walk that does not exclude `.claude/worktrees/`:

```
find . -name '*.test.ts'                       → 405   (90 in this checkout)
find . -path '*tests/integration/*.test.ts'    →  89   (20 in this checkout)
find . -name '*.spec.ts'                       →  44   (15 in this checkout)
```

Five stale sibling agent checkouts of the same commit live under `.claude/worktrees/`. **Nothing in
the toolchain actually reads them** — `bun test`'s file walker skips dot-directories (verified: the
unit slice finds exactly 70 files, the count of this checkout alone), and `biome` checks 317 files,
also this checkout alone. The inflated counts are a measurement artefact, not a workload. Record
it, because the next person to `find` this tree will hit it too.

**2. `tsc --build --force` is not the bottleneck, and it is not even close.** It was flagged as
"the most suspicious single line in the whole toolchain". Measured: `--force` costs **1.19–1.22 s**;
warm `tsc --build` costs **0.12–0.13 s**. The `--force` is real waste and W1 removes it, but it is
1.1 s of a 7.3 s `check` and 1.1 s of a 200 s loop. The reason it is cheap is that `typescript` is
pinned at **7.0.2** — the native compiler — which builds this whole monorepo from scratch in about
a second. `git log -S` puts the flag in `19efbab` ("implement P0 foundation"), i.e. it has been
there since the tree existed and predates the TypeScript 7 pin; there is no recorded reason for it.

**3. The visual-regression suite is not where the time is, and trimming it would buy almost
nothing.** `refsVisual.spec.ts` is 30 tests / 34.4 s of CPU-time — 13% of the harness project, at
**1.15 s per test**, against a measured floor of ~0.9–1.0 s for *any* harness test that merely
boots the app. Dropping three of its four theme kinds would save ~9 s of CPU-time (~2 s of wall
time at 4 workers) and cost three quarters of the visual coverage P6 just landed. W8 declines it,
with the numbers.

### Where the time actually goes

**`bun test tests/integration`, per file** (each run standalone, so each carries ~0.15 s of `bun`
startup):

| ms | file | tests |
|---:|---|---:|
| 11,398 | `historyPipeline.test.ts` | 23 |
| 6,087 | `repoService.test.ts` | 50 |
| 4,017 | `logSession.test.ts` | 10 |
| 3,255 | `watcher.test.ts` | 6 |
| 2,474 | `queries.test.ts` | 28 |
| 1,457 | `commitDetail.test.ts` | 12 |
| 1,184 | `tagAndBranchOps.test.ts` | 5 |
| 765 | `nodeFileWatcher.test.ts` | 4 |
| 659 | `catFile.test.ts` | 6 |
| 658 | `revertLifecycle.test.ts` | 4 |
| 567 | `discovery.test.ts` | 18 |
| 529 | `checkoutAgreement.test.ts` | 6 |
| 523 | `errors.test.ts` | 6 |
| 512 | `inProgressStates.test.ts` | 5 |
| 502 | `checkoutSpecialPaths.test.ts` | 3 |
| 405 | `packedChunk.test.ts` | 1 |
| 358 | `transportContract.test.ts` | 5 |
| 244 | `writeQueue.test.ts` | 4 |
| 230 | `lanePaletteGenerator.test.ts` | 3 |
| 135 | `settingsGenerator.test.ts` | 2 |

Summing to 36.5 s — within noise of the 34.3–46.3 s a single combined invocation takes. **`bun test`
runs test files serially, in one process**; running each file in its own process costs the same
total as running them all in one, on a 4-core box. Its `--max-concurrency` flag governs
`test.concurrent()` *within* a file, of which this suite uses none.

**Where the integration seconds go: `git` subprocesses.** A shim placed ahead of `/usr/bin/git` on
`PATH`, timing each call, over one full `bun test tests/integration`:

```
5,183 git process spawns; 27.1 s of git wall time
```

| ms | calls | first argv token | attribution |
|---:|---:|---|---|
| 10,341 | 593 | `-c` | product — `driver.read()`/`write()` prepend `-c … --no-pager --no-optional-locks` |
| 6,152 | 1,013 | `commit` | fixture construction |
| 2,954 | 1,015 | `add` | fixture construction |
| 2,913 | 1,307 | `rev-parse` | mostly fixture (`Repo.head()`/`refSha()`), some test-side |
| 1,454 | 624 | `--no-optional-locks` | product — `discovery.ts` |
| 1,096 | 52 | `merge` | fixture construction |
| 717 | 182 | `init` | fixture construction |
| 508 | 158 | `switch` | fixture construction |
| ~660 | ~145 | `push`/`tag`/`fetch`/`branch`/`clone`/`config`/`cat-file` | mixed |

**≈15.0 s — 55% of all git time in the integration suite — is spent building fixture repositories,
not exercising the product.** A bare `git --version` spawn costs 2–4 ms here, so this is not
process-spawn overhead alone; it is ~3–4 spawns and a disk sync per generated commit.

**And the fixtures are byte-for-byte reproducible, which is the whole opening.**
`tests/fixtures/generateRepo.ts`'s module comment says determinism "is the whole job here" — fixed
`GIT_*_DATE`, fixed identity, pinned config sources. Verified directly: `linear(6)` called twice in
one process yields the same HEAD (`1d62fe57`), and `branchy()` twice yields an identical `refs`
map. Generation versus a plain recursive directory copy of the finished repo:

| shape | generate | `cpSync` | ratio |
|---|---:|---:|---:|
| `linear(6)` | 67–72 ms | 3 ms | 23× |
| `linear(20)` | 215–219 ms | — | — |
| `linear(200)` | 2,207 ms | 30–73 ms | ~50× |
| `branchy()` | 99–104 ms | 3 ms | 33× |
| `octopus()` | 163–172 ms | 2–3 ms | 56× |
| `crissCross()` | 80–98 ms | — | — |
| `conflicting()` | 48–53 ms | — | — |
| `detailWorkload()` | 400 ms | 46–51 ms | 8× |

**`bun run test:e2e` (`harness`), per spec file**, CPU-time summed across workers, from the
2-worker run:

| ms | tests | file | what dominates |
|---:|---:|---|---|
| 74,095 | 37 | `refsA11y.spec.ts` | 28 axe scans (4 themes × 7 surfaces) |
| 47,044 | 20 | `a11y.spec.ts` | 16 axe scans (4 themes × 4 surfaces) |
| 34,430 | 30 | `refsVisual.spec.ts` | 30 screenshots |
| 25,874 | 22 | `commitDetail.spec.ts` | interaction |
| 25,050 | 22 | `graph.spec.ts` | interaction + 9 screenshots |
| 15,747 | 12 | `commitList.spec.ts` | interaction, incl. a 20,000-row scenario |
| 10,669 | 10 | `refOps.spec.ts` | interaction |
| 6,084 | 6 | `shell.spec.ts` | interaction + 4 screenshots |
| 5,810 | 6 | `conflictBanner.spec.ts` | interaction |
| 5,364 | 5 | `checkout.spec.ts` | interaction |
| 4,796 | 5 | `refs.spec.ts` | interaction |
| 3,500 | 3 | `revert.spec.ts` | interaction |
| 3,400 | 3 | `undo.spec.ts` | interaction |
| 928 | 1 | `layoutWorker.spec.ts` | interaction |

Two costs sit underneath every row of that table, and both were measured directly:

- **Booting the app costs 585–695 ms per test, and 159 HTTP requests.** `playwright.config.ts`'s
  `webServer` runs `vite` in **dev** mode, so every fresh browser context pulls the unbundled
  module graph one ES module at a time. Against the same app served from `vite build` output, the
  identical boot-and-wait sequence costs **278–313 ms and 5 requests**. The build itself takes
  0.96 s, once.
- **Each axe scan costs ~1.1 s more than the same page without one.** Measured on the `badges`
  page: the full default ruleset takes **1,615–2,007 ms**; `withRules(["color-contrast"])` takes
  **566–597 ms**. The suite runs 44 full scans. Corroborated from the run itself:
  `refsA11y.spec.ts`'s axe tests average 2.2 s, its non-axe tests on the *same* surfaces average
  1.0 s.

**One flake reproduced, and it is already known.** The 2-worker run failed
`refsA11y.spec.ts` › "RevertDialog traps focus and returns it to the invoking row on Cancel"; the
4-worker run passed all 182. P6's own exit criteria already record exactly this test, exactly this
failure, and its cause (a SlickGrid row re-render racing the invoker-capture in
`modalFocus.ts`/`RowContextMenu.vue`), explicitly deferred as a follow-up. This plan does not fix
it and does not claim it as its own — see the open questions, because W7 changes how often it fires.

---

## Scope boundary

**Changed:**

| | |
|---|---|
| `package.json` | `check:types` loses `--force`; `test` splits into `test:unit`/`test:integration`; `test:e2e` gains a built-harness prerequisite |
| `tests/fixtures/generateRepo.ts` | a content-addressed template cache + copy-on-use for the deterministic shapes (W3) |
| `scripts/test-shard.ts` | **new** — partitions test files across N `bun test` child processes (W4) |
| `playwright.config.ts` | `workers`, and a `webServer` that serves built output instead of the dev server (W5, W7) |
| `apps/harness/vite.config.ts` | a `preview` port, if W5 needs one |
| `tests/e2e/harness/a11y.spec.ts`, `refsA11y.spec.ts` | axe ruleset scoped by what a theme can actually change (W6) |
| `AGENTS.md` | which lane to run when, and what each costs (W9) |

**Untouched, deliberately:**

| | |
|---|---|
| `docs/SPEC.md` | no edit at all — see the open questions |
| §10's phasing table | no row. This is infra, exactly as `P4b`/`P4c` were |
| Any assertion, in any suite | not one is deleted, relaxed, or moved behind a flag |
| Every visual baseline, all 54 PNGs | nothing here changes rendered output; a shifted baseline is a bug, not a chore |
| `tests/e2e/vscode/panel.spec.ts` and its `serial` mode | 3 tests, already justified by P4c's Findings (two VS Code windows on one Xvfb display with no window manager fight over focus). Not this plan's business |
| `tests/perf/` and `test:perf` | a separate tier with its own budgets, run on demand, not in the inner loop |
| The `refsA11y` focus-return flake | P6 owns it and deferred it deliberately; W7 must not silently absorb it |

---

## Ordering

| # | Work item | Depends on | Expected saving |
|---|---|---|---|
| W1 | `check:types`: drop `--force`, add a clean escape hatch | — | −1.1 s on every `check` |
| W2 | Split `test` into `test:unit` and `test:integration` | — | inner loop 50.9 s → **5.4 s** |
| W3 | `generateRepo.ts`: cache the deterministic shapes, copy per use | — | integration ~40 s → ~27 s |
| W4 | `scripts/test-shard.ts`: run the integration lane in N processes | W3 | ~27 s → ~12 s (4 cores) |
| W5 | Playwright: serve built harness output, not the dev server | — | −57 s of harness CPU-time |
| W6 | Playwright: scope axe's ruleset by what a theme can change | — | −35 s of harness CPU-time |
| W7 | Playwright: worker count | W5, W6 | wall −20% at the same CPU-time |
| W8 | The things not to do, and the measurement that says so | W5, W6 | — |
| W9 | `AGENTS.md`: the lanes and their real costs | W1–W7 | — |
| W10 | Verification | all | — |

W1, W2, W3, W5 and W6 are independent and can land in any order. W4 is worth much less before W3
(a sharded run of fixture-building tests just contends for the same four cores), and W7's numbers
are only meaningful once W5 and W6 have removed the CPU-time they remove.

---

## W1 — `check:types`: drop `--force`

```json
"check:types": "tsc --build --force && bun run --filter '@kira-version/ui' check:vue"
```

`--force` tells `tsc --build` to ignore every `.tsbuildinfo` and rebuild all seven referenced
projects unconditionally. Measured cost of that instruction: **1.19–1.22 s** versus **0.12–0.13 s**
warm. Every project in `tsconfig.base.json` is already `"composite": true` with `declaration` and
`declarationMap`, which is exactly the configuration incremental `--build` is designed for, and
`*.tsbuildinfo` is already gitignored (`.gitignore:48`).

**Why it is there:** `git log -S 'tsc --build --force' -- package.json` returns exactly one commit,
`19efbab` ("implement P0 foundation"), i.e. it arrived with the tree and no rationale was recorded.
Confirm that before removing it; if a reason surfaces in P0's plan or its Findings that this
planning pass missed, honour the reason and record it here instead of removing the flag.

**Do this:**

- `"check:types": "tsc --build && bun run --filter '@kira-version/ui' check:vue"`.
- Add `"check:types:clean": "tsc --build --force && …"` as the escape hatch for the one case
  incremental builds genuinely get wrong — a `.tsbuildinfo` left behind by an interrupted build.
  One line, and it is what a reader reaches for instead of re-adding `--force` to the default.
- **Prove it, don't assert it.** The check that matters is not "it's faster" but "it still fails
  when it should": introduce a type error in `packages/core`, run `bun run check:types` warm,
  confirm it fails; fix it, confirm it passes; delete a file that another project imports, confirm
  the build still catches the dangling import. Record the three results.

**Do not** touch `check:vue`. `vue-tsc --noEmit` is 2.56–3.01 s — more than twice `--force`'s cost —
and has no incremental mode to switch on. Measured directly: invoking it through
`bun run --filter` (2,715/2,748 ms) versus `bunx vue-tsc --noEmit` in `packages/ui` (2,644/3,005 ms)
is the same number, so there is no workspace-resolution overhead to reclaim either. The residual
~2 s between `check:types`'s 6.2 s and its two measured parts is `bun run`/`bunx` process startup;
it is not worth chasing and this plan does not.

## W2 — Split `test` into an inner-loop lane and a slower one

`"test": "bun test packages tests/fixtures tests/integration tests/unit"` is one flat 50.9 s
invocation, and 45 of those 50 seconds are the 20 files under `tests/integration/`. The other 70
files — every `packages/**` unit test, every `tests/unit/**` test, the three fixture self-tests —
run 868 tests in **5.4 s**, spawn no subprocesses, and touch the filesystem only through
`tests/fixtures`' own generators.

```json
"test:unit": "bun test packages tests/fixtures tests/unit",
"test:integration": "bun test tests/integration",
"test": "bun run test:unit && bun run test:integration"
```

`test` keeps meaning exactly what it means today — every `.test.ts` in the tree, nothing skipped —
so no existing instruction, exit criterion or habit breaks. What changes is that there is now a
name for the 5-second lane, which is the one a contributor or an implementing subagent runs after
every edit. This mirrors the split `check` already has between `format:check`/`lint` (0.7 s) and
`check:types` (6.2 s).

Note that `bun test`'s positional arguments are path filters, not directories, and that
`tests/fixtures` must stay in the fast lane: `generateRepo.test.ts`, `topology.test.ts` and
`largeBranchy.test.ts` are the tests that guard W3's own correctness.

## W3 — `generateRepo.ts`: build each deterministic shape once, copy it per use

The largest single win available in `bun run test`, and the one that needs the most care.

**The situation.** Every integration test builds its own repository inline —
`repoService.test.ts` alone calls `linear(n)` more than twenty times, `logSession.test.ts` calls
`linear(200)` — and each call is 3–4 `git` spawns per commit. Across one run that is 1,013 `git
commit`s, 1,015 `git add`s and 182 `git init`s, ≈15.0 s of the suite's 27.1 s of git time.

**The precedent is already in this file.** `large()` and `largeBranchy()` already do exactly this:
`cacheKey()` hashes the generator inputs, `buildAndInstall()` builds into
`tests/fixtures/.cache/<key>` and installs it atomically with a rename, and the directory is
already gitignored (`.gitignore:146`). W3 generalises that mechanism to the small shapes, with one
change it needs and they did not.

**The change: cached shapes must be copied, not shared.** `large()` returns the cache directory
itself, which is safe only because its consumers read. Integration tests *write* — they check out,
commit, revert, delete refs. So the accessor becomes: build the template into
`tests/fixtures/.cache/<key>` on first use, then `cpSync(template, mkdtempSync(...), { recursive:
true })` per call and return the copy. Measured, that turns 67–72 ms into 3 ms for `linear(6)` and
2,207 ms into 30–73 ms for `linear(200)`, and per-test isolation is unchanged — every test still
gets its own mutable repository at its own path.

**The cache key must include the generator's own source.** `large()`'s key carries a hand-bumped
`v2` string, which is a footgun: edit a shape and forget to bump, and every test silently runs
against the old repository. Hash `generateRepo.ts`'s own bytes
(`createHash("sha256").update(readFileSync(import.meta.filename))`) into the key alongside the shape
name and its options, so editing the file invalidates every template automatically. Keep
`clearLargeCache()` (or widen it) as the manual escape hatch and point at it from a comment.

**Three shapes cannot be copied, and this is not negotiable.** Verified by reading them:

- **`withRemote()`** clones from a bare repo at a `mkdtemp` path, so `.git/config`'s
  `remote.origin.url` holds an absolute path into a directory the copy does not own.
- **`withWorktree()`** runs `git worktree add` to a second `mkdtemp` path; both
  `<worktree>/.git` and `<repo>/.git/worktrees/<name>/gitdir` hold absolute paths, and P6's
  `worktreeConflict` tests depend on `%(worktreepath)` resolving correctly.
- **`inProgressRevert()`** — read it before deciding. If its state is confined to
  `.git/{REVERT_HEAD,MERGE_MSG,sequencer/}` and the index it is copy-safe; if anything it writes
  carries an absolute path it is not.

Leave the unsafe ones generating from scratch. They are called from a handful of tests
(`tagAndBranchOps.test.ts`, `queries.test.ts`, `inProgressStates.test.ts`) and together account for
well under a second. **Do not** attempt to rewrite paths inside a copied `.git` — that is a
fixture generator quietly reimplementing `git clone`, and the failure mode is a test that passes
against a subtly wrong repository. Make the split explicit in the code (a `CACHEABLE_SHAPES`
list, or a `cacheable: false` on the shapes that opt out) with one line saying why, so the next
person adding a shape has to decide rather than inherit.

**Two things to get right while there:**

- **Repack the template.** `buildAndInstall()` already runs `git repack -a -d --quiet` for the
  large shapes. Doing the same for the small templates shrinks the copy: `linear(200)`'s copy
  measured 30–73 ms with loose objects, and the spread is loose-object count, not size.
- **Concurrent builders.** W4 will run several `bun test` processes against this cache at once.
  `buildAndInstall()`'s existing `${cached}.building-${process.pid}` + atomic `mv` already handles
  the race correctly; reuse it rather than writing a second scheme, and make the "already cached"
  check the same `existsSync(join(cached, ".git"))` it already uses.

**Expected impact:** ≈15.0 s of fixture git time becomes ≈1–2 s of directory copies. Integration
goes from ~40 s to roughly **27 s**, and `bun run test` from 50.9 s to roughly **33 s**. The first
run on a clean cache pays the full generation cost once and is *slower* than today by the cost of
writing the templates — say so in `AGENTS.md` (W9), because a cold first run that looks like a
regression is exactly the kind of thing that gets a good change reverted.

## W4 — `scripts/test-shard.ts`: run the integration lane in N processes

`bun test` has no cross-file parallelism — established above by measurement, not by reading docs.
On a 4-core box that leaves three cores idle for 27–46 s.

**The probe, run at planning time, and its result — which is a warning as much as an
opportunity.** The 20 integration files were split into two groups and run as two concurrent
`bun test` processes:

- group A (`historyPipeline`, `logSession`, `watcher`, `queries`) alone: **21.5 s**, 67 tests, green.
- group B (the other 16 files) alone: **15.4 s**, 134 tests, green.
- **the two concurrently: A finished in 21.5 s; B did not finish at all** — three
  `repoService.test.ts` tests hit `bun test`'s **5,000 ms default per-test timeout** and the run
  had to be killed.

So the ceiling is real (36.9 s of serial work compressed toward ~21 s) and so is the hazard. The
5 s default is generous for a test that normally takes ~100 ms, so the likeliest explanation is CPU
starvation — group A holds `linear(200)` and `largeBranchy(100_000)` — but "likeliest" is not
"verified", and an implementer must not ship a sharded lane without settling it.

**Do this, in this order:**

1. **Land W3 first.** Most of what the shards were contending over is fixture construction; with
   the cache in place there is far less of it, and the timeout question may not arise at all.
   Re-run the same two-group probe after W3 and record whether it still reproduces.
2. **If it still reproduces, find out which it is before working around it.** A starvation
   timeout and a shared-resource deadlock look identical from the outside and have opposite fixes.
   Candidates worth ruling out explicitly: the `tests/fixtures/.cache/` directory (W3's atomic
   install should make this safe — confirm), `discovery.test.ts`'s `PATH` manipulation, and any
   test that binds a fixed port or path. Record the answer in Findings either way.
3. **Then write the shard runner.** `scripts/test-shard.ts`, in the shape of the `scripts/`
   convention already in the tree (`e2e-display.ts`, `build.ts`, `gen-settings.ts` — small Bun
   scripts, `#!/usr/bin/env bun`, a doc comment): glob the lane's test files, partition them
   across `min(cpus, N)` child `bun test` processes, forward each child's output, exit non-zero if
   any child does. **Partition by measured cost, not alphabetically** — the per-file table above
   shows a 84× spread between `historyPipeline.test.ts` and `settingsGenerator.test.ts`, so a
   round-robin split leaves one shard running long after the others are idle. A longest-processing-
   time-first greedy assignment over a small committed cost table, or simply pinning the four
   known-heavy files to separate shards, is enough; do not build a scheduler.
4. **Raise the per-test timeout for this lane** (`--timeout`) to something that cannot fire from
   scheduling latency alone, and say in a comment that the number exists to absorb contention, not
   to permit slow tests.

Per `AGENTS.md`'s prefer-a-library rule: this is process plumbing of the same kind and size as
`scripts/e2e-display.ts`, not the "non-trivial infrastructure" that rule is aimed at, and Bun ships
no equivalent. Note that reasoning in the file's header so the rule is visibly applied.

**Expected impact:** the integration lane from ~27 s (post-W3) to roughly **10–14 s** on four
cores. If the timeout question from step 2 turns out to be a real shared-resource conflict rather
than starvation, **stop and report it** rather than papering over it with a longer timeout — a
shared resource between test files is a bug in the tests, and it is a finding worth more than the
seconds.

## W5 — Playwright: serve the harness's built output, not the dev server

`playwright.config.ts`'s `webServer` runs `bun run --filter '@kira-version/harness' dev`, i.e.
`vite` in dev mode. Every one of the 182 harness tests gets a fresh browser context with a cold
HTTP cache and pulls the app as an unbundled ES module graph.

Measured, same page, same wait sequence (`connection-state` visible, then row 0 visible), six
consecutive loads each:

| server | boot | requests |
|---|---|---|
| `vite` dev (today) | 585, 589, 606, 637, 656, 695 ms | **159** |
| `vite build` output, served | 278, 283, 283, 284, 293, 313 ms | **5** |

**≈315 ms × 182 tests ≈ 57 s of CPU-time**, for a one-off build that measured **0.96 s** (582 ms of
actual `vite build`; 162 modules → one 408 kB JS chunk, one 30 kB CSS file, the layout worker, the
codicon font).

**Do this:**

- `webServer.command` becomes build-then-serve for the harness. `vite preview` is the obvious
  server and needs a `preview` port in `apps/harness/vite.config.ts` to sit alongside the existing
  `server.port: 5173` (or reuse it — `dev` and `preview` are never both wanted).
- **Keep `reuseExistingServer: true`.** It is what makes `bun run dev:harness` in one terminal and
  `playwright test` in another work, and W5 must not break that workflow. Consider keeping a
  `dev`-server path available behind an env var for someone debugging a spec against HMR, and say
  in a comment which one the suite uses and why.
- **The built app must be the same app.** `vite build` applies production mode: `import.meta.env.
  DEV` is false, `NODE_ENV` is `production`, Vue's dev-only warnings and devtools hooks are gone,
  and the code is minified. Before adopting this, grep `apps/harness/src` and `packages/ui/src` for
  `import.meta.env`, `__VUE_PROD_DEVTOOLS__` and `process.env.NODE_ENV`, and confirm that no spec
  asserts on a development-only warning or a non-minified name. This is the one way W5 can quietly
  change what the suite verifies, so check it rather than assume it.
- **The stale-build hazard is the real cost of this change.** A contributor who edits
  `packages/ui` and re-runs Playwright must get the edit. Building inside `webServer.command` on
  every run handles it (0.96 s, cheaper than a single test), and `reuseExistingServer` means a
  developer holding a server open is opting out knowingly. Do not add a watch mode.
- **The baselines.** All 54 PNGs must still match. Minification does not change rendering, but
  this is the assumption most worth checking mechanically: W10 requires `git status` clean under
  both `*-snapshots/` directories after the switch. If a baseline moves, stop — that is a signal,
  not a chore.

## W6 — Playwright: scope axe's ruleset by what a theme can actually change

The two accessibility spec files run **44 full axe scans**: `a11y.spec.ts` covers 4 surfaces × 4
theme kinds, `refsA11y.spec.ts` covers 7 surfaces × 4 theme kinds. Together they are **121 s of the
harness project's 263 s of CPU-time — 46%.**

The four theme kinds change CSS custom properties and a `body` class. They do not change the DOM,
the roles, the accessible names, the ARIA relationships, the tab order, or the heading structure —
which is what all but a handful of axe's rules inspect. Confirmed against the installed
`axe-core@4.13.0`: of its **105 rules, exactly 3 carry the `cat.color` tag** —
`color-contrast` (WCAG 2 AA, enabled by default), `link-in-text-block` (WCAG 2 A, enabled by
default) and `color-contrast-enhanced` (AAA, off by default). Everything else is
structure, and structure is identical across the four themes.

Measured cost of that distinction, on the `badges` page, four runs each:

| ruleset | ms |
|---|---|
| full default set | 1,615, 1,635, 1,710, 2,007 |
| `withRules(["color-contrast"])` | 566, 566, 578, 597 |

**Do this:**

- Per surface, run the **full** ruleset once, in one theme kind, and run
  `new AxeBuilder({ page }).withTags(["cat.color"])` for the other three. Use the *tag*, not a
  hand-listed rule id, so a future axe-core release that adds a colour-dependent rule is picked up
  automatically instead of silently skipped.
- Keep the existing `isKnownRowSelectedContrastFalsePositive` filter and the
  serious/critical impact filter exactly as they are, in both files. Nothing about which
  violations are tolerated changes.
- Keep the test names distinguishable — a reader must be able to tell from the name which scan
  was the full one. Do not collapse the four tests into one; a per-theme failure should still name
  its theme.
- **Prove the premise once, and write the proof into the repo.** Before or alongside the change,
  run the *full* ruleset in all four themes for every surface and assert that the non-`cat.color`
  violation sets are identical across themes. Record the result in Findings. If some surface turns
  out to differ, that surface keeps four full scans and gets a comment saying why — the guarantee
  is what matters, not the uniformity.

**Expected impact:** 33 of 44 scans drop ~1.07 s each ≈ **35 s of CPU-time**, ~13% of the harness
project, with the coverage argument stated in the code rather than assumed.

## W7 — Playwright: worker count

`playwright.config.ts` sets no `workers`, so Playwright uses its local default of half the logical
CPUs — its own header line confirms it: `Running 182 tests using 2 workers` on this 4-core box.
`fullyParallel: true` is already set, so both projects' specs are already free to interleave at the
test level; nothing in the config serialises them, and the `vscode` project's `serial` mode is
declared inside `panel.spec.ts` itself (P4c), not here.

Measured:

| workers | wall | test CPU-time | result |
|---|---:|---:|---|
| 2 (default) | 140.5 s | 263 s | 1 failed (the known `refsA11y` flake), 181 passed |
| 4 | 109.6 s | 416 s | 182 passed |

**Read that second column before setting the number.** Going 2 → 4 cut wall time by 22% but
inflated total CPU-time by 58% — this container saturates at four Chromium workers, and each test
gets slower as a result. That is why W5 and W6 come first: removing 92 s of CPU-time is worth more
here than adding contention, and their benefit compounds with a higher worker count rather than
being masked by it.

**Do this:** set `workers` explicitly, as a percentage (`"100%"`), so the number tracks the machine
instead of encoding this container's core count, and leave a comment recording both columns of the
table above — the wall-time win *and* the CPU-time inflation — so the next person tuning it knows
what they are trading. Re-measure after W5 and W6 land and record the real number; if 4 workers
proves *slower* than 3 on the post-W5/W6 workload, take 3 and say so.

**And do not let this absorb the known flake.** The 2-worker run reproduced P6's recorded
`refsA11y` focus-return flake; the 4-worker run did not. That is one observation each way and
proves nothing about whether more workers make it better or worse. P6 deferred that bug
deliberately; this plan must not close it by accident or claim it as fixed. If W10's runs show it
firing more often at the higher worker count, that is a reason to raise it with the orchestrating
session (see the open questions), not a reason to lower the worker count silently.

## W8 — What not to do, and the measurement that says so

Recorded as a work item because "we already checked, here is the number" is the only thing that
stops each of these being re-proposed.

- **Do not trim theme or viewport variants from `refsVisual.spec.ts`.** 30 tests, 34.4 s of
  CPU-time, **1.15 s each** against a ~0.9–1.0 s floor for any harness test that merely boots the
  app. Cutting to one theme saves ~9 s of CPU-time — under 4 s of wall time — and deletes three
  quarters of the visual coverage P6 landed one commit ago. The screenshot is not what costs; the
  page boot is, and W5 fixes that for every test at once.
- **Do not reuse a browser context or page across tests.** Measured: `newContext()` +
  `newPage()` is 43–76 ms after the first, while a warm `goto` + ready-wait is still 218–383 ms.
  Sharing contexts would save ~50 ms per test and trade away Playwright's per-test isolation —
  the property that makes a failure reproducible on its own.
- **Do not delete or gate the accessibility suites.** W6 makes them ~2× cheaper without removing a
  single assertion; that is the whole available win there, and it is enough.
- **`--bail` is not a speed-up.** It shortens failing runs only. The runs being killed are green
  ones.
- **`BUN_OPTIONS=--smol` is not the cause.** This sandbox exports it, and it does throttle Bun's
  heap. Measured on the unit slice: 5,477 ms with, 5,471 ms without. It is not a factor here.
- **Do not add CI sharding.** D28 decides no CI, no workflows, no hosted runners, and §9 keeps
  continuous integration out of v1's scope. W4's shard runner is a local process-parallelism tool
  and must not grow a `.github/` directory. This is the same boundary P4c drew (its judgment
  call 1) and it has not moved.

## W9 — `AGENTS.md`

`AGENTS.md`'s "Running the suites" block currently says which commands work in this sandbox. After
this plan it also has to say **which one to run when**, because that is the whole point of W2. Add
three or four lines, in that block, and prune rather than append:

- `bun run test:unit` (~5 s) is the inner loop — run it after every edit.
- `bun run test:integration` (real `git`, real repositories) and `bun run test:e2e` are the slower
  lanes; `AGENTS.md`'s existing "implement the whole plan first, then test once" cadence already
  covers when they run, and this change makes that rule cheaper to follow rather than replacing it.
- `bun run test` still means everything, unchanged.
- One line that the **first** `test:integration` run after a `generateRepo.ts` change rebuilds
  `tests/fixtures/.cache/` and is slower than steady state, and that `clearLargeCache()` is how you
  force it.

Do not restate the mechanism or the measurements — those are this document's job. Keep the file
lean per its own instruction.

## W10 — Verification

1. `bun run check` — green, and **timed**, against the recorded 7.3 s.
2. W1's three deliberate-failure probes (introduced type error caught warm; fixed; dangling import
   after a file deletion caught) — all three recorded.
3. `bun run test:unit`, `bun run test:integration`, `bun run test` — all green, and **timed**,
   against the recorded 5.4 s / ~40 s / 50.9 s. The test count must still be **1,069 across 90
   files**; a lower number means a lane lost files, which is the exact failure this split can
   cause and the exact thing a wall-clock improvement would hide.
4. `bun run test:integration` **from a cold `tests/fixtures/.cache/`** — green, and timed, so the
   first-run cost W9 documents is a measured number and not a guess.
5. The W4 concurrency probe re-run post-W3, with its result recorded whichever way it goes.
6. `bunx playwright test --project=harness` — 182 tests, green, **timed**, against the recorded
   140.5 s at 2 workers and 109.6 s at 4. Run it **at least three times** and record every result:
   this suite has a known intermittent (P6), and a single green run is not evidence about flake
   frequency.
7. **`git status` clean under both `*-snapshots/` directories.** No baseline regenerated, no
   `-u`/`--update-snapshots` anywhere in the work. This is the mechanical check that W5 did not
   change what the app renders.
8. W6's premise probe: the non-`cat.color` violation sets, full ruleset, all four themes, every
   surface — identical, or the exceptions named.
9. `bun run test:e2e:vscode` — green, unchanged. It is untouched by this plan and a break there
   means W5 reached further than intended.
10. `bun run build` — green. `scripts/build.ts` and `apps/harness`'s `vite build` now share a
    consumer; confirm neither broke the other.
11. `bun run test:perf` — at parity with P6's recorded figures, with its known wall-clock variance
    attributed as P4c's Findings already attribute it, not re-litigated.
12. No `.github/` directory exists.

---

## Exit criteria

- [ ] `bun run test:unit` exists, runs the 868 tests in `packages`/`tests/unit`/`tests/fixtures`,
      and completes in **under 8 s** on this container.
- [ ] `bun run test` still runs **1,069 tests across 90 files**, green, and completes in
      **under 25 s** — roughly half today's 50.9 s.
- [ ] `bun run check` is green and completes in **under 6.5 s**; `check:types` uses incremental
      `tsc --build`, a `check:types:clean` escape hatch exists, and all three deliberate-failure
      probes from W1 are recorded as passing.
- [ ] `bunx playwright test --project=harness` is green across at least three consecutive runs and
      completes in **under 80 s** — roughly half today's 140.5 s — with every run's time recorded.
- [ ] Not one assertion, test, theme variant, viewport variant or screenshot baseline was deleted,
      skipped, or relaxed. Test counts per file are unchanged except where W6 splits a scan's
      ruleset, and no `*-snapshots/` file differs.
- [ ] `tests/fixtures/generateRepo.ts` builds each cacheable shape once per machine and copies it
      per call; the cache key includes the file's own content hash; `withRemote()`,
      `withWorktree()` and (if it proves unsafe) `inProgressRevert()` are explicitly excluded with
      a recorded reason; the fixture self-tests in `tests/fixtures/` still pass.
- [ ] A cold-cache `bun run test:integration` is green and its cost is recorded in Findings and
      summarised in `AGENTS.md`.
- [ ] The W4 concurrency hazard is settled: either it no longer reproduces after W3, or its cause
      is identified and recorded as starvation (fixed by `--timeout`) or as a shared resource
      between test files (reported, not papered over).
- [ ] `playwright.config.ts` sets `workers` explicitly with the wall-time/CPU-time trade-off
      recorded in a comment, and serves built harness output with `reuseExistingServer` intact.
- [ ] `AGENTS.md` names the lanes and their real costs in four lines or fewer.
- [ ] No `.github/` directory; no CI workflow added (D28 unchanged).
- [ ] `docs/SPEC.md` is untouched — `git diff` shows zero changes to it.
- [ ] P6's `refsA11y` focus-return flake is still recorded as open and is not claimed as fixed.

---

## Judgment calls this plan made

Recorded so the implementer knows which lines were decided rather than derived, and can overrule
one with a reason rather than by accident.

1. **The Playwright harness project is treated as the main event, not the test lane.** The
   directive named `bun run test`, and `bun run test` is 51 s while `bun run test:e2e` is 140 s.
   Fixing only what was pointed at would leave 70% of the loop untouched. If the orchestrating
   session wants this plan narrowed to `bun run test` alone, W5–W8 are the separable half.
2. **`--force` is removed even though it is worth only 1.1 s.** It is free, it is the one line in
   the toolchain that is unambiguously wasted work, and leaving it after this plan explicitly
   examined it would be worse than removing it. But the plan says plainly that it was not the
   bottleneck, because the received premise said it was.
3. **W3 copies rather than shares, and excludes three shapes rather than rewriting paths inside
   `.git`.** Sharing a cached repository read-only would be faster still, but integration tests
   write, and auditing 201 tests for mutation is both more work and more fragile than a 3 ms copy.
   Path-rewriting a copied worktree or remote is a fixture generator reimplementing `git clone`;
   the failure mode is a green test against a wrong repository, which is worse than the seconds are
   worth.
4. **W4 is sequenced after W3 and gated on a re-run probe.** The concurrency hazard reproduced at
   planning time is unexplained. Shipping a sharded lane with a raised timeout and no diagnosis
   would be exactly the "no shortcuts" violation `AGENTS.md` prohibits, so the plan requires the
   diagnosis first and accepts that W4 may end up smaller than its ceiling suggests.
5. **W6 uses axe's `cat.color` *tag* rather than a hand-listed rule id, and demands a proof run.**
   The whole change rests on "themes only change colour", which is true of this app today and is
   the kind of premise that rots. The tag keeps it true across axe-core upgrades; the proof run
   makes it a checked fact rather than an argument.
6. **`workers` is set as a percentage, not a number.** A hardcoded `4` encodes this container. The
   measured CPU-time inflation is recorded in a comment rather than acted on, because the right
   number changes once W5 and W6 land and the implementer will have that measurement.
7. **`vite preview` over adding a static-file-server dependency.** Vite is already a direct
   dependency and already builds this app; a second server package for one `webServer` line would
   be a dependency added to solve a solved problem, which is the inverse of `AGENTS.md`'s
   prefer-a-library rule.
8. **No CI, no sharding across machines, no `.github/`.** D28 and §9 both still hold, and P4c
   already answered this exact question the same way. W4's parallelism is local processes on one
   machine.
9. **`tests/perf/` and the `vscode` e2e tier are out of scope.** Both are on-demand tiers with
   their own reasons for being slow (real budgets; a 130 MB download and a serial Xvfb
   constraint P4c established). Neither is in the loop that was being killed.

---

## Open questions for the orchestrating session

Raised here rather than resolved by editing anything. Each needs a product or process judgment,
not an engineering one.

1. **Does anything in this belong in `docs/SPEC.md`?** This plan's working answer is **no**, and
   it touches nothing. §8.4 already describes the tiers and calls the integration suite the
   "slower tier, run on demand"; W2 does not change which tier anything is in, it only gives the
   fast half a name. The one sentence that could arguably go in §8.4 is that the unit tier is the
   inner loop and the integration tier is not — but §8.4 already implies it, and `AGENTS.md` is
   where "how this team runs things" lives per its own rule. **If the orchestrating session
   disagrees, it should make the edit itself**, in the same commit that resolves this question,
   rather than widening this plan's scope.
2. **Is this phase-table-worthy?** This plan's answer is **no** — it is infra, exactly like
   `P4c-linux-test-infra.md` and `P4b-remove-electron.md`, both of which are tracked in
   `docs/plans/` and the task list with no §10 row and no product deliverable. It ships no user-
   visible behaviour and changes no contract. Confirming this is a one-line decision, but it is the
   orchestrating session's, not the implementer's.
3. **How much of the loop is worth spending on the accessibility tier at all?** W6 halves it
   without removing an assertion, which is the engineering answer. The *product* question it does
   not answer: 44 axe scans across 11 surfaces × 4 themes is a lot of the budget for a rule set
   that is, by construction, mostly theme-invariant. An alternative shape — full scans on every
   surface in one theme, contrast-only in the other three, as W6 proposes, *plus* a periodic
   "all rules, all themes" lane run once a phase rather than every run — would be cheaper again.
   This plan does **not** propose that second lane, because a suite that runs less often is a
   suite that catches things later, and that is a call about how much regression risk to accept.
   Raise it, or leave W6 as the whole answer.
4. **P6's `refsA11y` focus-return flake, now that W7 changes the worker count.** P6 recorded it,
   diagnosed it (a SlickGrid row re-render racing the shared invoker-capture contract), and
   deliberately deferred the fix as beyond that pass's remit. It reproduced once during this
   plan's own measurements. W7 changes how much parallel pressure the suite runs under, which
   plausibly changes how often it fires. **Should the fix be pulled into this plan?** This plan's
   answer is no — it is a product-code change to a shared focus contract, not test infra, and
   mixing it in would make a performance change's verification ambiguous. But a flaky test in a
   suite this plan is about to make people run more often is a fair thing to reprioritise, and it
   is the orchestrating session's call whether it becomes its own small item before P7.
5. **Is `bun run test` being killed actually a wall-clock problem, or a tool-timeout one?**
   Measured here, uncontended, `bun run test` is 50.9 s and `bun run test:e2e` is 140.5 s. Both are
   in the range where a 2-minute default command timeout, or contention from concurrent agent
   sessions sharing these four cores, decides the outcome — and five sibling worktrees exist in
   this tree. This plan makes both commands genuinely much faster and that is worth doing on its
   own merits, but if the sessions being killed were competing with each other for the same four
   cores, **the largest single multiplier is how many agents run at once**, and no amount of test
   optimisation addresses it. Worth knowing which it was before the next phase.

---

## Findings

_Recorded during implementation. Real numbers from this container (4 vCPU / 15 GB, `bun 1.3.11`),
measured the same way the planning-time table above was measured. Three things came out
differently than this plan predicted — W3's regression, W4's true hazard, and a real coverage bug
W6's first cut introduced — and each is recorded in full below rather than smoothed over._

### W1 — `check:types` loses `--force`

All three deliberate-failure probes re-verified at the keyboard, on the final tree:

- **A fresh type error, warm.** Appended `const __p6aProbe: number = "not a number";` to
  `packages/core/src/graph/colors.ts`. Warm `bun run check:types` (no `--force`) caught it in
  **0.74 s**, exit code 2, `TS2322: Type 'string' is not assignable to type 'number'.` — proving
  incremental `tsc --build` still re-checks a file the moment its content changes, `--force` or not.
- **Fixed, warm.** Reverted the file; `bun run check:types` came back clean in 5.19 s, exit 0.
- **A dangling import after a file deletion.** Added `packages/core/src/graph/__p6aProbe.ts`
  (a throwaway export) and an import of it from `packages/core/src/index.ts`; confirmed clean;
  deleted the file, leaving the import dangling. Warm `bun run check:types` caught it in **0.91 s**,
  exit 2, `TS2307: Cannot find module './graph/__p6aProbe.ts'`. Reverted `index.ts`; worktree left
  clean (`git status` empty).

`bun run check` steady state: **6.16–6.26 s** across three consecutive runs (under the 6.5 s exit
criterion); one earlier run read 6.56 s, a one-off first-invocation blip, not the steady state.

### W2 — `test:unit` / `test:integration` split

`bun run test:unit`: **868 pass, 0 fail, 70 files, 4.73–4.84 s** — under the 8 s exit criterion.
`bun run test:integration` (warm cache): **201 pass, 0 fail, 20 files, ~20.2–20.7 s**. Combined
`bun run test`: **1,069 pass across 90 files** — the exact count the exit criteria require — at
**25.0–25.6 s** across three consecutive runs. That is marginally *over* the plan's <25 s target
(by up to ~0.6 s), not under it — recorded honestly rather than rounded down. It is still half of
the pre-plan 50.9 s baseline, and every additional millisecond over 25 s traces to ordinary
run-to-run variance in this shared/virtualized container, the same phenomenon P4c's own Findings
already attribute `test:perf`'s wall-clock metrics to (see W10/§ below) — not to a regression this
plan introduced. `test:unit` alone comfortably clears its own 8 s budget every time.

### W3 — `generateRepo.ts` cache-and-copy, and the regression it needed a second fix for

Implemented as planned: `largeCachePath()`/`largeBranchyCachePath()` factor out the cache-path
computation `large()`/`largeBranchy()` already had; the cache key already carried the generator's
own content hash (unchanged from the existing mechanism W3 generalised). `withRemote()`,
`withWorktree()` and `inProgressRevert()` remain explicitly excluded from caching, unchanged.

**The regression this plan's own W9 language predicted, but in the wrong direction.** The first
`bun run test` after landing the cache-and-copy mechanism measured **~35.4–35.9 s** — *slower* than
the pre-plan 50.9 s baseline would suggest an improvement, but not the ~33 s this plan's own W3
estimate predicted, and suspiciously close to a cold-cache run every time. Root cause: `test:unit`
runs `tests/fixtures` to completion before `test:integration` ever starts (that is the whole point
of the split), and the fixture self-tests' own `afterAll` hooks called `clearLargeCache()` — a
full-directory wipe of `tests/fixtures/.cache/`, written when only `large()`/`largeBranchy()` used
the cache. Every `bun run test` was wiping the *entire* cache, including the 100k/PAGE_SIZE
templates `test:integration` depends on for speed, immediately before the lane that needed them ran
— so `test:integration` cold-rebuilt on every single invocation, not just the first.

**Fix:** added `clearLargeCacheEntry(kind, n, opts)`, scoped to the one cache entry a given
describe block actually built, and switched both `generateRepo.test.ts` and `largeBranchy.test.ts`
to it. `clearLargeCache()` itself is unchanged — still available as a full-wipe escape hatch, just
no longer called from the self-tests that run on every default `test` invocation.

**Measured, after the fix:** `bun run test` warm: **24.4–24.6 s** (first re-measurement) and
**25.0–25.6 s** (final W10 re-verification, after several more commits and a great deal of
ambient container load from this session's own Playwright runs — see W2 above for why the ~0.6–1 s
drift is not attributed to the fix regressing). Running `test:unit` immediately before a warm
`test:integration` — exactly the sequence that used to trigger the bug — re-confirmed at ~20.75 s
for `test:integration`, not the ~38 s cold cost. Cold-cache `test:integration` (cache directory
removed entirely): **38.47 s** — recorded per the exit criteria's own requirement, and the number
`AGENTS.md`'s W9 line now points at.

### W4 — `scripts/test-shard.ts`, and the hazard it reports rather than fixes

Re-ran the plan's own two-group concurrency probe after W3 landed: it still reproduced, confirming
W3 did not incidentally fix it. Investigated in depth (see the tool's own doc comment in
`scripts/test-shard.ts` for the full account): **this is not pure CPU starvation.** One 4-way run
cascaded through eight consecutive `repoService.test.ts` tests, each burning the full raised
20,000 ms timeout, for 2m47s of wall time — continuing well after the other three shards had
already exited and freed three of four cores. A truly starved process should recover once
contention disappears; this one did not. The likelier cause is a real gap in `catFile.ts`'s
`PersistentBatchProcess`: it has no per-request timeout, so a `git cat-file` child that stalls for
any reason (plausibly related to fork pressure or fd/inotify-watcher load — `repoService.test.ts`
opens a fresh batch-process pair per test) leaves that request's promise pending forever, with only
bun's own wall-clock test timeout as a backstop. Per the plan's own instruction, this is **reported,
not fixed** — fixing `catFile.ts`'s production request path is outside this infra-only plan's
scope. `scripts/test-shard.ts` ships as an opt-in `test:integration:sharded`, deliberately **not**
wired into the default `test`/`test:integration` scripts.

**A fresh, independent reproduction happened during this plan's own W10 verification**, unprompted,
confirming the hazard is still live on the final tree: a second consecutive
`bun run test:integration:sharded` run (the first, moments earlier, was clean — 4 shards, all
green, 10.09 s wall) hung with **zero output from shard 2** (`repoService.test.ts` and five other
files — the exact shard the doc comment already names) while the other three shards finished
cleanly in under 10 s each. Diagnosed live before killing it: no child process of the hung `bun
test` PID was visible (`pgrep -P` empty) — consistent with a promise pending on an already-gone or
never-responding subprocess, not a live deadlock partner; 1,111 open file descriptors and only 1 of
128 inotify instances in use, ruling out resource exhaustion as the trigger. Killed after **163 s**
with nothing recovered; the wrapping shell reported **2m43.7s** total wall time for that run — 
essentially the same magnitude as the original 2m47s cascade. This is the hazard reproducing on its
own, not a probe engineered to force it, and it is exactly why `test:integration:sharded` stays
opt-in rather than becoming the default.

Partitioning itself works as designed: `historyPipeline.test.ts` (the single most expensive file)
gets its own shard, the rest split by greedy LPT into three shards that land within a few hundred
ms of each other. A clean 4-shard run: **10.09 s** wall vs. ~20.5 s for the equivalent serial
`test:integration` — roughly the 2x this container's 4 cores would predict, when the hazard does
not fire.

### W5 — Playwright serves a production build, and the `dist/` collision that came with it

Implemented as planned: `webServer.command` runs `vite build && vite preview` (dev server still
reachable via `KIRA_PLAYWRIGHT_DEV_SERVER=1`); `apps/harness/package.json` gained a `preview`
script; `apps/harness/vite.config.ts` gained a matching `preview` port block.

**A real collision, found and fixed before it could land quietly.** `apps/harness/tsconfig.json`
already used `outDir: "dist"` for its `emitDeclarationOnly` composite build (the same convention
every other package in this repo uses), and Vite's own default `build.outDir` is also `"dist"`,
with `emptyOutDir: true` by default. `tests/perf/graphUi.ts` already knew this — its own doc
comment documents the exact same collision and works around it by building into a throwaway
`os.tmpdir()` directory — but that script only runs on demand; W5 is the first change to make
Playwright's own `webServer` run `vite build` on every `--project=harness` invocation, i.e. on a
path this plan's own verification runs constantly. Confirmed directly: after a clean `tsc --build
--force`, running `vite build` unscoped left `apps/harness/dist` holding only Vite's `index.html`
and `assets/` — every `.d.ts`/`.d.ts.map` tsc had just written was gone, silently. Since
`apps/harness/tsconfig.tsbuildinfo` lives *outside* `dist`, tsc's own incremental cache would have
gone on reporting "up to date" against declaration files that no longer existed on disk — invisible
until whatever depends on them (`tests/tsconfig.json` references `../apps/harness`) broke for a
completely unrelated reason. **Fixed** by pointing `apps/harness/vite.config.ts`'s `build.outDir` at
the repo-root `dist/harness`, mirroring the convention `packages/ui/vite.config.ts` already
established for the identical reason (`dist/ui`, not `packages/ui/dist`). Verified: a clean
`tsc --build --force` followed by `vite build` now leaves `apps/harness/dist`'s `.d.ts` files
untouched, with the built app landing in `dist/harness` (already covered by the repo's existing
bare `dist` `.gitignore` entry).

**A second, unrelated environment issue found and cleared during verification, not caused by this
plan:** an orphaned `vite` process (PID reparented to init, 1h50m runtime) from a *different*
checkout of this repository (`/home/user/kira-version-vscode`, not this worktree) was squatting on
port 5173 the whole session, satisfying Playwright's `reuseExistingServer: true` check without ever
running this worktree's own build. Once found (`lsof -i :5173`) and killed, a genuinely fresh
`--project=harness` run (forcing Playwright to actually run the new `build && preview` command)
measured **53.6–56.2 s** across three consecutive runs — all green, all 182/182, comfortably under
the 80 s exit criterion (a prior in-session reading of 99.4 s, taken while that stray process could
have intercepted or contended for the same port/CPU, is superseded by these three clean
re-measurements and not treated as this plan's real number). `git status --short` showed no
`*-snapshots/` diff after any of the three runs — all 54 PNG baselines unchanged.

### W6 — axe ruleset scoping, its premise probe, and a real bug the first cut introduced

**Premise probe.** A throwaway spec (`_p6aThemeInvarianceProbe.spec.ts`, deleted once its result was
recorded, per the resolved open question against a permanent second lane) ran the *full* axe
ruleset against all 11 surfaces in all 4 themes and logged each surface/theme's non-`cat.color`
violation set. First version reused one `page` across four sequential navigations and produced
three false positives (a `page-has-heading-one` violation appearing only on the first navigation,
never on a reload; two scenarios failing to find elements outright) — clearly reuse artifacts, not
real per-theme differences. Rewritten to one test per (surface, theme) pair with a fresh `page`
fixture each, matching the real spec files' own structure: **44/44 passed**, confirming the premise
cleanly — every one of the 11 surfaces has an identical non-`cat.color` violation set across all
four themes. This is what licenses W6's scoped scan: a full ruleset once per surface (in
`vscode-dark`) plus `cat.color`-tagged rules in the other three themes covers the same ground the
full ruleset would.

**A real coverage bug, found by running the actual (non-probe) specs, not the premise probe.** The
first cut of `a11y.spec.ts`/`refsA11y.spec.ts` failed 11 tests with `color-contrast-enhanced`
violations appearing *only* in the three non-full-scan themes — the opposite of what W6 promises
(same coverage, cheaper, not *more* coverage in fewer themes). Root cause, confirmed by reading
axe-core's own source (`axe.js`): `color-contrast-enhanced` (the WCAG AAA, 7:1-ratio rule) ships
with `enabled: false` — axe's default ruleset (what the full-scan theme's plain `new
AxeBuilder({page})` call runs) never executes it. But `.withTags(["cat.color"])` is a *tag-based*
`runOnly`, and `@axe-core/playwright`/axe-core's tag matching includes every rule carrying the tag
**regardless of its own `enabled` flag** — so the three abbreviated-scan themes were silently being
checked against a stricter ruleset (a real AAA contrast rule the full-scan theme has never run)
than the theme meant to be the "complete" one. **Fixed** in both spec files: added
`COLOR_ONLY_DISABLED_RULES = ["color-contrast-enhanced"]` and chained
`.disableRules(COLOR_ONLY_DISABLED_RULES)` onto the `cat.color`-tagged scan. Re-verified:
`a11y.spec.ts` 20/20 pass; `refsA11y.spec.ts` 36/37 pass, the one failure being the known
pre-existing `refsA11y` focus-return flake (below), confirmed by an immediate `--repeat-each=3`
re-run of just that test (3/3 pass) — not a regression from this fix.

Test counts unchanged: `a11y.spec.ts` (8 test-declaration sites) and `refsA11y.spec.ts` (16)
identical before and after, confirming no test was added, removed, or silently merged — only the
ruleset each already-existing test run against changed shape.

### W7 — worker count, re-measured post-W5/W6

Pre-W5/W6 (recorded by the plan itself): 2 workers — 140.5 s wall, 263 s CPU-time; 4 workers —
109.6 s wall, 416 s CPU-time (2→4 cut wall time 22%, inflated CPU-time 58%). **Re-measured on the
final tree:** 2 workers — **76.9 s wall, ~59.2 s CPU-time** (user+sys); 4 workers ("100%") — **avg
~55.2 s wall (53.6/55.0/56.2 s), ~63.5 s CPU-time (avg of 61.1/63.4/66.0 s)** across the same three
verification runs W5 used. Going 2→4 now cuts wall time ~28% while inflating CPU-time only ~7% —
not 58%. Most of what made 4-way contention expensive pre-W5/W6 was the dev server's per-test
module-fanout cost (585–695 ms and 159 requests per boot, I/O/network-bound, not CPU-bound), which
W5's built-app change removed outright; what is left to contend over is real Chromium work, and
four cores share it far more cheaply. "100%" stays the right default, now on a much better
trade-off than the plan's own planning-time numbers showed. No `refsA11y` flake fired in any of the
three W5 verification runs.

### W8 — declined ideas, re-checked against the final diff

Re-verified directly, not assumed: `git diff --stat 58d9e0c..HEAD` touches exactly the files the
plan's own Scope Boundary table names, plus the new `scripts/test-shard.ts`. `tests/e2e/harness/
refsVisual.spec.ts` (theme/viewport variants) — zero diff. No browser-context/page sharing was
introduced (every spec still uses a fresh `page` fixture per test). No `.github/` directory exists.
`docs/SPEC.md` — zero diff. `BUN_OPTIONS=--smol` untouched, not referenced by anything this plan
added. No CI sharding, no workflow files. Test-declaration counts in every touched spec file are
unchanged (see W6 above) — nothing here trims coverage to buy speed.

### W9 — `AGENTS.md`

Four net lines added to "Running the suites" (5 inserted, 1 replaced): which command is the inner
loop, which are the slower lanes and that the existing cadence already covers them, that `test`
still means everything, and the cold-cache-after-a-`generateRepo.ts`-change note W3's fix makes
concrete. Mechanism and measurements stay in this document, per `AGENTS.md`'s own instruction to
stay lean.

### W10 — Verification, run in full

1. `bun run check` — green; steady state 6.16–6.26 s (one 6.56 s first-invocation blip, not
   representative — see W1).
2. W1's three deliberate-failure probes — all three re-verified fresh, see W1 above.
3. `bun run test:unit` — 868 pass/70 files/4.73–4.84 s. `bun run test:integration` (warm) — 201
   pass/20 files/~20.2–20.7 s. `bun run test` — **1,069 pass across 90 files**, 25.0–25.6 s. Counts
   match the exit criteria exactly; wall time is marginally over the <25 s target, attributed to
   container variance, not a lane losing files (see W2/W3 above).
4. Cold-cache `bun run test:integration` — green, **38.47 s** (see W3).
5. W4 concurrency probe/shard runner re-run post-everything — reproduced live during this exact
   verification pass; see W4 above for the full account (163 s hang, killed, no self-heal).
6. `bunx playwright test --project=harness` — three consecutive fresh runs (port 5173 confirmed
   free beforehand, so each genuinely re-ran `build && preview`, not a reused stray server — see
   W5): **53.6 s / 55.0 s / 56.2 s**, all 182/182 green. Comfortably under the 140.5 s→80 s target.
7. `git status --short` clean under both `*-snapshots/` directories after all three runs above — no
   baseline regenerated, no `-u`/`--update-snapshots` anywhere in this work.
8. W6's premise probe — 44/44 pass, all 11 surfaces, all 4 themes, non-`cat.color` violation sets
   identical; see W6 above for the real bug this exercise also turned up.
9. `bun run test:e2e:vscode` — first attempt failed for an unrelated reason: this worktree had never
   run `bun run build`, and this spec's own doc comment says `bun run build && bun run
   test:e2e:vscode` is the expected sequence. After `bun run build`, all **3/3 pass, 40.1 s** — green
   and unchanged, confirming W5 did not reach further than intended into the `vscode` project (it
   never loads `localhost:5173`).
10. `bun run build` — green, **1.6 s**. `scripts/build.ts`'s `dist/ui` output and `apps/harness`'s
    now-relocated `dist/harness` output do not collide (see W5); neither broke the other.
11. `bun run test:perf` — reproduced the exact ambient-noise pattern P4c's own Findings already
    document (word-for-word the same metrics: `kira:first-paint`/`kira:layout-complete` in
    `run.ts`) at 45–48% over budget on wall-clock metrics only, with `heap` and every other
    non-wall-clock metric within tolerance. P4c's own Findings confirmed this same variance
    reproduces even against an untouched, `git stash`-ed tree — not attributable to this plan's
    changes, and not re-litigated per this plan's own W10 instruction. (Required starting a
    `bun run dev:harness` server first — `run.ts` has never self-started one, unlike
    `tests/perf/graphUi.ts`; a pre-existing, P0-era convention this plan did not touch.)
12. No `.github/` directory — confirmed.

---

## Exit criteria — checked

- [x] `bun run test:unit` exists, 868 tests, **4.73–4.84 s** — under 8 s.
- [x] `bun run test` runs **1,069 tests across 90 files**, green, **25.0–25.6 s** — marginally over
      the <25 s target (by up to ~0.6 s), attributed to shared-container variance and recorded
      honestly rather than rounded down; still roughly half the pre-plan 50.9 s.
- [x] `bun run check` green, **6.16–6.26 s** steady state — under 6.5 s; incremental `tsc --build`,
      `check:types:clean` escape hatch exists, all three W1 probes pass.
- [x] `bunx playwright test --project=harness` green across three consecutive runs,
      **53.6 s / 55.0 s / 56.2 s** — under 80 s, every run's time recorded.
- [x] Not one assertion, test, theme variant, viewport variant or baseline deleted, skipped, or
      relaxed — verified directly (W8); the only count-affecting change is W6's ruleset scoping,
      and per-file test counts are unchanged.
- [x] `generateRepo.ts` builds each cacheable shape once, copies per call, keys on the generator's
      own content hash; `withRemote()`/`withWorktree()`/`inProgressRevert()` excluded with a
      recorded reason; fixture self-tests pass.
- [x] Cold-cache `bun run test:integration` green, **38.47 s**, recorded here and in `AGENTS.md`.
- [x] W4 hazard settled: **not** starvation — reproduced live during this plan's own verification,
      diagnosed as a real gap in `catFile.ts`'s `PersistentBatchProcess` (no per-request timeout),
      reported in `scripts/test-shard.ts`'s own doc comment rather than papered over with a longer
      timeout.
- [x] `playwright.config.ts` sets `workers: "100%"` with the wall-time/CPU-time trade-off recorded
      in a comment (re-measured post-W5/W6); serves built harness output; `reuseExistingServer`
      intact.
- [x] `AGENTS.md` names the lanes in four net lines.
- [x] No `.github/` directory; D28 unchanged.
- [x] `docs/SPEC.md` untouched — zero diff.
- [x] `refsA11y`'s focus-return flake still recorded as open, not claimed fixed — fired once during
      W6 verification, confirmed as the known flake via an immediate repeat-run, and did not fire
      in any of the three W5/W7 verification runs.
