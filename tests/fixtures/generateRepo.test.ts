import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  branchy,
  clearLargeCacheEntry,
  conflicting,
  crissCross,
  type GeneratedRepo,
  large,
  linear,
  octopus,
  withDivergedBranch,
  withEmptyPickCandidate,
  withMergeCommitToPick,
  withRemote,
  withStash,
  withStashes,
} from "./generateRepo.ts";

const generatedDirs: string[] = [];

function track(repo: GeneratedRepo): GeneratedRepo {
  generatedDirs.push(repo.dir);
  return repo;
}

afterAll(() => {
  for (const dir of generatedDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("generateRepo determinism", () => {
  test("linear(5) produces identical shas on two consecutive runs", () => {
    const a = track(linear(5));
    const b = track(linear(5));
    expect(a.commits).toEqual(b.commits);
    expect(a.refs.main).toBe(b.refs.main);
  });
});

describe("generateRepo shapes", () => {
  test("linear builds a real repo with n commits", () => {
    const repo = track(linear(3));
    expect(existsSync(`${repo.dir}/.git`)).toBe(true);
    expect(repo.commits).toHaveLength(3);
    const log = execFileSync("git", ["log", "--format=%H"], { cwd: repo.dir, encoding: "utf8" });
    expect(log.trim().split("\n")).toHaveLength(3);
  });

  test("branchy builds parallel branches merged back", () => {
    const repo = track(branchy());
    expect(repo.refs.main).toBeDefined();
    expect(repo.refs["feature/a"]).toBeDefined();
    const parents = execFileSync("git", ["rev-list", "--parents", "-1", "main"], {
      cwd: repo.dir,
      encoding: "utf8",
    }).trim();
    expect(parents.split(" ")).toHaveLength(3); // merge commit + 2 parents
  });

  test("octopus produces a merge commit with 3+ parents", () => {
    const repo = track(octopus());
    const parents = execFileSync("git", ["rev-list", "--parents", "-1", "main"], {
      cwd: repo.dir,
      encoding: "utf8",
    }).trim();
    expect(parents.split(" ").length).toBeGreaterThanOrEqual(4); // merge commit + 3 parents
  });

  test("crissCross produces two lowest common ancestors", () => {
    const repo = track(crissCross());
    const bases = execFileSync("git", ["merge-base", "--all", "main", "branch-b"], {
      cwd: repo.dir,
      encoding: "utf8",
    }).trim();
    expect(bases.split("\n").length).toBeGreaterThanOrEqual(2);
  });

  test("withStash leaves exactly one stash entry", () => {
    const repo = track(withStash({ includeUntracked: true }));
    const list = execFileSync("git", ["stash", "list"], { cwd: repo.dir, encoding: "utf8" }).trim();
    expect(list.split("\n")).toHaveLength(1);
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: repo.dir,
      encoding: "utf8",
    }).trim();
    expect(status).toBe(""); // stash pop-able clean tree
  });

  test("withStashes(count: 2) produces exactly two plain stash entries", () => {
    const repo = track(withStashes({ count: 2 }));
    const list = execFileSync("git", ["stash", "list"], { cwd: repo.dir, encoding: "utf8" }).trim();
    expect(list.split("\n")).toHaveLength(2);
  });

  test("withStashes({includeUntracked: true})'s stash pop hits probe 3's untracked collision", () => {
    const repo = track(withStashes({ count: 0, includeUntracked: true }));
    expect(() =>
      execFileSync("git", ["stash", "pop"], { cwd: repo.dir, encoding: "utf8", stdio: "pipe" }),
    ).toThrow(/already exists, no checkout/);
    // The worst-outcome half: the TRACKED half of the pop landed in the working tree (uncommitted
    // — a pop never commits), the untracked half did not, and the stash is still in the list.
    const trackedInWorktree = readFileSync(join(repo.dir, "base.txt"), "utf8");
    expect(trackedInWorktree).toBe("tracked edit alongside the untracked one\n");
    const untrackedInWorktree = readFileSync(join(repo.dir, "new.txt"), "utf8");
    expect(untrackedInWorktree).toBe("collision content\n"); // the worktree's own file, untouched
    const list = execFileSync("git", ["stash", "list"], { cwd: repo.dir, encoding: "utf8" }).trim();
    expect(list.split("\n")).toHaveLength(1);
  });

  test("withStashes({conflicting: true}) is the W16 'done when': clean without --merge-base, conflict with it", () => {
    const repo = track(withStashes({ count: 0, conflicting: true }));
    expect(repo.refs.side).toBeDefined();

    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: repo.dir,
      encoding: "utf8",
    }).trim();
    expect(status).toBe(""); // checked out on `side`, clean — ready for a pop attempt

    const withoutMergeBase = execFileSync(
      "git",
      ["merge-tree", "--write-tree", "--messages", "--name-only", "HEAD", "stash@{0}"],
      { cwd: repo.dir, encoding: "utf8" },
    );
    expect(withoutMergeBase.trim().split("\n")).toHaveLength(1); // just the resulting tree sha

    let threw = false;
    try {
      execFileSync(
        "git",
        [
          "merge-tree",
          "--write-tree",
          "--messages",
          "--name-only",
          "--merge-base=stash@{0}^",
          "HEAD",
          "stash@{0}",
        ],
        { cwd: repo.dir, encoding: "utf8" },
      );
    } catch {
      threw = true; // rc=1: a real conflict, unlike the false-clean call above
    }
    expect(threw).toBe(true);

    expect(() =>
      execFileSync("git", ["stash", "pop"], { cwd: repo.dir, encoding: "utf8", stdio: "pipe" }),
    ).toThrow();
    const list = execFileSync("git", ["stash", "list"], { cwd: repo.dir, encoding: "utf8" }).trim();
    expect(list.split("\n")).toHaveLength(1); // the pop conflicted; the stash is kept
  });

  test("conflicting guarantees a real conflict on merge", () => {
    const repo = track(conflicting());
    expect(() =>
      execFileSync("git", ["merge", "--no-gpg-sign", "--no-ff", "branch-theirs"], {
        cwd: repo.dir,
        encoding: "utf8",
      }),
    ).toThrow();
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: repo.dir,
      encoding: "utf8",
    });
    expect(status).toContain("UU conflict.txt");
    execFileSync("git", ["merge", "--abort"], { cwd: repo.dir });
  });

  test("docs/plans/P10.md W16: withDivergedBranch's own 'done when' — a genuinely two-sided count", () => {
    const repo = track(withDivergedBranch());
    const leftRight = execFileSync("git", ["rev-list", "--count", "--left-right", "other...HEAD"], {
      cwd: repo.dir,
      encoding: "utf8",
    }).trim();
    expect(leftRight).toBe("2\t2"); // probe 4's own "2 2" example, not the one-sided "2" a plain count gives
    const isAncestor = () =>
      execFileSync("git", ["merge-base", "--is-ancestor", "other", "HEAD"], { cwd: repo.dir });
    expect(isAncestor).toThrow(); // neither side is an ancestor of the other
  });

  test("docs/plans/P10.md W16: withMergeCommitToPick needs -m, and each parent choice lands differently", () => {
    const repo = track(withMergeCommitToPick());
    expect(() =>
      execFileSync("git", ["cherry-pick", "--no-gpg-sign", repo.refs.merged ?? ""], {
        cwd: repo.dir,
        encoding: "utf8",
        stdio: "pipe",
      }),
    ).toThrow(/is a merge but no -m option was given/);

    execFileSync("git", ["cherry-pick", "--no-gpg-sign", "-m", "1", repo.refs.merged ?? ""], {
      cwd: repo.dir,
      encoding: "utf8",
    });
    expect(readFileSync(join(repo.dir, "shared.txt"), "utf8")).toBe("feature change\n");
    expect(existsSync(join(repo.dir, "other.txt"))).toBe(false); // -m 1's own diff never touches it
    // By its own sha, not the `target` branch name — the first pick above already advanced that
    // branch (this test runs on the checked-out `target` worktree), so the name alone would land
    // back on the post-pick tip rather than the pre-pick fork point `refs.target` still names.
    execFileSync("git", ["reset", "--hard", repo.refs.target ?? ""], { cwd: repo.dir });

    execFileSync("git", ["cherry-pick", "--no-gpg-sign", "-m", "2", repo.refs.merged ?? ""], {
      cwd: repo.dir,
      encoding: "utf8",
    });
    expect(readFileSync(join(repo.dir, "other.txt"), "utf8")).toBe("main change\n");
    expect(readFileSync(join(repo.dir, "shared.txt"), "utf8")).toBe("root\n"); // -m 2's own diff never touches it
  });

  test("docs/plans/P10.md W16: withEmptyPickCandidate's own 'done when' — an empty, exit-1 pick", () => {
    const repo = track(withEmptyPickCandidate());
    let threw = false;
    try {
      execFileSync("git", ["cherry-pick", "--no-gpg-sign", repo.refs.topic ?? ""], {
        cwd: repo.dir,
        encoding: "utf8",
        stdio: "pipe",
      });
    } catch (err) {
      threw = true;
      // git 2.43 writes "The previous cherry-pick is now empty…" to STDERR (this repo's own
      // re-verification of probe 6 — the plan's transcript names stdout, but the mechanism this
      // fixture exists for reads neither: `classifyGitError` pattern-matches stderr and has no
      // rule for this text either way, so detection is exit-code-plus-read-back regardless of
      // which stream carries it).
      const stderr = String((err as { stderr?: Buffer | string }).stderr ?? "");
      const stdout = String((err as { stdout?: Buffer | string }).stdout ?? "");
      expect(`${stdout}${stderr}`).toContain("previous cherry-pick is now empty");
    }
    expect(threw).toBe(true);

    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: repo.dir,
      encoding: "utf8",
    });
    expect(status).toBe(""); // clean worktree — nothing left unmerged
    const cherryPickHead = execFileSync(
      "git",
      ["rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD"],
      { cwd: repo.dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    expect(cherryPickHead).not.toBe("");
    execFileSync("git", ["cherry-pick", "--skip"], { cwd: repo.dir });
  });

  test("withRemote wires a bare remote with ahead/behind commits", async () => {
    const repo = track(await withRemote({ remoteOnlyCommits: 2, localOnlyCommits: 1 }));
    expect(repo.refs.main).toBeDefined();
    expect(repo.refs["origin/main"]).toBeDefined();
    expect(repo.refs.main).not.toBe(repo.refs["origin/main"]);
  });
});

describe("generateRepo large()", () => {
  afterAll(() => {
    // Scoped to this describe's own n=200 entry (P6a W3 finding) — clearLargeCache()'s full-wipe
    // would also destroy the 100k/PAGE_SIZE templates test:integration depends on for speed.
    clearLargeCacheEntry("large", 200);
  });

  test("large(n) builds via fast-import and is cached on a second call", () => {
    const first = large(200);
    expect(existsSync(`${first.dir}/.git`)).toBe(true);
    const log = execFileSync("git", ["rev-list", "--count", "main"], {
      cwd: first.dir,
      encoding: "utf8",
    }).trim();
    expect(log).toBe("200");

    const start = performance.now();
    const second = large(200);
    const elapsedMs = performance.now() - start;
    expect(second.dir).toBe(first.dir);
    expect(elapsedMs).toBeLessThan(500); // cache hit: no rebuild
  });
});
