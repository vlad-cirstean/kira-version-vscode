import { execFileSync } from "node:child_process";
import { copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { locateGit } from "../../packages/git/src/discovery.ts";
import { openGitDriver } from "../../packages/git/src/driver.ts";
import { NodeProcessRunner } from "../../packages/git/src/nodeProcessRunner.ts";
import {
  commitDetail,
  countCommits,
  log,
  predictMerge,
  refs,
  stashList,
  status,
} from "../../packages/git/src/queries.ts";
import { noopCatFileSession } from "../../packages/git/src/testFakes.ts";
import {
  branchy,
  conflicting,
  crissCross,
  linear,
  octopus,
  withRemote,
  withStash,
} from "../fixtures/generateRepo.ts";

const runner = new NodeProcessRunner();
const noopCatFile = noopCatFileSession();

async function driverFor(repoRoot: string) {
  const resolution = await locateGit({ runner });
  if (resolution.kind !== "ok") throw new Error("no usable system git found for this test");
  return openGitDriver(resolution.git, runner, repoRoot, noopCatFile);
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

describe("log", () => {
  test("walks a linear history and reports every commit", async () => {
    const { dir, commits } = linear(5);
    const driver = await driverFor(dir);
    const records = await collect(log(driver, { scope: "all", pageSize: 100 }));
    expect(records.map((r) => r.sha).sort()).toEqual([...commits].sort());
  });

  test("an octopus merge's 4-parent commit parses correctly through the query layer", async () => {
    const { dir } = octopus();
    const driver = await driverFor(dir);
    const records = await collect(log(driver, { scope: "all", pageSize: 100 }));
    const merge = records.find((r) => r.parents.length >= 3);
    expect(merge?.parents).toHaveLength(4);
  });

  test("a criss-cross history's two merges both appear", async () => {
    const { dir } = crissCross();
    const driver = await driverFor(dir);
    const records = await collect(log(driver, { scope: "all", pageSize: 100 }));
    expect(records.filter((r) => r.parents.length === 2)).toHaveLength(2);
  });

  test("a branchy history: every commit walks, and the merge-back records both parents", async () => {
    const { dir, commits } = branchy();
    const driver = await driverFor(dir);
    const records = await collect(log(driver, { scope: "all", pageSize: 100 }));
    expect(records.map((r) => r.sha).sort()).toEqual([...commits].sort());
    const merge = records.find((r) => r.parents.length === 2);
    expect(merge).toBeDefined();
  });

  test("cancelling mid-stream kills the process within the SIGTERM grace", async () => {
    const { dir } = linear(50);
    const driver = await driverFor(dir);
    const controller = new AbortController();
    const start = Date.now();
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const record of log(driver, {
          scope: "all",
          pageSize: 50,
          signal: controller.signal,
        })) {
          seen.push(record.sha);
          if (seen.length === 2) controller.abort();
        }
      })(),
    ).rejects.toBeInstanceOf(Error);
    expect(Date.now() - start).toBeLessThan(3000);
    expect(seen.length).toBeGreaterThanOrEqual(2);
  }, 10_000);
});

describe("refs", () => {
  test("reports upstream and ahead/behind for a branch with a remote", async () => {
    const { dir } = withRemote({ localOnlyCommits: 1 });
    const driver = await driverFor(dir);
    const records = await refs(driver);
    const main = records.find((r) => r.refname === "refs/heads/main");
    expect(main?.upstream).toBe("refs/remotes/origin/main");
    expect(main?.track).toEqual({ ahead: 1, behind: 0 });
  });

  test("an annotated tag reports the tag object id and its peeled commit target", async () => {
    const { dir, commits } = linear(1);
    const sha = commits[0];
    if (sha === undefined) throw new Error("expected a commit");
    execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
    execFileSync("git", ["tag", "-a", "v1.0", "-m", "release", sha], { cwd: dir });

    const driver = await driverFor(dir);
    const records = await refs(driver);
    const tag = records.find((r) => r.refname === "refs/tags/v1.0");
    expect(tag).toBeDefined();
    expect(tag?.kind).toBe("tag");
    expect(tag?.objectType).toBe("tag");
    expect(tag?.objectId).not.toBe(sha); // the tag object itself, not the commit it points at
    expect(tag?.peeledObjectId).toBe(sha);
  });
});

