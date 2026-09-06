/**
 * P8's remote-op vocabulary. `PullStrategy`/`PullStrategySource`/`RemoteOpKind`/`RefUpdate` are
 * structural copies of `@kira-version/ipc`'s own (B3 — `core` and `ipc` both depend on nothing,
 * per §3.1, so neither imports the other); `tests/unit/ipc/wireConformance.test.ts` is what
 * keeps the two in step, the same discipline `HeadState`/`DecorationRef` already follow.
 */

export type PullStrategy = "ff-only" | "merge" | "rebase";

/** Where a resolved pull strategy came from, so the UI can say so before running it (§7.3). */
export type PullStrategySource =
  | "explicit" // the user picked it for this invocation
  | "setting" // kiraVersion.pull.strategy
  | "branchConfig" // branch.<name>.rebase
  | "pullConfig" // pull.rebase / pull.ff
  | "default"; // kira-version's own ff-only fallback

/** Which remote operation `remote.run` is being asked to perform. One key, five kinds — see
 *  `docs/plans/P8.md`'s D51 for why this is not a fifth arm of `op.run`'s union. */
export type RemoteOpKind = "fetch" | "push" | "pull" | "forcePush" | "deleteRemoteBranch";

/** One ref an operation moved, for the UI's "what happened" summary. */
export interface RefUpdate {
  readonly ref: string;
  readonly from: string | null; // null = created
  readonly to: string | null; // null = deleted
  readonly forced: boolean;
}
