/**
 * P8's remote-op vocabulary. `PullStrategy`/`PullStrategySource`/`RemoteOpKind`/`RefUpdate`/
 * `RemoteOpRequest`/`RemoteOpResult` are structural copies of `@kira-version/ipc`'s own (B3 —
 * `core` and `ipc` both depend on nothing, per §3.1, so neither imports the other);
 * `tests/unit/ipc/wireConformance.test.ts` is what keeps the two in step, the same discipline
 * `HeadState`/`DecorationRef` already follow.
 */
import type { InProgressOperation, OpErrorKind } from "./operation.ts";
import type { HeadState } from "./repo.ts";

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

/**
 * `RepoService.runRemoteOp`'s request — the same "no `repoId` in here, the wire adds it
 * alongside" shape `OpRequest`/`op.run` already established (`model/operation.ts`'s own doc
 * comment). One shape for all five `RemoteOpKind`s (D51) rather than a discriminated union per
 * kind: unlike `OpRequest`'s members, which genuinely need different fields per kind, every
 * field below is meaningful (or simply unused and `undefined`) for every kind, so a union would
 * buy type-narrowing at every call site for no real safety this shape does not already have.
 */
export interface RemoteOpRequest {
  readonly kind: RemoteOpKind;
  readonly remote: string;
  /** Required for every kind except plain `fetch` (which can target `"--all"` with no single
   *  branch in play). */
  readonly branch: string | undefined;
  /** `push` only: create the upstream tracking relationship if the branch has none yet
   *  (`PushPreflight.wouldSetUpstream`). */
  readonly setUpstream: boolean;
  /** `fetch`/`pull`'s fetch phase only. */
  readonly prune: boolean;
  /** `fetch`/`pull`'s fetch phase only — off by default even when `prune` is on (D49, OQ2). */
  readonly pruneTags: boolean;
  /** `pull` only: an explicit override of `resolvePullStrategy`'s ladder for this one
   *  invocation (`PullStrategySource`'s `"explicit"`). `undefined` lets the ladder decide. */
  readonly strategy: PullStrategy | undefined;
  /** `forcePush` only: the `PushPreflight.remoteTip` the confirmation dialog showed the user,
   *  `null` when the dialog showed "nothing to overwrite". `RepoService.runRemoteOp` (W14)
   *  re-reads the remote-tracking ref immediately before spawning and compares — a mismatch
   *  fails with `LeaseViolation` before any push happens, even when git's own bare
   *  `--force-with-lease --force-if-includes` would not itself object (D48's residual-hazard
   *  mitigation: a background auto-fetch can silently satisfy git's own lease between dialog-open
   *  and spawn by updating the remote-tracking ref to the very value that collided, without the
   *  user — still looking at the dialog's now-stale `remoteTip` — ever finding out). `undefined`
   *  for every other kind. */
  readonly expectedRemoteTip: string | null | undefined;
  /** `forcePush` only: `true` selects plain `--force`; `false`/`undefined` selects the default
   *  lease-based `--force-with-lease --force-if-includes` (D48). §7.4 puts plain `--force` behind
   *  a second, harder-worded confirmation client-side — there is nothing further for this field's
   *  consumer to verify server-side beyond which argv it builds (unlike `confirmToken` below,
   *  that second confirmation has no typed value a server could re-check). `undefined` for every
   *  other kind. */
  readonly plainForce: boolean | undefined;
  /** `forcePush`/`deleteRemoteBranch` against a protected branch only: the typed branch name,
   *  checked server-side against `kiraVersion.protectedBranches` (D52) — never trusted from the
   *  UI alone. `undefined` for every other kind, and for an unprotected branch. */
  readonly confirmToken: string | undefined;
}

export interface RemoteOpResult {
  readonly ok: boolean;
  readonly error:
    | {
        readonly kind: OpErrorKind;
        readonly message: string;
        /** `HookRejected` only: the hook's own `remote: `-prefixed output, stripped of that
         *  prefix (`GitError.remoteMessage`, W11) — the only actionable content in an otherwise
         *  buried wall of git output (probe 4). `undefined` for every other kind, and for a
         *  `HookRejected` whose stderr happened to carry no `remote: ` lines at all. */
        readonly remoteMessage: string | undefined;
      }
    | undefined;
  /** Never `undo` (§7.12: fetch/push/force-push never offer one) — this is the field
   *  `RemoteOpResult` has instead of `OpResult.undo`, not an oversight of a missing one. */
  readonly updates: readonly RefUpdate[];
  readonly head: HeadState;
  readonly inProgress: InProgressOperation | null;
}
