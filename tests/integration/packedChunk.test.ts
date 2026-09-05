import { describe, expect, test } from "bun:test";
import type { CommitRecord } from "../../packages/core/src/model/commit.ts";
import { CommitStore, packedTransferList } from "../../packages/core/src/store/commitStore.ts";
import { locateGit, resolveRepoIdentity } from "../../packages/git/src/discovery.ts";
import { openLogSession } from "../../packages/git/src/logSession.ts";
import { NodeProcessRunner } from "../../packages/git/src/nodeProcessRunner.ts";
import { large } from "../fixtures/generateRepo.ts";

/**
 * `packages/core`'s own `tests/unit/store/wire.test.ts` already proves `packSlice`/
 * `appendPacked`/`structuredClone`-with-transfer round-trip correctly, against small synthetic
 * topologies built by hand. What that suite cannot exercise is realistic scale and real git
 * output — real shas, real author/committer identities, real subjects, real ref decorations —
 * flowing through the same wire path "without a host" (no `RepoService`, no `rpc.ts`): this is
 * that proof, at the 5,000-row page size `docs/plans/P3.md`'s W16 names.
 */

describe("a 5,000-row packed chunk from a real repository survives the wire", () => {
  test("structuredClone with packedTransferList rebuilds an identical store", async () => {
    const PAGE_SIZE = 5000;
    const repo = large(PAGE_SIZE);
    const runner = new NodeProcessRunner();

    const gitResolution = await locateGit({ runner });
    if (gitResolution.kind !== "ok") throw new Error("no usable system git found for this test");
    const identityResolution = await resolveRepoIdentity(gitResolution.git, runner, repo.dir);
    if (identityResolution.kind !== "ok") throw new Error("expected a real repository");

    const session = openLogSession(gitResolution.git, runner, identityResolution.identity.root, {
      walk: { kind: "scope", scope: "all" },
      pageSize: PAGE_SIZE,
    });
    const records: CommitRecord[] = [];
    try {
      const outcome = await session.readPage((record) => records.push(record));
      expect(outcome.kind).toBe("page");
    } finally {
      session.dispose();
    }
    expect(records.length).toBe(PAGE_SIZE);

    const source = new CommitStore();
    source.appendPage(records);
    expect(source.rowCount).toBe(PAGE_SIZE);

    const chunk = source.packSlice(0, source.rowCount, 0);
    const transfer = packedTransferList(chunk);
    expect(transfer.length).toBeGreaterThan(0);

    const cloned = structuredClone(chunk, { transfer });
    // A real transfer, not a silent structural copy — every listed buffer is detached on the
    // sending side once `structuredClone` hands it to the receiver.
    for (const buffer of transfer) expect(buffer.byteLength).toBe(0);

    const receiver = new CommitStore();
    const result = receiver.appendPacked(cloned);
    expect(result.from).toBe(0);
    expect(result.to).toBe(PAGE_SIZE);
    expect(receiver.rowCount).toBe(source.rowCount);

    for (let row = 0; row < source.rowCount; row++) {
      expect(receiver.shaAt(row)).toBe(source.shaAt(row));
      expect(receiver.subjectAt(row)).toBe(source.subjectAt(row));
      expect(receiver.authorAt(row)).toEqual(source.authorAt(row));
      expect(receiver.committerAt(row)).toEqual(source.committerAt(row));
      expect(Array.from(receiver.parentsOf(row))).toEqual(Array.from(source.parentsOf(row)));
      expect(receiver.decorationAt(row)).toEqual(source.decorationAt(row));
      expect(receiver.commitAt(row)).toEqual(source.commitAt(row));
    }
  }, 30_000);
});
