import { describe, expect, test } from "bun:test";
import type { RefRow } from "../../../packages/ipc/src/index.ts";
import { REF_LIST_SECTION_CAP } from "../../../packages/ui/src/components/refListModel.ts";
import type {
  SearchResultsInput,
  SearchResultsSection,
} from "../../../packages/ui/src/components/searchResultsModel.ts";
import {
  buildSearchResultsModel,
  fieldLabel,
} from "../../../packages/ui/src/components/searchResultsModel.ts";
import type { CommitHit, RefHit } from "../../../packages/ui/src/state/search.ts";

/**
 * `docs/plans/P11.md` W16: `searchResultsModel.ts`'s pure fold — grouping, per-section caps and
 * the two honesty footers — asserted with no component mount at all (this file's own doc
 * comment). Also covers W16 row 17 ("both scope renders two groups, refs first"), which is this
 * model's own contract, not the matcher's (see `matcher.test.ts`'s row 17 for that half).
 */

function row(overrides: Partial<RefRow> = {}): RefRow {
  return {
    refname: "refs/heads/main",
    kind: "branch",
    shortName: "main",
    objectId: "a".repeat(40),
    peeledObjectId: undefined,
    upstream: undefined,
    track: undefined,
    committerDate: 0,
    isHead: false,
    checkedOutIn: undefined,
    annotation: undefined,
    ...overrides,
  };
}

function refHit(overrides: Partial<RefRow> = {}): RefHit {
  return { ref: row(overrides), fields: ["refName"] };
}

function commitHit(overrides: Partial<CommitHit> = {}): CommitHit {
  return {
    sha: "a".repeat(40),
    row: 0,
    subject: "a commit",
    authorName: "Kira Fixture",
    authorEmail: "fixture@kira-version.test",
    authorTime: 1_700_000_000,
    fields: ["subject"],
    ...overrides,
  };
}

function baseInput(overrides: Partial<SearchResultsInput> = {}): SearchResultsInput {
  return {
    scope: "both",
    refHits: [],
    commitHits: [],
    loaded: undefined,
    loadedRowCount: 0,
    tail: undefined,
    ...overrides,
  };
}

function titles(sections: readonly SearchResultsSection[]): string[] {
  return sections.map((s) => s.title);
}

describe("fieldLabel", () => {
  test("subject/refName alone (the hit's own visible text) needs no label", () => {
    expect(fieldLabel(["subject"])).toBeUndefined();
    expect(fieldLabel(["refName"])).toBeUndefined();
  });

  test("a body-only hit gets a 'body' label", () => {
    expect(fieldLabel(["body"])).toBe("body");
  });

  test("subject plus another field still labels the other field", () => {
    expect(fieldLabel(["subject", "authorEmail"])).toBe("author email");
  });

  test("multiple non-subject fields join with a comma", () => {
    expect(fieldLabel(["authorName", "committerName"])).toBe("author, committer");
  });

  test("an empty field list has no label", () => {
    expect(fieldLabel([])).toBeUndefined();
  });
});

