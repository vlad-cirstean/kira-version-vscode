import { canRunOp, classifyReset } from "@kira-version/core";
import type {
  CheckoutPreflight,
  CherryPickPreflight,
  HeadState,
  InProgressOperation,
  OpErrorKind,
  OpRequest,
  OpResult,
  PullPreflight,
  PullStrategy,
  PullStrategySource,
  PushPreflight,
  RemoteOpKind,
  RemoteOpParams,
  RemoteOpResult,
  RemoteProgress,
  ResetMode,
  ResetPreflight,
  RevertPreflight,
  StashBranchPreflight,
  StashEntry,
  StashPopPreflight,
  StatusSummary,
  UndoSlotSnapshot,
} from "@kira-version/ipc";
import { type ShallowRef, shallowRef } from "vue";
import type { BridgeClient } from "../bridge/client.ts";
import {
  composeCheckoutAnnouncement,
  composeCherryPickAnnouncement,
  composeCherryPickMismatchAnnouncement,
  type CherryPickPredictionMismatch,
  composeOpFailureAnnouncement,
  composeResetAnnouncement,
  composeRevertAnnouncement,
  composeStashAnnouncement,
  composeStashPushAnnouncement,
  composeUndoAnnouncement,
  type StashPredictionMismatch,
} from "./liveAnnouncements.ts";
import type { RefsState } from "./refs.ts";

export type { StashPredictionMismatch } from "./liveAnnouncements.ts";

/** `StashPopPreflight.prediction`'s own inline shape, named here since `@kira-version/ipc` has no
 *  standalone export for it (it is a structural copy of core's `MergeOutcomePrediction`, inlined
 *  at each of its two call sites rather than given its own top-level name — §7.10/§7.6 both do
 *  this). */
type StashPrediction = StashPopPreflight["prediction"];

/** `StashDialog.vue`'s own pending state for the shared apply/pop confirmation (OQ7: one dialog,
 *  the verb and one sentence differing) — opened only when `preflight.stashPop`'s verdict is not
 *  `"clean"` (mirrors `RevertDialog`'s own threshold). There is no route data beyond
 *  proceed/cancel: `restoreIndex` is chosen by the caller before the preflight round trip even
 *  starts (`runStashApply`/`runStashPop`'s own parameter), since it is a user preference the
 *  merge-tree prediction never depends on, not a hazard the dialog discovers. */
export interface PendingStashPop {
  readonly verb: "apply" | "pop";
  readonly preflight: StashPopPreflight;
}

/** The common subset of `OpResult` and `RemoteOpResult` the `stashAndCarry` route (§7.5/§7.3,
 *  OQ10) actually reads — `checkout` and `pull` return different result shapes (`undo` vs.
 *  `updates`), but both carry exactly this much, which is all `#stashAndCarry` needs from
 *  whichever one its caller ran. */
interface CarryMiddleResult {
  readonly ok: boolean;
  readonly error: { readonly kind: OpErrorKind; readonly message: string } | undefined;
  readonly head: HeadState;
  readonly inProgress: InProgressOperation | null;
}

/** The route a confirmed `ForcePushDialog.vue` takes. `plain: true` selects §7.4's second,
 *  differently-worded confirmation (plain `--force`); `plain: false` is the default
 *  `--force-with-lease --force-if-includes` path (D48). `confirmToken` is the typed branch name,
 *  present only when `PushPreflight.protectedBy` was non-null — re-verified host-side (D52), so a
 *  wrong value here surfaces as an ordinary `ProtectedBranch` failure, not a client-side check. */
export interface ForcePushRoute {
  readonly plain: boolean;
  readonly confirmToken: string | undefined;
}

/** `ForcePushDialog.vue`'s own pending state: the preflight it renders from, plus which remote
 *  and branch it was opened for (both already known by the caller, but the dialog needs them
 *  again to build the eventual `RemoteOpParams`). */
export interface PendingForcePush {
  readonly remote: string;
  readonly branch: string;
  readonly preflight: PushPreflight;
}

/** The resolved pull strategy and its provenance, shown by the toolbar's pull-strategy picker
 *  before (and after) a pull runs (§7.3: "must not discover [a rebase] by watching their history
 *  get rewritten"). Set the moment it is known — from a preflight round trip, or immediately for
 *  an explicit override the user already picked — and left in place once the op finishes so it
 *  stays visible as a record of what just ran. */
export interface PullStrategyInfo {
  readonly strategy: PullStrategy;
  readonly source: PullStrategySource;
}

/** The route a confirmed `blockedByTracked` checkout takes: discard the local changes and
 *  proceed, or (P9, when `preflight.routes` lists it) push them to a stash first and pop them
 *  back afterward — §7.5's `stashAndCarry`. `runCheckout` only ever opens the dialog for
 *  `"blocked"` at all (§7.5: clean and cleanCarry proceed with no prompt). */
export type CheckoutRoute = { readonly kind: "discard" } | { readonly kind: "stashAndCarry" };

/** The route a confirmed revert takes: the chosen mainline (present only when the preflight's
 *  `mainlineRequired` was non-empty) and whether to stop short of committing. */
export interface RevertRoute {
  readonly mainline: number | undefined;
  readonly noCommit: boolean;
}

/** The route a confirmed `ResetDialog.vue` takes: `mode` is the radio the dialog settled on
 *  (`runReset`'s own `mode` argument is only the *initial* pre-flight's mode — OQ1's mixed
 *  default — the dialog may change it client-side via `previewResetMode`, never a second round
 *  trip, per OQ11). `stashFirst` selects §7.7's "stash first" route (judgment call 5: stash-
 *  then-stop, never P9's stash-and-carry); `token` is the typed short sha, present only when the
 *  chosen mode is destructive and `stashFirst` was not taken (judgment call 19 — requiring both
 *  would be theatre once the work is preserved). */
export interface ResetRoute {
  readonly mode: ResetMode;
  readonly stashFirst: boolean;
  readonly token: string | undefined;
}

/** The route a confirmed `CherryPickDialog.vue` takes — the direct structural sibling of
 *  `RevertRoute`. */
export interface CherryPickRoute {
  readonly mainline: number | undefined;
  readonly noCommit: boolean;
}

/**
 * `docs/plans/P6.md` W12: one exported method per user-facing action, each the same four steps —
 * pre-flight, confirm (only when the pre-flight found a hazard), run, refresh/announce/surface —
 * so no component ever writes them out of order or calls `bridge.request("op.run", …)` itself.
 *
 * The **confirm** step for `checkout`/`revert` is mediated entirely inside this class: a hazard
 * pre-flight sets `pendingCheckout`/`pendingRevert`, a dialog component watches that ref and
 * renders itself, and calling `resolveCheckoutDialog`/`resolveRevertDialog` (Cancel passes
 * `null`) settles the promise `runCheckout`/`runRevert` is awaiting. Every other action
 * (`branchCreate`, `tagDelete`, …) has no pre-flight endpoint of its own — the dialog that
 * collects its input (`TagDialog.vue`, a context-menu confirmation) *is* the confirm step, and
 * has already run by the time it calls one of this class's methods.
 *
 * **The gate.** `canRun(opKind)` is `core`'s own pure `canRunOp` over this class's own
 * `statusSummary.inProgress` — never a component's `v-if` chain (W12's own "Done when"). **The
 * busy flag.** One in-flight operation at a time; every method below is a no-op while `busy` is
 * true, on top of the driver's own serialization (P1) — belt and braces, matching W12's own
 * wording for step 4's synchronous head/inProgress apply.
 */
