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
  /** P8: `git`'s own `(stale info)` — the bare `--force-with-lease` lease was violated because
   *  the remote moved and we never fetched it. Probe 1, rows 1-2. */
  | "LeaseViolation"
  /** P8: `git`'s own `(remote ref updated since checkout)` — `--force-if-includes` caught a
   *  remote move we DID fetch but have not integrated. Probe 1, row 3. */
  | "RemoteRefUpdated"
  /** P8: a transport-level failure — never git's own decision, always the network. */
  | "NetworkFailed"
  /** P8: the remote itself does not exist. */
  | "RemoteNotFound"
  /** P9: a pop/apply merged with conflicts. Deliberately NOT a stderr pattern below — a
   *  conflicting pop writes to stdout and leaves stderr EMPTY (probe 5) — `RepoService`
   *  classifies this one from `exitCode !== 0` plus a post-op status read-back finding unmerged
   *  paths, never from this file's pattern list. Kept in this union anyway, since it is still a
   *  `GitError` the executor constructs and callers still switch on `GitErrorKind` the same way. */
  | "StashConflict"
  /** P9: `error: ... conflicts in index. Try without --index.` — `stash pop --index`/`apply
   *  --index` refuses to restore the index because doing so would itself conflict. Distinct from
   *  `StashConflict`: the worktree merge never even ran, and the remedy is "retry without
   *  restoring the index", not "resolve conflicts". */
  | "StashIndexConflict"
  /** P9: `error: Untracked files in the working tree... x already exists, no checkout` / `error:
   *  could not restore untracked files from stash` — an untracked file at the same path as one
   *  the stash carries. Non-atomic: the worktree merge (and, per probe 3, the index restore) has
   *  already happened by the time this is reported — the stash is kept regardless. */
  | "StashUntrackedCollision"
  /** P10, probe 8: `commit <sha> is a merge but no -m option was given.` — a cherry-pick/revert
   *  of a merge commit with no mainline chosen. Prevented by the pre-flight's `mainlineRequired`;
   *  classified here because a pre-flight is advice, not an enforcement boundary. */
  | "MainlineRequired"
  | "Unknown";

export class GitError extends Error {
  readonly kind: GitErrorKind;
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  /** Preserved verbatim and always surfacable — an `Unknown` classification is only
   *  unactionable if this text is discarded, so it never is. */
  readonly stderr: string;
  /** P8/W11: on a `HookRejected` failure, the hook's own `remote: `-prefixed lines with that
   *  prefix stripped — probe 4's finding that this is the only actionable content in an
   *  otherwise-buried wall of git output. `undefined` for every other kind, and for a
   *  `HookRejected` whose stderr happened to carry no `remote: ` lines at all. */
  readonly remoteMessage: string | undefined;

