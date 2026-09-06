/**
 * One row of the history walk (§4.4's `git log` format). `%D`'s decoration list is parsed
 * into structured refs here rather than kept as the raw "HEAD -> main, tag: v1, origin/main"
 * string, since every consumer wants to know which kind of ref it is looking at.
 */
import type { CommitTrailer } from "./diff.ts";

export interface CommitIdentity {
  readonly name: string;
  readonly email: string;
  readonly timestamp: number; // unix seconds
}

export type DecorationRef =
  | { readonly kind: "branch"; readonly name: string; readonly isHead: boolean }
  | { readonly kind: "remoteBranch"; readonly name: string }
  | { readonly kind: "tag"; readonly name: string }
  /** Detached HEAD pointing directly at this commit, with no branch in the decoration list. */
  | { readonly kind: "head" }
  /** A stash entry (P4 W7/W8: badge and node shape both key off this, the single source
   *  `git/src/parse/log.ts`'s `parseDecorationToken` recognizes by name — never a second
   *  heuristic over the subject line, which a normal commit could coincidentally match).
   *  `index` is the `stash@{N}` position at chunk-build time — P9 synthesises it by sha
   *  membership against the fetched stash list, not parsed from `%D`: `--decorate` only ever
   *  names the *tip* of `refs/stash` literally, so `parseDecorationToken` alone can produce this
   *  variant only for `stash@{0}` (`index: 0`, probe 7) — every other stack member gets its
   *  decoration from that same synthesis pass, never from the log walk's own `%D` field. */
  | { readonly kind: "stash"; readonly index: number };

export interface CommitRecord {
  readonly sha: string;
  /** Empty for a root commit; 3+ entries for an octopus merge. */
  readonly parents: readonly string[];
  readonly author: CommitIdentity;
  readonly committer: CommitIdentity;
  readonly subject: string;
  readonly decoration: readonly DecorationRef[];
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
  /** Set for `renamed`/`copied` only. */
  readonly originalPath: string | undefined;
  /** Set for `renamed`/`copied` only — the `-M`/`-C` similarity score, 0-100. */
  readonly similarity: number | undefined;
  /** Undefined when `isBinary` — numstat reports `-` for a binary file's line counts. */
  readonly additions: number | undefined;
  readonly deletions: number | undefined;
  readonly isBinary: boolean;
}

/** `%G?`'s raw signature-verification code (§4.4, D20): good, bad, unknown key, expired, etc. */
export type SignatureStatus = "G" | "B" | "U" | "X" | "Y" | "R" | "E" | "N";

export interface CommitSignature {
  readonly status: SignatureStatus;
  /** `%GS` — empty when `status` is `"N"` (no signature to name a signer for). */
  readonly signer: string;
}

export interface CommitDetail extends CommitRecord {
  /** The message body, trailer paragraph already removed by `splitTrailerBlock` — everything
   *  else after the subject line, per git's own %b convention. */
  readonly body: string;
  /** Git's own `%(trailers:only=true,unfold=true)` parse — folded onto one line each. */
  readonly trailers: readonly CommitTrailer[];
  readonly signature: CommitSignature;
  /** Which parent `files` (and any requested `FileDiff`) is diffed against — 0 for a non-merge. */
  readonly parentIndex: number;
  /** Diffed against a single selected parent (default: first). Empty array for a root commit's
   *  detail against the empty tree, which is a real, valid diff, not a missing one. */
  readonly files: readonly FileChange[];
}