export class OpsState {
  readonly busy: ShallowRef<boolean> = shallowRef(false);
  readonly statusSummary: ShallowRef<StatusSummary | undefined> = shallowRef(undefined);
  readonly undoSlot: ShallowRef<UndoSlotSnapshot | null> = shallowRef(null);
  /** Set after every action, success or failure — `App.vue` forwards it to the one live region,
   *  the same way it already does for `DetailState.announcement` (P5 W11). */
  readonly announcement: ShallowRef<string> = shallowRef("");

  readonly pendingCheckout: ShallowRef<CheckoutPreflight | undefined> = shallowRef(undefined);
  readonly pendingRevert: ShallowRef<RevertPreflight | undefined> = shallowRef(undefined);
  /** `docs/plans/P10.md` W10: `ResetDialog.vue`'s own pending state — unlike `pendingRevert`,
   *  opened for EVERY reset, not only a hazardous one (judgment call 18's single entry point IS
   *  the mode picker, so there is no "clean, skip the dialog" fast path to mirror here). */
  readonly pendingReset: ShallowRef<ResetPreflight | undefined> = shallowRef(undefined);
  /** `CherryPickDialog.vue`'s own pending state — a near-sibling of `pendingRevert`: opened only
   *  when the pre-flight found something worth a dialog (a blocker, a mainline choice, or the
   *  non-blocking `alreadyApplied` advisory — `runCherryPick`'s own trigger condition). */
  readonly pendingCherryPick: ShallowRef<CherryPickPreflight | undefined> = shallowRef(undefined);
  /** P9 W13: the shared apply/pop confirmation's own pending state — see `PendingStashPop`'s own
   *  doc comment on why one field, not two, covers both verbs (OQ7). */
  readonly pendingStashPop: ShallowRef<PendingStashPop | undefined> = shallowRef(undefined);

  // -------------------------------------------------------------------------------------
  // P8 W17: remote ops. Deliberately a sibling to the four steps above, not folded into
  // `#runSimple` — `docs/plans/P8.md`'s own W17 doc comment: cancellation and progress are
  // genuinely different concerns, and merging them would make the local path pay for the
  // remote path's complexity. `#applyRemoteResult` below (not `#applyResult`) is the other half
  // of that split: `RemoteOpResult` carries no `undo` field at all, by construction (D51, OQ6 —
  // no remote operation ever touches the undo slot in either direction).
  // -------------------------------------------------------------------------------------

  /** Which `RemoteOpKind` is currently running against this repo, or `undefined` — the toolbar's
   *  progress affordance and its cancel button both key off this, not `busy` (which is also true
   *  for local ops the toolbar renders no progress bar for). */
  readonly activeRemoteOp: ShallowRef<RemoteOpKind | undefined> = shallowRef(undefined);
  /** Latest throttled `remote.progress` for the op named by `activeRemoteOp` — `undefined` before
   *  the first chunk arrives (a trivially small fetch/push may emit none at all; the toolbar must
   *  not read that as a stall, matching probe 6). Cleared when the op finishes. */
  readonly remoteProgress: ShallowRef<RemoteProgress | undefined> = shallowRef(undefined);
  readonly pendingForcePush: ShallowRef<PendingForcePush | undefined> = shallowRef(undefined);
  /** Set the moment a strategy is known (preflight response, or an explicit override) and left
   *  in place after the pull finishes — see `PullStrategyInfo`'s own doc comment. */
  readonly pullStrategy: ShallowRef<PullStrategyInfo | undefined> = shallowRef(undefined);
  /** P9/OQ10: `runPull`'s own confirm step for a `dirtyNonFastForward` blocker — mirrors
   *  `pendingCheckout`'s shape one field simpler, since `PullPreflight.routes` only ever offers
   *  `"stashAndCarry"` (its own doc comment): `resolvePullDialog`'s `boolean` says only whether
   *  to take that one route, there being no second one (no pull analogue of "discard"). */
  readonly pendingPull: ShallowRef<PullPreflight | undefined> = shallowRef(undefined);

  readonly #bridge: BridgeClient;
  readonly #refs: RefsState;
  #repoId: string | undefined;
  #resolveCheckout: ((route: CheckoutRoute | null) => void) | undefined;
  #resolveRevert: ((route: RevertRoute | null) => void) | undefined;
  #resolveReset: ((route: ResetRoute | null) => void) | undefined;
  #resolveCherryPick: ((route: CherryPickRoute | null) => void) | undefined;
  #resolveForcePush: ((route: ForcePushRoute | null) => void) | undefined;
  #resolveStashPop: ((proceed: boolean) => void) | undefined;
  #resolvePull: ((proceed: boolean) => void) | undefined;
  readonly #unsubscribe: () => void;
  readonly #unsubscribeProgress: () => void;

