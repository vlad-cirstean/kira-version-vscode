# Working agreement

**Opus plans, Sonnet implements.**

- The **main session runs on Sonnet**. It implements directly — it does not delegate
  implementation to subagents.
- Each phase (see `docs/SPEC.md` §10 phasing table, P0–P11) gets an Opus-authored plan
  committed under `docs/plans/` before any implementation starts. Produce this by spawning an
  **Opus subagent** (`Agent` tool, `model: "opus"`) whose job is only to write that plan; the
  main Sonnet session then implements it.
- If a phase's plan is missing from `docs/plans/`, do not implement from the spec directly —
  get the Opus plan written and committed first.
- Do not spawn implementation subagents (Sonnet or otherwise) for the core sequential work.
  Phases build on each other, so the main session needs continuity of what was decided and why;
  a fresh subagent starts cold and has to re-derive that context, which is the expensive path.
  Subagents are fine for genuinely independent, parallelizable, or throwaway research (e.g.
  "how does the `pg` driver handle cancellation?") — not for writing the phase's code.
- **The loop per phase:** check for a plan → spawn an Opus subagent to write one if missing →
  Sonnet implements the whole phase → **stop**. Do not roll on into the next phase automatically;
  each phase boundary is a checkpoint.
- **Best practices throughout, no shortcuts** — no stubbed error handling, no `TODO: fix later`,
  no skipped validation to make something demo. Scope left out of a phase is left out entirely,
  not half-implemented.
- **Comments: very concise, and only where truly necessary.** Add one only when the code cannot
  say it for itself — a non-obvious *why*, a constraint, a workaround. Never restate what the code
  already shows.
- **Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)** —
  `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, etc., with a `!` or `BREAKING CHANGE:`
  footer for breaking changes.

## Branching

- **All v1 work lands on `feature/kickoff`.** It is the integration branch for the whole of v1,
  not a per-phase branch. No per-phase PRs and no per-phase branches.
- Any agent picking up work **starts from the current tip of `feature/kickoff`** and adds on top
  of it. Fetch it first. Never branch from `main` — `main` stays at the pre-v1 state until v1 is
  done.
- This holds for as long as phases in `docs/SPEC.md` §10 remain unfinished. Once P11 is complete,
  `feature/kickoff` merges to `main` and the rule lapses.
- **Never rebase or force-push `feature/kickoff`** — another agent's work may already sit on top
  of it. Merge, don't rewrite.
- The spec and the phase plans live on the same branch as the code, so a phase's plan is
  committed to `feature/kickoff` before its implementation begins.

## Structure

`docs/SPEC.md` §3.1 defines the folder and file layout normatively. P0 creates that tree; later
phases fill it in rather than reorganising it. If a phase needs a file the tree does not
anticipate, add it to the tree in the same commit — the spec stays the map.

Full spec: `docs/SPEC.md`.