describe("status", () => {
  test("reports a clean repo with no entries", async () => {
    const { dir } = linear(1);
    const driver = await driverFor(dir);
    const result = await status(driver);
    expect(result.entries).toHaveLength(0);
    expect(result.branch.head).toEqual({ kind: "branch", name: "main" });
  });

  test("reports an unstaged (dirty) modification as an ordinary entry", async () => {
    const { dir } = linear(1);
    writeFileSync(join(dir, "file.txt"), "dirty change\n");
    const driver = await driverFor(dir);
    const result = await status(driver);
    expect(result.entries).toEqual([
      expect.objectContaining({ kind: "ordinary", path: "file.txt", staged: ".", unstaged: "M" }),
    ]);
  });

  test("reports a staged addition and an untracked file separately", async () => {
    const { dir } = linear(1);
    writeFileSync(join(dir, "staged.txt"), "staged\n");
    execFileSync("git", ["add", "staged.txt"], { cwd: dir });
    writeFileSync(join(dir, "untracked.txt"), "untracked\n");

    const driver = await driverFor(dir);
    const result = await status(driver);
    expect(result.entries).toContainEqual(
      expect.objectContaining({ kind: "ordinary", path: "staged.txt", staged: "A", unstaged: "." }),
    );
    expect(result.entries).toContainEqual({ kind: "untracked", path: "untracked.txt" });
  });

  test("reports a staged rename with its original path and similarity", async () => {
    const { dir } = linear(1);
    execFileSync("git", ["mv", "file.txt", "renamed.txt"], { cwd: dir });
    const driver = await driverFor(dir);
    const result = await status(driver);
    const renamed = result.entries.find((e) => e.kind === "renamed");
    expect(renamed).toBeDefined();
    if (renamed?.kind === "renamed") {
      expect(renamed.path).toBe("renamed.txt");
      expect(renamed.originalPath).toBe("file.txt");
      expect(renamed.renameOrCopy).toBe("rename");
      expect(renamed.similarity).toBeGreaterThan(0);
    }
  });

  test("reports an unmerged conflict with all three stages", async () => {
    const { dir } = conflicting();
    try {
      execFileSync("git", ["merge", "--no-gpg-sign", "branch-theirs"], { cwd: dir });
    } catch {
      // Expected: the merge conflicts, leaving an unmerged entry in the index.
    }
    const driver = await driverFor(dir);
    const result = await status(driver);
    const unmerged = result.entries.find((e) => e.kind === "unmerged");
    expect(unmerged).toBeDefined();
    if (unmerged?.kind === "unmerged") {
      expect(unmerged.path).toBe("conflict.txt");
      expect(unmerged.base.objectId).toBeTruthy();
      expect(unmerged.ours.objectId).toBeTruthy();
      expect(unmerged.theirs.objectId).toBeTruthy();
    }
  });
});

describe("stashList", () => {
  test("reports a stash entry's base and message", async () => {
    const { dir } = withStash();
    const driver = await driverFor(dir);
    const entries = await stashList(driver);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.message).toContain("On main:");
  });
});

describe("countCommits", () => {
  test("counts commits across all refs vs. just HEAD", async () => {
    // conflicting() leaves branch-theirs unmerged into main (they diverge), so --all sees a
    // commit HEAD alone does not.
    const { dir } = conflicting();
    const driver = await driverFor(dir);
    const all = await countCommits(driver, "all");
    const head = await countCommits(driver, "head");
    expect(all).toBeGreaterThan(head);
  });
});

