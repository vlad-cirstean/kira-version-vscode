/**
 * Harness-local, browser-safe equivalent of `tests/fixtures/topology.ts`'s spec parser and
 * builder (P3 W14). That fixture calls `node:crypto`'s `createHash` for deterministic shas —
 * fine for the Bun/Node unit tests that import it, fatal here: Vite silently externalizes
 * `node:` built-ins for a browser bundle (stubs them to `{}` rather than failing the build), so
 * `createHash` would be `undefined` and throw the moment a scenario actually built its
 * topology. This file keeps the same `"name"` / `"name:parent1,parent2"` spec format and
 * algorithm, swapping only the hash function for one that runs in a browser — it is a sibling
 * of the fixture, not a replacement for it; `tests/fixtures/topology.ts` still backs the P2
 * unit tests that already depend on its exact (Node-only) shas.
 */
import type { CommitRecord } from "@kira-version/core";

// Exported (P4 W12) so `main.ts` can pin the harness's own clock to a fixed point relative to
// these same fixture timestamps — see `main.ts`'s "deterministic clock" comment for why.
export const EPOCH_SECONDS = 1_700_000_000;
export const STEP_SECONDS = 3600;
const AUTHOR_NAME = "Kira Fixture";
const AUTHOR_EMAIL = "fixture@kira-version.test";

export class TopologyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TopologyError";
  }
}

/** FNV-1a over 32 bits, five differently-seeded words concatenated into a 40-hex-char
 *  (160-bit) string standing in for a sha1 — deterministic per name, with no dependency on
 *  `node:crypto`. Collisions are not a concern at the scale any one scenario names commits. */
function fnv1aWord(input: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// Exported (P11 W18) so tests/perf/graphUi.ts's `searchKeystrokeMs` sha-prefix probe can name a
// real, known commit's sha without duplicating this hash — the same reason `chain`/`EPOCH_SECONDS`
// above are already exported for that same script.
export function shaFor(name: string): string {
  const input = `topology-fixture:${name}`;
  let hex = "";
  for (let word = 0; word < 5; word++) {
    hex += fnv1aWord(input, 0x811c9dc5 + word)
      .toString(16)
      .padStart(8, "0");
  }
  return hex;
}

interface ParsedEntry {
  readonly name: string;
  readonly parents: readonly string[];
}

function parseEntry(spec: string, index: number): ParsedEntry {
  const colon = spec.indexOf(":");
  const name = (colon === -1 ? spec : spec.slice(0, colon)).trim();
  if (name.length === 0) {
    throw new TopologyError(`topology(): entry ${index} (${JSON.stringify(spec)}) has no name`);
  }
  const parents =
    colon === -1
      ? []
      : spec
          .slice(colon + 1)
          .split(",")
          .map((p) => p.trim())
          .filter((p) => p.length > 0);
  return { name, parents };
}

/**
 * Builds a topology from `"name"` / `"name:parent1,parent2"` entries, oldest-first — the order
 * a human writes a topology in. Every parent must name an entry that already appeared earlier
 * in `spec`, so a cycle is structurally impossible rather than something detected after the
 * fact. Returns `CommitRecord[]` newest-first, exactly as `git log --topo-order` emits — see
 * `tests/fixtures/topology.ts`'s own doc comment for the full reasoning; the algorithm here is
 * identical.
 */
export function topology(spec: readonly string[]): CommitRecord[] {
  const known = new Map<string, ParsedEntry>();
  const order: ParsedEntry[] = [];

  spec.forEach((raw, index) => {
    const entry = parseEntry(raw, index);
    if (known.has(entry.name)) {
      throw new TopologyError(`topology(): duplicate commit name ${JSON.stringify(entry.name)}`);
    }
    for (const parent of entry.parents) {
      if (!known.has(parent)) {
        throw new TopologyError(
          `topology(): entry ${JSON.stringify(entry.name)} names unknown parent ` +
            `${JSON.stringify(parent)} (parents must be defined earlier in the spec)`,
        );
      }
    }
    known.set(entry.name, entry);
    order.push(entry);
  });

  const records: CommitRecord[] = order.map((entry, index) => {
    const timestamp = EPOCH_SECONDS + index * STEP_SECONDS;
    const identity = { name: AUTHOR_NAME, email: AUTHOR_EMAIL, timestamp };
    return {
      sha: shaFor(entry.name),
      parents: entry.parents.map(shaFor),
      author: identity,
      committer: identity,
      subject: entry.name,
      decoration: [],
    };
  });

  return records.reverse();
}

/**
 * `count` linear commits newest-first, without going through `topology()`'s spec-string
 * parsing — `hugeRepo`'s tens of thousands of rows need a generator that costs O(1) string
 * work per commit, not a many-thousand-entry spec array built and parsed just to describe a
 * straight line.
 */
export function chain(count: number, prefix: string): CommitRecord[] {
  const records: CommitRecord[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const name = `${prefix}-${i}`;
    const parentName = i > 0 ? `${prefix}-${i - 1}` : undefined;
    records.push(commitByName(name, parentName ? [parentName] : [], i));
  }
  return records;
}

/**
 * One `CommitRecord` by name, exactly as `chain()` and `topology()` each build one internally —
 * exported (P4 W13) so a scenario that needs a *shaped* history no O(1) generator here already
 * covers (e.g. `pagedBranch`'s trunk-plus-one-open-side-branch, where the two chains must
 * interleave in a specific row order) can still avoid `topology()`'s spec-string parsing at
 * multi-thousand-commit scale. `index` only ever feeds the timestamp — callers needing a stable
 * `EPOCH_SECONDS`-relative ordering across two independently-generated chains should pick indices
 * from one shared, monotonic sequence, the same way this file's own two generators already do.
 */
export function commitByName(
  name: string,
  parentNames: readonly string[],
  index: number,
): CommitRecord {
  const timestamp = EPOCH_SECONDS + index * STEP_SECONDS;
  const identity = { name: AUTHOR_NAME, email: AUTHOR_EMAIL, timestamp };
  return {
    sha: shaFor(name),
    parents: parentNames.map(shaFor),
    author: identity,
    committer: identity,
    subject: name,
    decoration: [],
  };
}
