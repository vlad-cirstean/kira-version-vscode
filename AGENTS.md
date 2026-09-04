# Working agreement

Facts about the app itself — protocol/contract constraints, host-quirk reasoning, and why a
design was chosen — live in `docs/SPEC.md` and each phase plan's own Findings section (see
`docs/plans/README.md`), not here. This file is process only: how this team works.

**Opus plans, a Sonnet subagent implements — this session only orchestrates.**

- The **main session runs on Sonnet, and it orchestrates only** — it does not implement, edit
  code, or fix findings directly. Its job is to spawn the right subagents in the right order,
  carry context between them, and track progress; the actual writing happens in a subagent every
  time.
- Each phase (see `docs/SPEC.md` §10 phasing table, P0–P12) gets an Opus-authored plan committed
  under `docs/plans/` before any implementation starts. Produce this by spawning an **Opus
  subagent** (`Agent` tool, `model: "opus"`) whose job is only to write that plan.
- If a phase's plan is missing from `docs/plans/`, do not implement from the spec directly — get
  the Opus plan written and committed first.
- **Once the Opus plan lands, spawn a Sonnet subagent** (`Agent` tool, `model: "sonnet"`) to
  implement it. Default to **one sequential subagent for the whole phase**, not several — a fresh
  subagent starts cold, so the orchestrating session's prompt to it must carry the plan and
  whatever prior-phase context (inherited Findings, open items) it needs to pick up with
  continuity, rather than assuming it remembers anything. **Use multiple subagents in parallel
  only when the plan's own work is genuinely independent and parallelizable** (e.g. several
  unrelated port adapters, or research that doesn't touch the same files or depend on other
  output) — never split a single continuous, order-dependent work item across subagents just to
  run it concurrently.
- **Within a phase, implement the whole plan first, then test once and fix what's found** — don't
  gate every intermediate commit on the full test suite. Cheap, fast checks (`bun run
  check:types`, `bun run lint`, a build) are fine to run as you go, since they're nearly free and
  catch obvious breaks immediately, but an expensive suite (`bun run test:e2e`, `bun run
  test:perf`, anything that takes real wall-clock time or spins up a real host) runs once, near
  the end of the phase's implementation, not after every commit. This is a cadence change only —
  the "best practices, no shortcuts" bar below still applies to the result, and a phase isn't done
  until that one full run is green and whatever it turned up is fixed and committed. Landing
  intermediate commits as the plan's own work is completed is still expected, for a legible
  history — this only changes when the expensive verification happens, not whether commits stay
  granular.
- **The loop per phase:** check for a plan → spawn an Opus subagent to write one if missing →
  spawn a Sonnet subagent (or several, only if the work is genuinely parallelizable) to implement
  the whole phase, and wait for it to finish before moving on. Phases are done one at a time, in
  order — do not parallelize or batch multiple phases together.
- **A phase asked for in multiple passes/iterations/rounds means repeat that whole loop that many
  times**, not run it once and call the extra passes optional. Each pass is its own
  Opus-plans-then-Sonnet-subagent-implements cycle, in order, each one written and implemented
  against the *current* state of the tree (i.e. on top of everything the previous pass already
  landed) — never against the pre-phase state, and never batched into one plan up front. Give each
  pass's plan its own file under `docs/plans/` (e.g. `P4.md` plus `P4-iter2.md`/`P4-iter3.md`
  suffixes) so the history of what each round found and fixed stays legible on its own. The point
  of more than one pass is that later rounds find what earlier rounds missed or newly created — an
  Opus session planning pass N should actually re-read the current source rather than trust pass
  N-1's own target-tree/summary prose, and should say plainly when a pass turns up nothing real
  rather than manufacturing a finding to fill it.
- **A "code review"** — run once a phase (or a batch of phases) is otherwise complete, on request —
  means spawning **three Opus subagents in parallel**, each analyzing the current tree against one
  dimension: (1) overall architecture and structure, maintainability, clean code, and security;
  (2) functional correctness and business logic (contract/protocol compliance, RPC handler
  correctness, cache/rehydration behavior); (3) performance and resource efficiency (against the
  `tests/perf/` budgets). Each agent only reports findings — it does not fix anything. The
  orchestrating session then spawns a Sonnet subagent to fix every finding — one sequential
  subagent by default, since findings usually land in overlapping files, and parallel subagents
  only for a batch of findings genuinely isolated from each other. Once every finding from that
  round is fixed, **repeat the whole three-agent cycle again** — a fresh round against the
  now-changed tree, not a one-shot — for as many rounds as asked for; this is the same "multiple
  passes" rule two bullets up, applied to review instead of implementation. A round that turns up
  nothing real should say so plainly rather than manufacture a finding to fill it. No findings
  document survives a round once it's fixed — each finding is fixed and committed one at a time,
  so the commit log is the durable record; carry forward only a genuinely still-open item (see
  "Known open items" below), never a running narrative of what each round found.
