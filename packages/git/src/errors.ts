/**
 * §4.3's typed error union, classified from exit code + stderr pattern matching. Every pattern
 * below was captured from a real, actually-failed git invocation (not invented) — see the
 * pattern comments. `git merge`'s own conflict text goes to *stdout*, not stderr, which this
 * classifier cannot see by design (§4.3 says stderr) — that line remains genuinely unreachable.
 * What P6 (W6) changes is that it no longer matters for a conflicting *revert* or *cherry-pick*:
 * both say "error: could not revert/apply <sha>..." on **stderr**, which the `Conflict` pattern
 * below now matches. `git merge`'s own stdout-only `CONFLICT (` text is still not seen here —
 * P6 routes revert and cherry-pick's sequencer-based conflicts through the driver, not a bare
 * `git merge`, so this gap is survived rather than closed.
 *
 * `GitCancelled` and `GitSpawnFailed` are driver-level, not git-level, and are deliberately
 * kept out of the domain union: a caller superseding its own query must not have to
 * pattern-match a `GitError.kind` to know its read was merely cancelled.
 */

export type GitErrorKind =
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

export class GitError extends Error {
  readonly kind: GitErrorKind;
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  /** Preserved verbatim and always surfacable — an `Unknown` classification is only
   *  unactionable if this text is discarded, so it never is. */
  readonly stderr: string;

