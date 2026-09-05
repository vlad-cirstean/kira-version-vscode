/**
 * The type map every transport (real or mock) and the UI client are checked against.
 * P0 seeded four entries "enough to exercise all three mechanisms"; P3 grows this into the
 * surface §3.5 describes, restricted to what P3 or an immediately following phase calls —
 * every entry here has a producer and a consumer in P3 (`docs/plans/P3.md`, W1).
 *
 * `core` and `ipc` both depend on nothing (§3.1), so the wire shapes below are *structural
 * copies* of the corresponding `@kira-version/core` types, not imports of them — `ipc` may
 * not import `@kira-version/core` (B3). Drift between the two sides is caught by
 * `tests/unit/ipc/wireConformance.test.ts`, which asserts assignability in both directions,
 * not by an import the lint rule would reject anyway.
 */

/** Which shell mounted the UI bundle. `"harness"` is a real value, not a test-only stand-in —
 *  the harness is a first-class Transport consumer (§8.4, C4). */
export type HostKind = "vscode" | "harness";

// ---------------------------------------------------------------------------------------
// Structural copies of core's wire-relevant types — kept honest by wireConformance.test.ts.
// ---------------------------------------------------------------------------------------

export type HeadState =
  | { readonly kind: "branch"; readonly name: string }
  | { readonly kind: "detached"; readonly sha: string }
  | { readonly kind: "unborn"; readonly name: string };

export type DecorationRef =
  | { readonly kind: "branch"; readonly name: string; readonly isHead: boolean }
  | { readonly kind: "remoteBranch"; readonly name: string }
  | { readonly kind: "tag"; readonly name: string }
  | { readonly kind: "head" }
  | { readonly kind: "stash" };

/** The settings schema's keys and value types (D25, W4) — a structural copy of `core`'s
 *  generated `Settings` type, kept in step by wireConformance.test.ts. */
export interface SettingsSnapshot {
  readonly "kiraVersion.git.path": string;
  readonly "kiraVersion.graph.pageSize": number;
  readonly "kiraVersion.graph.scope": "all" | "head";
  readonly "kiraVersion.log.level": "off" | "error" | "warn" | "info" | "debug";
}

export interface RepoSummary {
  readonly repoId: string;
  readonly root: string;
  readonly gitDir: string;
  readonly commonDir: string;
  readonly isBare: boolean;
  readonly isLinkedWorktree: boolean;
  readonly head: HeadState;
}

export interface RepoCandidate {
  readonly path: string;
  readonly label: string;
}

/** A commit's author or committer identity (§4.4) — structural copy of `core`'s own, needed
 *  because `commit.detail`'s result embeds it directly (P5 W4). */
export interface CommitIdentity {
  readonly name: string;
  readonly email: string;
  readonly timestamp: number; // unix seconds
}

/** P5's diff model, wired: structural copies of `core/src/model/diff.ts` and the `FileChange`/
 *  `SignatureStatus` halves of `core/src/model/commit.ts`, kept honest by
 *  `wireConformance.test.ts`. */
export interface CommitTrailer {
  readonly token: string;
  readonly value: string;
}

export type FileChangeKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "typeChanged"
  | "unmerged";

export interface FileChange {
  readonly kind: FileChangeKind;
  readonly path: string;
  /** Set for `renamed`/`copied` only — and load-bearing: a per-file diff of a rename must
   *  name both paths in its pathspec or git renders it as a whole-file add (probe P2). */
  readonly originalPath: string | undefined;
  readonly similarity: number | undefined;
  readonly additions: number | undefined; // undefined when isBinary
  readonly deletions: number | undefined;
  readonly isBinary: boolean;
}

/** `%G?`'s raw signature-verification code (§4.4, D20): good, bad, unknown key, expired, etc. */
export type SignatureStatus = "G" | "B" | "U" | "X" | "Y" | "R" | "E" | "N";

export type DiffLineKind = "context" | "add" | "del";

