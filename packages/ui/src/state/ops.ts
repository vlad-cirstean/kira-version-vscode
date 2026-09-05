import { canRunOp } from "@kira-version/core";
import type {
  CheckoutPreflight,
  OpRequest,
  OpResult,
  RevertPreflight,
  StatusSummary,
  UndoSlotSnapshot,
} from "@kira-version/ipc";
import { type ShallowRef, shallowRef } from "vue";
import type { BridgeClient } from "../bridge/client.ts";
import {
  composeCheckoutAnnouncement,
  composeOpFailureAnnouncement,
  composeRevertAnnouncement,
} from "./liveAnnouncements.ts";
import type { RefsState } from "./refs.ts";

/** The route a confirmed `blockedByTracked` checkout takes — `discardLocalChanges: false` for
 *  every other verdict, since `runCheckout` only ever opens the dialog for `"blocked"` (§7.5:
 *  clean and cleanCarry proceed with no prompt). */
export interface CheckoutRoute {
  readonly discardLocalChanges: boolean;
}

/** The route a confirmed revert takes: the chosen mainline (present only when the preflight's
 *  `mainlineRequired` was non-empty) and whether to stop short of committing. */
export interface RevertRoute {
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

  readonly #bridge: BridgeClient;
  readonly #refs: RefsState;
  #repoId: string | undefined;
  #resolveCheckout: ((route: CheckoutRoute | null) => void) | undefined;
  #resolveRevert: ((route: RevertRoute | null) => void) | undefined;
  readonly #unsubscribe: () => void;

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
  }

  setRepoId(repoId: string | undefined): void {
    this.#repoId = repoId;
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
        discardLocalChanges = route.discardLocalChanges;
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

  async undo(): Promise<OpResult | undefined> {
    const repoId = this.#repoId;
    const slot = this.undoSlot.value;
    if (repoId === undefined || slot === null || this.busy.value) return undefined;
    this.busy.value = true;
    try {
      const result = await this.#bridge.request("undo.run", { repoId, id: slot.id });
      this.#applyResult(result);
      this.announcement.value = result.ok
        ? `Undone: ${slot.label}`
        : composeOpFailureAnnouncement("Undo", result.error);
      return result;
    } finally {
      this.busy.value = false;
    }
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
  }
}