  constructor(
    kind: GitErrorKind,
    argv: readonly string[],
    exitCode: number | null,
    stderr: string,
  ) {
    const summary = stderr.trim().split("\n")[0] || `exited ${exitCode}`;
    super(`git ${argv.join(" ")} failed (${kind}): ${summary}`);
    this.name = "GitError";
    this.kind = kind;
    this.argv = argv;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/** Raised when an in-flight read's `AbortSignal` fires. Never a failure the UI should surface. */
export class GitCancelled extends Error {
  readonly argv: readonly string[];

  constructor(argv: readonly string[]) {
    super(`git ${argv.join(" ")} was cancelled`);
    this.name = "GitCancelled";
    this.argv = argv;
  }
}

/** The git binary itself could not be executed — distinct from any git-reported failure. */
export class GitSpawnFailed extends Error {
  readonly path: string;
  override readonly cause: unknown;

  constructor(path: string, cause: unknown) {
    super(
      `could not spawn git at '${path}': ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "GitSpawnFailed";
    this.path = path;
    this.cause = cause;
  }
}

interface Pattern {
  readonly kind: GitErrorKind;
  readonly pattern: RegExp;
}

// Ordered most-specific-first: a candidate is checked against each in turn and the first
// match wins, which matters where two kinds' messages could otherwise both mention "rejected".
const PATTERNS: readonly Pattern[] = [
  // "fatal: Unable to create '.../index.lock': File exists." — a stale or contended lock.
  { kind: "LockHeld", pattern: /Unable to create '.*\.lock'.*File exists/s },
  // "! [remote rejected] main -> main (pre-receive hook declined)" — a server-side hook.
  { kind: "HookRejected", pattern: /hook declined/ },
  // P6/W6, three real captures: "fatal: a branch named 'x' already exists" (git branch),
  // "fatal: tag 'x' already exists" (git tag), "! [rejected]  t1 -> t1 (already exists)" (a
  // diverged tag push) — this last one MUST be checked before `NonFastForward` below, whose
  // `! \[rejected\]` half would otherwise swallow it; a name conflict and a diverged branch are
  // different problems with different remedies.
  {
    kind: "AlreadyExists",
    pattern: /a branch named '.*' already exists|tag '.*' already exists|! \[rejected\].*\(already exists\)/,
  },
  // "! [rejected]  main -> main (fetch first)" / "(non-fast-forward)" — needs a fetch/rebase.
  { kind: "NonFastForward", pattern: /! \[rejected\]|non-fast-forward/ },
  // P6/W6: "error: the branch 'x' is not fully merged." (`git branch -d`, no `-D`).
  { kind: "NotFullyMerged", pattern: /the branch '.*' is not fully merged/ },
  // P6/W6: "fatal: 'x' is already used by worktree at '…'" (switch) and "error: cannot delete
  // branch 'x' used by worktree at '…'" (branch -D) — one pattern, both messages share this
  // clause. D12's fifth checkout blocker and the same refusal on delete.
  { kind: "WorktreeConflict", pattern: /used by worktree at/ },
  // P6/W6, two real captures with different phrasing (case differs too — plain checkout leads
  // with "The following untracked…", `--discard-changes` with "Untracked working tree file
  // '…'"): "error: The following untracked working tree files would be overwritten by
  // checkout:" and "error: Untracked working tree file 'x' would be overwritten by merge."
  {
    kind: "UntrackedWouldBeOverwritten",
    pattern: /untracked working tree files?(?: '.*?')? would be overwritten/i,
  },
  // P6/W6: "fatal: cannot switch branch while (merging|rebasing|cherry-picking|reverting)" (a
  // gated op attempted mid-operation) and the three "no operation to continue" shapes — real
  // captures: "fatal: There is no merge in progress (MERGE_HEAD missing)."; "error: no
  // cherry-pick or revert in progress" (both cherry-pick and revert --continue with none
  // running); "fatal: No rebase in progress?".
  {
    kind: "OperationInProgress",
    pattern:
      /cannot switch branch while (merging|rebasing|cherry-picking|reverting)|no (merge|rebase) in progress|no cherry-pick or revert in progress/i,
  },
  // GIT_TERMINAL_PROMPT=0 (§4.3) turns a credential prompt into this, always — the realistic
  // auth-failure shape in a driver that never allows an interactive prompt. A credential
  // helper supplying *wrong* creds instead produces "Authentication failed for '<url>'".
  {
    kind: "AuthFailed",
    pattern:
      /terminal prompts disabled|could not read (Username|Password) for|Authentication failed for/,
  },
  // P6/W6, two real captures: "error: unable to delete 'x': remote ref does not exist" (a
  // remote tag delete for a name not on the remote) and "error: src refspec x does not match
  // any" (pushing a local ref that does not exist).
  { kind: "RemoteRefMissing", pattern: /remote ref does not exist|src refspec .* does not match any/ },
  // "error: Your local changes to the following files would be overwritten by checkout:"
  { kind: "DirtyWorktree", pattern: /local changes to the following files would be overwritten/ },
  // "fatal: invalid reference: x" / "unknown revision or path" / "did not match any file(s)" —
  // plus four more real captures added at P6/W6 (probe P7): "fatal: reference is not a tree: x"
  // (`switch --detach` on a bad sha), "fatal: no branch named 'x'" (`branch -m` on one that
  // doesn't exist), "error: tag 'x' not found." (`tag -d` on one that doesn't exist), "fatal:
  // bad object x" (`revert` on a bad sha).
  {
    kind: "NotFound",
    pattern:
      /invalid reference:|unknown revision or path|did not match any file\(s\) known to git|bad revision|reference is not a tree:|no branch named|tag '.*' not found|bad object/,
  },
  // "error: could not apply <sha>... <subject>" (cherry-pick hitting a real conflict) — and, as
  // of P6/W6, "error: could not revert <sha>... <subject>" (a conflicting revert; probe P8:
  // this was the classifier's inherited P1 gap — a conflicting revert classified as `Unknown`
  // because only "could not apply" was matched). `CONFLICT (` remains stdout-only and
  // unreachable here — see the file header.
  { kind: "Conflict", pattern: /could not apply|could not revert|CONFLICT \(/ },
];

export function classifyGitError(
  argv: readonly string[],
  exitCode: number | null,
  stderr: string,
): GitError {
  for (const { kind, pattern } of PATTERNS) {
    if (pattern.test(stderr)) return new GitError(kind, argv, exitCode, stderr);
  }
  return new GitError("Unknown", argv, exitCode, stderr);
}
