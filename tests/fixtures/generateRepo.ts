/**
 * Builds real repositories with real `git`, for tests that exercise actual behaviour.
 * Recorded porcelain fixtures (tests/fixtures/porcelain/) are for parser unit tests instead.
 *
 * Determinism is the whole job here: every invocation pins config sources
 * (GIT_CONFIG_GLOBAL/SYSTEM/NOSYSTEM=1) so a developer's own ~/.gitconfig never leaks in,
 * and every commit gets a fixed author/committer identity and a date that advances by a
 * fixed step, so shas are reproducible across machines. With no CI (D28), this hygiene is
 * the only thing standing between us and tests that pass on one machine only.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EPOCH_SECONDS = 1_700_000_000; // fixed base instant; commit dates advance from here
const STEP_SECONDS = 3600;
const AUTHOR_NAME = "Kira Fixture";
const AUTHOR_EMAIL = "fixture@kira-version.test";
const CACHE_DIR = join(import.meta.dir, ".cache");

/**
 * P6a W3 — every cache key (this file's small shapes below, and large()/largeBranchy()'s own
 * cacheKey()) folds this in, so editing any shape's generation logic invalidates every cached
 * template automatically. Replaces large()'s old hand-bumped "v2" string, which was a footgun:
 * edit a shape and forget to bump it, and every test silently runs against the stale repo.
 */
const SOURCE_HASH = createHash("sha256")
  .update(readFileSync(import.meta.filename))
  .digest("hex")
  .slice(0, 16);

export interface GeneratedRepo {
  /** Absolute path to the generated working copy (or bare repo, for the withRemote() remote). */
  readonly dir: string;
  /** Commit shas in creation order. */
  readonly commits: readonly string[];
  /** Named refs of interest, e.g. { main: sha, "feature/a": sha }. */
  readonly refs: Readonly<Record<string, string>>;
}

function dateFor(index: number): string {
  return `${EPOCH_SECONDS + index * STEP_SECONDS} +0000`;
}

/** Exported so `recordPorcelain.ts` and integration tests can shell out with the same hygiene. */
export function baseEnv(cwd: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    HOME: cwd, // belt-and-braces: nothing under HOME/.gitconfig can be read either
  };
}

class Repo {
  #dir: string;
  #commitIndex = 0;

  constructor(dir: string) {
    this.#dir = dir;
  }

  get dir(): string {
    return this.#dir;
  }

