import { describe, expect, test } from "bun:test";
import type { CommitFields, MatchableRef } from "./matcher.ts";
import { matchCommitFields, matchRef } from "./matcher.ts";
import type { CompiledQuery, SearchQuery } from "./query.ts";
import { compileQuery } from "./query.ts";

/**
 * `docs/plans/P11.md` W16 — exit criterion 1: the semantics table, driven as data rather than
 * prose, over the one matcher every half of search shares (`compileQuery` + `matchCommitFields` +
 * `matchRef`). Table numbers below (row 1, row 2, …) are the plan's own numbering, so a failure
 * here points straight back at the row it broke.
 */

function query(partial: Partial<SearchQuery>): SearchQuery {
  return {
    text: "",
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    scope: "commits",
    ...partial,
  };
}

/** Compiles and asserts `kind === "ok"` in one step — every row below expects a valid query. */
function compileOk(partial: Partial<SearchQuery>): Extract<CompiledQuery, { kind: "ok" }> {
  const compiled = compileQuery(query(partial));
  if (compiled.kind !== "ok") throw new Error(`expected an ok query, got ${compiled.kind}`);
  return compiled;
}

function fields(partial: Partial<CommitFields> & { readonly sha: string }): CommitFields {
  return {
    subject: "",
    body: "",
    authorName: "Kira Fixture",
    authorEmail: "fixture@kira-version.test",
    committerName: "Kira Fixture",
    committerEmail: "fixture@kira-version.test",
    ...partial,
  };
}

// Rows 1-7's shared fixture: one subject each, chosen so case, whole-word and regex each have a
// real discriminating case rather than a contrived one (mirrors `searchable()`'s own choices,
// `tests/fixtures/generateRepo.ts`, W15).
const WIDGET_CACHE = fields({ sha: "a".repeat(40), subject: "Fix the widget cache" });
const ADD_WIDGETS = fields({ sha: "b".repeat(40), subject: "add WIDGETS to the list" });
const SUBWIDGETARY = fields({ sha: "c".repeat(40), subject: "subwidgetary refactor noted" });
const UNRELATED = fields({ sha: "d".repeat(40), subject: "unrelated change to build config" });
const HASH_123 = fields({ sha: "e".repeat(40), subject: "fix (#123) parsing bug" });

interface ToggleRow {
  readonly row: number;
  readonly toggles: Partial<SearchQuery>;
  readonly text: string;
  readonly matches: readonly CommitFields[];
  readonly notMatches: readonly CommitFields[];
}

const TOGGLE_ROWS: readonly ToggleRow[] = [
  {
    row: 1,
    toggles: {},
    text: "widget",
    matches: [WIDGET_CACHE, ADD_WIDGETS, SUBWIDGETARY],
    notMatches: [UNRELATED],
  },
  {
    row: 2,
    toggles: { caseSensitive: true },
    text: "widget",
    matches: [WIDGET_CACHE, SUBWIDGETARY],
    notMatches: [ADD_WIDGETS],
  },
  {
    row: 3,
    toggles: { wholeWord: true },
    text: "widget",
    matches: [WIDGET_CACHE],
    notMatches: [SUBWIDGETARY, ADD_WIDGETS],
  },
  {
    row: 4,
    toggles: { caseSensitive: true, wholeWord: true },
    text: "WIDGETS",
    matches: [ADD_WIDGETS],
    notMatches: [WIDGET_CACHE],
  },
  {
    row: 5,
    toggles: { regex: true },
    text: "wid(get|ening)",
    matches: [WIDGET_CACHE],
    notMatches: [UNRELATED],
  },
  {
    row: 6,
    toggles: { regex: true, caseSensitive: true },
    text: "WIDGET",
    matches: [ADD_WIDGETS],
    notMatches: [WIDGET_CACHE],
  },
  {
    row: 7,
    toggles: { regex: true, wholeWord: true },
    text: "widget",
    matches: [WIDGET_CACHE],
    notMatches: [SUBWIDGETARY],
  },
  {
    row: 9,
    toggles: { wholeWord: true },
    text: "#123",
    matches: [HASH_123],
    notMatches: [WIDGET_CACHE],
  },
];

describe("matchCommitFields — semantics table, rows 1-7 and 9 (toggle combinations)", () => {
  for (const { row, toggles, text, matches, notMatches } of TOGGLE_ROWS) {
    test(`row ${row}: ${JSON.stringify(toggles)} over "${text}"`, () => {
      const compiled = compileOk({ text, ...toggles });
      for (const commit of matches) {
        expect(matchCommitFields(commit, compiled).length).toBeGreaterThan(0);
      }
      for (const commit of notMatches) {
        expect(matchCommitFields(commit, compiled)).toEqual([]);
      }
    });
  }
});

test("row 8: an invalid regex compiles to {kind: 'invalid'} — nothing to match against", () => {
  const compiled = compileQuery(query({ text: "foo(", regex: true }));
  expect(compiled.kind).toBe("invalid");
});

test("row 10: an author-email query hits authorEmail, not a subject-only row", () => {
  const alice = fields({
    sha: "f".repeat(40),
    subject: "chore: bump deps",
    authorEmail: "alice@example.com",
  });
  const compiled = compileOk({ text: "alice@" });
  expect(matchCommitFields(alice, compiled)).toEqual(["authorEmail"]);
  expect(matchCommitFields(WIDGET_CACHE, compiled)).toEqual([]);
});

