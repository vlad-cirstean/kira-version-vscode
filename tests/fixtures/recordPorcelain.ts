/**
 * Regenerates tests/fixtures/porcelain/ — raw byte recordings of real git output, for the
 * parser unit tests in packages/git/src/parse/*.test.ts. Run with `bun run
 * tests/fixtures/recordPorcelain.ts`.
 *
 * Recorded as raw byte files, never as string literals in a .ts file: escaping NUL and 0x1f
 * into TypeScript source is exactly where a fixture silently stops representing what git
 * actually emits. Args are built with the exact same functions the parsers' own arg builders
 * export (packages/git/src/parse/*.ts), so the recorder and the code under test can never
 * silently drift apart.
 *
 * Two kinds of fixture: shapes from generateRepo.ts's deterministic shas (reproducible,
 * regenerated here byte-identically run to run), and a handful of hand-authored repos built
 * directly with plumbing commands for cases a generated repo cannot easily produce — a
 * non-UTF-8 path, a path with an embedded newline, a subject with a literal 0x1f or CRLF, an
 * empty subject, and a commit decorated by a branch, a tag and three remotes at once.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  logArgs,
  mergeTreeArgs,
  nameStatusArgs,
  numstatArgs,
  refsArgs,
  showMetadataArgs,
  stashListArgs,
  statusArgs,
} from "../../packages/git/src/index.ts";
import {
  baseEnv,
  branchy,
  conflicting,
  crissCross,
  linear,
  octopus,
  withRemote,
  withStash,
} from "./generateRepo.ts";

const OUT_DIR = join(import.meta.dir, "porcelain");

function git(cwd: string, args: string[]): Buffer {
  return execFileSync("git", args, {
    cwd,
    env: { ...baseEnv(cwd), ...IDENTITY },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** For invocations expected to exit non-zero on purpose (a real conflicting merge). */
function gitAllowFail(cwd: string, args: string[]): Buffer {
  try {
    return git(cwd, args);
  } catch (err) {
    const stdout = (err as { stdout?: Buffer }).stdout;
    if (!stdout) throw err;
    return stdout;
  }
}

function save(relPath: string, data: Buffer): void {
  const full = join(OUT_DIR, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, data);
}

function tempRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `kira-porcelain-${prefix}-`));
  git(dir, ["init", "--quiet", "--initial-branch=main"]);
  return dir;
}

const IDENTITY = {
  GIT_AUTHOR_NAME: "Kira Fixture",
  GIT_AUTHOR_EMAIL: "fixture@kira-version.test",
  GIT_COMMITTER_NAME: "Kira Fixture",
  GIT_COMMITTER_EMAIL: "fixture@kira-version.test",
  GIT_AUTHOR_DATE: "1700000000 +0000",
  GIT_COMMITTER_DATE: "1700000000 +0000",
};