  constructor(bridge: BridgeClient, refs: RefsState) {
    this.#bridge = bridge;
    this.#refs = refs;
    // Any change at all (a ref write OR a worktree/index touch) can move `inProgress`,
    // `dirtyPaths` or the upstream ahead/behind counts — unlike `RefsState`, which only cares
    // about `refsChanged`, this refreshes on both event kinds.
    this.#unsubscribe = bridge.on("repo.changed", (event) => {
      if (this.#repoId !== event.repoId) return;
      void this.refreshStatus();
    });
    this.#unsubscribeProgress = bridge.on("remote.progress", (event) => {
      if (this.#repoId !== event.repoId) return;
      this.remoteProgress.value = event;
    });
  }

  setRepoId(repoId: string | undefined): void {
    this.#repoId = repoId;
    this.activeRemoteOp.value = undefined;
    this.remoteProgress.value = undefined;
    this.pullStrategy.value = undefined;
    if (repoId === undefined) {
      this.statusSummary.value = undefined;
      this.undoSlot.value = null;
      return;
    }
    void this.refreshStatus();
    void this.refreshUndo();
  }

  /** Pure predicate over `(inProgress, opKind)` (§7.11) — the gate every dialog and menu entry's
   *  disabled state reads, never a component-local re-derivation. */
  canRun(kind: OpRequest["kind"]): boolean {
    return canRunOp(this.statusSummary.value?.inProgress ?? null, kind);
  }

  async refreshStatus(): Promise<void> {
    const repoId = this.#repoId;
    if (repoId === undefined) return;
    const result = await this.#bridge.request("status.get", { repoId });
    if (this.#repoId !== repoId) return;
    this.statusSummary.value = result;
  }

  async refreshUndo(): Promise<void> {
    const repoId = this.#repoId;
    if (repoId === undefined) return;
    const { slot } = await this.#bridge.request("undo.peek", { repoId });
    if (this.#repoId !== repoId) return;
    this.undoSlot.value = slot;
  }

  /** `docs/plans/P7.md` W14: "Review branch changes", from either menu `buildRefMenu` puts it on
   *  (`BranchPicker.vue`'s own row menu, and `App.vue`'s ref-badge menu). This is a read, not an
   *  operation — no pre-flight, no hazard, no `canRunOp` gate, no `op.run` envelope, so it does
   *  not go through `#runSimple` below; it is the one method on this class that is really just a
   *  named `bridge.request` (§6.8's `review.open` reveals the sidebar view and either seeds a
   *  cold resolve or pushes `review.target` to an already-open one, host-side — this class does
   *  not wait on, or need to know, which). */
  async openReview(branch: string): Promise<void> {
    const repoId = this.#repoId;
    if (repoId === undefined) return;
    await this.#bridge.request("review.open", { repoId, branch });
  }

  // -------------------------------------------------------------------------------------
  // checkout
  // -------------------------------------------------------------------------------------

  async runCheckout(target: string, mode: "switch" | "detach"): Promise<void> {
    const repoId = this.#repoId;
    if (repoId === undefined || this.busy.value) return;
    this.busy.value = true;
    try {
      const preflight = await this.#bridge.request("preflight.checkout", { repoId, target, mode });
      let discardLocalChanges = false;
      if (preflight.verdict === "blocked") {
        const route = await this.#confirmCheckout(preflight);
        if (route === null) {
          this.announcement.value = "Checkout cancelled.";
          return;
        }
        if (route.kind === "stashAndCarry") {
          // §7.5's `stashAndCarry` route (P9) — `discardLocalChanges: false` for the checkout
          // half below; the stash push `#stashAndCarry` runs first is what actually clears the
          // tree. Handled inline (not via a public `runCheckoutStashAndCarry`) so it shares this
          // call's own `busy` hold rather than needing a second one of its own.
          await this.#stashAndCarry(
            () =>
              this.#bridge.request("op.run", {
                repoId,
                op: { kind: "checkout", target, mode, discardLocalChanges: false },
              }),
            "Checkout",
            () => `Checked out ${target}${mode === "detach" ? " (detached)" : ""}`,
          );
          return;
        }
        discardLocalChanges = true;
      }
      const result = await this.#bridge.request("op.run", {
        repoId,
        op: { kind: "checkout", target, mode, discardLocalChanges },
      });
      this.#applyResult(result);
      this.announcement.value = result.ok
        ? composeCheckoutAnnouncement(preflight, target)
        : composeOpFailureAnnouncement("Checkout", result.error);
    } finally {
      this.busy.value = false;
    }
  }

  #confirmCheckout(preflight: CheckoutPreflight): Promise<CheckoutRoute | null> {
    this.pendingCheckout.value = preflight;
    return new Promise((resolve) => {
      this.#resolveCheckout = resolve;
    });
  }

  /** `CheckoutDialog.vue`'s own Discard/Cancel buttons call this — `null` for Cancel, matching
   *  `RevertDialog`'s own convention below. */
  resolveCheckoutDialog(route: CheckoutRoute | null): void {
    this.pendingCheckout.value = undefined;
    const resolve = this.#resolveCheckout;
    this.#resolveCheckout = undefined;
    resolve?.(route);
  }

  // -------------------------------------------------------------------------------------
  // revert
  // -------------------------------------------------------------------------------------

  async runRevert(shas: readonly string[]): Promise<void> {
    const repoId = this.#repoId;
    if (repoId === undefined || this.busy.value || shas.length === 0) return;
    this.busy.value = true;
    try {
      const preflight = await this.#bridge.request("preflight.revert", { repoId, shas });
      let mainline: number | undefined;
      let noCommit = false;
      if (preflight.verdict !== "clean" || preflight.mainlineRequired.length > 0) {
        const route = await this.#confirmRevert(preflight);
        if (route === null) {
          this.announcement.value = "Revert cancelled.";
          return;
        }
        mainline = route.mainline;
        noCommit = route.noCommit;
      }
      const result = await this.#bridge.request("op.run", {
        repoId,
        op: { kind: "revert", shas, mainline, noCommit },
      });
      this.#applyResult(result);
      this.announcement.value = result.ok
        ? composeRevertAnnouncement(shas, noCommit)
        : composeOpFailureAnnouncement("Revert", result.error);
    } finally {
      this.busy.value = false;
    }
  }

  #confirmRevert(preflight: RevertPreflight): Promise<RevertRoute | null> {
    this.pendingRevert.value = preflight;
    return new Promise((resolve) => {
      this.#resolveRevert = resolve;
    });
  }

  /** `RevertDialog.vue` calls this once a mainline is picked (`mainlineRequired.length > 0`) so
   *  the dialog's own prediction re-runs against the newly-known mainline before the user
   *  decides on `--no-commit` — the *same* pending promise stays open; only the displayed
   *  `pendingRevert` snapshot changes. */
  async previewRevertMainline(mainline: number): Promise<void> {
    const repoId = this.#repoId;
    const shas = this.pendingRevert.value?.shas;
    if (repoId === undefined || shas === undefined) return;
    const preflight = await this.#bridge.request("preflight.revert", { repoId, shas, mainline });
    if (this.pendingRevert.value !== undefined) this.pendingRevert.value = preflight;
  }

  resolveRevertDialog(route: RevertRoute | null): void {
    this.pendingRevert.value = undefined;
    const resolve = this.#resolveRevert;
    this.#resolveRevert = undefined;
    resolve?.(route);
  }

  // -------------------------------------------------------------------------------------
  // reset (`docs/plans/P10.md` W10, §7.7)
  // -------------------------------------------------------------------------------------

  /** `mode` is only the *initial* pre-flight's mode (OQ1's mixed default, chosen by
   *  `ResetDialog.vue`'s caller before this even runs) — the dialog itself may change it via
   *  `previewResetMode` with no second round trip (OQ11), and whatever it settles on travels back
   *  in `ResetRoute.mode`. The dialog opens for every reset, hazardous or not (judgment call 18):
   *  choosing a mode IS the confirm step here, unlike `runCheckout`/`runRevert`'s "skip the dialog
   *  when nothing is wrong" shape. A `blocked` verdict should never actually reach a user (the row
   *  menu's own `canRun("reset")` gate gets there first for an in-progress operation, and
   *  `unknownTarget` cannot happen for a sha taken from a real graph row) — handled defensively,
   *  with no dialog, rather than assumed unreachable. */
  async runReset(target: string, mode: ResetMode): Promise<void> {
    const repoId = this.#repoId;
    if (repoId === undefined || this.busy.value) return;
    this.busy.value = true;
    try {
      const preflight = await this.#bridge.request("preflight.reset", { repoId, target, mode });
      if (preflight.verdict === "blocked") {
        this.announcement.value = preflight.blockers.includes("inProgressOperation")
          ? "Reset failed — another operation is in progress."
          : `Reset failed — ${target} does not resolve to a commit.`;
        return;
      }
      const route = await this.#confirmReset(preflight);
      if (route === null) {
        this.announcement.value = "Reset cancelled.";
        return;
      }
      if (route.stashFirst) {
        const push = await this.#bridge.request("op.run", {
          repoId,
          op: {
            kind: "stashPush",
            message: undefined,
            includeUntracked: false,
            keepIndex: false,
            paths: [],
          },
        });
        this.#applyResult(push);
        if (!push.ok) {
          this.announcement.value = composeOpFailureAnnouncement("Stash", push.error);
          return;
        }
      }
      const result = await this.#bridge.request("op.run", {
        repoId,
        op: {
          kind: "reset",
          mode: route.mode,
          target,
          // Dropped when the stash-first route ran: the tree is clean by then, nothing is
          // destroyed, and the confirmation would be theatre (judgment call 19).
          confirmToken: route.stashFirst ? undefined : route.token,
        },
      });
      this.#applyResult(result);
      this.announcement.value = result.ok
        ? composeResetAnnouncement(route.mode, target)
        : composeOpFailureAnnouncement("Reset", result.error);
    } finally {
      this.busy.value = false;
    }
  }

  #confirmReset(preflight: ResetPreflight): Promise<ResetRoute | null> {
    this.pendingReset.value = preflight;
    return new Promise((resolve) => {
      this.#resolveReset = resolve;
    });
  }

  /** `ResetDialog.vue`'s own mode-radio recompute (OQ11): `destroys`/`requiresTypedConfirmation`/
   *  `routes`/`verdict` all depend only on `mode` and the ONE pre-flight's own `dirty` breakdown,
   *  already in hand — no round trip. Re-derived via `core`'s own `classifyReset`, never a hand-
   *  rolled duplicate, holding every other field fixed. `stagedNew: []` is not a loss of fidelity:
   *  a staged-but-new file is already counted in `dirty.staged` by construction
   *  (`repoService.ts`'s own `dirtySplitFrom`/`stagedNewPathsFrom` — the latter is a subset of the
   *  former), so the union `classifyReset` forms is identical either way. */
  previewResetMode(mode: ResetMode): void {
    const current = this.pendingReset.value;
    if (current === undefined) return;
    this.pendingReset.value = classifyReset({
      target: current.target,
      targetSubject: current.targetSubject,
      mode,
      currentHead: current.currentHead,
      branch: current.branch,
      leaving: current.leaving,
      gaining: current.gaining,
      leavingCommits: current.leavingCommits,
      leavingTruncated: current.leavingTruncated,
      dirty: current.dirty,
      stagedNew: [],
      inProgress: current.inProgress,
      targetResolves: !current.blockers.includes("unknownTarget"),
    });
  }

  /** `ResetDialog.vue`'s Reset/Stash first/Cancel buttons call this — `null` for Cancel, matching
   *  `resolveCheckoutDialog`/`resolveRevertDialog`'s own convention. */
  resolveResetDialog(route: ResetRoute | null): void {
    this.pendingReset.value = undefined;
    const resolve = this.#resolveReset;
    this.#resolveReset = undefined;
    resolve?.(route);
  }

  // -------------------------------------------------------------------------------------
  // cherry-pick (`docs/plans/P10.md` W10, §7.13)
  // -------------------------------------------------------------------------------------

  /** Mirrors `runRevert` exactly, including the "skip the dialog when there is nothing to show"
   *  shape — with one addition: the non-blocking `alreadyApplied` advisory (probe 6) also opens
   *  the dialog, since it is a fact §7.13 wants the user to actually read before proceeding, not
   *  one `classifyCherryPick` folds into `verdict`/`blockers` (it never blocks anything, judgment
   *  call 9's own "guessing is not honest" reasoning applied to the dialog's own trigger). */
  async runCherryPick(sha: string): Promise<void> {
    const repoId = this.#repoId;
    if (repoId === undefined || this.busy.value) return;
    this.busy.value = true;
    try {
      const preflight = await this.#bridge.request("preflight.cherryPick", { repoId, sha });
      let mainline: number | undefined;
      let noCommit = false;
      if (
        preflight.verdict !== "clean" ||
        preflight.mainlineRequired.length > 0 ||
        preflight.alreadyApplied
      ) {
        const route = await this.#confirmCherryPick(preflight);
        if (route === null) {
          this.announcement.value = "Cherry-pick cancelled.";
          return;
        }
        mainline = route.mainline;
        noCommit = route.noCommit;
      }
      const result = await this.#bridge.request("op.run", {
        repoId,
        op: { kind: "cherryPick", sha, mainline, noCommit },
      });
      this.#applyResult(result);
      const mismatch = this.#reconcileCherryPick(preflight.prediction, result);
      this.announcement.value = mismatch
        ? composeCherryPickMismatchAnnouncement(mismatch)
        : result.ok
          ? composeCherryPickAnnouncement(sha, noCommit)
          : composeOpFailureAnnouncement("Cherry-pick", result.error);
    } finally {
      this.busy.value = false;
    }
  }

  #confirmCherryPick(preflight: CherryPickPreflight): Promise<CherryPickRoute | null> {
    this.pendingCherryPick.value = preflight;
    return new Promise((resolve) => {
      this.#resolveCherryPick = resolve;
    });
  }

  /** `CherryPickDialog.vue` calls this once a mainline is picked, same shape as
   *  `previewRevertMainline` — the *same* pending promise stays open; only the displayed
   *  `pendingCherryPick` snapshot changes, re-predicted against the newly-known mainline before
   *  the user decides on `--no-commit`. */
  async previewCherryPickMainline(mainline: number): Promise<void> {
    const repoId = this.#repoId;
    const sha = this.pendingCherryPick.value?.sha;
    if (repoId === undefined || sha === undefined) return;
    const preflight = await this.#bridge.request("preflight.cherryPick", {
      repoId,
      sha,
      mainline,
    });
    if (this.pendingCherryPick.value !== undefined) this.pendingCherryPick.value = preflight;
  }

  resolveCherryPickDialog(route: CherryPickRoute | null): void {
    this.pendingCherryPick.value = undefined;
    const resolve = this.#resolveCherryPick;
    this.#resolveCherryPick = undefined;
    resolve?.(route);
  }

  /** Hard part 7/D57: `CherryPickPreflight.prediction` is exact about the merge alone, reconciled
   *  after the fact exactly like `#reconcileStashPop` — a disagreement is announced, never
   *  swallowed. `unknown` predictions are never compared against, for the same reason
   *  `#reconcileStashPop` never does: there is nothing to disagree WITH. No `stashKept` half
   *  exists here (`CherryPickPredictionMismatch`'s own doc comment) — a cherry-pick never touches
   *  the stash. */
  #reconcileCherryPick(
    predicted: CherryPickPreflight["prediction"],
    result: OpResult,
  ): CherryPickPredictionMismatch | null {
    if (predicted.kind === "unknown") return null;
    const actual: "clean" | "conflicts" | "refused" = result.ok
      ? "clean"
      : result.error?.kind === "Conflict"
        ? "conflicts"
        : "refused";
    if (actual === predicted.kind) return null;
    return { predicted: predicted.kind, actual };
  }

  // -------------------------------------------------------------------------------------
  // stash (`docs/plans/P9.md` W13, §7.6)
  // -------------------------------------------------------------------------------------

  /** `StashDialog.vue`'s create mode IS the confirm step (no pre-flight endpoint exists for
   *  `stashPush` — there is nothing to classify before the fact), so this runs directly. The one
   *  thing it still cannot take on faith is git's own `No local changes to save` no-op (probe
   *  10): that spawn exits 0 with no error, so a stash-count comparison before/after is the only
   *  way to tell "stashed" from "there was nothing to stash" apart — reporting the latter as a
   *  plain success would be exactly the silent-no-op failure mode §6.4 already named. */
  async runStashPush(input: {
    readonly message: string | undefined;
    readonly includeUntracked: boolean;
    readonly keepIndex: boolean;
    readonly paths: readonly string[];
  }): Promise<OpResult> {
    const repoId = this.#repoId;
    if (repoId === undefined) throw new Error("ops: no repo open");
    if (this.busy.value) throw new Error("ops: another operation is already running");
    this.busy.value = true;
    try {
      const before = await this.#bridge.request("stash.list", { repoId });
      const result = await this.#bridge.request("op.run", {
        repoId,
        op: { kind: "stashPush", ...input },
      });
      this.#applyResult(result);
      let pushed = true;
      if (result.ok) {
        const after = await this.#bridge.request("stash.list", { repoId });
        pushed = after.entries.length > before.entries.length;
      }
      this.announcement.value = result.ok
        ? composeStashPushAnnouncement(pushed)
        : composeOpFailureAnnouncement("Stash", result.error);
      return result;
    } finally {
      this.busy.value = false;
    }
  }

  /** `apply` — the stash survives regardless of outcome (probe 8: it accepts a raw sha, so this
   *  needs no `stash@{index}` addressing or position re-verification at all). `restoreIndex` is a
   *  plain caller preference (`StashList.vue`'s own row-menu choice), never discovered by the
   *  pre-flight — the merge-tree prediction covers the worktree half only (§7.6). */
  async runStashApply(entry: StashEntry, restoreIndex = false): Promise<OpResult | undefined> {
    return this.#runStashPopLike("apply", entry, restoreIndex);
  }

  /** `pop` — REFUSES a raw sha (probe 8), so the executed op addresses `stash@{index}`; the
   *  service re-verifies that position immediately before writing and the write removes the
   *  entry on success. */
  async runStashPop(entry: StashEntry, restoreIndex = false): Promise<OpResult | undefined> {
    return this.#runStashPopLike("pop", entry, restoreIndex);
  }

  async #runStashPopLike(
    verb: "apply" | "pop",
    entry: StashEntry,
    restoreIndex: boolean,
  ): Promise<OpResult | undefined> {
    const repoId = this.#repoId;
    if (repoId === undefined || this.busy.value) return undefined;
    this.busy.value = true;
    try {
      const preflight = await this.#bridge.request("preflight.stashPop", {
        repoId,
        sha: entry.sha,
        index: entry.index,
      });
      if (preflight.verdict !== "clean") {
        const proceed = await this.#confirmStashPop(verb, preflight);
        if (!proceed) {
          this.announcement.value = `Stash ${verb} cancelled.`;
          return undefined;
        }
      }
      const op: OpRequest =
        verb === "apply"
          ? { kind: "stashApply", sha: entry.sha, restoreIndex }
          : { kind: "stashPop", sha: entry.sha, index: entry.index, restoreIndex };
      const result = await this.#bridge.request("op.run", { repoId, op });
      this.#applyResult(result);
      const mismatch = this.#reconcileStashPop(verb, preflight.prediction, result);
      this.announcement.value = composeStashAnnouncement(verb, entry, result, mismatch);
      return result;
    } finally {
      this.busy.value = false;
    }
  }

  #confirmStashPop(verb: "apply" | "pop", preflight: StashPopPreflight): Promise<boolean> {
    this.pendingStashPop.value = { verb, preflight };
    return new Promise((resolve) => {
      this.#resolveStashPop = resolve;
    });
  }

  /** `StashDialog.vue`'s shared apply/pop confirmation calls this — `false` for Cancel, matching
   *  `resolveCheckoutDialog`/`resolveRevertDialog`'s own `null`-for-cancel convention as closely
   *  as a boolean route can (there is no route data to withhold on cancel here, per
   *  `PendingStashPop`'s own doc comment). */
  resolveStashPopDialog(proceed: boolean): void {
    this.pendingStashPop.value = undefined;
    const resolve = this.#resolveStashPop;
    this.#resolveStashPop = undefined;
    resolve?.(proceed);
  }

  /** §7.6's concrete answer to hard part 1 (D... `docs/plans/P9.md`'s own worked example): only
   *  ever non-null when reality disagreed with the prediction the user was shown. `unknown`
   *  predictions are never compared against — there is nothing to disagree WITH when pre-flight
   *  itself could not predict. `actual` is read from `result.ok`/`result.error.kind` — `runOp`'s
   *  own read-back already turns a real conflicting pop into `StashConflict` (never a thrown
   *  error), so no second git read is needed here. Every non-clean outcome keeps the stash
   *  (probes 3-5); a genuinely clean `pop` is the one outcome that does not, `apply` never drops
   *  it either way. */
  #reconcileStashPop(
    verb: "apply" | "pop",
    predicted: StashPrediction,
    result: OpResult,
  ): StashPredictionMismatch | null {
    if (predicted.kind === "unknown") return null;
    const actual: "clean" | "conflicts" | "refused" = result.ok
      ? "clean"
      : result.error?.kind === "StashConflict"
        ? "conflicts"
        : "refused";
    if (actual === predicted.kind) return null;
    const stashKept = verb === "apply" || actual !== "clean";
    return { predicted: predicted.kind, actual, stashKept };
  }

  /** OQ8: §7.12 gives the undo slot no stash-specific exception — the very next operation clears
   *  it exactly like any other undoable op — so the one honest thing to promise here is the bound
   *  itself, not a guarantee. No pre-flight endpoint exists for `stashDrop` (`git stash drop`
   *  cannot fail in a way worth predicting), so — like `tagDelete`/`branchDelete` — this runs
   *  directly with no confirm dialog; the announcement below stands in as the "confirmation" OQ8
   *  asks for. */
  async runStashDrop(entry: StashEntry): Promise<OpResult> {
    return this.#runSimple(
      { kind: "stashDrop", sha: entry.sha, index: entry.index },
      (ok) =>
        ok
          ? `Dropped stash@{${entry.index}}: ${entry.message} — undo available until your next operation.`
          : undefined,
      "Drop stash",
    );
  }

  /** `StashDialog.vue`'s branch mode — the live preflight it re-renders as the user types a name,
   *  mirroring `previewRevertMainline`'s own read-only-round-trip shape. Not gated by `busy`: a
   *  read, like `previewPullStrategy`/`previewRevertMainline`, not an operation. */
  async previewStashBranch(
    entry: StashEntry,
    name: string,
  ): Promise<StashBranchPreflight | undefined> {
    const repoId = this.#repoId;
    if (repoId === undefined) return undefined;
    return this.#bridge.request("preflight.stashBranch", { repoId, sha: entry.sha, branch: name });
  }

  /** `stash branch` gets no pop prediction (probe 11: clean by construction) but IS non-atomic on
   *  a mid-way failure (OQ6) — `StashDialog.vue`'s own branch mode has already run the classifier
   *  via `previewStashBranch` and is the confirm step, so this runs directly like `branchCreate`. */
  async runStashBranch(entry: StashEntry, name: string): Promise<OpResult> {
    return this.#runSimple(
      { kind: "stashBranch", branch: name, sha: entry.sha, index: entry.index },
      (ok) => (ok ? `Created branch ${name} from stash@{${entry.index}}` : undefined),
      "Create branch from stash",
    );
  }

  /**
   * §7.5/§7.3's `stashAndCarry` route (OQ10: pull ships it in this same phase, W10) — shared
   * between `runCheckout`'s and `runPull`'s own inline calls below (each confirms via its own
   * dialog first, so there is no separate public `run*StashAndCarry` entry point), which differ
   * only in `runMiddle` (the blocked operation itself) and its own success wording.
   *
   * **Push, then run, then pop only if predicted clean (OQ1).** The middle op ALWAYS runs once
   * the stash push succeeds — carrying the user's changes across is the entire point of the
   * route, and a predicted-conflict pop is a reason to leave the stash for the user to resolve
   * by hand, never a reason to also withhold the checkout/pull they explicitly asked for. A
   * predicted conflict (or a blocker) therefore ends the route with the stash intentionally
   * still in the stack, not an error — the middle op's own success is what gets announced.
   *
   * **`targetSha` is omitted deliberately.** `preflight.stashPop`'s own contract documents this
   * field as the `stashAndCarry` route's way to predict against a target the walk has not
   * switched to yet — accurate for `checkout`, whose target is already a known revision before
   * the middle op runs. `pull` has no such revision to offer: its target is whatever the fetch
   * half of a single atomic `remote.run` resolves to, not something this class learns ahead of
   * running it. Predicting AFTER `runMiddle` (the default `targetSha` ⇒ current HEAD, which by
   * then already reflects whatever the middle op did) is correct for both — even for `checkout`,
   * it is the ACTUAL resulting tree rather than a hypothetical one — so both routes share this one
   * predict-after shape rather than checkout alone taking the more elaborate predict-before path
   * the field's doc comment names. This is a deliberate, documented deviation from that comment's
   * literal reading — see `docs/plans/P9.md`'s own Findings.
   */
  async #stashAndCarry(
    runMiddle: () => Promise<CarryMiddleResult>,
    actionLabel: string,
    announceMiddleOk: () => string,
  ): Promise<void> {
    const repoId = this.#repoId;
    if (repoId === undefined) return;
    const pushResult = await this.#bridge.request("op.run", {
      repoId,
      op: {
        kind: "stashPush",
        message: undefined,
        includeUntracked: false,
        keepIndex: false,
        paths: [],
      },
    });
    this.#applyResult(pushResult);
    if (!pushResult.ok) {
      this.announcement.value = composeOpFailureAnnouncement("Stash", pushResult.error);
      return;
    }

    const middle = await runMiddle();
    this.#refs.applyHead(middle.head);
    const current = this.statusSummary.value;
    if (current)
      this.statusSummary.value = { ...current, head: middle.head, inProgress: middle.inProgress };
    if (!middle.ok) {
      this.announcement.value = `${composeOpFailureAnnouncement(actionLabel, middle.error)} Your changes are stashed — see the stash list.`;
      return;
    }

    const { entries } = await this.#bridge.request("stash.list", { repoId });
    const top = entries[0];
    if (top === undefined) {
      // `stashPush` above was itself a no-op (probe 10) — the worktree really was clean, so
      // there is nothing left to carry back.
      this.announcement.value = announceMiddleOk();
      return;
    }

    const preflight = await this.#bridge.request("preflight.stashPop", {
      repoId,
      sha: top.sha,
      index: top.index,
    });
    if (preflight.verdict !== "clean") {
      this.announcement.value = `${announceMiddleOk()} — your stashed changes were kept (popping back would conflict); pop stash@{${top.index}} manually when ready.`;
      return;
    }

    const popResult = await this.#bridge.request("op.run", {
      repoId,
      op: { kind: "stashPop", sha: top.sha, index: top.index, restoreIndex: false },
    });
    this.#applyResult(popResult);
    const mismatch = this.#reconcileStashPop("pop", preflight.prediction, popResult);
    this.announcement.value = mismatch
      ? composeStashAnnouncement("pop", top, popResult, mismatch)
      : popResult.ok
        ? announceMiddleOk()
        : composeOpFailureAnnouncement("Stash pop", popResult.error);
  }

  // -------------------------------------------------------------------------------------
  // Branch/tag mutations and the in-progress op controls: none of these have a pre-flight
  // endpoint of their own (only checkout and revert do) — the dialog or menu confirmation that
  // collects their input has already run by the time one of these is called, so there is no
  // second "confirm" step here, only run → refresh/announce/surface.
  // -------------------------------------------------------------------------------------

  async branchCreate(req: {
    readonly name: string;
    readonly startPoint: string;
    readonly checkout: boolean;
    readonly track: string | undefined;
  }): Promise<OpResult> {
    return this.#runSimple(
      { kind: "branchCreate", ...req },
      (ok) => (ok ? `Created branch ${req.name}` : undefined),
      "Create branch",
    );
  }

  async branchDelete(name: string, force: boolean): Promise<OpResult> {
    return this.#runSimple(
      { kind: "branchDelete", name, force },
      (ok) => (ok ? `Deleted branch ${name}` : undefined),
      "Delete branch",
    );
  }

  async branchRename(from: string, to: string): Promise<OpResult> {
    return this.#runSimple(
      { kind: "branchRename", from, to },
      (ok) => (ok ? `Renamed branch ${from} to ${to}` : undefined),
      "Rename branch",
    );
  }

  async tagCreate(req: {
    readonly name: string;
    readonly target: string;
    readonly message: string | undefined;
    readonly force: boolean;
  }): Promise<OpResult> {
    return this.#runSimple(
      { kind: "tagCreate", ...req },
      (ok) => (ok ? `Created tag ${req.name}` : undefined),
      "Create tag",
    );
  }

  async tagDelete(name: string): Promise<OpResult> {
    return this.#runSimple(
      { kind: "tagDelete", name },
      (ok) => (ok ? `Deleted tag ${name}` : undefined),
      "Delete tag",
    );
  }

  async tagPush(remote: string, names: readonly string[] | "all"): Promise<OpResult> {
    return this.#runSimple(
      { kind: "tagPush", remote, names },
      (ok) =>
        ok ? `Pushed ${names === "all" ? "all tags" : names.join(", ")} to ${remote}` : undefined,
      "Push tag",
    );
  }

  async tagDeleteRemote(remote: string, name: string): Promise<OpResult> {
    return this.#runSimple(
      { kind: "tagDeleteRemote", remote, name },
      (ok) => (ok ? `Deleted tag ${name} on ${remote}` : undefined),
      "Delete remote tag",
    );
  }

  async continueOp(): Promise<OpResult> {
    return this.#runSimple(
      { kind: "opContinue" },
      (ok) => (ok ? "Continued" : undefined),
      "Continue",
    );
  }

  async abortOp(): Promise<OpResult> {
    return this.#runSimple({ kind: "opAbort" }, (ok) => (ok ? "Aborted" : undefined), "Abort");
  }

  /** §7.11's third sequencer verb (probe 6) — `ConflictBanner.vue`'s Skip button, rendered only
   *  when `inProgress.canSkip`. Joins `continueOp`/`abortOp` as a `#runSimple` one-liner: like
   *  them, the confirmation already happened (the banner itself), so there is no separate confirm
   *  step here either. */
  async skipOp(): Promise<OpResult> {
    return this.#runSimple({ kind: "opSkip" }, (ok) => (ok ? "Skipped" : undefined), "Skip");
  }

  async undo(): Promise<OpResult | undefined> {
    const repoId = this.#repoId;
    const slot = this.undoSlot.value;
    if (repoId === undefined || slot === null || this.busy.value) return undefined;
    this.busy.value = true;
    try {
      const result = await this.#bridge.request("undo.run", { repoId, id: slot.id });
      this.#applyResult(result);
      this.announcement.value = result.ok
        ? composeUndoAnnouncement(slot.label)
        : composeOpFailureAnnouncement("Undo", result.error);
      return result;
    } finally {
      this.busy.value = false;
    }
  }

  // -------------------------------------------------------------------------------------
  // remote ops (P8 W17)
  // -------------------------------------------------------------------------------------

  /** `PullStrategyPicker.vue`'s own read: what the ladder in §7.3 would resolve to *right now*,
   *  with no override — a read, not an operation (mirrors `openReview`'s own doc comment above),
   *  so the popover can show "follow your configuration (would run: rebase)" before the user
   *  commits to an override. */
  async previewPullStrategy(branch: string): Promise<PullPreflight | undefined> {
    const repoId = this.#repoId;
    if (repoId === undefined) return undefined;
    return this.#bridge.request("remote.pullPreflight", { repoId, branch });
  }

  /** §7.1: `--prune` on, `--prune-tags` off, both by default (D49 — an unpushed tag is user
   *  work and fetch offers no undo). Neither is exposed as a toolbar option at P8; a future
   *  phase can surface them without changing this method's shape. */
  async runFetch(remote: string): Promise<void> {
    await this.#runRemote(
      {
        kind: "fetch",
        remote,
        branch: undefined,
        setUpstream: false,
        prune: true,
        pruneTags: false,
        strategy: undefined,
        expectedRemoteTip: undefined,
        plainForce: undefined,
        confirmToken: undefined,
      },
      (result) => (result.ok ? `Fetched ${remote}` : undefined),
      "Fetch",
    );
  }

  /**
   * §7.3: the resolved strategy and its provenance are shown before the operation runs, not
   * after — `remote.pullPreflight` always runs first (P9: its `blockers`/`routes` are the only
   * way to learn about a dirty tree that would rewrite history, so this can no longer be
   * short-circuited the way a bare strategy resolution once was) and `pullStrategy` is set from
   * it before `remote.run` is ever called, so what the toolbar displays is exactly what is about
   * to run, not a guess. `explicitStrategy` overrides the *strategy* the preflight resolved (the
   * user's own choice is authoritative, ladder step 1, `source: "explicit"` by construction) but
   * not the dirty-tree check: `blockers` is evaluated against the ladder's own default-resolved
   * strategy regardless, since `remote.pullPreflight` has no way to ask "would this be blocked
   * under strategy X instead" — a known imprecision (see `docs/plans/P9.md`'s own Findings) that
   * only matters for the narrow case of an explicit override changing whether history would be
   * rewritten at all.
   *
   * §7.3/§7.5's `stashAndCarry` route (OQ10/W10): a `dirtyNonFastForward` blocker opens
   * `pendingPull` (`PullDialog.vue`'s own confirm step, mirroring `pendingCheckout`) — cancelling
   * ends the pull with nothing run; confirming pushes a stash, runs the pull, and pops it back
   * exactly like `runCheckout`'s own inline call above (`#stashAndCarry`'s shared shape).
   */
  async runPull(remote: string, branch: string, explicitStrategy?: PullStrategy): Promise<void> {
    const repoId = this.#repoId;
    if (repoId === undefined || this.busy.value) return;
    const preflight: PullPreflight = await this.#bridge.request("remote.pullPreflight", {
      repoId,
      branch,
    });
    if (this.#repoId !== repoId) return;
    const strategy = explicitStrategy ?? preflight.strategy;
    const source: PullStrategySource =
      explicitStrategy !== undefined ? "explicit" : preflight.source;
    this.pullStrategy.value = { strategy, source };

    if (preflight.blockers.length > 0) {
      const proceed = await this.#confirmPull(preflight);
      if (!proceed) {
        this.announcement.value = "Pull cancelled.";
        return;
      }
      if (this.busy.value) return; // another op started while the dialog was open
      this.busy.value = true;
      try {
        await this.#stashAndCarry(
          () =>
            this.#bridge.request("remote.run", {
              repoId,
              kind: "pull",
              remote,
              branch,
              setUpstream: false,
              prune: false,
              pruneTags: false,
              strategy,
              expectedRemoteTip: undefined,
              plainForce: undefined,
              confirmToken: undefined,
            }),
          "Pull",
          () => `Pulled ${remote}/${branch} (${strategy})`,
        );
      } finally {
        this.busy.value = false;
      }
      return;
    }

    await this.#runRemote(
      {
        kind: "pull",
        remote,
        branch,
        setUpstream: false,
        prune: false,
        pruneTags: false,
        strategy,
        expectedRemoteTip: undefined,
        plainForce: undefined,
        confirmToken: undefined,
      },
      (result) => (result.ok ? `Pulled ${remote}/${branch} (${strategy})` : undefined),
      "Pull",
    );
  }

  #confirmPull(preflight: PullPreflight): Promise<boolean> {
    this.pendingPull.value = preflight;
    return new Promise((resolve) => {
      this.#resolvePull = resolve;
    });
  }

  /** `PullDialog.vue`'s own Stash-and-pull/Cancel buttons call this — `false` for Cancel. */
  resolvePullDialog(proceed: boolean): void {
    this.pendingPull.value = undefined;
    const resolve = this.#resolvePull;
    this.#resolvePull = undefined;
    resolve?.(proceed);
  }

  /** Plain push is never gated (D52) — no confirm step here, only the upstream question a
   *  preflight already answers: §7.2's "offered, not silent" for `--set-upstream`. */
  async runPush(remote: string, branch: string): Promise<void> {
    const repoId = this.#repoId;
    if (repoId === undefined || this.busy.value) return;
    const preflight: PushPreflight = await this.#bridge.request("remote.pushPreflight", {
      repoId,
      branch,
      remote,
    });
    if (this.#repoId !== repoId) return;
    await this.#runRemote(
      {
        kind: "push",
        remote,
        branch,
        setUpstream: preflight.wouldSetUpstream,
        prune: false,
        pruneTags: false,
        strategy: undefined,
        expectedRemoteTip: undefined,
        plainForce: undefined,
        confirmToken: undefined,
      },
      (result) => (result.ok ? `Pushed ${branch} to ${remote}` : undefined),
      "Push",
    );
  }

  /**
   * `ForcePushDialog.vue`'s own entry point: a preflight round trip (so the dialog can show the
   * remote tip it is about to overwrite and the matched protected pattern, if any), then the
   * dialog's own confirm/cancel promise, mirroring `#confirmCheckout`/`#confirmRevert` above.
   * `expectedRemoteTip` is the preflight's `remoteTip` — re-read and compared host-side
   * immediately before spawning (D48's residual-hazard mitigation), so a change between here and
   * the actual spawn fails with `LeaseViolation` rather than silently overwriting more than the
   * dialog showed.
   */
  async runForcePush(remote: string, branch: string): Promise<void> {
    const repoId = this.#repoId;
    if (repoId === undefined || this.busy.value) return;
    const preflight: PushPreflight = await this.#bridge.request("remote.pushPreflight", {
      repoId,
      branch,
      remote,
    });
    if (this.#repoId !== repoId) return;
    const route = await this.#confirmForcePush({ remote, branch, preflight });
    if (route === null) {
      this.announcement.value = "Force push cancelled.";
      return;
    }
    await this.#runRemote(
      {
        kind: "forcePush",
        remote,
        branch,
        setUpstream: false,
        prune: false,
        pruneTags: false,
        strategy: undefined,
        expectedRemoteTip: preflight.remoteTip,
        plainForce: route.plain,
        confirmToken: route.confirmToken,
      },
      (result) => (result.ok ? `Force-pushed ${branch} to ${remote}` : undefined),
      "Force push",
    );
  }

  #confirmForcePush(pending: PendingForcePush): Promise<ForcePushRoute | null> {
    this.pendingForcePush.value = pending;
    return new Promise((resolve) => {
      this.#resolveForcePush = resolve;
    });
  }

  /** `ForcePushDialog.vue`'s Cancel/confirm buttons call this — `null` for Cancel, matching
   *  `resolveCheckoutDialog`/`resolveRevertDialog`'s own convention. */
  resolveForcePushDialog(route: ForcePushRoute | null): void {
    this.pendingForcePush.value = undefined;
    const resolve = this.#resolveForcePush;
    this.#resolveForcePush = undefined;
    resolve?.(route);
  }

  /** `remote.cancel` — always safe to call: `false` (never an error) when there was nothing to
   *  cancel, including when the toolbar's cancel button is clicked against a push or a pull
   *  already past its fetch phase (D50; W19's "cancel is refused mid-push"). Does not throw and
   *  does not touch `busy`/`activeRemoteOp` itself — the in-flight `#runRemote` call unwinds
   *  those the moment `remote.run` actually settles, whether that is `Cancelled` or, for an
   *  unkillable op, its ordinary result. */
  async cancelRemote(): Promise<boolean> {
    const repoId = this.#repoId;
    if (repoId === undefined) return false;
    const { cancelled } = await this.#bridge.request("remote.cancel", { repoId });
    return cancelled;
  }

  async #runRemote(
    op: Omit<RemoteOpParams, "repoId">,
    announceOk: (result: RemoteOpResult) => string | undefined,
    actionLabel: string,
  ): Promise<RemoteOpResult | undefined> {
    const repoId = this.#repoId;
    if (repoId === undefined || this.busy.value) return undefined;
    this.busy.value = true;
    this.activeRemoteOp.value = op.kind;
    this.remoteProgress.value = undefined;
    try {
      const result = await this.#bridge.request("remote.run", { repoId, ...op });
      if (this.#repoId !== repoId) return result;
      this.#applyRemoteResult(result);
      this.announcement.value = result.ok
        ? (announceOk(result) ?? `${actionLabel} succeeded`)
        : composeOpFailureAnnouncement(actionLabel, result.error);
      return result;
    } finally {
      this.busy.value = false;
      this.activeRemoteOp.value = undefined;
      this.remoteProgress.value = undefined;
    }
  }

  /** The remote-op half of `#applyResult`: reconciles `head`/`inProgress` exactly the same way
   *  (so a conflicting pull lands in P6's existing in-progress banner, unchanged), but — unlike
   *  `#applyResult` — never touches `undoSlot` in either direction. `RemoteOpResult` carries no
   *  `undo` field at all, by construction (D51); this method's whole reason to exist separately
   *  is that OQ6's answer must be structurally impossible to get wrong, not merely remembered. */
  #applyRemoteResult(result: RemoteOpResult): void {
    this.#refs.applyHead(result.head);
    const current = this.statusSummary.value;
    this.statusSummary.value = current
      ? { ...current, head: result.head, inProgress: result.inProgress }
      : {
          head: result.head,
          upstream: undefined,
          counts: { staged: 0, unstaged: 0, untracked: 0, unmerged: 0 },
          isClean: true,
          dirtyPaths: [],
          dirtyTruncated: false,
          inProgress: result.inProgress,
        };
  }

  async #runSimple(
    op: OpRequest,
    announceOk: (ok: true) => string | undefined,
    actionLabel: string,
  ): Promise<OpResult> {
    const repoId = this.#repoId;
    if (repoId === undefined) throw new Error("ops: no repo open");
    if (this.busy.value) throw new Error("ops: another operation is already running");
    this.busy.value = true;
    try {
      const result = await this.#bridge.request("op.run", { repoId, op });
      this.#applyResult(result);
      this.announcement.value = result.ok
        ? (announceOk(true) ?? `${actionLabel} succeeded`)
        : composeOpFailureAnnouncement(actionLabel, result.error);
      return result;
    } finally {
      this.busy.value = false;
    }
  }

  /** Step 4's synchronous half (W12's own doc comment): applies `head`/`inProgress`/`undo`
   *  before the matching `repo.changed` event — which always follows a real op — has a chance to
   *  arrive and trigger `RefsState.reload()`/`refreshStatus()`'s own, fuller reconcile. */
  #applyResult(result: OpResult): void {
    this.#refs.applyHead(result.head);
    const current = this.statusSummary.value;
    this.statusSummary.value = current
      ? { ...current, head: result.head, inProgress: result.inProgress }
      : {
          head: result.head,
          upstream: undefined,
          counts: { staged: 0, unstaged: 0, untracked: 0, unmerged: 0 },
          isClean: true,
          dirtyPaths: [],
          dirtyTruncated: false,
          inProgress: result.inProgress,
        };
    this.undoSlot.value = result.undo;
  }

  dispose(): void {
    this.#unsubscribe();
    this.#unsubscribeProgress();
  }
}
