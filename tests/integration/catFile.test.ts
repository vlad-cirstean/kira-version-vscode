import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openCatFileSession } from "../../packages/git/src/catFile.ts";
import { locateGit } from "../../packages/git/src/discovery.ts";
import { NodeProcessRunner } from "../../packages/git/src/nodeProcessRunner.ts";
import { linear } from "../fixtures/generateRepo.ts";

const runner = new NodeProcessRunner();

async function resolvedRealGit() {
  const resolution = await locateGit({ runner });
  if (resolution.kind !== "ok") throw new Error("no usable system git found for this test");
  return resolution.git;
}

function blobShaFor(dir: string, relativePath: string): string {
  return execFileSync("git", ["rev-parse", `HEAD:${relativePath}`], { cwd: dir })
    .toString("utf8")
    .trim();
}

function realCatFileContent(dir: string, sha: string): Buffer {
  return execFileSync("git", ["cat-file", "-p", sha], { cwd: dir });
}

describe("catFile integration — real git, real repo", () => {
  test("a text blob reads byte-identically to `git cat-file -p`", async () => {
    const git = await resolvedRealGit();
    const { dir } = linear(1);
    const sha = blobShaFor(dir, "file.txt");
    const session = openCatFileSession(git, runner, dir);

    const result = await session.read(sha);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.type).toBe("blob");
      expect(Buffer.from(result.content).equals(realCatFileContent(dir, sha))).toBe(true);
    }
    session.dispose();
  });

  test("a binary blob with embedded NUL and LF bytes reads byte-identically", async () => {
    const git = await resolvedRealGit();
    const { dir } = linear(1);
    const content = new Uint8Array(2000);
    for (let i = 0; i < content.length; i++)
      content[i] = i % 7 === 0 ? 0x00 : i % 5 === 0 ? 0x0a : i % 256;
    writeFileSync(join(dir, "blob.bin"), content);
    execFileSync("git", ["add", "blob.bin"], { cwd: dir });
    execFileSync("git", ["commit", "--quiet", "--no-gpg-sign", "-m", "add binary"], {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "T",
        GIT_AUTHOR_EMAIL: "t@t.com",
        GIT_COMMITTER_NAME: "T",
        GIT_COMMITTER_EMAIL: "t@t.com",
      },
    });
    const sha = blobShaFor(dir, "blob.bin");
    const session = openCatFileSession(git, runner, dir);

    const result = await session.read(sha);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(Buffer.from(result.content).equals(Buffer.from(content))).toBe(true);
    }
    session.dispose();
  });

  test("a blob sized at a common pipe-buffer boundary (64KiB) reads intact", async () => {
    const git = await resolvedRealGit();
    const { dir } = linear(1);
    const size = 64 * 1024;
    const content = new Uint8Array(size);
    for (let i = 0; i < size; i++) content[i] = i % 256;
    writeFileSync(join(dir, "boundary.bin"), content);
    execFileSync("git", ["add", "boundary.bin"], { cwd: dir });
    execFileSync("git", ["commit", "--quiet", "--no-gpg-sign", "-m", "add boundary blob"], {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "T",
        GIT_AUTHOR_EMAIL: "t@t.com",
        GIT_COMMITTER_NAME: "T",
        GIT_COMMITTER_EMAIL: "t@t.com",
      },
    });
    const sha = blobShaFor(dir, "boundary.bin");
    const session = openCatFileSession(git, runner, dir);

    const result = await session.read(sha);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(result.size).toBe(size);
      expect(Buffer.from(result.content).equals(Buffer.from(content))).toBe(true);
    }
    session.dispose();
  });

  test("a missing oid returns the typed missing result", async () => {
    const git = await resolvedRealGit();
    const { dir } = linear(1);
    const session = openCatFileSession(git, runner, dir);

    const missingOid = "0".repeat(40);
    const result = await session.read(missingOid);
    expect(result).toEqual({ kind: "missing", oid: missingOid });
    session.dispose();
  });

  test("many sequential reads over the same persistent process all resolve correctly", async () => {
    const git = await resolvedRealGit();
    const { dir, commits } = linear(20);
    const session = openCatFileSession(git, runner, dir);

    for (const sha of commits) {
      const fileSha = execFileSync("git", ["rev-parse", `${sha}:file.txt`], { cwd: dir })
        .toString("utf8")
        .trim();
      const result = await session.read(fileSha);
      expect(result.kind).toBe("found");
      if (result.kind === "found") {
        expect(Buffer.from(result.content).equals(realCatFileContent(dir, fileSha))).toBe(true);
      }
    }
    session.dispose();
  });

  test("dispose() then a further read is rejected, not silently re-spawned", async () => {
    const git = await resolvedRealGit();
    const { dir } = linear(1);
    const sha = blobShaFor(dir, "file.txt");
    const session = openCatFileSession(git, runner, dir);

    await session.read(sha);
    session.dispose();

    await expect(session.read(sha)).rejects.toBeInstanceOf(Error);
  });
});
