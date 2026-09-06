/**
 * The §4.4 history walk: format string and parser together, so a field added to one is a
 * type error in the other rather than a silent runtime shift of every field after it.
 *
 * `--decorate=full` is one addition over the spec's literal invocation: it makes `%D` emit
 * fully-qualified refnames (`refs/heads/main` rather than `main`), which is the only way to
 * classify a decoration entry by prefix instead of guessing from ref-name shape — a local
 * branch and a remote-tracking branch can both legally contain a `/`.
 */
import type { CommitIdentity, CommitRecord, DecorationRef } from "@kira-version/core";
import { splitLimitedFields } from "@kira-version/core";

const FIELD_DELIMITER = 0x1f;
const FIELD_COUNT = 10;

/** `%H %P %an %ae %at %cn %ce %ct %D %s` — subject last, so a stray delimiter inside a commit
 *  message can only corrupt the subject, never a field before it. */
export const LOG_FORMAT = "%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%D%x1f%s";

/**
 * The rev set §4.4's history walk covers: every ref (`--all`, which as of git 2.43 already
 * includes `refs/stash` — confirmed empirically, V3 below) plus the explicit `--glob` as a
 * belt-and-braces guard against an older or differently-behaving git, versus just `HEAD` for
 * the narrow current-branch-only view (D10's toggle; git defaults to `HEAD` when no revision
 * is given, so "head" scope needs no extra argv at all). One builder shared by `logArgs`,
 * `git/logSession.ts`'s spawn (P2 W11), and `countCommits` — a remaining-count computed over a
 * *different* rev set than the walk itself would make "127,400 remaining" a lie.
 *
 * P9 W12: only `refs/stash` — i.e. `stash@{0}` — is reachable by glob (probe 7); every other
 * stash entry is invisible to `--all` no matter what, so each one's own sha is passed as an
 * explicit positional rev in `stashShas`. They arrive with an empty `%D` (`--decorate` cannot
 * name a commit no ref points at), which is why `graph/stashRows.ts`'s post-pass synthesises
 * their decoration by sha membership instead of parsing it.
 *
 * `includeStash` is `kiraVersion.stash.showInGraph`, threaded as its own flag rather than folded
 * into an empty `stashShas` array: a repo with zero stashes and the setting ON must still carry
 * `--glob=refs/stash` (harmless — git ignores a glob matching nothing — and exactly this
 * function's pre-P9 behaviour), while the setting OFF must drop the glob too, not merely the
 * extra positional revs — showing only `stash@{0}` because a glob happens to reach it would be
 * the worst of both (this plan's own words, W12).
 */
export function revSetArgs(
  scope: "all" | "head",
  stashShas: readonly string[] = [],
  includeStash = true,
): string[] {
  if (scope === "head") return [];
  if (!includeStash) return ["--all"];
  return ["--all", "--glob=refs/stash", ...stashShas];
}

/**
 * `docs/plans/P7.md` W2: what a walk covers, in one two-member union — the graph panel's own
 * `scope` (unchanged), or Branch review's `<base>..<branch>` range (§6.8/D30). A range walk is
 * *the same walk* with different argv, which is what keeps the chunk shape identical between the
 * two (`packSlice`/`appendPacked` know nothing about either variant).
 */
export type WalkSpec =
  | {
      readonly kind: "scope";
      readonly scope: "all" | "head";
      /** P9 W12: every currently-open stash's own sha, resolved once when the session (re)opens
       *  — see `revSetArgs`'s own doc comment. Omitted (or empty) ⇒ only `stash@{0}` is ever
       *  reachable, exactly pre-P9 behaviour. */
      readonly stashShas?: readonly string[];
      /** P9 W12: `kiraVersion.stash.showInGraph`. Defaults to `true` when omitted, so every
       *  caller that predates this setting (and Branch review's own range walk, which has no
       *  stash-in-graph behaviour to opt into at all) keeps exactly the behaviour it always had. */
      readonly includeStash?: boolean;
    }
  | { readonly kind: "range"; readonly base: string; readonly branch: string };

/** Two-dot, never three-dot (D30) — built here, once, so no call site can accidentally write
 *  `${base}...${branch}`. */
export function walkArgs(walk: WalkSpec): string[] {
  return walk.kind === "scope"
    ? revSetArgs(walk.scope, walk.stashShas, walk.includeStash ?? true)
    : [`${walk.base}..${walk.branch}`];
}

