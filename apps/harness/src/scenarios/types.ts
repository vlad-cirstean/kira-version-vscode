import type {
  CommitRecord,
  CommitSignature,
  CommitTrailer,
  DiffHunk,
  FileChange,
  FileDiffBody,
} from "@kira-version/core";
import type { GitStatus, RepoCandidate, RepoOpenResult } from "@kira-version/ipc";

/**
 * A named, deep-linkable state the harness can render (`?scenario=<name>`). P3 W14 grows this
 * from P0's flat `{repoId, toplevel, gitDir, isBare, commitCount}` shape into real,
 * contract-shaped data `mockBridge.ts` can serve without inventing anything at request time.
 */

/**
 * `commit.detail`'s fixture for one `(sha, parentIndex)` pair (P5 W12) — everything `CommitDetail`
 * carries beyond what a plain `CommitRecord` (`Scenario.commits`) already states, since
 * sha/parents/author/committer/subject/decoration never change across a merge's parent selector
 * but `body`/`trailers`/`signature`/`files` in principle could (git re-derives them against
 * whichever parent `--first-parent`-style tools like this one diff against).
 */
export interface CommitDetailFixture {
  readonly body: string;
  readonly trailers: readonly CommitTrailer[];
  readonly signature: CommitSignature;
  readonly files: readonly FileChange[];
}

export interface Scenario {
  readonly name: string;
  /** `app.init`'s own git status for this scenario — independent of `repoOpen`'s: a host can
   *  have a working git and still fail to open one particular repo, or (this file's
   *  `authFailure`) have no working git at all, in which case both fields carry the same
   *  status. */
  readonly git: GitStatus;
  /** What `repo.open` returns, regardless of the `path` the UI actually passes — the mock
   *  bridge has exactly one repo per scenario, so there is nothing to branch on. */
  readonly repoOpen: RepoOpenResult;
  /** Newest-first, exactly as `git log` and `CommitStore.append`/`appendPage` both expect.
   *  Empty for a scenario whose `repoOpen` never succeeds. */
  readonly commits: readonly CommitRecord[];
  /** `repo.list`'s answer for this scenario (P4 W13) — absent (equivalent to `[]`) for every
   *  scenario that does not care about the repo picker's candidate list. Real git-repo discovery
   *  is not modelled; a scenario simply states the candidates it wants `RepoPicker.vue` to show,
   *  independent of `repoOpen`'s own "ignores `path`, one repo per scenario" behaviour (its own
   *  doc comment) — clicking a candidate here still opens *this* scenario's one repo, which is
   *  enough to exercise the picker's own open/close/emit flow. */
  readonly candidates?: readonly RepoCandidate[];
  /** Per-sha detail, served by `commit.detail` — keyed by sha, then indexed by `parentIndex`
   *  (P5 W12). A commit not present here (or missing the requested `parentIndex`) is a fixture
   *  bug, not a real "no detail" outcome — `mockBridge.ts` throws rather than inventing one, the
   *  same convention `requireSession` already uses for an unopened repo. */
  readonly details?: Readonly<Record<string, readonly CommitDetailFixture[]>>;
  /** Per-`(sha, path)` diff bodies served by `commit.fileDiff`, keyed by `./diffKey.ts`'s
   *  `diffKey(sha, path)`. Doubles as `editor.goToFile`'s "does this blob exist at `<rev>`"
   *  signal (`mockBridge.ts`'s `blobExistsAtRev`) — deliberately independent of whether the path
   *  also appears in `details`, so a scenario can list a path as "touched" for the file tree while
   *  still fixturing its blob as unresolvable. */
  readonly diffs?: Readonly<Record<string, FileDiffBody>>;
  /** D14a's one question, modelled: which paths exist in "the checkout" (`fs.existsSync`'s
   *  stand-in, per `mockBridge.ts`'s own `editor.goToFile`). */
  readonly checkoutPaths?: readonly string[];
  /**
   * The drift between `<rev>` and "the working tree", per `./diffKey.ts`'s `diffKey(rev, path)`:
   * the hunks the real host would get from `worktreeDiff`. A key absent here means no drift — the
   * re-map is skipped and the historical line is used, exactly as `worktreeDiff` returning `null`
   * does on the real host.
   */
  readonly worktreeDrift?: Readonly<Record<string, readonly DiffHunk[]>>;
  /** Which capabilities this scenario's "host" reports on `app.init` — `undefined` means all
   *  true, the harness's default posture. */
  readonly capabilities?: {
    readonly openInEditor: boolean;
    readonly goToFile: boolean;
    readonly clipboard: boolean;
  };
}