export interface DiffLine {
  readonly kind: DiffLineKind;
  /** Without the leading marker character. */
  readonly text: string;
  readonly oldLine: number | undefined;
  readonly newLine: number | undefined;
  /** git's `\ No newline at end of file`, attached to the line it followed. */
  readonly noNewlineAtEof: boolean;
}

export interface DiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  /** Whatever git put after the closing `@@` — rendered in the hunk header row. */
  readonly heading: string;
  readonly lines: readonly DiffLine[];
}

export type FileDiffBody =
  | { readonly kind: "text"; readonly hunks: readonly DiffHunk[] }
  | {
      readonly kind: "binary";
      readonly oldBytes: number | undefined;
      readonly newBytes: number | undefined;
    }
  | { readonly kind: "lfsPointer"; readonly oid: string; readonly bytes: number }
  | { readonly kind: "tooLarge"; readonly bytes: number; readonly limitBytes: number }
  | { readonly kind: "empty"; readonly reason: "modeChangeOnly" | "identical" };

/** D14a's "Go to file" outcome — wire-only, produced entirely by `rpcHandlers.ts`'s
 *  `editor.goToFile` handler, so it has no `core` counterpart to keep in step with. */
export type GoToFileOutcome =
  | { readonly kind: "liveFile"; readonly path: string; readonly line: number }
  | {
      readonly kind: "virtualBlob";
      readonly path: string;
      readonly rev: string;
      readonly line: number;
    }
  | { readonly kind: "unavailable"; readonly reason: "notInRevision" | "binary" | "tooLarge" };

/**
 * W3's wire shape for a slice of `CommitStore` rows — the packed, transferable representation
 * `CommitStore.packSlice`/`appendPacked` (`packages/core/src/store/commitStore.ts`) produce and
 * consume. Declared here (structurally, not imported) because it is the payload of
 * `GraphChunk.commits` below; `wireConformance.test.ts` is what keeps the two in step.
 */
export interface PackedCommitChunk {
  readonly from: number;
  readonly to: number;
  readonly shaWidthBytes: number;
  /** `(to - from) * shaWidthBytes` bytes, binary (§5.5). */
  readonly shas: ArrayBuffer;
  /** `Uint32Array`, `(to - from) + 1` entries, chunk-relative CSR offsets. */
  readonly parentOffsets: ArrayBuffer;
  /** Binary shas in CSR order — parents travel as shas, not row indices (W3). */
  readonly parentShas: ArrayBuffer;
  /** `Uint32Array`, 4 per row (authorName, authorEmail, committerName, committerEmail), into
   *  `dictionary`. */
  readonly identityIds: ArrayBuffer;
  /** `Uint32Array`, 2 per row (authorTime, committerTime). */
  readonly times: ArrayBuffer;
  readonly subjectBytes: ArrayBuffer;
  readonly subjectOffsets: ArrayBuffer;
  /** The first dictionary id this chunk's `dictionary` array defines — the receiver's interner
   *  must be at exactly this size, or the chunk is out of order (W3). */
  readonly dictionaryBase: number;
  /** Only the strings interned since `dictionaryBase` — a delta, not the whole dictionary. */
  readonly dictionary: readonly string[];
  readonly decorations: readonly (readonly [row: number, refs: readonly DecorationRef[]])[];
}

// ---------------------------------------------------------------------------------------
// P6 — refs, status, pre-flight and operations. Structural copies of `packages/core`'s own
// (`model/ref.ts`, `model/operation.ts`, `model/status.ts`, `preflight/types.ts`, `undo/slot.ts`),
// kept honest by `tests/unit/ipc/wireConformance.test.ts` rather than an import (B3).
// ---------------------------------------------------------------------------------------

export type RefKind = "branch" | "remoteBranch" | "tag";

export interface RefTrack {
  readonly ahead: number;
  readonly behind: number;
}

/** The tagger identity and message subject of an *annotated* tag — `undefined` for a lightweight
 *  one (never an empty annotation: `%(contents:subject)` on a lightweight tag returns the
 *  pointed-at commit's subject, which would read as an annotation that is not there). */
export interface TagAnnotation {
  readonly tagger: string;
  readonly date: number; // unix seconds
  readonly subject: string;
}