  constructor(
    kind: GitErrorKind,
    argv: readonly string[],
    exitCode: number | null,
    stderr: string,
    remoteMessage?: string,
  ) {
    const summary = stderr.trim().split("\n")[0] || `exited ${exitCode}`;
    super(`git ${argv.join(" ")} failed (${kind}): ${summary}`);
    this.name = "GitError";
    this.kind = kind;
    this.argv = argv;
    this.exitCode = exitCode;
    this.stderr = stderr;
    this.remoteMessage = remoteMessage;
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
    pattern:
      /a branch named '.*' already exists|tag '.*' already exists|! \[rejected\].*\(already exists\)/,
  },
  // P8/W11, probe 1 rows 1-2: "! [rejected] main -> main (stale info)" — a bare
  // `--force-with-lease`'s lease was violated because the remote moved and we never fetched it.
  // MUST be checked before `NonFastForward` below, whose `! \[rejected\]` alternative is broad
  // enough to swallow it (docs/plans/P8.md's "The hard parts" §8).
  { kind: "LeaseViolation", pattern: /\(stale info\)/ },
  // P8/W11, probe 1 row 3: "! [rejected] main -> main (remote ref updated since checkout)" —
  // `--force-if-includes` caught a remote move we DID fetch but have not integrated. Kept
  // distinct from `LeaseViolation`: the remedies differ (fetch-and-look vs.
  // you-already-saw-this).
  { kind: "RemoteRefUpdated", pattern: /\(remote ref updated since checkout\)/ },
  // P8/W11: a transport-level failure — never git's own decision, always the network reachable
  // (or not) underneath it. Three real shapes: an unresolvable host, a refused/timed-out
  // connection, and libcurl's own "unable to access '<url>': …" wrapper.
  {
    kind: "NetworkFailed",
    pattern: /Could not resolve host|Connection (refused|timed out)|unable to access '.*': /,
  },
  // P8/W11: the remote itself does not exist — an SSH transport says the first, a dumb-HTTP/
  // smart-HTTP transport the second.
  {
    kind: "RemoteNotFound",
    pattern: /does not appear to be a git repository|Repository not found/,
  },
  // "! [rejected]  main -> main (fetch first)" / "(non-fast-forward)" — needs a fetch/rebase.
  { kind: "NonFastForward", pattern: /! \[rejected\]|non-fast-forward/ },
  // P9/W7: "error: ... x already exists, no checkout" (`stash pop`'s worktree-checkout half) and
  // "error: could not restore untracked files from stash." (`stash apply`'s own wording for the
  // same collision) — an untracked file at the same path as one the stash carries. Checked before
  // `Conflict` below, whose broader `could not apply` alternative would otherwise be a plausible
  // (wrong) match for the second message's "could not restore" phrasing.
  {
    kind: "StashUntrackedCollision",
    pattern: /already exists, no checkout|could not restore untracked files from stash/,
  },
  // P9/W7: "error: ... conflicts in index. Try without --index." — `stash pop --index`/`apply
  // --index` refuses because restoring the index would itself conflict; the worktree merge never
  // ran. Checked before `Conflict` below for the same reason as `StashUntrackedCollision` above.
  { kind: "StashIndexConflict", pattern: /conflicts in index\. Try without --index/ },
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
  // running); "fatal: No rebase in progress?". P10/W7 probe 3 adds "fatal: Cannot do a soft
  // reset in the middle of a merge." (and the same for mixed/hard) — defence in depth: `reset`
  // is host-gated (§7.11/`GATED_OP_KINDS`) precisely because git does NOT reliably refuse this
  // on its own (probe 3 found `--mixed`/`--hard` succeed and silently abandon the merge), but
  // `--soft` genuinely is refused, so this pattern still matters.
  {
    kind: "OperationInProgress",
    pattern:
      /cannot switch branch while (merging|rebasing|cherry-picking|reverting)|no (merge|rebase) in progress|no cherry-pick or revert in progress|Cannot do a (soft|mixed|hard) reset in the middle of a merge/i,
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
  {
    kind: "RemoteRefMissing",
    pattern: /remote ref does not exist|src refspec .* does not match any/,
  },
  // "error: Your local changes to the following files would be overwritten by checkout:" and,
  // as of P10/W7 probe 7 B/D, cherry-pick's own shorter form with no "to the following files"
  // clause at all: "error: Your local changes to 'x' would be overwritten by cherry-pick." /
  // "... would be overwritten by merge." (a STAGED change, not merely unstaged — probe 7 found
  // git refuses any staged change here, related to the pick or not).
  {
    kind: "DirtyWorktree",
    pattern:
      /local changes to the following files would be overwritten|your local changes would be overwritten by/i,
  },
  // "fatal: invalid reference: x" / "unknown revision or path" / "did not match any file(s)" —
  // plus four more real captures added at P6/W6 (probe P7): "fatal: reference is not a tree: x"
  // (`switch --detach` on a bad sha), "fatal: no branch named 'x'" (`branch -m` on one that
  // doesn't exist), "error: tag 'x' not found." (`tag -d` on one that doesn't exist), "fatal:
  // bad object x" (`revert` on a bad sha). "error: branch 'x' not found" (P6/W8: `branch -d`/`-D`
  // on a name that doesn't exist — distinct wording from rename's "no branch named", probed while
  // writing `RepoService.runOp`'s own integration tests) joins the same set. P9/W7 adds two more:
  // "fatal: x is not a stash reference" (`stash apply`/`pop`/`drop`/`branch` given a bad
  // `stash@{N}`) and "fatal: 'x' is not a stash-like commit" (`stash show`/`branch` given a sha
  // that resolves but isn't shaped like a stash commit) — both are the same "no such thing here"
  // outcome as every other member of this pattern, not a new kind. P10/W7 probe 3 adds "fatal:
  // Could not parse object 'x'." (`reset` given a target that does not resolve) — a pre-existing
  // hole in this pattern, not new git behaviour.
  {
    kind: "NotFound",
    pattern:
      /invalid reference:|unknown revision or path|did not match any file\(s\) known to git|bad revision|reference is not a tree:|no branch named|branch '.*' not found|tag '.*' not found|bad object|is not a stash reference|is not a stash-like commit|Could not parse object/,
  },
  // P10/W7 probe 8: "error: commit <sha> is a merge but no -m option was given." — a
  // cherry-pick/revert of a merge commit with no mainline. Ordered BEFORE `Conflict`: both are
  // merge-shaped failures, and keeping them adjacent here (rather than earlier in the list)
  // documents that relationship, even though their patterns do not actually overlap.
  { kind: "MainlineRequired", pattern: /is a merge but no -m option was given/ },
  // "error: could not apply <sha>... <subject>" (cherry-pick hitting a real conflict) — and, as
  // of P6/W6, "error: could not revert <sha>... <subject>" (a conflicting revert; probe P8:
  // this was the classifier's inherited P1 gap — a conflicting revert classified as `Unknown`
  // because only "could not apply" was matched). `CONFLICT (` remains stdout-only and
  // unreachable here — see the file header.
  { kind: "Conflict", pattern: /could not apply|could not revert|CONFLICT \(/ },
];

/** P8/W11: collects `remote: `-prefixed lines and strips the prefix — the hook's own message,
 *  per probe 4. `undefined` (not `""`) when stderr carried no such lines, so a `HookRejected`
 *  error's `remoteMessage` is always either real content or explicitly absent. */
function extractHookRemoteMessage(stderr: string): string | undefined {
  const lines = stderr
    .split("\n")
    .filter((line) => line.startsWith("remote: "))
    .map((line) => line.slice("remote: ".length));
  return lines.length > 0 ? lines.join("\n") : undefined;
}

export function classifyGitError(
  argv: readonly string[],
  exitCode: number | null,
  stderr: string,
): GitError {
  for (const { kind, pattern } of PATTERNS) {
    if (pattern.test(stderr)) {
      const remoteMessage = kind === "HookRejected" ? extractHookRemoteMessage(stderr) : undefined;
      return new GitError(kind, argv, exitCode, stderr, remoteMessage);
    }
  }
  return new GitError("Unknown", argv, exitCode, stderr);
}
