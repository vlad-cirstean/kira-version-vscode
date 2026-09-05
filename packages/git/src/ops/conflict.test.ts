import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { abortArgs, continueArgs, readInProgressStateFiles } from "./conflict.ts";

const dirs: string[] = [];

async function tempGitDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kira-conflict-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("readInProgressStateFiles", () => {
  test("an empty gitDir: everything undefined/false — never a throw", async () => {
    const dir = await tempGitDir();
    const result = await readInProgressStateFiles(dir);
    expect(result).toEqual({
      mergeHead: undefined,
      cherryPickHead: undefined,
      revertHead: undefined,
      bisectLog: false,
      rebaseMergeDir: false,
      rebaseApplyDir: false,
      rebaseHeadName: undefined,
      rebaseOnto: undefined,
      sequencerDir: false,
    });
  });

  test("MERGE_HEAD present: content trimmed", async () => {
    const dir = await tempGitDir();
    await writeFile(join(dir, "MERGE_HEAD"), "abc1234\n");
    const result = await readInProgressStateFiles(dir);
    expect(result.mergeHead).toBe("abc1234");
  });

  test("CHERRY_PICK_HEAD present", async () => {
    const dir = await tempGitDir();
    await writeFile(join(dir, "CHERRY_PICK_HEAD"), "def5678\n");
    const result = await readInProgressStateFiles(dir);
    expect(result.cherryPickHead).toBe("def5678");
  });

  test("REVERT_HEAD present", async () => {
    const dir = await tempGitDir();
    await writeFile(join(dir, "REVERT_HEAD"), "ghi9012\n");
    const result = await readInProgressStateFiles(dir);
    expect(result.revertHead).toBe("ghi9012");
  });

  test("BISECT_LOG present: presence only, content never read", async () => {
    const dir = await tempGitDir();
    await writeFile(join(dir, "BISECT_LOG"), "git bisect start\n");
    const result = await readInProgressStateFiles(dir);
    expect(result.bisectLog).toBe(true);
  });

  test("rebase-merge/ present: dir flag true, head-name and onto read as trimmed content", async () => {
    const dir = await tempGitDir();
    await mkdir(join(dir, "rebase-merge"));
    await writeFile(join(dir, "rebase-merge", "head-name"), "refs/heads/side\n");
    await writeFile(join(dir, "rebase-merge", "onto"), "abcdef0123456789\n");
    const result = await readInProgressStateFiles(dir);
    expect(result.rebaseMergeDir).toBe(true);
    expect(result.rebaseApplyDir).toBe(false);
    expect(result.rebaseHeadName).toBe("refs/heads/side");
    expect(result.rebaseOnto).toBe("abcdef0123456789");
  });

  test("rebase-apply/ present (the apply-based rebase, no head-name/onto files)", async () => {
    const dir = await tempGitDir();
    await mkdir(join(dir, "rebase-apply"));
    const result = await readInProgressStateFiles(dir);
    expect(result.rebaseApplyDir).toBe(true);
    expect(result.rebaseMergeDir).toBe(false);
    expect(result.rebaseHeadName).toBeUndefined();
  });

  test("sequencer/ present: a multi-commit revert or cherry-pick mid-run", async () => {
    const dir = await tempGitDir();
    await mkdir(join(dir, "sequencer"));
    const result = await readInProgressStateFiles(dir);
    expect(result.sequencerDir).toBe(true);
  });

  test("a file that exists but is all whitespace reads as undefined, not an empty string", async () => {
    const dir = await tempGitDir();
    await writeFile(join(dir, "MERGE_HEAD"), "   \n");
    const result = await readInProgressStateFiles(dir);
    expect(result.mergeHead).toBeUndefined();
  });
});

describe("continueArgs — the Ordering table's --continue column", () => {
  test("merge / cherryPick / revert all offer --continue", () => {
    expect(continueArgs("merge")).toEqual(["merge", "--continue"]);
    expect(continueArgs("cherryPick")).toEqual(["cherry-pick", "--continue"]);
    expect(continueArgs("revert")).toEqual(["revert", "--continue"]);
  });

  test("rebase, bisect and unmergedOnly offer no --continue (§9, and nothing to continue)", () => {
    expect(continueArgs("rebase")).toBeUndefined();
    expect(continueArgs("bisect")).toBeUndefined();
    expect(continueArgs("unmergedOnly")).toBeUndefined();
  });
});

describe("abortArgs — the Ordering table's --abort column", () => {
  test("merge / cherryPick / revert / rebase all offer --abort", () => {
    expect(abortArgs("merge")).toEqual(["merge", "--abort"]);
    expect(abortArgs("cherryPick")).toEqual(["cherry-pick", "--abort"]);
    expect(abortArgs("revert")).toEqual(["revert", "--abort"]);
    expect(abortArgs("rebase")).toEqual(["rebase", "--abort"]);
  });

  test("bisect's abort is `git bisect reset`, not `bisect --abort`", () => {
    expect(abortArgs("bisect")).toEqual(["bisect", "reset"]);
  });

  test("unmergedOnly offers no abort — no state file for git to abort", () => {
    expect(abortArgs("unmergedOnly")).toBeUndefined();
  });
});