export interface RefRow {
  readonly refname: string; // refs/heads/main
  readonly kind: RefKind;
  readonly shortName: string; // main, origin/main, v1.2.0
  /** For an annotated tag: the TAG OBJECT's sha — which is what undo needs (probe P3). */
  readonly objectId: string;
  readonly peeledObjectId: string | undefined; // %(*objectname); annotated tags only
  readonly upstream: string | undefined;
  readonly track: RefTrack | "gone" | undefined;
  readonly committerDate: number;
  readonly isHead: boolean;
  /** D12. Absolute path of the worktree holding this branch checked out, when that worktree is
   *  NOT this session's own. `undefined` for every other ref, including the branch checked out
   *  here — `%(worktreepath)` is populated for both and the service subtracts its own toplevel. */
  readonly checkedOutIn: string | undefined;
  /** Present iff this is an annotated tag. */
  readonly annotation: TagAnnotation | undefined;
}

export type InProgressKind =
  | "merge"
  | "cherryPick"
  | "revert"
  | "rebase"
  | "bisect"
  | "unmergedOnly";

export interface InProgressOperation {
  readonly kind: InProgressKind;
  /** MERGE_HEAD / CHERRY_PICK_HEAD / REVERT_HEAD, or rebase's `onto`. */
  readonly otherSha: string | undefined;
  /** rebase only: `rebase-merge/head-name`, e.g. `refs/heads/side`. */
  readonly headName: string | undefined;
  readonly conflictedPaths: readonly string[];
  /** True only where `git <op> --continue` exists AND v1 offers it — false for rebase (§9) and
   *  bisect. */
  readonly canContinue: boolean;
  readonly canAbort: boolean;
  /** `.git/sequencer/` present: a multi-commit revert or cherry-pick mid-run, where --abort is
   *  what delivers §7.10's all-or-nothing. */
  readonly isSequence: boolean;
  /** Continue is *enabled* only when this is 0 (§7.11). Kept separate from
   *  `conflictedPaths.length` so a host that caps the path list cannot accidentally enable it. */
  readonly unmergedCount: number;
}

export interface StatusSummary {
  readonly head: HeadState;
  readonly upstream:
    | { readonly name: string; readonly ahead: number; readonly behind: number }
    | undefined;
  readonly counts: {
    readonly staged: number;
    readonly unstaged: number;
    readonly untracked: number;
    readonly unmerged: number;
  };
  readonly isClean: boolean;
  /** Bounded (W8's 200-entry display cap). §7.5 requires naming the exact files; it does not
   *  require naming ten thousand of them. `dirtyTruncated` says the list was cut. */
  readonly dirtyPaths: readonly string[];
  readonly dirtyTruncated: boolean;
  readonly inProgress: InProgressOperation | null;
}

export type CheckoutBlocker =
  | { readonly kind: "blockedByTracked"; readonly paths: readonly string[] }
  | { readonly kind: "blockedByUntracked"; readonly paths: readonly string[] }
  | { readonly kind: "inProgressOperation"; readonly operation: InProgressOperation }
  | { readonly kind: "worktreeConflict"; readonly branch: string; readonly worktreePath: string };

export interface CheckoutPreflight {
  readonly target: { readonly kind: RefKind | "sha"; readonly name: string };
  /** True when the result is a detached HEAD: a tag, a raw sha, or an explicitly detached
   *  checkout of a remote-tracking ref. */
  readonly detaches: boolean;
  /** Set when the only way to land ON A BRANCH is to create one tracking a remote — the DWIM
   *  case (probe P7), surfaced as an explicit choice instead of happening silently. */
  readonly createsTracking: { readonly branch: string; readonly upstream: string } | undefined;
  /** D \ T: the local changes that will survive the switch. Empty on a clean tree. */
  readonly carried: readonly string[];
  readonly blockers: readonly CheckoutBlocker[];
  /** "clean" = nothing local at all. "cleanCarry" = §7.5's carry case; still no prompt, but the
   *  confirmation copy differs and the UI announces what carried. */
  readonly verdict: "clean" | "cleanCarry" | "blocked";
  /** Which routes the UI may offer for a `blockedByTracked` verdict. P6 emits `["discard"]` (or
   *  `[]` when an untracked block is also present); P9 adds `"stashAndCarry"`. */
  readonly routes: readonly ("discard" | "stashAndCarry")[];
}