test("row 11: a body-only term hits only 'body' — the loaded-store scan can never produce this", () => {
  const bodyOnly = fields({
    sha: "1".repeat(40),
    subject: "routine maintenance",
    body: "Renames the internal Zebra module.",
  });
  const compiled = compileOk({ text: "Zebra" });
  expect(matchCommitFields(bodyOnly, compiled)).toEqual(["body"]);
});

test("row 12: a 6-hex-digit query hits the sha prefix", () => {
  const shaHit = fields({ sha: `218224${"a".repeat(34)}`, subject: "sha prefix commit" });
  const compiled = compileOk({ text: "218224" });
  expect(matchCommitFields(shaHit, compiled)).toEqual(["sha"]);
});

test(`row 13: below MIN_SHA_PREFIX (3 hex digits) matches nothing, even against a sha that starts with it`, () => {
  const shaHit = fields({ sha: `218224${"a".repeat(34)}`, subject: "sha prefix commit" });
  const compiled = compileOk({ text: "218" });
  expect(compiled.shaPrefix).toBeNull();
  expect(matchCommitFields(shaHit, compiled)).toEqual([]);
});

function ref(partial: Partial<MatchableRef> & { readonly shortName: string }): MatchableRef {
  return { annotation: undefined, ...partial };
}

describe("matchRef — semantics table, rows 14-15", () => {
  test("row 14: a branch and a tag sharing one name both hit refName — kind distinguishes them structurally", () => {
    const compiled = compileOk({ text: "v1.2" });
    const branch = ref({ shortName: "v1.2" });
    const tag = ref({ shortName: "v1.2" });
    // `matchRef` itself never sees `kind` (`MatchableRef` carries only `shortName`/`annotation`) —
    // the caller's own `RefRow.kind` is what makes the two hits distinguishable in the dropdown.
    expect(matchRef(branch, compiled)).toEqual(["refName"]);
    expect(matchRef(tag, compiled)).toEqual(["refName"]);
  });

  test("row 15: an annotation-body term hits the annotated tag, not a same-named lightweight tag", () => {
    const compiled = compileOk({ text: "widgetorium" });
    const annotated = ref({
      shortName: "v1.0.0",
      annotation: {
        tagger: "Kira Fixture <fixture@kira-version.test>",
        date: 1_700_000_000,
        subject: "Release 1.0.0",
        body: "Ships the new widgetorium assembly line.",
      },
    });
    // A lightweight tag has no annotation at all (probe 7) — never a borrowed commit subject.
    const lightweight = ref({ shortName: "v1.0.0-lw" });
    expect(matchRef(annotated, compiled)).toEqual(["tagAnnotation"]);
    expect(matchRef(lightweight, compiled)).toEqual([]);
  });

  test("an annotation subject match also hits tagAnnotation, not just the body", () => {
    const compiled = compileOk({ text: "Release 1.0.0" });
    const annotated = ref({
      shortName: "v1.0.0",
      annotation: {
        tagger: "Kira Fixture <fixture@kira-version.test>",
        date: 1_700_000_000,
        subject: "Release 1.0.0",
        body: "",
      },
    });
    expect(matchRef(annotated, compiled)).toEqual(["tagAnnotation"]);
  });
});

describe("matchRef — the pr seam (P12, unused)", () => {
  test("matchRef ignores an unused pr argument entirely — the seam stays inert for the whole phase", () => {
    const compiled = compileOk({ text: "no-such-term-anywhere" });
    const branch = ref({ shortName: "main" });
    expect(matchRef(branch, compiled, { number: 42, title: "does not matter" })).toEqual([]);
  });
});

describe("rows 16-17: scope is which function the caller invokes, not a matcher parameter", () => {
  test("row 16: 'commits' scope means matchRef is simply never called — refs cannot appear", () => {
    const compiled = compileOk({ text: "widget" });
    // Scope filtering lives in the caller (ui/state/search.ts, W10); at the matcher level,
    // "commits" scope is just: only matchCommitFields runs. Nothing here can produce a ref hit.
    const hits = [WIDGET_CACHE, ADD_WIDGETS, SUBWIDGETARY, UNRELATED]
      .map((commit) => ({ commit, fields: matchCommitFields(commit, compiled) }))
      .filter((r) => r.fields.length > 0);
    expect(hits.map((h) => h.commit.subject).sort()).toEqual(
      [WIDGET_CACHE, ADD_WIDGETS, SUBWIDGETARY].map((c) => c.subject).sort(),
    );
  });

  test("row 17: 'both' scope's refs-first ordering is the grouping fold's contract, not the matcher's — see searchResultsModel.test.ts", () => {
    // `matchCommitFields`/`matchRef` return unordered hit lists per row; grouping ("refs group
    // first, then commits") is `searchResultsModel.ts`'s own pure fold, asserted there. This test
    // only pins down the half that *is* the matcher's job: both a ref and a commit can match the
    // same query text independently, which is what gives the grouping fold two non-empty groups
    // to order in the first place.
    const compiled = compileOk({ text: "widget" });
    const branchHit = matchRef(ref({ shortName: "widget-fix" }), compiled);
    const commitHit = matchCommitFields(WIDGET_CACHE, compiled);
    expect(branchHit).toEqual(["refName"]);
    expect(commitHit).toEqual(["subject"]);
  });
});