describe("predictMerge", () => {
  test("a clean merge, cross-checked against an actual executed merge", async () => {
    const { dir, refs: shapeRefs } = linear(1);
    execFileSync("git", ["switch", "--quiet", "-c", "b1"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
    execFileSync("git", ["commit", "--quiet", "--no-gpg-sign", "--allow-empty", "-m", "b1"], {
      cwd: dir,
    });
    execFileSync("git", ["switch", "--quiet", "main"], { cwd: dir });

    const driver = await driverFor(dir);
    const main = shapeRefs.main;
    if (main === undefined) throw new Error("expected a main ref");
    const prediction = await predictMerge(driver, main, "b1");
    expect(prediction.kind).toBe("clean");

    // Cross-check: an actual merge in a throwaway clone should also succeed cleanly.
    const cloneDir = `${dir}-clone`;
    execFileSync("git", ["clone", "--quiet", dir, cloneDir]);
    execFileSync("git", ["config", "user.name", "T"], { cwd: cloneDir });
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: cloneDir });
    execFileSync("git", ["merge", "--quiet", "--no-gpg-sign", "origin/b1"], { cwd: cloneDir });
  });

  test("a real conflict, cross-checked against an actual executed merge", async () => {
    const { dir, refs: shapeRefs } = conflicting();
    const driver = await driverFor(dir);
    const main = shapeRefs.main;
    const theirs = shapeRefs["branch-theirs"];
    if (main === undefined || theirs === undefined) throw new Error("expected both refs");
    const prediction = await predictMerge(driver, main, theirs);
    expect(prediction.kind).toBe("conflicts");
    if (prediction.kind === "conflicts") {
      expect(prediction.paths).toContain("conflict.txt");
    }

    let actuallyConflicted = false;
    try {
      execFileSync("git", ["merge", "--no-gpg-sign", "branch-theirs"], { cwd: dir });
    } catch {
      actuallyConflicted = true;
    }
    expect(actuallyConflicted).toBe(true);
  });
});