export interface RevertParentChoice {
  readonly parentNumber: number; // 1-based, as `-m` takes it
  readonly sha: string;
  readonly subject: string;
}

export interface RevertPreflight {
  readonly shas: readonly string[];
  /** Non-empty ⇒ the user MUST pick before the op is offered (§7.10: "rather than guessing
   *  -m 1"). One entry per merge commit among `shas` whose mainline is not already resolved. */
  readonly mainlineRequired: readonly {
    readonly sha: string;
    readonly parents: readonly RevertParentChoice[];
  }[];
  readonly dirtyPaths: readonly string[];
  readonly inProgress: InProgressOperation | null;
  /** §7.10's merge-tree prediction. Scoped to `shas[0]` — `predictedFor` says so, and the UI
   *  quotes it when `shas.length > 1`. `unknown` when the prediction itself could not run. */
  readonly prediction:
    | { readonly kind: "clean" }
    | { readonly kind: "conflicts"; readonly paths: readonly string[] }
    | { readonly kind: "unknown"; readonly reason: string };
  readonly predictedFor: string | null;
  /** §7.10: allowed, with a note. Not a blocker. */
  readonly detachedHead: boolean;
  readonly verdict: "clean" | "willConflict" | "blocked";
  readonly blockers: readonly ("dirtyWorktree" | "inProgressOperation" | "mainlineRequired")[];
}

export type OpRequest =
  | {
      readonly kind: "checkout";
      readonly target: string;
      readonly mode: "switch" | "detach";
      /** §7.5's "discard" route: `git switch --discard-changes`. Cannot clear an untracked
       *  block (probe P9) — the UI never offers it for one. */
      readonly discardLocalChanges: boolean;
    }
  | {
      readonly kind: "branchCreate";
      readonly name: string;
      readonly startPoint: string;
      readonly checkout: boolean;
      readonly track: string | undefined;
    }
  | { readonly kind: "branchDelete"; readonly name: string; readonly force: boolean }
  | { readonly kind: "branchRename"; readonly from: string; readonly to: string }
  | {
      readonly kind: "tagCreate";
      readonly name: string;
      readonly target: string;
      /** Present ⇒ annotated (`-a -m`). Absent ⇒ lightweight. On `force`, an annotated tag MUST
       *  re-supply this or `-f` downgrades it to lightweight (probe P3). */
      readonly message: string | undefined;
      readonly force: boolean;
    }
  | { readonly kind: "tagDelete"; readonly name: string }
  | { readonly kind: "tagPush"; readonly remote: string; readonly names: readonly string[] | "all" }
  | { readonly kind: "tagDeleteRemote"; readonly remote: string; readonly name: string }
  | {
      readonly kind: "revert";
      readonly shas: readonly string[];
      readonly mainline: number | undefined;
      readonly noCommit: boolean;
    }
  | { readonly kind: "opContinue" }
  | { readonly kind: "opAbort" };

export type OpErrorKind =
  | "AuthFailed"
  | "NonFastForward"
  | "Conflict"
  | "DirtyWorktree"
  | "UntrackedWouldBeOverwritten"
  | "LockHeld"
  | "NotFound"
  | "AlreadyExists"
  | "NotFullyMerged"
  | "WorktreeConflict"
  | "OperationInProgress"
  | "RemoteRefMissing"
  | "HookRejected"
  | "Unknown";

export interface UndoSlotSnapshot {
  readonly id: string;
  /** "Deleted branch feature" — §7.12's "labelled with what it will undo". */
  readonly label: string;
  /** "was d657c6e" — §7.12's "captured recovery sha is shown alongside the button, so the user
   *  can recover manually even after the slot is cleared". */
  readonly recoverySha: string;
  readonly createdAt: number;
}

