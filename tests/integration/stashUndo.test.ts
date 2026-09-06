import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSettings, UNDO_POLICY } from "../../packages/core/src/index.ts";
import { FakeLogger } from "../../packages/core/src/ports/testFakes.ts";
import { NodeFileWatcher } from "../../packages/git/src/nodeFileWatcher.ts";
import { NodeProcessRunner } from "../../packages/git/src/nodeProcessRunner.ts";
import { RepoService } from "../../packages/git/src/repoService.ts";
import { baseEnv, withStashes } from "../fixtures/generateRepo.ts";

/**
 * `docs/plans/P9.md` W19 — exit criterion 2, against real repos. Each test names the plan's own
 * numbered scenario in its title.
 */

async function openService(dir: string) {
  const service = await RepoService.create({
    runner: new NodeProcessRunner(),
    fileWatcher: new NodeFileWatcher(),
    logger: new FakeLogger(),
    settings: () => defaultSettings(),
    configuredGitCandidates: [],
  });
  const opened = await service.open(dir);
  if (opened.kind !== "ok") throw new Error("unreachable");
  return { service, repoId: opened.repoId };
}

describe("W19 scenario 1 — drop then undo restores the entry, at stash@{0}", () => {
  test("dropping the middle of three, then undo: the label/recoverySha are right, and the restored entry keeps its original %gs message", async () => {
    const repo = withStashes({ count: 3 });
    const { service, repoId } = await openService(repo.dir);
    try {
      const before = await service.stashList(repoId);
      expect(before.entries).toHaveLength(3);
      const middle = before.entries[1];
      if (!middle) throw new Error("unreachable");

      const del = await service.runOp(repoId, {
        kind: "stashDrop",
        sha: middle.sha,
        index: middle.index,
      });
      expect(del.ok).toBe(true);
      expect(del.undo).not.toBeNull();
      expect(del.undo?.recoverySha).toBe(middle.sha);
      expect(del.undo?.label).toBe(`Dropped stash@{1}: ${middle.message}`);

      const afterDrop = await service.stashList(repoId);
      expect(afterDrop.entries).toHaveLength(2);
      expect(afterDrop.entries.some((e) => e.sha === middle.sha)).toBe(false);

      const undoId = del.undo?.id;
      if (undoId === undefined) throw new Error("unreachable");
      const undone = await service.undoRun(repoId, undoId);
      expect(undone.ok).toBe(true);
      expect(undone.undo).toBeNull(); // undo.run's own OpResult never carries a new slot

      const restored = await service.stashList(repoId);
      expect(restored.entries).toHaveLength(3);
      // Probe 9: it comes back at the TOP of the stack, not its old position — and with its
      // exact original reflog subject, not a generic "recovered"/"WIP" message.
      expect(restored.entries[0]?.sha).toBe(middle.sha);
      expect(restored.entries[0]?.message).toBe(middle.message);
    } finally {
      service.dispose();
    }
  });
});

describe("W19 scenario 2 — undo after the recovery object is pruned", () => {
  test("reflog expire + gc --prune=now, then undo.run: a clean NotFound refusal, nothing written", async () => {
    const repo = withStashes({ count: 1 });
    const env = baseEnv(repo.dir);
    const { service, repoId } = await openService(repo.dir);
    try {
      const { entries } = await service.stashList(repoId);
      const entry = entries[0];
      if (!entry) throw new Error("unreachable");

      const del = await service.runOp(repoId, {
        kind: "stashDrop",
        sha: entry.sha,
        index: entry.index,
      });
      expect(del.ok).toBe(true);
      const undoId = del.undo?.id;
      if (undoId === undefined) throw new Error("unreachable");

      // Actually prune the now-unreachable stash commit — `undoRun`'s own `cat-file -e` guard is
      // only worth anything if the object can genuinely be gone.
      execFileSync("git", ["reflog", "expire", "--expire-unreachable=now", "--all"], {
        cwd: repo.dir,
        env,
      });
      execFileSync("git", ["gc", "--prune=now", "--quiet"], { cwd: repo.dir, env });
      let stillExists = true;
      try {
        execFileSync("git", ["cat-file", "-e", `${entry.sha}^{commit}`], {
          cwd: repo.dir,
          env,
          stdio: "pipe",
        });
      } catch {
        stillExists = false;
      }
      expect(stillExists).toBe(false); // confirms the premise, not just the fixture's shape

      const undone = await service.undoRun(repoId, undoId);
      expect(undone.ok).toBe(false);
      expect(undone.error?.kind).toBe("NotFound");

      // Nothing written: the stash is not back, and the slot was taken (not replayed twice).
      const after = await service.stashList(repoId);
      expect(after.entries).toEqual([]);
      expect(service.undoPeek(repoId)).toBeNull();
    } finally {
      service.dispose();
    }
  });
});