export interface LogArgsOptions {
  readonly scope: "all" | "head";
  readonly maxCount: number;
}

// `--no-optional-locks` is not included here: driver.ts (W7) adds it structurally to every
// read, so a caller of this args builder does not need to remember it too.
export function logArgs(opts: LogArgsOptions): string[] {
  const args = ["log", "--decorate=full", "--topo-order", "-z", `--format=${LOG_FORMAT}`];
  args.push(...revSetArgs(opts.scope));
  args.push(`--max-count=${opts.maxCount}`);
  return args;
}

/** The unpaged walk `logSession.ts` (W11/P7 W3) spawns: same format as `logArgs`, minus
 *  `--max-count` — the pause is the page limit, not a git-side one — and `walkArgs(walk)` in
 *  place of a bare scope, so a range walk and a scoped walk are the same code path. */
export function logSessionArgs(walk: WalkSpec): string[] {
  const args = ["log", "--decorate=full", "--topo-order", "-z", `--format=${LOG_FORMAT}`];
  args.push(...walkArgs(walk));
  return args;
}

/** The `--skip` fallback (§5.1.1) after a reclaimed session: same walk, resumed by count. */
export function logSessionSkipArgs(walk: WalkSpec, skip: number): string[] {
  return [...logSessionArgs(walk), `--skip=${skip}`];
}

/** Same format, for a single commit (`git show -s`) — reused rather than duplicated. */
export function showMetadataArgs(sha: string): string[] {
  return ["show", "-s", "--decorate=full", "-z", `--format=${LOG_FORMAT}`, sha];
}

const decoder = new TextDecoder("utf-8", { fatal: false });

function stripPrefix(value: string, prefix: string): string | undefined {
  return value.startsWith(prefix) ? value.slice(prefix.length) : undefined;
}

function parseDecorationToken(token: string): DecorationRef {
  if (token === "HEAD") return { kind: "head" };
  if (token.startsWith("HEAD -> ")) {
    const rest = token.slice("HEAD -> ".length);
    return { kind: "branch", name: stripPrefix(rest, "refs/heads/") ?? rest, isHead: true };
  }
  if (token.startsWith("tag: ")) {
    const rest = token.slice("tag: ".length);
    return { kind: "tag", name: stripPrefix(rest, "refs/tags/") ?? rest };
  }
  // `revSetArgs("all")` walks `refs/stash` explicitly (this file's own doc comment on why), and
  // `--decorate=full` names it exactly this way — distinct from a `refs/heads/stash` branch,
  // which would arrive as `refs/heads/stash` and fall through to the branch case below instead.
  // `refs/stash` the REF only ever points at the top of the stack, so `%D` can only ever mean
  // `stash@{0}` here (probe 7) — every other stack member's decoration is synthesised
  // separately, by sha membership against the fetched stash list (P9 W12), never parsed from a
  // log record's own `%D` field.
  if (token === "refs/stash") return { kind: "stash", index: 0 };
  const branch = stripPrefix(token, "refs/heads/");
  if (branch !== undefined) return { kind: "branch", name: branch, isHead: false };
  const remote = stripPrefix(token, "refs/remotes/");
  if (remote !== undefined) return { kind: "remoteBranch", name: remote };
  // An unrecognised decoration prefix (a custom refs/ namespace) — keep it rather than drop it.
  return { kind: "branch", name: token, isHead: false };
}

function parseDecoration(raw: string): DecorationRef[] {
  return raw.length === 0 ? [] : raw.split(", ").map(parseDecorationToken);
}

function parseIdentity(
  name: string | undefined,
  email: string | undefined,
  ts: string | undefined,
): CommitIdentity {
  return { name: name ?? "", email: email ?? "", timestamp: Number(ts ?? 0) };
}

export function parseLogRecord(record: Uint8Array): CommitRecord {
  const [sha, parentsRaw, an, ae, at, cn, ce, ct, decorationRaw, subject] = splitLimitedFields(
    record,
    FIELD_DELIMITER,
    FIELD_COUNT,
  ).map((field) => decoder.decode(field));

  return {
    sha: sha ?? "",
    parents: parentsRaw ? parentsRaw.split(" ").filter((p) => p.length > 0) : [],
    author: parseIdentity(an, ae, at),
    committer: parseIdentity(cn, ce, ct),
    subject: subject ?? "",
    decoration: parseDecoration(decorationRaw ?? ""),
  };
}