export interface OpResult {
  readonly ok: boolean;
  readonly error: { readonly kind: OpErrorKind; readonly message: string } | undefined;
  /** The slot AFTER this op: a new record for an undoable op, `null` for any other (which clears
   *  it — §7.12's "performing another operation clears the undo slot"). */
  readonly undo: UndoSlotSnapshot | null;
  /** Read back after the op, success or failure — the reconcile step, closing the window before
   *  the watcher's debounce. */
  readonly head: HeadState;
  readonly inProgress: InProgressOperation | null;
}

// ---------------------------------------------------------------------------------------
// Discriminated unions the UI renders explicitly rather than infers.
// ---------------------------------------------------------------------------------------

export type GitStatus =
  | { readonly kind: "ok"; readonly path: string; readonly version: string }
  | { readonly kind: "notFound"; readonly probed: readonly string[] }
  | {
      readonly kind: "tooOld";
      readonly path: string;
      readonly detected: string;
      readonly required: string;
      readonly settingId: string;
    }
  | { readonly kind: "unusable"; readonly path: string; readonly reason: string };

export type RepoOpenResult =
  | { readonly kind: "ok"; readonly repo: RepoSummary }
  | { readonly kind: "notARepository"; readonly path: string }
  | { readonly kind: "gitUnavailable"; readonly git: GitStatus };

// ---------------------------------------------------------------------------------------
// The contract.
// ---------------------------------------------------------------------------------------