- **Best practices throughout, no shortcuts** — no stubbed error handling, no `TODO: fix later`,
  no skipped validation to make something demo. Scope left out of a phase is left out entirely,
  not half-implemented.
- **Reach for an existing, well-maintained library before hand-rolling non-trivial
  infrastructure** — a diffing/virtualizer, a layout/positioning engine, retry/backoff, and
  similar. Check whether a mature library already solves it and prefer adopting it over carrying a
  hand-rolled equivalent, the way this repo already relies on Vue, Vite, Playwright and Biome
  rather than reimplementing them. A hand-rolled version earns its keep only against a real
  requirement no general library meets (e.g. the packed commit-chunk wire format §5, a lane-layout
  algorithm this codebase controls end to end for the graph canvas), not just that the existing
  code already works.
- **Only fully open-source libraries** — no "community edition" of a dual-licensed product, no
  non-commercial-only free tier, no functionality gated behind a paid/Enterprise tier. Check the
  license at the package level *and* for the specific feature being used, not just the headline
  badge. Applies to every new dependency, not only the UI/graph-rendering ones.
- **Measure when there's a real, concrete question at stake — not as a default ritual for every
  decision.** A `tests/perf/` harness run against §5.1's budgets earns its keep when a claimed
  fix, regression, or cost genuinely can't be checked any other way (a stream round-trip
  transfer-cost question, a layout-worker throughput claim, a bundle-size cost that's the deciding
  factor for a dependency). Don't extend that same rigor to routine changes or to every option
  considered and declined along the way — a short, honest estimate or a plain read of the code's
  or library's own stated behavior is enough there. If a measurement wouldn't change the decision,
  skip it.
- **Comments: very concise, and only where truly necessary.** Add one only when the code cannot
  say it for itself — a non-obvious *why*, a constraint, a workaround. Never restate what the code
  already shows.
- **Unit tests earn their keep only for advanced, complex, or deeply nested logic** — cursor/page
  arithmetic with real boundary cases, the packed-chunk dictionary/interning scheme, cache
  eviction/rehydration rules that interact, the layout algorithm, concurrency (stream
  cancellation, sequence-dropping, ordering). The default for a new piece of code is *no dedicated
  unit test at all*: thin RPC handler wrappers, one- or two-condition validation, constructors,
  and serialize/deserialize round-trips with no format-specific edge case get nothing. This
  narrows *unit* tests specifically — it does not reduce what each phase plan's own harness
  scenarios, Playwright interaction/visual/accessibility suites, or `tests/perf/` budgets already
  require; those stay mandatory per-phase deliverables regardless of how trivial an individual
  unit looks. When torn between two similar unit tests, delete.
- **Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)** —
  `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, etc., with a `!` or `BREAKING CHANGE:`
  footer for breaking changes.
- **Keep this file lean — prune as you go, don't just append.** A fact about the app itself (why a
  host behaves a certain way, a protocol quirk, a design decision) belongs in `docs/SPEC.md` or
  the relevant phase's own Findings section under `docs/plans/`. A discovery, bug, or result from
  finishing one specific phase or review round belongs in that phase's own plan doc, never bolted
  onto this file as a permanent "findings" section; the plan doc and the commit log are the
  durable record of what a phase found and fixed, not `AGENTS.md`. Before adding a bullet here,
  ask whether it's a standing rule for how this team works or how to run things in this sandbox —
  if it's a one-off result from finishing a task, it goes elsewhere or nowhere. When you do touch
  this file, also remove anything that's gone stale: a workaround for a tool that's since been
  fixed, a pointer to a file or subsystem that no longer exists, an open question a later phase
  already resolved. A short "Known open items" list (below) is the one exception — keep it, but
  only while each item is genuinely still open, and delete an item the moment it's resolved rather
  than marking it done in place.

## Known open items

- None.

## Branching

- **All v1 work lands on `feature/kickoff`.** It is the integration branch for the whole of v1,
  not a per-phase branch. No per-phase PRs and no per-phase branches.
- Any agent picking up work **starts from the current tip of `feature/kickoff`** and adds on top
  of it. Fetch it first. Never branch from `main` — `main` stays at the pre-v1 state until v1 is
  done.
- This holds for as long as phases in `docs/SPEC.md` §10 remain unfinished. Once P12 (Ship) is
  complete, `feature/kickoff` merges to `main` and the rule lapses.
- **Never rebase or force-push `feature/kickoff`** — another agent's work may already sit on top
  of it. Merge, don't rewrite.
- The spec and the phase plans live on the same branch as the code, so a phase's plan is
  committed to `feature/kickoff` before its implementation begins.

## Structure

`docs/SPEC.md` §3.1 defines the folder and file layout normatively. P0 creates that tree; later
phases fill it in rather than reorganising it. If a phase needs a file the tree does not
anticipate, add it to the tree in the same commit — the spec stays the map.

Full spec: `docs/SPEC.md`.
