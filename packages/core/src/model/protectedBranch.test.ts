import { describe, expect, test } from "bun:test";
import { matchProtectedBranch, type ProtectedBranchProblem } from "./protectedBranch.ts";

describe("matchProtectedBranch", () => {
  test("exact match", () => {
    expect(matchProtectedBranch("main", ["main", "master"])).toEqual({ pattern: "main" });
  });

  test("no match", () => {
    expect(matchProtectedBranch("feature/x", ["main", "master"])).toBeNull();
  });

  test("release/* matches release/1.2", () => {
    expect(matchProtectedBranch("release/1.2", ["release/*"])).toEqual({ pattern: "release/*" });
  });

  test("release/* does NOT match release/1.2/hotfix — * never crosses /", () => {
    expect(matchProtectedBranch("release/1.2/hotfix", ["release/*"])).toBeNull();
  });

  test("releases/1.2 does not match release/* (different literal prefix)", () => {
    expect(matchProtectedBranch("releases/1.2", ["release/*"])).toBeNull();
  });

  test("empty pattern list never matches", () => {
    expect(matchProtectedBranch("main", [])).toBeNull();
  });

  test("a literal * in a branch name is matched literally, not as a wildcard escape hole", () => {
    // The branch itself contains no '*' in these fixtures because git ref names may not
    // contain '*' — but the pattern's OWN literal characters (a dot, say) must not be treated
    // as regex metacharacters either.
    expect(matchProtectedBranch("release.x", ["release.x"])).toEqual({ pattern: "release.x" });
    expect(matchProtectedBranch("releaseAx", ["release.x"])).toBeNull();
  });

  test("case-sensitive", () => {
    expect(matchProtectedBranch("Main", ["main"])).toBeNull();
  });

  test("returns the FIRST matching pattern, in order", () => {
    expect(matchProtectedBranch("main", ["never", "main", "main"])).toEqual({ pattern: "main" });
  });

  test("a pattern containing ** is reported as a problem and matched literally", () => {
    const problems: ProtectedBranchProblem[] = [];
    expect(matchProtectedBranch("release/1.2/hotfix", ["release/**"], problems)).toBeNull();
    expect(problems).toEqual([{ pattern: "release/**", reason: "unsupportedGlob" }]);

    const problems2: ProtectedBranchProblem[] = [];
    expect(matchProtectedBranch("release/**", ["release/**"], problems2)).toEqual({
      pattern: "release/**",
    });
  });

  test("default protected patterns (main, master, release/*)", () => {
    const defaults = ["main", "master", "release/*"];
    expect(matchProtectedBranch("main", defaults)).not.toBeNull();
    expect(matchProtectedBranch("master", defaults)).not.toBeNull();
    expect(matchProtectedBranch("release/2.0", defaults)).not.toBeNull();
    expect(matchProtectedBranch("feature/anything", defaults)).toBeNull();
  });
});