describe("commitDetail", () => {
  test("an ordinary commit's metadata, body and file changes", async () => {
    const { dir, commits } = linear(2);
    const driver = await driverFor(dir);
    const sha = commits[1];
    if (sha === undefined) throw new Error("expected a second commit");
    const detail = await commitDetail(driver, sha);
    expect(detail.sha).toBe(sha);
    expect(detail.signature.status).toBe("N");
    expect(detail.files.map((f) => f.path)).toContain("file.txt");
  });

  test("a root commit diffs against the empty tree", async () => {
    const { dir, commits } = linear(1);
    const driver = await driverFor(dir);
    const sha = commits[0];
    if (sha === undefined) throw new Error("expected a commit");
    const detail = await commitDetail(driver, sha);
    expect(detail.parents).toHaveLength(0);
    expect(detail.files.map((f) => f.kind)).toEqual(["added"]);
  });

  test("a rename's file change carries the original path and similarity", async () => {
    const { dir } = linear(1);
    execFileSync("git", ["mv", "file.txt", "renamed.txt"], { cwd: dir });
    execFileSync("git", ["commit", "--quiet", "--no-gpg-sign", "-m", "rename"], {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "T",
        GIT_AUTHOR_EMAIL: "t@t.com",
        GIT_COMMITTER_NAME: "T",
        GIT_COMMITTER_EMAIL: "t@t.com",
      },
    });
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString("utf8").trim();
    const driver = await driverFor(dir);
    const detail = await commitDetail(driver, sha);
    const renamed = detail.files.find((f) => f.kind === "renamed");
    expect(renamed?.originalPath).toBe("file.txt");
    expect(renamed?.path).toBe("renamed.txt");
    expect(renamed?.similarity).toBeGreaterThan(0);
    // P1 fix: a pure rename with no content edit reports a true 0/0 delta, not an approximated
    // full delete of the old path plus a full add of the new one.
    expect(renamed?.additions).toBe(0);
    expect(renamed?.deletions).toBe(0);
  });

  test("a rename with an edit reports the true post-rename delta, not delete+add (P1 fix)", async () => {
    const { dir } = linear(1);
    // Enough shared content that git's default 50% rename-similarity threshold still classifies
    // this as a rename once one more line is appended, not an unrelated delete + add.
    writeFileSync(join(dir, "old.txt"), "line1\nline2\nline3\nline4\nline5\n");
    execFileSync("git", ["add", "old.txt"], { cwd: dir });
    execFileSync("git", ["commit", "--quiet", "--no-gpg-sign", "-m", "seed old.txt"], {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "T",
        GIT_AUTHOR_EMAIL: "t@t.com",
        GIT_COMMITTER_NAME: "T",
        GIT_COMMITTER_EMAIL: "t@t.com",
      },
    });
    execFileSync("git", ["mv", "old.txt", "new.txt"], { cwd: dir });
    writeFileSync(join(dir, "new.txt"), "line1\nline2\nline3-edited\nline4\nline5\n");
    execFileSync("git", ["commit", "--quiet", "--no-gpg-sign", "-am", "rename with edit"], {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "T",
        GIT_AUTHOR_EMAIL: "t@t.com",
        GIT_COMMITTER_NAME: "T",
        GIT_COMMITTER_EMAIL: "t@t.com",
      },
    });
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString("utf8").trim();
    const driver = await driverFor(dir);
    const detail = await commitDetail(driver, sha);
    const renamed = detail.files.find((f) => f.kind === "renamed");
    expect(renamed?.originalPath).toBe("old.txt");
    expect(renamed?.path).toBe("new.txt");
    // One line changed inside the renamed file — the true delta is +1/-1, never the old +5/-5
    // (or larger) a delete+add reconstruction would have reported for the same edit.
    expect(renamed?.additions).toBe(1);
    expect(renamed?.deletions).toBe(1);
  });

  const testIdentityEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "T",
    GIT_AUTHOR_EMAIL: "t@t.com",
    GIT_COMMITTER_NAME: "T",
    GIT_COMMITTER_EMAIL: "t@t.com",
  };

  test("a copy's file change carries the original path and similarity", async () => {
    const { dir } = linear(1);
    // `-C` (without --find-copies-harder) only detects a copy when its source is *also*
    // modified in the same commit — copy.txt alone, with file.txt untouched, would not do it.
    copyFileSync(join(dir, "file.txt"), join(dir, "copy.txt"));
    writeFileSync(join(dir, "file.txt"), "line 0\nan added line\n");
    execFileSync("git", ["add", "file.txt", "copy.txt"], { cwd: dir });
    execFileSync("git", ["commit", "--quiet", "--no-gpg-sign", "-m", "copy"], {
      cwd: dir,
      env: testIdentityEnv,
    });
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString("utf8").trim();

    const driver = await driverFor(dir);
    const detail = await commitDetail(driver, sha);
    const copied = detail.files.find((f) => f.kind === "copied");
    expect(copied?.originalPath).toBe("file.txt");
    expect(copied?.path).toBe("copy.txt");
    expect(copied?.similarity).toBeGreaterThan(0);
    const modified = detail.files.find((f) => f.path === "file.txt");
    expect(modified?.kind).toBe("modified");
  });

  test("a binary file's addition reports isBinary with no line counts", async () => {
    const { dir } = linear(1);
    writeFileSync(join(dir, "image.bin"), Buffer.from([0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00]));
    execFileSync("git", ["add", "image.bin"], { cwd: dir });
    execFileSync("git", ["commit", "--quiet", "--no-gpg-sign", "-m", "binary"], {
      cwd: dir,
      env: testIdentityEnv,
    });
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString("utf8").trim();

    const driver = await driverFor(dir);
    const detail = await commitDetail(driver, sha);
    const binary = detail.files.find((f) => f.path === "image.bin");
    expect(binary?.isBinary).toBe(true);
    expect(binary?.additions).toBeUndefined();
    expect(binary?.deletions).toBeUndefined();
  });

  test("a merge commit's parent selector picks which parent to diff against", async () => {
    const { dir, refs: shapeRefs } = linear(1);
    const identity = { name: "T", email: "t@t.com" };
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
    };
    execFileSync("git", ["switch", "--quiet", "-c", "feature"], { cwd: dir });
    execFileSync("node", ["-e", "require('fs').writeFileSync('feature.txt','x\\n')"], { cwd: dir });
    execFileSync("git", ["add", "feature.txt"], { cwd: dir });
    execFileSync("git", ["commit", "--quiet", "--no-gpg-sign", "-m", "feature commit"], {
      cwd: dir,
      env,
    });
    execFileSync("git", ["switch", "--quiet", "main"], { cwd: dir });
    execFileSync(
      "git",
      ["merge", "--quiet", "--no-gpg-sign", "--no-ff", "-m", "merge", "feature"],
      {
        cwd: dir,
        env,
      },
    );
    const mergeSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir })
      .toString("utf8")
      .trim();

    const driver = await driverFor(dir);
    // Parent 0 (main, default) never had feature.txt — diffing against it shows the addition.
    const againstMain = await commitDetail(driver, mergeSha);
    expect(againstMain.files.map((f) => f.path)).toContain("feature.txt");
    // Parent 1 (feature) already had feature.txt — diffing against it shows no change to it,
    // proving the selector actually changes which parent is used, not just accepted and ignored.
    const againstFeature = await commitDetail(driver, mergeSha, { parentIndex: 1 });
    expect(againstFeature.files.map((f) => f.path)).not.toContain("feature.txt");
    void shapeRefs;
  });
});