function commitTree(cwd: string, args: string[]): string {
  const out = execFileSync("git", ["commit-tree", ...args], {
    cwd,
    env: { ...baseEnv(cwd), ...IDENTITY },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return out.toString("utf8").trim();
}

// ---------------------------------------------------------------------------------------
// log — over every history-shape generateRepo.ts provides.
// ---------------------------------------------------------------------------------------

function recordLog(): void {
  const shapes: Record<string, () => { dir: string }> = {
    linear: () => linear(5),
    branchy: () => branchy(),
    octopus: () => octopus(),
    crissCross: () => crissCross(),
    withStash: () => withStash(),
  };
  for (const [name, build] of Object.entries(shapes)) {
    const { dir } = build();
    const out = git(dir, logArgs({ scope: "all", maxCount: 5000 }));
    save(`log/${name}.bin`, out);
  }
}

// ---------------------------------------------------------------------------------------
// refs — upstream/track populated, plus an annotated tag's peeled target.
// ---------------------------------------------------------------------------------------

function recordRefs(): void {
  const { dir } = withRemote({ localOnlyCommits: 1, remoteOnlyCommits: 0 });
  save("refs/withRemote.bin", git(dir, refsArgs()));

  const { dir: tagDir, refs } = linear(2);
  const head = refs.main;
  if (head === undefined) throw new Error("linear(2) did not produce a main ref");
  git(tagDir, ["tag", "-a", "v1", "-m", "release", head]);
  save("refs/annotatedTag.bin", git(tagDir, refsArgs()));
}

// ---------------------------------------------------------------------------------------
// status — clean, dirty, untracked, staged+unstaged, renamed, ignored, unmerged, unborn.
// ---------------------------------------------------------------------------------------

function recordStatus(): void {
  {
    const { dir } = linear(1);
    save("status/clean.bin", git(dir, statusArgs()));
  }
  {
    const { dir } = linear(1);
    writeFileSync(join(dir, "file.txt"), "dirty change\n");
    save("status/dirty.bin", git(dir, statusArgs()));
  }
  {
    const { dir } = linear(1);
    writeFileSync(join(dir, "new.txt"), "untracked\n");
    save("status/untracked.bin", git(dir, statusArgs()));
  }
  {
    const { dir } = linear(1);
    writeFileSync(join(dir, "file.txt"), "staged change\n");
    git(dir, ["add", "file.txt"]);
    writeFileSync(join(dir, "file.txt"), "staged change, plus unstaged on top\n");
    save("status/stagedAndUnstaged.bin", git(dir, statusArgs()));
  }
  {
    const { dir } = linear(1);
    git(dir, ["mv", "file.txt", "renamed.txt"]);
    save("status/renamed.bin", git(dir, statusArgs()));
  }
  {
    const { dir } = linear(1);
    writeFileSync(join(dir, "ignored.log"), "noise\n");
    writeFileSync(join(dir, ".gitignore"), "*.log\n");
    save("status/ignored.bin", git(dir, statusArgs({ ignored: true })));
  }
  {
    const { dir } = conflicting();
    gitAllowFail(dir, ["merge", "--no-gpg-sign", "branch-theirs"]);
    save("status/unmerged.bin", git(dir, statusArgs()));
  }
  {
    const dir = tempRepo("unborn");
    save("status/unborn.bin", git(dir, statusArgs()));
  }
}

// ---------------------------------------------------------------------------------------
// diff-tree — numstat (plain, binary) and name-status (ordinary, rename, copy).
// ---------------------------------------------------------------------------------------

function recordDiffTree(): void {
  {
    const dir = tempRepo("numstat-simple");
    writeFileSync(join(dir, "a.txt"), "line1\nline2\n");
    git(dir, ["add", "a.txt"]);
    const c1 = commitTree(dir, ["-m", "c1", git(dir, ["write-tree"]).toString("utf8").trim()]);
    writeFileSync(join(dir, "a.txt"), "line1\nline2\nline3\n");
    writeFileSync(join(dir, "b.txt"), "new file\n");
    git(dir, ["add", "-A"]);
    const c2 = commitTree(dir, [
      "-p",
      c1,
      "-m",
      "c2",
      git(dir, ["write-tree"]).toString("utf8").trim(),
    ]);
    save("diffTree/numstat-simple.bin", git(dir, numstatArgs(c1, c2)));
    save("diffTree/nameStatus-ordinary.bin", git(dir, nameStatusArgs(c1, c2)));
  }
  {
    const dir = tempRepo("numstat-binary");
    writeFileSync(join(dir, "a.txt"), "seed\n");
    git(dir, ["add", "a.txt"]);
    git(dir, ["commit", "--quiet", "--no-gpg-sign", "-m", "c1"]);
    const c1 = git(dir, ["rev-parse", "HEAD"]).toString("utf8").trim();
    writeFileSync(join(dir, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x10]));
    git(dir, ["add", "blob.bin"]);
    git(dir, ["commit", "--quiet", "--no-gpg-sign", "-m", "c2 binary"]);
    const c2 = git(dir, ["rev-parse", "HEAD"]).toString("utf8").trim();
    save("diffTree/numstat-binary.bin", git(dir, numstatArgs(c1, c2)));
  }
  {
    const dir = tempRepo("rename");
    writeFileSync(join(dir, "old.txt"), "line1\nline2\nline3\nline4\nline5\n");
    git(dir, ["add", "old.txt"]);
    git(dir, ["commit", "--quiet", "--no-gpg-sign", "-m", "c1"]);
    const c1 = git(dir, ["rev-parse", "HEAD"]).toString("utf8").trim();
    git(dir, ["mv", "old.txt", "new.txt"]);
    git(dir, ["commit", "--quiet", "--no-gpg-sign", "-m", "c2 pure rename"]);
    const c2 = git(dir, ["rev-parse", "HEAD"]).toString("utf8").trim();
    save("diffTree/nameStatus-rename.bin", git(dir, nameStatusArgs(c1, c2)));
    save("diffTree/numstat-rename.bin", git(dir, numstatArgs(c1, c2)));
  }
  {
    // A rename with an edit in the same commit (P1 fix's whole point): numstat with -M -C must
    // report the true post-rename delta (+1/-1), not an independent full delete + full add.
    const dir = tempRepo("rename-with-edit");
    writeFileSync(join(dir, "old.txt"), "line1\nline2\nline3\nline4\nline5\n");
    git(dir, ["add", "old.txt"]);
    git(dir, ["commit", "--quiet", "--no-gpg-sign", "-m", "c1"]);
    const c1 = git(dir, ["rev-parse", "HEAD"]).toString("utf8").trim();
    git(dir, ["mv", "old.txt", "new.txt"]);
    writeFileSync(join(dir, "new.txt"), "line1\nline2\nline3\nline4\nline5\nline6\n");
    git(dir, ["commit", "--quiet", "--no-gpg-sign", "-am", "c2 rename with edit"]);
    const c2 = git(dir, ["rev-parse", "HEAD"]).toString("utf8").trim();
    save("diffTree/nameStatus-renameWithEdit.bin", git(dir, nameStatusArgs(c1, c2)));
    save("diffTree/numstat-renameWithEdit.bin", git(dir, numstatArgs(c1, c2)));
  }
  {
    const dir = tempRepo("copy");
    writeFileSync(join(dir, "orig.txt"), "shared content line one\nline two\nline three\n");
    git(dir, ["add", "orig.txt"]);
    git(dir, ["commit", "--quiet", "--no-gpg-sign", "-m", "c1"]);
    const c1 = git(dir, ["rev-parse", "HEAD"]).toString("utf8").trim();
    execFileSync("cp", [join(dir, "orig.txt"), join(dir, "copy.txt")]);
    writeFileSync(join(dir, "orig.txt"), "shared content line one\nline two\nline three\nedited\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "--quiet", "--no-gpg-sign", "-m", "c2 copy"]);
    const c2 = git(dir, ["rev-parse", "HEAD"]).toString("utf8").trim();
    save("diffTree/nameStatus-copy.bin", git(dir, nameStatusArgs(c1, c2)));
  }
  {
    // A merge commit's diff against each parent individually — the parent-selector case.
    const { dir, refs } = branchy();
    const mergeSha = refs.main;
    if (mergeSha === undefined) throw new Error("branchy() did not produce a main ref");
    const parents = git(dir, ["rev-list", "--parents", "-n", "1", mergeSha])
      .toString("utf8")
      .trim()
      .split(" ")
      .slice(1);
    parents.forEach((parentSha, index) => {
      save(
        `diffTree/mergeParent${index + 1}-numstat.bin`,
        git(dir, numstatArgs(parentSha, mergeSha)),
      );
      save(
        `diffTree/mergeParent${index + 1}-nameStatus.bin`,
        git(dir, nameStatusArgs(parentSha, mergeSha)),
      );
    });
  }
  {
    // A root commit's diff against the empty tree (`--root`, no `from`).
    const { dir, commits } = linear(1);
    const root = commits[0];
    if (root === undefined) throw new Error("linear(1) did not produce a commit");
    save("diffTree/root-numstat.bin", git(dir, numstatArgs(undefined, root)));
    save("diffTree/root-nameStatus.bin", git(dir, nameStatusArgs(undefined, root)));
  }
}

// ---------------------------------------------------------------------------------------
// stash list
// ---------------------------------------------------------------------------------------

function recordStash(): void {
  const { dir } = withStash();
  save("stash/list.bin", git(dir, stashListArgs()));
}

// ---------------------------------------------------------------------------------------
// merge-tree — clean and conflicting.
// ---------------------------------------------------------------------------------------

function recordMergeTree(): void {
  {
    const dir = tempRepo("merge-tree-clean");
    writeFileSync(join(dir, "shared.txt"), "line1\nline2\nline3\n");
    git(dir, ["add", "shared.txt"]);
    git(dir, ["commit", "--quiet", "--no-gpg-sign", "-m", "base"]);
    git(dir, ["switch", "--quiet", "-c", "b1"]);
    writeFileSync(join(dir, "shared.txt"), "line1\nCHANGED-B1\nline3\n");
    git(dir, ["commit", "--quiet", "--no-gpg-sign", "-am", "b1"]);
    git(dir, ["switch", "--quiet", "main"]);
    writeFileSync(join(dir, "other.txt"), "unrelated\n");
    git(dir, ["add", "other.txt"]);
    git(dir, ["commit", "--quiet", "--no-gpg-sign", "-m", "m1"]);
    save("mergeTree/clean.bin", git(dir, mergeTreeArgs("main", "b1")));
  }
  {
    const { dir } = conflicting();
    save("mergeTree/conflict.bin", gitAllowFail(dir, mergeTreeArgs("main", "branch-theirs")));
  }
}

// ---------------------------------------------------------------------------------------
// Hand-authored pathological cases.
// ---------------------------------------------------------------------------------------

function recordHandAuthored(): void {
  {
    const dir = tempRepo("nonutf8-path");
    // "bad" + two invalid-UTF-8 bytes + ".txt" — a raw Buffer path bypasses fs's string
    // encoding entirely, which a JS string round-trip (even via the latin1 "binary" encoding)
    // cannot: re-encoding a decoded string back to bytes goes through UTF-8 and would silently
    // turn the invalid bytes into a *different*, validly-encoded byte sequence.
    const badName = Buffer.concat([
      Buffer.from(`${dir}/bad`),
      Buffer.from([0xff, 0xfe]),
      Buffer.from(".txt"),
    ]);
    writeFileSync(badName, "content\n");
    git(dir, ["add", "-A"]);
    const tree = git(dir, ["write-tree"]).toString("utf8").trim();
    const sha = commitTree(dir, ["-m", "c1", tree]);
    save("handAuthored/nonUtf8Path-nameStatus.bin", git(dir, nameStatusArgs(undefined, sha)));
  }
  {
    const dir = tempRepo("path-with-newline");
    writeFileSync(join(dir, "a.txt"), "seed\n");
    git(dir, ["add", "a.txt"]);
    git(dir, ["commit", "--quiet", "--no-gpg-sign", "-m", "c1"]);
    const c1 = git(dir, ["rev-parse", "HEAD"]).toString("utf8").trim();
    writeFileSync(join(dir, "line\nbreak.txt"), "content\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "--quiet", "--no-gpg-sign", "-m", "c2"]);
    const c2 = git(dir, ["rev-parse", "HEAD"]).toString("utf8").trim();
    save("handAuthored/pathWithNewline-nameStatus.bin", git(dir, nameStatusArgs(c1, c2)));
  }
  {
    const dir = tempRepo("subject-0x1f");
    writeFileSync(join(dir, "a.txt"), "seed\n");
    git(dir, ["add", "a.txt"]);
    const tree = git(dir, ["write-tree"]).toString("utf8").trim();
    const sha = commitTree(dir, ["-m", "subject with a literal \x1f byte inside it", tree]);
    save("handAuthored/subjectWith0x1f-log.bin", git(dir, showMetadataArgs(sha)));
  }
  {
    const dir = tempRepo("crlf-subject");
    writeFileSync(join(dir, "a.txt"), "seed\n");
    git(dir, ["add", "a.txt"]);
    const tree = git(dir, ["write-tree"]).toString("utf8").trim();
    const sha = commitTree(dir, ["-m", "line one\r\nline two", tree]);
    save("handAuthored/crlfSubject-log.bin", git(dir, showMetadataArgs(sha)));
  }
  {
    const dir = tempRepo("empty-subject");
    writeFileSync(join(dir, "a.txt"), "seed\n");
    git(dir, ["add", "a.txt"]);
    const tree = git(dir, ["write-tree"]).toString("utf8").trim();
    // commit-tree is plumbing: unlike `git commit`, it needs no --allow-empty-message flag.
    const sha = commitTree(dir, ["-m", "", tree]);
    save("handAuthored/emptySubject-log.bin", git(dir, showMetadataArgs(sha)));
  }
  {
    // HEAD -> branch, plus a tag, plus three remote-tracking branches, all on one commit.
    const dir = tempRepo("full-decoration");
    writeFileSync(join(dir, "a.txt"), "seed\n");
    git(dir, ["add", "a.txt"]);
    git(dir, ["commit", "--quiet", "--no-gpg-sign", "-m", "c1"]);
    const sha = git(dir, ["rev-parse", "HEAD"]).toString("utf8").trim();
    git(dir, ["tag", "v1", sha]);
    for (const remote of ["origin", "upstream", "fork"]) {
      git(dir, ["update-ref", `refs/remotes/${remote}/main`, sha]);
    }
    save("handAuthored/fullDecoration-log.bin", git(dir, logArgs({ scope: "all", maxCount: 1 })));
  }

  // A for-each-ref record with an empty upstream, over the simplest possible shape (no
  // upstream ever configured).
  {
    const { dir } = linear(1);
    save("handAuthored/refsNoUpstream.bin", git(dir, refsArgs()));
  }
}

function main(): void {
  recordLog();
  recordRefs();
  recordStatus();
  recordDiffTree();
  recordStash();
  recordMergeTree();
  recordHandAuthored();
  console.log(`recorded porcelain fixtures under ${OUT_DIR}`);
}

main();
