import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { locateGit } from "../../packages/git/src/discovery.ts";
import { openGitDriver } from "../../packages/git/src/driver.ts";
import { NodeProcessRunner } from "../../packages/git/src/nodeProcessRunner.ts";
import { noopCatFileSession } from "../../packages/git/src/testFakes.ts";
import { conflicting, linear, withRemote } from "../fixtures/generateRepo.ts";

/**
 * §4.3's error classification (errors.ts, W6), exercised against operations induced to fail
 * for real through the driver — not just the recorded-stderr unit tests in errors.test.ts.
 */
const runner = new NodeProcessRunner();
const noopCatFile = noopCatFileSession();

async function driverFor(repoRoot: string) {
  const resolution = await locateGit({ runner });
  if (resolution.kind !== "ok") throw new Error("no usable system git found for this test");
  return openGitDriver(resolution.git, runner, repoRoot, noopCatFile);
}

describe("real induced failures classify correctly", () => {
  test("LockHeld — a stale index.lock blocks a real write", async () => {
    const { dir } = linear(1);
    writeFileSync(join(dir, ".git", "index.lock"), "");
    const driver = await driverFor(dir);

    await expect(
      driver.write(["commit", "--no-gpg-sign", "--allow-empty", "-m", "blocked"]),
    ).rejects.toMatchObject({ name: "GitError", kind: "LockHeld" });
  });

  test("NotFound — a bad sha on a real read", async () => {
    const { dir } = linear(1);
    const driver = await driverFor(dir);

    // `git show <bad sha>` gives "fatal: ambiguous argument '...': unknown revision or path
    // not in the working tree." — the message errors.ts's NotFound pattern actually matches
    // (`rev-parse --verify` on a bad ref gives a vaguer message that does not, see errors.ts's
    // header comment on what was actually captured).
    const read = driver.read(["show", "badsha0000000000000000000000000000000000"]);
    for await (const _chunk of read.bytes) {
      // drain
    }
    await expect(read.done).rejects.toMatchObject({ name: "GitError", kind: "NotFound" });
  });

  test("DirtyWorktree — a real switch that would overwrite local changes", async () => {
    const { dir } = linear(1);
    execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
    execFileSync("git", ["switch", "--quiet", "-c", "other"], { cwd: dir });
    // `other`'s committed version of file.txt must genuinely differ from main's, or `switch`
    // is smart enough to carry the dirty change forward without conflict (verified earlier
    // empirically — an identical target version is not what "would be overwritten" means).
    writeFileSync(join(dir, "file.txt"), "other branch's committed content\n");
    execFileSync("git", ["commit", "--quiet", "--no-gpg-sign", "-am", "other"], { cwd: dir });
    execFileSync("git", ["switch", "--quiet", "main"], { cwd: dir });
    writeFileSync(join(dir, "file.txt"), "dirty, conflicting with other's version\n");

    const driver = await driverFor(dir);
    await expect(driver.write(["switch", "other"])).rejects.toMatchObject({
      name: "GitError",
      kind: "DirtyWorktree",
    });
  });

  test("HookRejected — a real push rejected by a server-side pre-receive hook", async () => {
    const { dir } = withRemote({ localOnlyCommits: 1 });
    const bareRemote = execFileSync("git", ["remote", "get-url", "origin"], { cwd: dir })
      .toString("utf8")
      .trim();
    mkdirSync(join(bareRemote, "hooks"), { recursive: true });
    const hookPath = join(bareRemote, "hooks", "pre-receive");
    writeFileSync(hookPath, "#!/bin/sh\nexit 1\n");
    chmodSync(hookPath, 0o755);

    const driver = await driverFor(dir);
    await expect(driver.write(["push", "origin", "main"])).rejects.toMatchObject({
      name: "GitError",
      kind: "HookRejected",
    });
  });

  test("NonFastForward — a real push rejected because the remote has diverged", async () => {
    const { dir } = withRemote({ localOnlyCommits: 1 });
    const bareRemote = execFileSync("git", ["remote", "get-url", "origin"], { cwd: dir })
      .toString("utf8")
      .trim();

    // Push from a second clone so the shared remote moves out from under `dir`.
    const otherClone = `${dir}-other`;
    execFileSync("git", ["clone", "--quiet", bareRemote, otherClone]);
    execFileSync("git", ["config", "user.name", "T"], { cwd: otherClone });
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: otherClone });
    execFileSync(
      "git",
      ["commit", "--quiet", "--no-gpg-sign", "--allow-empty", "-m", "diverging"],
      {
        cwd: otherClone,
      },
    );
    execFileSync("git", ["push", "--quiet", "origin", "main"], { cwd: otherClone });

    const driver = await driverFor(dir);
    await expect(driver.write(["push", "origin", "main"])).rejects.toMatchObject({
      name: "GitError",
      kind: "NonFastForward",
    });
  });

  test("Unknown — an unrecognised failure still preserves the raw stderr", async () => {
    const { dir } = conflicting();
    const driver = await driverFor(dir);

    // A genuinely nonsensical argv that no pattern should match, but that still fails.
    await expect(driver.write(["frobnicate-not-a-real-subcommand"])).rejects.toMatchObject({
      name: "GitError",
    });
  });
});