describe("buildSearchResultsModel — grouping and scope", () => {
  test("row 17: 'both' scope renders refs group(s) first, then commits", () => {
    const model = buildSearchResultsModel(
      baseInput({
        scope: "both",
        refHits: [refHit({ kind: "branch", shortName: "widget-fix" })],
        commitHits: [commitHit()],
      }),
    );
    expect(titles(model.sections)).toEqual(["Branches", "Commits"]);
    expect(model.flatOptions.map((o) => o.kind)).toEqual(["ref", "commit"]);
  });

  test("row 16: 'commits' scope renders only the commits section, no ref sections at all", () => {
    const model = buildSearchResultsModel(
      baseInput({
        scope: "commits",
        refHits: [refHit()],
        commitHits: [commitHit()],
      }),
    );
    expect(titles(model.sections)).toEqual(["Commits"]);
  });

  test("'refs' scope renders only ref sections, no commits section at all", () => {
    const model = buildSearchResultsModel(
      baseInput({
        scope: "refs",
        refHits: [refHit()],
        commitHits: [commitHit()],
      }),
    );
    expect(titles(model.sections)).toEqual(["Branches"]);
  });

  test("branches, remote branches and tags are three distinct sections, in that order", () => {
    const model = buildSearchResultsModel(
      baseInput({
        scope: "refs",
        refHits: [
          refHit({ kind: "tag", shortName: "v1.2", refname: "refs/tags/v1.2" }),
          refHit({
            kind: "remoteBranch",
            shortName: "origin/main",
            refname: "refs/remotes/origin/main",
          }),
          refHit({ kind: "branch", shortName: "main", refname: "refs/heads/main" }),
        ],
      }),
    );
    expect(titles(model.sections)).toEqual(["Branches", "Remote branches", "Tags"]);
  });

  test("an empty section is omitted entirely, not rendered with zero options", () => {
    const model = buildSearchResultsModel(
      baseInput({ scope: "refs", refHits: [refHit({ kind: "branch" })] }),
    );
    expect(titles(model.sections)).toEqual(["Branches"]);
  });

  test("no hits at all (of either kind) produces no sections and no flat options", () => {
    const model = buildSearchResultsModel(baseInput());
    expect(model.sections).toEqual([]);
    expect(model.flatOptions).toEqual([]);
  });
});

describe("buildSearchResultsModel — per-section cap", () => {
  test(`a section over the cap keeps the first ${REF_LIST_SECTION_CAP} and reports the rest as hidden`, () => {
    const many = Array.from({ length: REF_LIST_SECTION_CAP + 7 }, (_, i) =>
      commitHit({ sha: i.toString(16).padStart(40, "0") }),
    );
    const model = buildSearchResultsModel(baseInput({ scope: "commits", commitHits: many }));
    const commits = model.sections.find((s) => s.title === "Commits");
    expect(commits?.options).toHaveLength(REF_LIST_SECTION_CAP);
    expect(commits?.hiddenCount).toBe(7);
  });

  test("a section at or under the cap reports zero hidden", () => {
    const model = buildSearchResultsModel(
      baseInput({ scope: "commits", commitHits: [commitHit()] }),
    );
    expect(model.sections[0]?.hiddenCount).toBe(0);
  });
});

describe("buildSearchResultsModel — footers", () => {
  test("loadedFooter is set only when the client-side scan did not complete", () => {
    const incomplete = buildSearchResultsModel(
      baseInput({ loaded: { complete: false, scannedRows: 4_000 }, loadedRowCount: 10_000 }),
    );
    expect(incomplete.loadedFooter).toBe("Searched 4000 of 10000 loaded commits");

    const complete = buildSearchResultsModel(
      baseInput({ loaded: { complete: true, scannedRows: 10_000 }, loadedRowCount: 10_000 }),
    );
    expect(complete.loadedFooter).toBeUndefined();

    const noScanYet = buildSearchResultsModel(baseInput({ loaded: undefined }));
    expect(noScanYet.loadedFooter).toBeUndefined();
  });

  test("tailFooter is set only when the tail truncated, and pluralizes 'match(es)' correctly", () => {
    const truncated = buildSearchResultsModel(
      baseInput({
        tail: { kind: "ok", hits: [], total: 5, truncated: true, scanned: 100, complete: true },
      }),
    );
    expect(truncated.tailFooter).toBe("5 more matches in history");

    const singular = buildSearchResultsModel(
      baseInput({
        tail: { kind: "ok", hits: [], total: 1, truncated: true, scanned: 100, complete: true },
      }),
    );
    expect(singular.tailFooter).toBe("1 more match in history");

    const notTruncated = buildSearchResultsModel(
      baseInput({
        tail: { kind: "ok", hits: [], total: 0, truncated: false, scanned: 100, complete: true },
      }),
    );
    expect(notTruncated.tailFooter).toBeUndefined();

    const invalidPattern = buildSearchResultsModel(
      baseInput({ tail: { kind: "invalidPattern", message: "bad regex" } }),
    );
    expect(invalidPattern.tailFooter).toBeUndefined();

    const noTailYet = buildSearchResultsModel(baseInput({ tail: undefined }));
    expect(noTailYet.tailFooter).toBeUndefined();
  });
});
