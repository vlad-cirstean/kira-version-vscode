import { describe, expect, test } from "bun:test";
import { classifyGitError, GitCancelled, GitError, GitSpawnFailed } from "./errors.ts";

/**
 * Every stderr string below is a real, captured message (see errors.ts's header comment) —
 * generated with the exact commands that produce it: a stale index.lock, `git switch` to an
 * unknown branch, `git show` on a bad sha, `git switch` with changes that would be
 * overwritten, a push to a repo with a rejecting pre-receive hook, a push that has diverged,
 * `GIT_TERMINAL_PROMPT=0` blocking a credential prompt, and a real cherry-pick conflict.
 */

describe("classifyGitError", () => {
  test("LockHeld — a stale index.lock", () => {
    const stderr = [
      "fatal: Unable to create '/tmp/errprobe/.git/index.lock': File exists.",
      "",
      "Another git process seems to be running in this repository, e.g.",
      "an editor opened by 'git commit'. Please make sure all processes",
      "are terminated then try again. If it still fails, a git process",
      "may have crashed in this repository earlier:",
      "remove the file manually to continue.",
    ].join("\n");
    expect(classifyGitError(["commit", "-m", "c1"], 128, stderr).kind).toBe("LockHeld");
  });

  test("NotFound — invalid reference on switch", () => {
    const stderr = "fatal: invalid reference: nonexistent-branch\n";
    expect(classifyGitError(["switch", "nonexistent-branch"], 128, stderr).kind).toBe("NotFound");
  });

  test("NotFound — unknown revision on show", () => {
    const stderr = [
      "fatal: ambiguous argument 'badsha1234': unknown revision or path not in the working tree.",
      "Use '--' to separate paths from revisions, like this:",
      "'git <command> [<revision>...] -- [<file>...]'",
    ].join("\n");
    expect(classifyGitError(["show", "badsha1234"], 128, stderr).kind).toBe("NotFound");
  });

  test("NotFound — pathspec did not match any files", () => {
    const stderr =
      "error: pathspec 'nonexistent-file.txt' did not match any file(s) known to git\n";
    expect(classifyGitError(["checkout", "--", "nonexistent-file.txt"], 1, stderr).kind).toBe(
      "NotFound",
    );
  });

  test("DirtyWorktree — switch would overwrite local changes", () => {
    const stderr = [
      "error: Your local changes to the following files would be overwritten by checkout:",
      "\ta.txt",
      "Please commit your changes or stash them before you switch branches.",
      "Aborting",
    ].join("\n");
    expect(classifyGitError(["switch", "other"], 1, stderr).kind).toBe("DirtyWorktree");
  });

  test("NonFastForward — push rejected, remote has diverged", () => {
    const stderr = [
      "To /tmp/nff.bare",
      " ! [rejected]        main -> main (fetch first)",
      "error: failed to push some refs to '/tmp/nff.bare'",
      "hint: Updates were rejected because the remote contains work that you do not",
      "hint: have locally. This is usually caused by another repository pushing to",
      "hint: the same ref. If you want to integrate the remote changes, use",
      "hint: 'git pull' before pushing again.",
      "hint: See the 'Note about fast-forwards' in 'git push --help' for details.",
    ].join("\n");
    expect(classifyGitError(["push", "origin", "main"], 1, stderr).kind).toBe("NonFastForward");
  });

  test("HookRejected — server-side pre-receive hook declined", () => {
    const stderr = [
      "To /tmp/nff.bare",
      " ! [remote rejected] main -> main (pre-receive hook declined)",
      "error: failed to push some refs to '/tmp/nff.bare'",
    ].join("\n");
    expect(classifyGitError(["push", "origin", "main"], 1, stderr).kind).toBe("HookRejected");
  });

  test("AuthFailed — GIT_TERMINAL_PROMPT=0 blocked a credential prompt", () => {
    const stderr =
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n";
    expect(classifyGitError(["ls-remote", "https://github.com/x/y.git"], 128, stderr).kind).toBe(
      "AuthFailed",
    );
  });

  test("AuthFailed — a credential helper supplied wrong credentials", () => {
    const stderr =
      "remote: Invalid username or password.\nfatal: Authentication failed for 'https://example.com/x.git'\n";
    expect(classifyGitError(["fetch", "origin"], 128, stderr).kind).toBe("AuthFailed");
  });

  test("Conflict — a real cherry-pick conflict", () => {
    const stderr = [
      "error: could not apply 264650c... other",
      "hint: After resolving the conflicts, mark them with",
      'hint: "git add/rm <pathspec>", then run',
      'hint: "git cherry-pick --continue".',
      'hint: You can instead skip this commit with "git cherry-pick --skip".',
      'hint: To abort and get back to the state before "git cherry-pick",',
      'hint: run "git cherry-pick --abort".',
    ].join("\n");
    expect(classifyGitError(["cherry-pick", "264650c"], 1, stderr).kind).toBe("Conflict");
  });

  // P6/W6: this was P1's inherited gap (probe P8) — "could not revert" did not match the old
  // `/could not apply|CONFLICT \(/` pattern, so a conflicting revert classified as `Unknown`.
  test("Conflict — a real REVERT conflict (P1's inherited gap, probe P8)", () => {
    const stderr = [
      "error: could not revert dce0c49... side change",
      "hint: After resolving the conflicts, mark them with",
      'hint: "git add/rm <pathspec>", then run',
      'hint: "git revert --continue".',
      'hint: You can instead skip this commit with "git revert --skip".',
      'hint: To abort and get back to the state before "git revert",',
      'hint: run "git revert --abort".',
    ].join("\n");
    expect(classifyGitError(["revert", "--no-edit", "dce0c49"], 1, stderr).kind).toBe("Conflict");
  });

  test("AlreadyExists — a branch by that name already exists", () => {
    const stderr = "fatal: a branch named 'feature' already exists\n";
    expect(classifyGitError(["branch", "feature"], 128, stderr).kind).toBe("AlreadyExists");
  });

  test("AlreadyExists — a tag by that name already exists", () => {
    const stderr = "fatal: tag 'v1' already exists\n";
    expect(classifyGitError(["tag", "v1"], 128, stderr).kind).toBe("AlreadyExists");
  });

  test("AlreadyExists beats NonFastForward — a diverged tag push rejected as 'already exists'", () => {
    const stderr = [
      "To ../errprobe-remote.git",
      " ! [rejected]        t1 -> t1 (already exists)",
      "error: failed to push some refs to '../errprobe-remote.git'",
      "hint: Updates were rejected because the tag already exists in the remote.",
    ].join("\n");
    const error = classifyGitError(["push", "origin", "t1"], 1, stderr);
    expect(error.kind).toBe("AlreadyExists");
    expect(error.kind).not.toBe("NonFastForward");
  });

  test("NotFullyMerged — deleting an unmerged branch without -D", () => {
    const stderr = [
      "error: the branch 'unmerged' is not fully merged.",
      "If you are sure you want to delete it, run 'git branch -D unmerged'",
    ].join("\n");
    expect(classifyGitError(["branch", "-d", "unmerged"], 1, stderr).kind).toBe("NotFullyMerged");
  });

  test("WorktreeConflict — switching to a branch checked out in a linked worktree", () => {
    const stderr = "fatal: 'feature' is already used by worktree at '/tmp/errprobe-wt'\n";
    expect(classifyGitError(["switch", "feature"], 128, stderr).kind).toBe("WorktreeConflict");
  });

  test("WorktreeConflict — deleting a branch checked out in a linked worktree", () => {
    const stderr = "error: cannot delete branch 'feature' used by worktree at '/tmp/errprobe-wt'\n";
    expect(classifyGitError(["branch", "-D", "feature"], 1, stderr).kind).toBe("WorktreeConflict");
  });

  test("UntrackedWouldBeOverwritten — a plain checkout, plural 'files'", () => {
    const stderr = [
      "error: The following untracked working tree files would be overwritten by checkout:",
      "\tadded-on-topic.txt",
      "Please move or remove them before you switch branches.",
      "Aborting",
    ].join("\n");
    expect(classifyGitError(["switch", "topic"], 1, stderr).kind).toBe("UntrackedWouldBeOverwritten");
  });

  test("UntrackedWouldBeOverwritten — --discard-changes, singular 'file', different verb ('merge')", () => {
    const stderr = "error: Untracked working tree file 'added-on-topic.txt' would be overwritten by merge.\n";
    expect(
      classifyGitError(["switch", "--discard-changes", "topic"], 128, stderr).kind,
    ).toBe("UntrackedWouldBeOverwritten");
  });

  test("OperationInProgress — switch refused while merging/rebasing/cherry-picking/reverting", () => {
    expect(
      classifyGitError(["switch", "main"], 128, "fatal: cannot switch branch while merging\n").kind,
    ).toBe("OperationInProgress");
    expect(
      classifyGitError(["switch", "main"], 128, "fatal: cannot switch branch while rebasing\n").kind,
    ).toBe("OperationInProgress");
    expect(
      classifyGitError(["switch", "main"], 128, "fatal: cannot switch branch while cherry-picking\n")
        .kind,
    ).toBe("OperationInProgress");
    expect(
      classifyGitError(["switch", "main"], 128, "fatal: cannot switch branch while reverting\n").kind,
    ).toBe("OperationInProgress");
  });

  test("OperationInProgress — --continue with no operation running (three real shapes)", () => {
    expect(
      classifyGitError(
        ["merge", "--continue"],
        128,
        "fatal: There is no merge in progress (MERGE_HEAD missing).\n",
      ).kind,
    ).toBe("OperationInProgress");
    expect(
      classifyGitError(
        ["revert", "--continue"],
        128,
        "error: no cherry-pick or revert in progress\nfatal: revert failed\n",
      ).kind,
    ).toBe("OperationInProgress");
    expect(
      classifyGitError(["rebase", "--continue"], 128, "fatal: No rebase in progress?\n").kind,
    ).toBe("OperationInProgress");
  });

  test("RemoteRefMissing — remote-delete a tag not on the remote", () => {
    const stderr = [
      "error: unable to delete 'nosuchtag': remote ref does not exist",
      "error: failed to push some refs to '../errprobe-remote.git'",
    ].join("\n");
    expect(classifyGitError(["push", "origin", "--delete", "nosuchtag"], 1, stderr).kind).toBe(
      "RemoteRefMissing",
    );
  });

  test("RemoteRefMissing — pushing a local ref that does not exist", () => {
    const stderr = [
      "error: src refspec nosuchbranch does not match any",
      "error: failed to push some refs to '../errprobe-remote.git'",
    ].join("\n");
    expect(classifyGitError(["push", "origin", "nosuchbranch"], 1, stderr).kind).toBe(
      "RemoteRefMissing",
    );
  });

  test("NotFound — reference is not a tree (detach on a bad sha)", () => {
    const stderr = "fatal: reference is not a tree: deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n";
    expect(
      classifyGitError(["switch", "--detach", "deadbeef"], 128, stderr).kind,
    ).toBe("NotFound");
  });

  test("NotFound — no branch named (rename on a name that doesn't exist)", () => {
    const stderr = "fatal: no branch named 'nope'\n";
    expect(classifyGitError(["branch", "-m", "nope", "nope2"], 128, stderr).kind).toBe("NotFound");
  });

  test("NotFound — tag not found (delete on a name that doesn't exist)", () => {
    const stderr = "error: tag 'nope' not found.\n";
    expect(classifyGitError(["tag", "-d", "nope"], 1, stderr).kind).toBe("NotFound");
  });

  test("NotFound — bad object (revert on a bad sha)", () => {
    const stderr = "fatal: bad object deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n";
    expect(
      classifyGitError(["revert", "--no-edit", "deadbeef"], 128, stderr).kind,
    ).toBe("NotFound");
  });

  test("Unknown — an unrecognised stderr keeps its text intact", () => {
    const stderr = "fatal: something this classifier has never seen before\n";
    const error = classifyGitError(["frobnicate"], 1, stderr);
    expect(error.kind).toBe("Unknown");
    expect(error.stderr).toBe(stderr);
  });

  test("GitError preserves argv, exit code and raw stderr verbatim", () => {
    const error = classifyGitError(
      ["status", "--porcelain=v2"],
      129,
      "fatal: not a git repository\n",
    );
    expect(error.argv).toEqual(["status", "--porcelain=v2"]);
    expect(error.exitCode).toBe(129);
    expect(error.stderr).toBe("fatal: not a git repository\n");
    expect(error.name).toBe("GitError");
  });
});

describe("GitCancelled / GitSpawnFailed", () => {
  test("GitCancelled is not a GitError and carries no kind", () => {
    const error = new GitCancelled(["log", "--all"]);
    expect(error).not.toBeInstanceOf(GitError);
    expect(error.name).toBe("GitCancelled");
    expect(error.argv).toEqual(["log", "--all"]);
  });

  test("GitSpawnFailed carries the path and the underlying cause", () => {
    const cause = new Error("ENOENT");
    const error = new GitSpawnFailed("/no/such/git", cause);
    expect(error.name).toBe("GitSpawnFailed");
    expect(error.path).toBe("/no/such/git");
    expect(error.cause).toBe(cause);
  });
});