export type Contract = {
  requests: {
    "app.init": {
      params: Record<string, never>;
      result: {
        host: HostKind;
        contractVersion: number;
        settings: SettingsSnapshot;
        git: GitStatus;
        /** An optional capability the UI feature-detects rather than assumes (§3.3). Nothing in
         *  P5 or P6 branches on host kind. */
        capabilities: {
          readonly openInEditor: boolean;
          readonly goToFile: boolean;
          readonly clipboard: boolean;
          /** §7.11's "Resolve in VS Code". `true` under VS Code, `false` in the harness's
           *  default posture (D15: reveal the host's own SCM surface, never our own merge UI). */
          readonly resolveConflict: boolean;
        };
      };
    };
    "repo.list": {
      params: Record<string, never>;
      result: { candidates: readonly RepoCandidate[]; activeRepoId: string | null };
    };
    "repo.pick": {
      params: Record<string, never>;
      result: { path: string | null };
    };
    "repo.open": {
      params: { path: string };
      result: RepoOpenResult;
    };
    "repo.close": {
      params: { repoId: string };
      result: Record<string, never>;
    };
    "graph.status": {
      params: { repoId: string };
      result: { loaded: number; remaining: number; exhausted: boolean };
    };
    "graph.loadMore": {
      params: { repoId: string; pages?: number };
      result: { started: boolean };
    };
    "graph.refresh": {
      params: { repoId: string };
      result: { restarted: boolean };
    };
    "commit.detail": {
      params: { repoId: string; sha: string; parentIndex?: number };
      result: {
        readonly sha: string;
        readonly parents: readonly string[];
        readonly author: CommitIdentity;
        readonly committer: CommitIdentity;
        readonly subject: string;
        /** `%b` with the trailer paragraph removed (W1) — the trailers travel structured,
         *  below. */
        readonly body: string;
        readonly trailers: readonly CommitTrailer[];
        readonly signature: { readonly status: SignatureStatus; readonly signer: string };
        /** `%D`, already parsed by `parse/log.ts` — "all refs pointing at this commit" (§6.4). */
        readonly decoration: readonly DecorationRef[];
        /** Which parent `files` is diffed against. Always 0 for a non-merge; always
         *  < parents.length. */
        readonly parentIndex: number;
        readonly files: readonly FileChange[];
      };
    };
    "commit.fileDiff": {
      params: {
        repoId: string;
        sha: string;
        path: string;
        /** From the same `FileChange` — passed so the argv can name both sides (probe P2). */
        originalPath?: string;
        parentIndex?: number;
      };
      result: {
        readonly sha: string;
        readonly parentIndex: number;
        /** The pre-image revision, or null for a root commit (diffed against the empty tree). */
        readonly baseSha: string | null;
        /** Echoed so the view has status, rename arrow and counts without a second lookup. */
        readonly change: FileChange;
        readonly body: FileDiffBody;
      };
    };
    /** "Open in editor" (§6.4) — hands the same two blobs to the host's native diff. */
    "editor.openDiff": {
      params: {
        repoId: string;
        sha: string;
        path: string;
        originalPath?: string;
        parentIndex?: number;
      };
      result: Record<string, never>;
    };
    /**
     * D14a. `line` in is 1-based **in `rev`'s version of `path`** — the UI maps the cursor row
     * to the historical revision (`mapDiffLineToRevision`) and stops there. `line` out, on the
     * outcome, is the line actually revealed. The two are equal on every branch except
     * `liveFile`, where the handler re-maps across the commit→worktree drift (`worktreeDiff` +
     * `mapLineAcrossDiff`) so the UI never has to run a second mapping or a second round trip.
     */
    "editor.goToFile": {
      params: { repoId: string; rev: string; path: string; line: number };
      result: GoToFileOutcome;
    };
    /** `label` is for the host's log line only — never the content, which may be a whole
     *  message. */
    "clipboard.write": {
      params: { text: string; label: string };
      result: Record<string, never>;
    };
    // ---- P6: refs, status, pre-flight, operations -----------------------------------------
    "refs.list": {
      params: { repoId: string };
      /** Two spawns: heads+remotes `--sort=-committerdate`, tags `--sort=-v:refname` (§7.9's
       *  version-aware sort, which git does correctly and JS does not). */
      result: {
        branches: readonly RefRow[];
        remoteBranches: readonly RefRow[];
        tags: readonly RefRow[];
        head: HeadState;
      };
    };
    "status.get": {
      params: { repoId: string };
      result: StatusSummary;
    };
    "preflight.checkout": {
      params: { repoId: string; target: string; mode: "switch" | "detach" };
      result: CheckoutPreflight;
    };
    "preflight.revert": {
      params: { repoId: string; shas: readonly string[]; mainline?: number };
      result: RevertPreflight;
    };
    "op.run": {
      params: { repoId: string; op: OpRequest };
      result: OpResult;
    };
    "undo.peek": {
      params: { repoId: string };
      result: { slot: UndoSlotSnapshot | null };
    };
    "undo.run": {
      params: { repoId: string; id: string };
      result: OpResult;
    };
    /** §7.11's "Resolve in VS Code": reveal the SCM view and open the first unmerged file in the
     *  three-way merge editor. Only ever called when `capabilities.resolveConflict` is true. */
    "editor.resolveConflict": {
      params: { repoId: string; path: string };
      result: Record<string, never>;
    };
  };
  events: {
    "repo.changed": { repoId: string; kind: "refsChanged" | "worktreeChanged" };
    "settings.changed": { settings: SettingsSnapshot };
  };
  streams: {
    "graph.stream": {
      params: { repoId: string; resumeThroughRow?: number };
      chunk: {
        readonly repoId: string;
        readonly seq: number;
        /** Absolute row indices, not chunk-relative. */
        readonly from: number;
        readonly to: number;
        /** §5.4 made observable; W9 renders it, P4 keeps it. */
        readonly source: "git" | "cache";
        readonly remaining: number;
        readonly exhausted: boolean;
        readonly commits: PackedCommitChunk;
      };
    };
  };
};

export type RequestKey = keyof Contract["requests"];
export type EventKey = keyof Contract["events"];
export type StreamKey = keyof Contract["streams"];

export type ParamsOf<K extends RequestKey> = Contract["requests"][K]["params"];
export type ResultOf<K extends RequestKey> = Contract["requests"][K]["result"];
export type EventPayload<K extends EventKey> = Contract["events"][K];
export type StreamParamsOf<K extends StreamKey> = Contract["streams"][K]["params"];
export type StreamChunkOf<K extends StreamKey> = Contract["streams"][K]["chunk"];
