import { execFileSync } from "node:child_process";
import { describe, expect, test } from "bun:test";
import { locateGit } from "../../packages/git/src/discovery.ts";
import { openGitDriver } from "../../packages/git/src/driver.ts";
import { NodeProcessRunner } from "../../packages/git/src/nodeProcessRunner.ts";
import { noopCatFileSession } from "../../packages/git/src/testFakes.ts";
import { linear } from "../fixtures/generateRepo.ts";

/**
 * §4.3's write queue, exercised against real mutating commands (`git tag`, `git commit`)
 * issued through `driver.write()` directly — P1 deliberately does not implement `ops/*`
 * wrappers (P6-P9's job), so this is the write path's only real-git coverage.
 */
const runner = new NodeProcessRunner();
const noopCatFile = noopCatFileSession();

async function driverFor(repoRoot: string) {
  const resolution = await locateGit({ runner });
  if (resolution.kind !== "ok") throw new Error("no usable system git found for this test");
  return openGitDriver(resolution.git, runner, repoRoot, noopCatFile);
}

describe("driver.write() against real git", () => {
  test("a burst of real `git tag` writes all land, and generation bumps once per write", async () => {
    const { dir } = linear(1);
    const driver = await driverFor(dir);

    expect(driver.generation).toBe(0);
    await Promise.all(Array.from({ length: 8 }, (_, i) => driver.write(["tag", `t${i}`])));
    expect(driver.generation).toBe(8);

    const tags = execFileSync("git", ["tag", "--list"], { cwd: dir })
      .toString("utf8")
      .trim()
      .split("\n")
      .sort();
    expect(tags).toEqual(Array.from({ length: 8 }, (_, i) => `t${i}`).sort());
  });

  test("a real `git commit` through write() actually creates a commit", async () => {
    const { dir } = linear(1);
    const driver = await driverFor(dir);

    execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir });
    const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString("utf8").trim();

    await driver.write(["commit", "--no-gpg-sign", "--allow-empty", "-m", "via driver.write()"]);

    const after = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString("utf8").trim();
    expect(after).not.toBe(before);
    expect(driver.generation).toBe(1);

    const subject = execFileSync("git", ["log", "-1", "--format=%s"], { cwd: dir })
      .toString("utf8")
      .trim();
    expect(subject).toBe("via driver.write()");
  });

  test("onInvalidated fires once per real completed write, driven by real generation bumps", async () => {
    const { dir } = linear(1);
    const driver = await driverFor(dir);
    let fired = 0;
    driver.onInvalidated(() => {
      fired++;
    });

    await driver.write(["tag", "v1"]);
    await driver.write(["tag", "v2"]);
    expect(fired).toBe(2);
    expect(driver.generation).toBe(2);
  });

  test("a real failing write (bad tag name) rejects with a classified GitError and does not bump generation", async () => {
    const { dir } = linear(1);
    const driver = await driverFor(dir);

    await expect(driver.write(["tag", "..invalid..tag.."])).rejects.toMatchObject({
      name: "GitError",
    });
    expect(driver.generation).toBe(0);
  });
});
