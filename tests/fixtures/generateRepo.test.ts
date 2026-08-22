import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import {
  branchy,
  clearLargeCache,
  conflicting,
  crissCross,
  type GeneratedRepo,
  large,
  linear,
  octopus,
  withRemote,
  withStash,
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

  test("withRemote wires a bare remote with ahead/behind commits", () => {
    const repo = track(withRemote({ remoteOnlyCommits: 2, localOnlyCommits: 1 }));
    expect(repo.refs.main).toBeDefined();
    expect(repo.refs["origin/main"]).toBeDefined();
    expect(repo.refs.main).not.toBe(repo.refs["origin/main"]);
  });
});

describe("generateRepo large()", () => {
  afterAll(() => {
    clearLargeCache();
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