  git(args: string[], extraEnv: NodeJS.ProcessEnv = {}): string {
    return execFileSync("git", args, {
      cwd: this.#dir,
      env: { ...baseEnv(this.#dir), ...extraEnv },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  init(initialBranch: string): void {
    mkdirSync(this.#dir, { recursive: true });
    this.git(["init", "--quiet", `--initial-branch=${initialBranch}`]);
  }

  initBare(initialBranch: string): void {
    mkdirSync(this.#dir, { recursive: true });
    this.git(["init", "--quiet", "--bare", `--initial-branch=${initialBranch}`]);
  }

  writeFile(relativePath: string, content: string): void {
    writeFileSync(join(this.#dir, relativePath), content);
  }

  add(...paths: string[]): void {
    this.git(["add", ...paths]);
  }

  /** Author/committer identity + date advance one step per call, so shas stay reproducible. */
  private commitEnv(): NodeJS.ProcessEnv {
    const date = dateFor(this.#commitIndex++);
    return {
      GIT_AUTHOR_NAME: AUTHOR_NAME,
      GIT_AUTHOR_EMAIL: AUTHOR_EMAIL,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: AUTHOR_NAME,
      GIT_COMMITTER_EMAIL: AUTHOR_EMAIL,
      GIT_COMMITTER_DATE: date,
    };
  }

  commit(message: string, opts: { allowEmpty?: boolean } = {}): string {
    const args = ["commit", "--quiet", "--no-gpg-sign", "-m", message];
    if (opts.allowEmpty) args.push("--allow-empty");
    this.git(args, this.commitEnv());
    return this.head();
  }

  merge(message: string, refs: readonly string[], opts: { noFf?: boolean } = {}): string {
    const args = ["merge", "--no-gpg-sign", "-m", message];
    if (opts.noFf !== false) args.push("--no-ff");
    args.push(...refs);
    this.git(args, this.commitEnv());
    return this.head();
  }

  checkoutNew(branch: string, startPoint?: string): void {
    const args = ["switch", "--quiet", "-c", branch];
    if (startPoint) args.push(startPoint);
    this.git(args);
  }

  checkout(branch: string): void {
    this.git(["switch", "--quiet", branch]);
  }

  head(): string {
    return this.git(["rev-parse", "HEAD"]).trim();
  }

  refSha(ref: string): string {
    return this.git(["rev-parse", ref]).trim();
  }

  stashPush(message: string, opts: { includeUntracked?: boolean } = {}): void {
    const args = ["stash", "push", "--quiet", "-m", message];
    if (opts.includeUntracked) args.push("-u");
    this.git(args, this.commitEnv());
  }
}

function tempRepoDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `kira-fixture-${prefix}-`));
}

// ---------------------------------------------------------------------------------------
// Shapes
//
// P6a W3 — most shapes below are built once per machine, into tests/fixtures/.cache/, and
// copied per call via cachedShape() (the same content-addressed-cache-plus-atomic-install
// mechanism large()/largeBranchy() already use further down, generalised to cache-then-*copy*
// rather than cache-then-share: integration tests write to their repo — checkout, commit,
// revert, delete refs — so every call still gets its own mutable copy at its own path, just a
// `cpSync` away instead of a from-scratch `git init` + N spawns).
//
// Three shapes are deliberately excluded from caching (read them yourself before adding a
// fourth):
//   - withRemote() — clones from a bare repo at a mkdtemp path; `.git/config`'s
//     `remote.origin.url` holds an absolute path into a directory the copy would not own.
//   - withWorktree() — `git worktree add`s a second mkdtemp path; both `<worktree>/.git` and
//     `<repo>/.git/worktrees/<name>/gitdir` hold absolute paths into each other.
//   - inProgressRevert() was read and found copy-safe (its state is confined to
//     `.git/{REVERT_HEAD,MERGE_MSG,sequencer/}` and the index — no absolute paths anywhere) and
//     so *is* cached below, unlike the two above.
// Rewriting the absolute paths inside a copied .git for the first two would be a fixture
// generator reimplementing `git clone`/`git worktree add`; the failure mode is a green test
// against a subtly wrong repository, which costs more than the few spawns saved.
// ---------------------------------------------------------------------------------------

/** Metadata sidecar lives *inside* `.git/`, not next to it — it rides along with the single
 *  `mv` that installs the template, so the install stays one atomic rename (matching
 *  large()/largeBranchy()'s own precedent) instead of two racing renames. It is never part of
 *  the working tree, so no test's `git status --porcelain` ever sees it. */
const CACHE_META_FILENAME = "kira-fixture-meta.json";

// Small shapes live under their own subdirectory, separate from large()/largeBranchy()'s
// CACHE_DIR entries below — so largeBranchy.test.ts's own clearLargeCache() calls (mid-test, to
// re-verify determinism) invalidate only what they've always invalidated, not every small-shape
// template test:integration relies on for speed.
const SHAPE_CACHE_DIR = join(CACHE_DIR, "shapes");

/**
 * Builds `name(options)` once per machine (keyed on this file's own source, so editing a shape
 * invalidates every cached copy of it automatically) and returns a fresh, independently mutable
 * copy on every call. `build()` must construct its repo via `tempRepoDir()` as every shape below
 * already does; its returned `dir` becomes the cache template on a miss and is discarded (via the
 * same building-then-atomic-rename install large()/largeBranchy() use, so concurrent `bun test`
 * processes racing the same key are safe) in favour of a `cpSync`'d copy on every call, hit or
 * miss.
 */
function cachedShape<T extends GeneratedRepo>(name: string, options: unknown, build: () => T): T {
  const key = createHash("sha256")
    .update(`${SOURCE_HASH}:shape:${name}:${JSON.stringify(options)}`)
    .digest("hex")
    .slice(0, 16);
  const cached = join(SHAPE_CACHE_DIR, key);
  const metaPath = join(cached, ".git", CACHE_META_FILENAME);

  if (!existsSync(metaPath)) {
    const template = build();
    execFileSync("git", ["repack", "-a", "-d", "--quiet"], {
      cwd: template.dir,
      env: baseEnv(template.dir),
    });
    // `dir` is per-copy, never part of the cached metadata — every other field here is either a
    // sha or a relative path, both stable across a `cpSync`.
    const { dir: _dir, ...meta } = template;
    writeFileSync(join(template.dir, ".git", CACHE_META_FILENAME), JSON.stringify(meta));

    mkdirSync(SHAPE_CACHE_DIR, { recursive: true });
    const building = `${cached}.building-${process.pid}`;
    rmSync(building, { recursive: true, force: true });
    rmSync(cached, { recursive: true, force: true });
    execFileSync("mv", [template.dir, building]);
    execFileSync("mv", [building, cached]);
  }

  const dest = tempRepoDir(name);
  cpSync(cached, dest, { recursive: true });
  const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Omit<T, "dir">;
  return { ...meta, dir: dest } as T;
}

/** Trivial baseline: `n` commits on a single branch. For parser tests and smoke tests. */
export function linear(n: number): GeneratedRepo {
  return cachedShape("linear", { n }, () => {
    const repo = new Repo(tempRepoDir("linear"));
    repo.init("main");
    const commits: string[] = [];
    for (let i = 0; i < n; i++) {
      repo.writeFile("file.txt", `line ${i}\n`);
      repo.add("file.txt");
      commits.push(repo.commit(`commit ${i}`));
    }
    return { dir: repo.dir, commits, refs: { main: repo.head() } };
  });
}

export interface DetailWorkloadOptions {
  /** Total commits returned — includes the merge and the many-files commit below, not on top of
   *  them. Default 20, `docs/plans/P5.md` W15's own sample size for `commitDetailMs`. */
  readonly commitCount?: number;
  /** How many files the one "touches many files" commit adds at once. Default 500 — W15's own
   *  number, matching §6.4/W8's render-cap fixture (`detail.ts`'s `manyFiles` in the harness). */
  readonly manyFilesCount?: number;
}

/**
 * W15's own fixture: a small, real repository built for `commitDetailMs`/`fileDiffMs` rather
 * than layout stress (`large`/`largeBranchy` above) — `git commit` per commit is plenty fast at
 * this scale, so this skips the fast-import machinery those two need at 100k+ commits.
 * `commitCount` real commits, including exactly one merge (so the sample the perf script times
 * genuinely exercises a multi-parent `commitDetail`) and exactly one commit that adds
 * `manyFilesCount` files in a single commit (so `fileDiff` has a 5,000-line file to time, and
 * `commitDetail`'s own `numstat`/`name-status` spawns have a realistically large file list to
 * parse at least once in the sample, not only single-file commits).
 */
export function detailWorkload(opts: DetailWorkloadOptions = {}): GeneratedRepo {
  const { commitCount = 20, manyFilesCount = 500 } = opts;
  return cachedShape("detailWorkload", { commitCount, manyFilesCount }, () => {
    const repo = new Repo(tempRepoDir("detail-workload"));
    repo.init("main");
    const commits: string[] = [];

    repo.writeFile("README.md", "root\n");
    repo.add("README.md");
    commits.push(repo.commit("root"));

    repo.checkoutNew("feature/detail");
    repo.writeFile("feature.txt", "feature work\n");
    repo.add("feature.txt");
    commits.push(repo.commit("feature commit"));
    const featureSha = repo.head();

    repo.checkout("main");
    repo.writeFile("main.txt", "main work\n");
    repo.add("main.txt");
    commits.push(repo.commit("main commit before merge"));

    commits.push(repo.merge("Merge feature/detail into main", [featureSha])); // the one merge

    // The one many-files commit — its first file (`generated/file-0000.ts`) carries 5,000 lines
    // rather than one, so the same commit also supplies `fileDiffMs`'s own "one 5,000-line file".
    mkdirSync(join(repo.dir, "generated"), { recursive: true });
    for (let i = 0; i < manyFilesCount; i++) {
      const lineCount = i === 0 ? 5000 : 1;
      const lines = Array.from(
        { length: lineCount },
        (_, line) => `export const line${line} = ${i};`,
      );
      repo.writeFile(`generated/file-${String(i).padStart(4, "0")}.ts`, `${lines.join("\n")}\n`);
    }
    repo.add("generated");
    commits.push(repo.commit(`add ${manyFilesCount} generated files`));

    // Simple single-file edits fill out the rest of `commitCount`.
    let i = 0;
    while (commits.length < commitCount) {
      repo.writeFile("main.txt", `main work ${i}\n`);
      repo.add("main.txt");
      commits.push(repo.commit(`main commit ${i}`));
      i++;
    }

    return { dir: repo.dir, commits, refs: { main: repo.head(), "feature/detail": featureSha } };
  });
}

export interface BranchyOptions {
  mainCommits?: number;
  featureCommits?: number;
  /** Merge the feature branch back into main with a non-ff merge commit. */
  mergeBack?: boolean;
}

/** Lane layout: a main branch and one parallel feature branch, merged back. */
export function branchy(opts: BranchyOptions = {}): GeneratedRepo {
  const { mainCommits = 3, featureCommits = 2, mergeBack = true } = opts;
  return cachedShape("branchy", { mainCommits, featureCommits, mergeBack }, () => {
    const repo = new Repo(tempRepoDir("branchy"));
    repo.init("main");
    const commits: string[] = [];

    for (let i = 0; i < mainCommits; i++) {
      repo.writeFile("main.txt", `main ${i}\n`);
      repo.add("main.txt");
      commits.push(repo.commit(`main commit ${i}`));
    }

    repo.checkoutNew("feature/a");
    for (let i = 0; i < featureCommits; i++) {
      repo.writeFile("feature.txt", `feature ${i}\n`);
      repo.add("feature.txt");
      commits.push(repo.commit(`feature commit ${i}`));
    }
    const featureSha = repo.head();

    repo.checkout("main");
    repo.writeFile("main.txt", "main after branch\n");
    repo.add("main.txt");
    commits.push(repo.commit("main commit after branch"));

    const refs: Record<string, string> = { main: repo.head(), "feature/a": featureSha };
    if (mergeBack) {
      commits.push(repo.merge("Merge feature/a into main", ["feature/a"]));
      refs.main = repo.head();
    }
    return { dir: repo.dir, commits, refs };
  });
}

/** A merge commit with 3+ parents — the case naive layout algorithms get wrong. */
export function octopus(): GeneratedRepo {
  return cachedShape("octopus", {}, () => {
    const repo = new Repo(tempRepoDir("octopus"));
    repo.init("main");
    const commits: string[] = [];

    repo.writeFile("base.txt", "base\n");
    repo.add("base.txt");
    commits.push(repo.commit("base commit"));
    const base = repo.head();

    const branches = ["topic/a", "topic/b", "topic/c"];
    for (const branch of branches) {
      repo.checkoutNew(branch, base);
      repo.writeFile(`${branch.replace("/", "-")}.txt`, `${branch}\n`);
      repo.add(`${branch.replace("/", "-")}.txt`);
      commits.push(repo.commit(`${branch} commit`));
    }

    repo.checkout("main");
    commits.push(repo.merge("Octopus merge", branches));

    return { dir: repo.dir, commits, refs: { main: repo.head() } };
  });
}

/**
 * Two branches that merge each other twice — the other layout trap: it produces two
 * lowest common ancestors, so a naive merge-base lookup is ambiguous.
 */
export function crissCross(): GeneratedRepo {
  return cachedShape("crissCross", {}, () => {
    const repo = new Repo(tempRepoDir("criss-cross"));
    repo.init("main");
    const commits: string[] = [];

    // A common base, then two sibling commits B (main) and C (branch-b) both parented
    // directly on A — not on each other — so a later cross-merge has two candidate lowest
    // common ancestors instead of one.
    repo.writeFile("shared.txt", "base\n");
    repo.add("shared.txt");
    const baseSha = repo.commit("base commit"); // A
    commits.push(baseSha);

    repo.writeFile("a.txt", "a1\n");
    repo.add("a.txt");
    commits.push(repo.commit("a1")); // B, main tip
    const bSha = repo.head();

    repo.checkoutNew("branch-b", baseSha);
    repo.writeFile("b.txt", "b1\n");
    repo.add("b.txt");
    commits.push(repo.commit("b1")); // C, branch-b tip

    // Cross-merge: main pulls in C (parents: B, C) ...
    repo.checkout("main");
    commits.push(repo.merge("main merges branch-b", ["branch-b"])); // D, parents [B, C]

    // ... and branch-b pulls in B, not D (parents: C, B) — the criss-cross.
    repo.checkout("branch-b");
    commits.push(repo.merge("branch-b merges main@B", [bSha])); // E, parents [C, B]

    return {
      dir: repo.dir,
      commits,
      refs: { main: repo.refSha("main"), "branch-b": repo.head() },
    };
  });
}

export interface WithStashOptions {
  includeUntracked?: boolean;
}

/** A repo with a stash entry on top of a couple of commits, including an -u variant. */
export function withStash(opts: WithStashOptions = {}): GeneratedRepo {
  const includeUntracked = opts.includeUntracked ?? false;
  return cachedShape("withStash", { includeUntracked }, () => {
    const repo = new Repo(tempRepoDir("with-stash"));
    repo.init("main");
    const commits: string[] = [];

    repo.writeFile("tracked.txt", "committed\n");
    repo.add("tracked.txt");
    commits.push(repo.commit("initial commit"));

    repo.writeFile("tracked.txt", "dirty change\n");
    if (includeUntracked) {
      repo.writeFile("untracked.txt", "new file\n");
    }
    repo.stashPush("fixture stash", includeUntracked ? { includeUntracked: true } : {});

    return { dir: repo.dir, commits, refs: { main: repo.head() } };
  });
}

export interface ConflictingOptions {
  path?: string;
}

/** A pair of branches guaranteed to conflict on a known file, for preflight/merge-tree tests. */
export function conflicting(opts: ConflictingOptions = {}): GeneratedRepo {
  const path = opts.path ?? "conflict.txt";
  return cachedShape("conflicting", { path }, () => {
    const repo = new Repo(tempRepoDir("conflicting"));
    repo.init("main");
    const commits: string[] = [];

    repo.writeFile(path, "base line\n");
    repo.add(path);
    commits.push(repo.commit("base commit"));

    repo.checkoutNew("branch-theirs");
    repo.writeFile(path, "theirs line\n");
    repo.add(path);
    commits.push(repo.commit("theirs change"));

    repo.checkout("main");
    repo.writeFile(path, "ours line\n");
    repo.add(path);
    commits.push(repo.commit("ours change"));

    return {
      dir: repo.dir,
      commits,
      refs: { main: repo.head(), "branch-theirs": repo.refSha("branch-theirs") },
    };
  });
}

export interface WithRemoteOptions {
  /** Commits pushed to the remote but not present locally (behind). */
  remoteOnlyCommits?: number;
  /** Commits present locally but not pushed (ahead). */
  localOnlyCommits?: number;
}

/** A local repo with a bare "remote" wired up, for fetch/push/non-ff/lease tests. */
export function withRemote(opts: WithRemoteOptions = {}): GeneratedRepo {
  const { remoteOnlyCommits = 0, localOnlyCommits = 1 } = opts;

  const remote = new Repo(tempRepoDir("remote-bare"));
  remote.initBare("main");

  const seed = new Repo(tempRepoDir("remote-seed"));
  seed.init("main");
  seed.writeFile("file.txt", "seed\n");
  seed.add("file.txt");
  seed.commit("seed commit");
  seed.git(["remote", "add", "origin", remote.dir]);
  seed.git(["push", "--quiet", "origin", "main"]);

  const local = new Repo(tempRepoDir("with-remote"));
  local.git(["clone", "--quiet", remote.dir, local.dir]);
  local.git(["config", "user.name", AUTHOR_NAME]);
  local.git(["config", "user.email", AUTHOR_EMAIL]);
  const commits: string[] = [local.head()];

  for (let i = 0; i < remoteOnlyCommits; i++) {
    seed.writeFile("file.txt", `remote-only ${i}\n`);
    seed.add("file.txt");
    commits.push(seed.commit(`remote-only commit ${i}`));
    seed.git(["push", "--quiet", "origin", "main"]);
  }

  for (let i = 0; i < localOnlyCommits; i++) {
    local.writeFile("local.txt", `local-only ${i}\n`);
    local.add("local.txt");
    commits.push(local.commit(`local-only commit ${i}`));
  }

  local.git(["fetch", "--quiet", "origin"]);
  return {
    dir: local.dir,
    commits,
    refs: { main: local.head(), "origin/main": local.refSha("origin/main") },
  };
}

export interface GeneratedRepoWithWorktree extends GeneratedRepo {
  /** Absolute path of the linked worktree — `%(worktreepath)` on `branchInWorktree` resolves
   *  here, never `dir` (the main worktree, D12's own "not for this session's own checkout"
   *  subtraction needs both to exist so a test can assert against each). */
  readonly worktreeDir: string;
  /** The branch checked out in `worktreeDir`, not `dir` — the one §7.5's fifth blocker,
   *  `worktreeConflict`, is about. */
  readonly branchInWorktree: string;
}

/** P6 W21: a `branchy()`-shaped repo plus a real linked worktree holding a second branch
 *  checked out — the fixture behind every `worktreeConflict` test (probe P6/D12), so a test
 *  stops hand-rolling `mkdtempSync` + `git worktree add` inline (`repoService.test.ts`'s own
 *  preflightCheckout suite did, before this generator existed). */
export function withWorktree(): GeneratedRepoWithWorktree {
  const repo = branchy();
  const worktreeDir = mkdtempSync(join(tmpdir(), "kira-fixture-worktree-"));
  execFileSync("git", ["worktree", "add", "--quiet", worktreeDir, "feature/a"], {
    cwd: repo.dir,
    env: baseEnv(repo.dir),
  });
  return { ...repo, worktreeDir, branchInWorktree: "feature/a" };
}

export interface GeneratedRepoWithInProgressRevert extends GeneratedRepo {
  /** The commit `git revert` was asked to invert — the one `REVERT_HEAD` now names. */
  readonly revertedSha: string;
  /** The path left with unresolved conflict markers — `status --porcelain=v2`'s `U` line. */
  readonly conflictedPath: string;
}

/** P6 W21: a real mid-revert, mid-conflict repository — `git revert <sha>` left exactly as a
 *  real one leaves it on a conflict (REVERT_HEAD present, no commit made, `conflictedPath`
 *  carrying `<<<<<<<` markers), for the in-progress reader and the opContinue/opAbort tests to
 *  exercise against reality rather than a hand-written state-file directory
 *  (`ops/conflict.test.ts`'s own unit coverage already does the latter). The shape: a base line,
 *  a change (the commit that gets reverted), then a *further* change to the same line — reverting
 *  the middle commit after the tip has moved the same line again is exactly what makes git unable
 *  to apply the inverse patch cleanly. */
/**
 * P6a W3: cached, unlike withRemote()/withWorktree() above — read directly, its in-progress
 * state lives entirely in `.git/{REVERT_HEAD,MERGE_MSG,sequencer/}` and the index, none of which
 * carries an absolute path, so a `cpSync`'d copy is a faithful, independently mutable conflict
 * every time.
 */
export function inProgressRevert(): GeneratedRepoWithInProgressRevert {
  const path = "conflict.txt";
  return cachedShape("inProgressRevert", {}, () => {
    const repo = new Repo(tempRepoDir("in-progress-revert"));
    repo.init("main");
    const commits: string[] = [];

    repo.writeFile(path, "base line\n");
    repo.add(path);
    commits.push(repo.commit("base commit"));

    repo.writeFile(path, "changed by the commit we will revert\n");
    repo.add(path);
    const revertedSha = repo.commit("change to revert");
    commits.push(revertedSha);

    repo.writeFile(path, "changed again after that, on top\n");
    repo.add(path);
    commits.push(repo.commit("further change on the same line"));

    try {
      repo.git(["revert", "--no-gpg-sign", "--no-edit", revertedSha]);
      throw new Error("generateRepo.inProgressRevert(): revert did not conflict as designed");
    } catch (error) {
      // `execFileSync` throws on git's non-zero exit — the conflict this fixture exists to
      // produce, not a real failure. Anything else (e.g. this file's own "did not conflict"
      // throw above, which carries no `status`) rethrows rather than being swallowed.
      if (!(error instanceof Error) || !("status" in error)) throw error;
    }

    return {
      dir: repo.dir,
      commits,
      refs: { main: repo.refSha("main") },
      revertedSha,
      conflictedPath: path,
    };
  });
}

// ---------------------------------------------------------------------------------------
// large(n) / largeBranchy(n) — via `git fast-import`, cached under a gitignored directory
// keyed by inputs. Both write a commit-graph by default (§4.4, W13): `git gc` has written one
// by default since 2.24, so a repository of this size that has ever been gc'd already has one
// — "with a graph" is the realistic configuration a real user's machine has, not "without".
// D21 (never write a commit-graph into a *user's* repository) does not apply here: these are
// repositories this fixture generates and owns, not a user's `.git`.
// ---------------------------------------------------------------------------------------

// Own subdirectory, sibling to SHAPE_CACHE_DIR above — so clearLargeCache() (called mid-test by
// largeBranchy.test.ts's own determinism check) clears only what it always cleared, not every
// small-shape template test:integration relies on for speed.
const LARGE_CACHE_DIR = join(CACHE_DIR, "large");

export interface LargeRepoOptions {
  /** `git commit-graph write --reachable --split` after generation (default true — see the
   *  module comment above). Set false to get the "no commit-graph" configuration W13/W15
   *  measure the cost of, cached separately from the default. */
  readonly commitGraph?: boolean;
}

function cacheKey(prefix: string, n: number, opts: Required<LargeRepoOptions>): string {
  return createHash("sha256")
    .update(`${SOURCE_HASH}:${prefix}:${n}:graph=${opts.commitGraph}`)
    .digest("hex")
    .slice(0, 16);
}

function buildFastImportStream(n: number): string {
  const lines: string[] = [];
  lines.push("reset refs/heads/main");
  for (let i = 0; i < n; i++) {
    const date = dateFor(i);
    lines.push(`commit refs/heads/main`);
    lines.push(`mark :${i + 1}`);
    lines.push(`author ${AUTHOR_NAME} <${AUTHOR_EMAIL}> ${date}`);
    lines.push(`committer ${AUTHOR_NAME} <${AUTHOR_EMAIL}> ${date}`);
    const message = `commit ${i}`;
    lines.push(`data ${message.length}`);
    lines.push(message);
    if (i === 0) {
      lines.push("deleteall");
    } else {
      lines.push(`from :${i}`);
    }
    lines.push(`M 100644 inline file.txt`);
    const content = `line ${i}\n`;
    lines.push(`data ${content.length}`);
    lines.push(content);
    lines.push("");
  }
  return lines.join("\n");
}

/** Builds `building` from a fast-import stream, repacks, optionally writes a commit-graph,
 *  then atomically installs it at `cached`. Shared by `large()` and `largeBranchy()`. */
function buildAndInstall(cached: string, stream: string, opts: Required<LargeRepoOptions>): string {
  mkdirSync(LARGE_CACHE_DIR, { recursive: true });
  const building = `${cached}.building-${process.pid}`;
  rmSync(building, { recursive: true, force: true });
  const repo = new Repo(building);
  repo.init("main");
  execFileSync("git", ["fast-import", "--quiet"], {
    cwd: repo.dir,
    input: stream,
    env: baseEnv(repo.dir),
  });
  repo.git(["reset", "--quiet", "--hard", "main"]);
  repo.git(["repack", "-a", "-d", "--quiet"]);
  if (opts.commitGraph) {
    repo.git(["commit-graph", "write", "--reachable", "--split"]);
  }

  const headSha = repo.head();
  rmSync(cached, { recursive: true, force: true });
  execFileSync("mv", [building, cached]);
  return headSha;
}

const DEFAULT_LARGE_REPO_OPTIONS: Required<LargeRepoOptions> = { commitGraph: true };

/**
 * Perf-scale generation. `n` invocations of `git commit` would be minutes to hours at
 * 100k, so this feeds a single `git fast-import` stream instead — single-digit seconds
 * for 100k commits. Cached under tests/fixtures/.cache/, keyed by the generator inputs,
 * so it is built once per machine.
 */
function largeCachePath(n: number, opts: Required<LargeRepoOptions>): string {
  return join(LARGE_CACHE_DIR, cacheKey("large", n, opts));
}

export function large(n: number, opts: LargeRepoOptions = {}): GeneratedRepo {
  const resolved = { ...DEFAULT_LARGE_REPO_OPTIONS, ...opts };
  const cached = largeCachePath(n, resolved);

  if (existsSync(join(cached, ".git"))) {
    const repo = new Repo(cached);
    return { dir: cached, commits: [], refs: { main: repo.head() } };
  }

  const headSha = buildAndInstall(cached, buildFastImportStream(n), resolved);
  return { dir: cached, commits: [], refs: { main: headSha } };
}

export interface LargeBranchyOptions extends LargeRepoOptions {
  /** Concurrently open branches merged back into main every `commitsPerRound` commits each.
   *  Default 12 — "on the order of 8-16 concurrent branches" (docs/plans/P2.md W13). */
  readonly branchCount?: number;
  readonly commitsPerRound?: number;
}

/**
 * `largeBranchy(n)` is `large(n)`'s layout-stress counterpart: `large()` is a single linear
 * branch (one lane, one edge per row) and says nothing about the algorithm P2's layout is
 * judged on. This distributes `n` commits across `branchCount` concurrently open branches,
 * merging each back into main every `commitsPerRound` commits, plus one deliberately
 * long-lived branch (index 0) that merges only in the final commit — so `maxEdgeSpan` is
 * exercised the way a real long-running feature branch would.
 */
function buildLargeBranchyStream(n: number, branchCount: number, commitsPerRound: number): string {
  const lines: string[] = [];
  lines.push("reset refs/heads/main");
  let mark = 0;
  const nextMark = () => ++mark;

  function emitCommit(ref: string, m: number, index: number, parents: readonly number[]): void {
    const date = dateFor(index);
    lines.push(`commit ${ref}`);
    lines.push(`mark :${m}`);
    lines.push(`author ${AUTHOR_NAME} <${AUTHOR_EMAIL}> ${date}`);
    lines.push(`committer ${AUTHOR_NAME} <${AUTHOR_EMAIL}> ${date}`);
    const message = `commit ${index}`;
    lines.push(`data ${message.length}`);
    lines.push(message);
    if (parents.length === 0) {
      lines.push("deleteall");
    } else {
      lines.push(`from :${parents[0]}`);
      for (let p = 1; p < parents.length; p++) lines.push(`merge :${parents[p]}`);
    }
    lines.push("M 100644 inline file.txt");
    const content = `line ${index}\n`;
    lines.push(`data ${content.length}`);
    lines.push(content);
    lines.push("");
  }

  let produced = 0;
  const rootMark = nextMark();
  emitCommit("refs/heads/main", rootMark, produced, []);
  produced++;
  let mainTip = rootMark;

  const LONG_LIVED_INDEX = 0;
  const tailReserve = Math.max(1, Math.min(Math.floor(n * 0.1), 2000));
  const mainPhaseTarget = Math.max(1, n - tailReserve);

  const branchNames = Array.from({ length: branchCount }, (_, b) => `refs/heads/topic-${b}`);
  const branchTips = new Array<number>(branchCount).fill(mainTip);

  outer: while (produced < mainPhaseTarget) {
    for (let b = 0; b < branchCount; b++) {
      let tip = branchTips[b] as number;
      for (let c = 0; c < commitsPerRound; c++) {
        if (produced >= mainPhaseTarget) break outer;
        const m = nextMark();
        emitCommit(branchNames[b] as string, m, produced, [tip]);
        tip = m;
        produced++;
      }
      branchTips[b] = tip;
      if (b !== LONG_LIVED_INDEX) {
        if (produced >= mainPhaseTarget) continue;
        const m = nextMark();
        emitCommit("refs/heads/main", m, produced, [mainTip, tip]);
        mainTip = m;
        branchTips[b] = mainTip;
        produced++;
      }
    }
  }

  let longTip = branchTips[LONG_LIVED_INDEX] as number;
  while (produced < n - 1) {
    const m = nextMark();
    emitCommit(branchNames[LONG_LIVED_INDEX] as string, m, produced, [longTip]);
    longTip = m;
    produced++;
  }
  const finalMark = nextMark();
  emitCommit("refs/heads/main", finalMark, produced, [mainTip, longTip]);
  produced++;

  return lines.join("\n");
}

function largeBranchyCachePath(
  n: number,
  branchCount: number,
  commitsPerRound: number,
  opts: Required<LargeRepoOptions>,
): string {
  return join(LARGE_CACHE_DIR, cacheKey(`largeBranchy:${branchCount}:${commitsPerRound}`, n, opts));
}

export function largeBranchy(n: number, opts: LargeBranchyOptions = {}): GeneratedRepo {
  const branchCount = opts.branchCount ?? 12;
  const commitsPerRound = opts.commitsPerRound ?? 200;
  const resolved = { commitGraph: opts.commitGraph ?? DEFAULT_LARGE_REPO_OPTIONS.commitGraph };
  const cached = largeBranchyCachePath(n, branchCount, commitsPerRound, resolved);

  if (existsSync(join(cached, ".git"))) {
    const repo = new Repo(cached);
    return { dir: cached, commits: [], refs: { main: repo.head() } };
  }

  const stream = buildLargeBranchyStream(n, branchCount, commitsPerRound);
  const headSha = buildAndInstall(cached, stream, resolved);
  return { dir: cached, commits: [], refs: { main: headSha } };
}

/**
 * Removes every cached large()/largeBranchy() repo (LARGE_CACHE_DIR only — the small shapes'
 * own SHAPE_CACHE_DIR, cached by cachedShape() since P6a W3, is untouched, so this doesn't
 * undo W3's win for whatever else is running). Exposed for tests that need a clean cache, and
 * as the manual escape hatch a stale template (e.g. mid-`.building-<pid>` after a killed
 * process) can't self-heal from. `clearFixtureCache()` below is the escape hatch for
 * everything.
 */
export function clearLargeCache(): void {
  clearCacheDir(LARGE_CACHE_DIR);
}

/**
 * Removes only the one cache entry a specific `large(n, opts)` or `largeBranchy(n, opts)` call
 * would use, leaving every other cached large repo (crucially, the 100k/PAGE_SIZE templates
 * `historyPipeline.test.ts`/`packedChunk.test.ts` depend on for speed) untouched.
 *
 * P6a W3 finding: `largeBranchy.test.ts`'s determinism check needs a guaranteed-cold rebuild of
 * its own small (n=300) repo, twice, and both self-test files want to clean up the small entries
 * they create — neither actually needs `clearLargeCache()`'s indiscriminate full-directory wipe,
 * which used to force the two integration tests above to pay a ~10s cold rebuild on every `bun
 * run test` (test:unit's fixture self-tests always ran, and always wiped, before test:integration
 * ever got a chance to read the cache). This is the scoped alternative those two self-tests use
 * instead.
 */
export function clearLargeCacheEntry(
  kind: "large" | "largeBranchy",
  n: number,
  opts: LargeBranchyOptions = {},
): void {
  const resolved = { commitGraph: opts.commitGraph ?? DEFAULT_LARGE_REPO_OPTIONS.commitGraph };
  const cached =
    kind === "large"
      ? largeCachePath(n, resolved)
      : largeBranchyCachePath(n, opts.branchCount ?? 12, opts.commitsPerRound ?? 200, resolved);
  rmSync(cached, { recursive: true, force: true });
}

/** Removes every cached template of every kind — large()/largeBranchy()'s and the small shapes'
 *  alike. The manual escape hatch for `generateRepo.ts` changes that a cache-key edit alone
 *  can't invalidate (the key already folds in this file's own source hash — see SOURCE_HASH —
 *  so that case should be rare). */
export function clearFixtureCache(): void {
  clearCacheDir(LARGE_CACHE_DIR);
  clearCacheDir(SHAPE_CACHE_DIR);
}

function clearCacheDir(dir: string): void {
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir)) {
      rmSync(join(dir, entry), { recursive: true, force: true });
    }
  }
}
