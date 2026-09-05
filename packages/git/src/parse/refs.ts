/**
 * `for-each-ref` (§4.4): heads, remote-tracking branches and tags are one record type
 * discriminated on the refname prefix, since that is how `for-each-ref` returns them.
 *
 * Unlike every other §4.4 query, `for-each-ref` has no `-z` mode — records are LF-terminated,
 * fields are `%1f`-separated. None of its fields can legally contain a raw LF (ref names and
 * hex object ids cannot), so line framing is safe here without the NUL-splitting machinery.
 *
 * P6 (W4) adds three fields to the base 11-field format: `%(worktreepath)` (D12 — populated for
 * a ref checked out in ANY worktree, including this session's own; the service subtracts its own
 * toplevel to get "checked out ELSEWHERE"), and the annotated-tag tagger's name/date.
 *
 * The tag *subject* is deliberately **not** in this base format — `%(contents:subject)` on a
 * lightweight tag returns the pointed-at commit's subject (probe P3), which would read as an
 * annotation on a tag that has none, and the base format is shared with branches/remotes where
 * that risk is worse still (a branch's "subject" would just be its HEAD commit's). It DOES go
 * into `TAG_REFS_FORMAT`, used only for the tags-only scope (every record returned is guaranteed
 * to be a tag), with the *parser* gating it on `objecttype === "tag"` so a lightweight tag's
 * borrowed commit-subject is discarded rather than stored.
 */
import type { RefKind, RefRecord, RefTrack } from "@kira-version/core";
import { splitLimitedFields } from "@kira-version/core";

const FIELD_DELIMITER = 0x1f;
const FIELD_COUNT = 11;
const FIELD_COUNT_WITH_SUBJECT = 12;

/** for-each-ref has no `-z`; records are separated by this byte instead. */
export const REFS_RECORD_DELIMITER = 0x0a;

export const REFS_FORMAT =
  "%(refname)%1f%(objectname)%1f%(objecttype)%1f%(upstream)%1f%(upstream:track)%1f" +
  "%(committerdate:unix)%1f%(HEAD)%1f%(*objectname)%1f%(worktreepath)%1f" +
  "%(taggername)%1f%(taggerdate:unix)";

/** Tags-only: `REFS_FORMAT` plus `%(contents:subject)` — see the file header for why this is
 *  safe only when every returned record is already known to be a tag. */
export const TAG_REFS_FORMAT = `${REFS_FORMAT}%1f%(contents:subject)`;

/**
 * `"all"` keeps P1's exact behaviour (one spawn over all three ref roots, unsorted — the
 * existing integration tests do not move). `"heads"` and `"tags"` are two separate spawns rather
 * than one `--sort` split client-side: `for-each-ref` takes a single `--sort`, and git's
 * `v:refname` version-number comparison (§7.9: `v10` after `v9`) is not one JS should reimplement.
 */
export function refsArgs(scope: "all" | "heads" | "tags" = "all"): string[] {
  if (scope === "heads") {
    return [
      "for-each-ref",
      `--format=${REFS_FORMAT}`,
      "--sort=-committerdate",
      "refs/heads",
      "refs/remotes",
    ];
  }
  if (scope === "tags") {
    return ["for-each-ref", `--format=${TAG_REFS_FORMAT}`, "--sort=-v:refname", "refs/tags"];
  }
  return ["for-each-ref", `--format=${REFS_FORMAT}`, "refs/heads", "refs/remotes", "refs/tags"];
}

const decoder = new TextDecoder("utf-8", { fatal: false });

function classify(refname: string): { kind: RefKind; shortName: string } {
  if (refname.startsWith("refs/heads/")) {
    return { kind: "branch", shortName: refname.slice("refs/heads/".length) };
  }
  if (refname.startsWith("refs/remotes/")) {
    return { kind: "remoteBranch", shortName: refname.slice("refs/remotes/".length) };
  }
  return { kind: "tag", shortName: refname.replace(/^refs\/tags\//, "") };
}

function parseTrack(raw: string): RefTrack | "gone" | undefined {
  if (raw.length === 0) return undefined;
  if (raw === "[gone]") return "gone";
  const aheadMatch = /ahead (\d+)/.exec(raw);
  const behindMatch = /behind (\d+)/.exec(raw);
  return {
    ahead: aheadMatch?.[1] ? Number(aheadMatch[1]) : 0,
    behind: behindMatch?.[1] ? Number(behindMatch[1]) : 0,
  };
}

/**
 * `withSubject` must match which args builder produced `record` — `true` for
 * `refsArgs("tags")`'s `TAG_REFS_FORMAT`, `false` (the default) for `"all"`/`"heads"`'s
 * `REFS_FORMAT`. Passing the wrong one misframes every field after the mismatch, which is why
 * this is a caller-supplied flag rather than something inferred from field count at parse time.
 */
export function parseRefRecord(record: Uint8Array, withSubject = false): RefRecord {
  const fieldCount = withSubject ? FIELD_COUNT_WITH_SUBJECT : FIELD_COUNT;
  const [
    refname,
    objectId,
    objectType,
    upstream,
    track,
    committerDate,
    headMarker,
    peeled,
    worktreePath,
    taggerName,
    taggerDate,
    subject,
  ] = splitLimitedFields(record, FIELD_DELIMITER, fieldCount).map((field) => decoder.decode(field));

  const { kind, shortName } = classify(refname ?? "");
  const objType = (objectType as RefRecord["objectType"] | undefined) ?? "commit";
  const isTag = objType === "tag";

  return {
    refname: refname ?? "",
    kind,
    shortName,
    objectId: objectId ?? "",
    objectType: objType,
    peeledObjectId: peeled && peeled.length > 0 ? peeled : undefined,
    upstream: upstream && upstream.length > 0 ? upstream : undefined,
    track: parseTrack(track ?? ""),
    committerDate: Number(committerDate ?? 0),
    isHead: headMarker === "*",
    checkedOutIn: worktreePath && worktreePath.length > 0 ? worktreePath : undefined,
    // Gated on `isTag`, never on "does taggerName look non-empty" alone changing behaviour by
    // format — a lightweight tag's %(contents:subject) is the pointed-at COMMIT's subject
    // (probe P3) and must never be stored as this tag's own annotation.
    annotation:
      isTag && taggerName && taggerName.length > 0
        ? {
            tagger: taggerName,
            date: Number(taggerDate ?? 0),
            subject: withSubject ? (subject ?? "") : "",
          }
        : undefined,
  };
}
