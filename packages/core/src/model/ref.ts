/**
 * One row of `for-each-ref` (§4.4). Heads, remote-tracking branches and tags are one record
 * type discriminated on the refname prefix, because that is how `for-each-ref` returns them —
 * inventing three separate types would mean three near-identical parsers.
 */
export type RefKind = "branch" | "remoteBranch" | "tag";

export interface RefTrack {
  readonly ahead: number;
  readonly behind: number;
}

/** §4.4/P6: the tagger identity and message subject of an *annotated* tag — `undefined` for a
 *  lightweight one. Populated from `%(contents:subject)` only when `objecttype === "tag"`
 *  (`parse/refs.ts`): that placeholder returns the *pointed-at commit's* subject on a
 *  lightweight tag, which would read as an annotation that is not there. */
export interface TagAnnotation {
  readonly tagger: string;
  readonly date: number; // unix seconds
  readonly subject: string;
}

export interface RefRecord {
  /** Full refname, e.g. `refs/heads/main`. */
  readonly refname: string;
  readonly kind: RefKind;
  /** `refname` with its `refs/heads|remotes|tags/` prefix stripped, e.g. `origin/main`. */
  readonly shortName: string;
  /** `%(objectname)` verbatim. For an annotated tag this is the TAG OBJECT's sha, not the
   *  commit's — P6's undo (`update-ref refs/tags/<name> <objectId>`) depends on that staying
   *  true, so this field must never be silently peeled here. */
  readonly objectId: string;
  readonly objectType: "commit" | "tag" | "tree" | "blob";
  /** For an annotated tag: the commit it points at. Undefined for anything else. */
  readonly peeledObjectId: string | undefined;
  /** Full refname of the upstream, if this is a branch with one configured. */
  readonly upstream: string | undefined;
  readonly track: RefTrack | "gone" | undefined;
  readonly committerDate: number; // unix seconds
  readonly isHead: boolean;
  /** D12/P6. Absolute path of the worktree that has this ref checked out, when that worktree is
   *  NOT this session's own — `undefined` for every other ref, including the branch checked out
   *  in *this* worktree (`%(worktreepath)` is populated for both; the service subtracts its own
   *  toplevel — see `git/src/repoService.ts`'s `refs()`). */
  readonly checkedOutIn: string | undefined;
  /** Present iff this is an annotated tag (`objectType === "tag"`). `undefined` for a
   *  lightweight tag or for a branch/remote-branch ref. */
  readonly annotation: TagAnnotation | undefined;
}