describe("W19 scenario 3 — the slot is cleared by the next op (§7.12)", () => {
  test("stashDrop's slot is gone after a stashPush, and stashPush's own notUndoable reason is what the UI would show", async () => {
    const repo = withStashes({ count: 1 });
    const { service, repoId } = await openService(repo.dir);
    try {
      const { entries } = await service.stashList(repoId);
      const entry = entries[0];
      if (!entry) throw new Error("unreachable");

      const del = await service.runOp(repoId, {
        kind: "stashDrop",
        sha: entry.sha,
        index: entry.index,
      });
      expect(del.ok).toBe(true);
      expect(service.undoPeek(repoId)).not.toBeNull();

      // OQ8: no stash-specific exception — the very next op clears the slot exactly like any
      // other undoable op, even one that is itself a stash operation (`stashPush` right after a
      // `stashDrop`, the exact interaction OQ8 calls out by name).
      writeFileSync(join(repo.dir, "base.txt"), "a fresh, unrelated dirty edit\n");
      const push = await service.runOp(repoId, {
        kind: "stashPush",
        message: undefined,
        includeUntracked: false,
        keepIndex: false,
        paths: [],
      });
      expect(push.ok).toBe(true);
      expect(push.undo).toBeNull();
      expect(service.undoPeek(repoId)).toBeNull(); // the drop's slot is gone

      // The reason the UI then shows for why THIS op offered no undo of its own.
      expect(UNDO_POLICY.stashPush).toEqual({
        kind: "notUndoable",
        reason: "Pop the stash to undo this.",
      });
    } finally {
      service.dispose();
    }
  });
});

describe("W19 scenario 4 — known limitation: two byte-identical stash entries share a sha", () => {
  test("restoring the one that is no longer at the tip is a silent update-ref no-op (probe 9)", async () => {
    // Two stashes with the exact same tree, parent and message, pushed under the exact same
    // pinned author/committer identity+date, are the exact same git object — content-addressed,
    // like everything else in git. `withStashes`'s own `Repo` helper advances the commit clock on
    // every call, which would give the two entries different shas despite identical content, so
    // this needs its own tightly pinned repo rather than reusing that fixture. A THIRD, distinct
    // stash is pushed in between the two identical ones: `git update-ref`'s reflog append is
    // itself skipped whenever a ref update's new value equals its own immediately-prior value
    // (verified directly against real git while writing this test), so two consecutive identical
    // pushes collapse into a single reflog line rather than two — the distinct middle push is
    // what makes the *second* identical push's old-value differ from its new one, so a real,
    // separate reflog entry is actually recorded for it.
    const dir = mkdtempSync(join(tmpdir(), "kira-fixture-stash-undo-identical-"));
    const env = {
      ...baseEnv(dir),
      GIT_AUTHOR_NAME: "Kira Fixture",
      GIT_AUTHOR_EMAIL: "fixture@kira-version.test",
      GIT_AUTHOR_DATE: "1700000000 +0000",
      GIT_COMMITTER_NAME: "Kira Fixture",
      GIT_COMMITTER_EMAIL: "fixture@kira-version.test",
      GIT_COMMITTER_DATE: "1700000000 +0000",
    };
    const git = (args: string[]) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8" });
    git(["init", "--quiet", "--initial-branch=main"]);
    writeFileSync(join(dir, "base.txt"), "base\n");
    git(["add", "-A"]);
    git(["commit", "--quiet", "--no-gpg-sign", "-m", "initial commit"]);

    writeFileSync(join(dir, "base.txt"), "identical change\n");
    git(["stash", "push", "--quiet", "-m", "twin stash"]); // stash@{0}
    writeFileSync(join(dir, "base.txt"), "distinct change\n");
    git(["stash", "push", "--quiet", "-m", "distinct stash"]); // stash@{0}, twin pushed to @{1}
    writeFileSync(join(dir, "base.txt"), "identical change\n");
    git(["stash", "push", "--quiet", "-m", "twin stash"]); // stash@{0} again, twin now at @{2}

    const { service, repoId } = await openService(dir);
    try {
      const before = await service.stashList(repoId);
      expect(before.entries).toHaveLength(3);
      const tip = before.entries[0];
      const older = before.entries[2];
      if (!tip || !older) throw new Error("unreachable");
      expect(older.sha).toBe(tip.sha); // the premise: same object, twice in the reflog
      expect(before.entries[1]?.sha).not.toBe(tip.sha); // the distinct one sits between them

      const del = await service.runOp(repoId, {
        kind: "stashDrop",
        sha: older.sha,
        index: older.index,
      });
      expect(del.ok).toBe(true);
      const undoId = del.undo?.id;
      if (undoId === undefined) throw new Error("unreachable");

      const afterDrop = await service.stashList(repoId);
      expect(afterDrop.entries).toHaveLength(2); // the tip and the distinct one survived

      const undone = await service.undoRun(repoId, undoId);
      expect(undone.ok).toBe(true); // `stash store` itself never fails here — no error at all

      // The documented limitation: the "restore" is a silent no-op — `refs/stash`'s CURRENT value
      // already IS that sha (it is still the tip), so `update-ref`'s own new-equals-old skip
      // (verified directly against real git above) means no reflog entry is appended. Still
      // exactly two entries afterward, not three — the drop is, in effect, un-undoable in this
      // one specific shape, and `undoRun` has no way to detect that from its own success/failure
      // signal alone.
      const after = await service.stashList(repoId);
      expect(after.entries).toHaveLength(2);
      expect(after.entries[0]?.sha).toBe(tip.sha);
    } finally {
      service.dispose();
    }
  });
});
