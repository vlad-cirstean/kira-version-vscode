import { describe, expect, test } from "bun:test";
import type { FileChange } from "../../../packages/ipc/src/contract.ts";
import {
  buildFileTree,
  buildFlatList,
  capRows,
  filterFiles,
  flattenTreeRows,
  renameDisplay,
} from "../../../packages/ui/src/components/fileTreeModel.ts";

function change(path: string, overrides: Partial<FileChange> = {}): FileChange {
  return {
    kind: "modified",
    path,
    originalPath: undefined,
    similarity: undefined,
    additions: 1,
    deletions: 1,
    isBinary: false,
    ...overrides,
  };
}

describe("filterFiles", () => {
  test("an empty filter keeps every file, in its original index order", () => {
    const files = [change("a.ts"), change("b.ts")];
    expect(filterFiles(files, "")).toEqual([
      { change: files[0] as FileChange, fileIndex: 0 },
      { change: files[1] as FileChange, fileIndex: 1 },
    ]);
  });

  test("matches case-insensitively, by substring, anywhere in the path", () => {
    const files = [change("src/Added.ts"), change("src/other.ts")];
    expect(filterFiles(files, "added").map((f) => f.fileIndex)).toEqual([0]);
  });

  test("whitespace-only filter behaves like empty", () => {
    const files = [change("a.ts")];
    expect(filterFiles(files, "   ")).toHaveLength(1);
  });
});

describe("buildFlatList", () => {
  test("sorts by full path regardless of input order", () => {
    const files = [change("b.ts"), change("a.ts")];
    const indexed = filterFiles(files, "");
    const flat = buildFlatList(indexed);
    expect(flat.map((n) => n.path)).toEqual(["a.ts", "b.ts"]);
    // fileIndex still points at the ORIGINAL files array, not the sorted position.
    expect(flat.find((n) => n.path === "b.ts")?.fileIndex).toBe(0);
  });
});

describe("buildFileTree", () => {
  test("a single top-level file is one file node, no directories", () => {
    const files = [change("readme.md")];
    const tree = buildFileTree(filterFiles(files, ""));
    expect(tree).toEqual([
      {
        kind: "file",
        name: "readme.md",
        path: "readme.md",
        change: files[0] as FileChange,
        fileIndex: 0,
      },
    ]);
  });

  test("directories aggregate their descendants' additions/deletions/file counts", () => {
    const files = [
      change("src/a.ts", { additions: 3, deletions: 1 }),
      change("src/b.ts", { additions: 2, deletions: 0 }),
    ];
    const tree = buildFileTree(filterFiles(files, ""));
    expect(tree).toHaveLength(1);
    const dir = tree[0];
    if (dir?.kind !== "directory") throw new Error("expected a directory node");
    expect(dir.name).toBe("src");
    expect(dir.additions).toBe(5);
    expect(dir.deletions).toBe(1);
    expect(dir.fileCount).toBe(2);
    expect(dir.children).toHaveLength(2);
  });

  test("a single-child directory chain collapses into one row (src/main/java/)", () => {
    const files = [change("src/main/java/App.java")];
    const tree = buildFileTree(filterFiles(files, ""));
    expect(tree).toHaveLength(1);
    const dir = tree[0];
    if (dir?.kind !== "directory") throw new Error("expected a directory node");
    expect(dir.name).toBe("src/main/java");
    expect(dir.path).toBe("src/main/java");
    expect(dir.children).toEqual([
      {
        kind: "file",
        name: "App.java",
        path: "src/main/java/App.java",
        change: files[0] as FileChange,
        fileIndex: 0,
      },
    ]);
  });

  test("a directory with a file of its own and one subdirectory does NOT collapse", () => {
    const files = [change("src/index.ts"), change("src/lib/util.ts")];
    const tree = buildFileTree(filterFiles(files, ""));
    expect(tree).toHaveLength(1);
    const src = tree[0];
    if (src?.kind !== "directory") throw new Error("expected a directory node");
    expect(src.name).toBe("src");
    // Two children: the "lib" directory and "index.ts" — directories sort before files.
    expect(src.children.map((c) => c.name)).toEqual(["lib", "index.ts"]);
  });

  test("directories are sorted before files, both alphabetically", () => {
    const files = [change("zeta.ts"), change("dir/inner.ts"), change("alpha.ts")];
    const tree = buildFileTree(filterFiles(files, ""));
    expect(tree.map((n) => n.name)).toEqual(["dir", "alpha.ts", "zeta.ts"]);
  });

  test("a binary file's undefined additions/deletions count as zero in an aggregate", () => {
    const files = [
      change("assets/img.png", { additions: undefined, deletions: undefined, isBinary: true }),
      change("assets/other.ts", { additions: 4, deletions: 2 }),
    ];
    const tree = buildFileTree(filterFiles(files, ""));
    const dir = tree[0];
    if (dir?.kind !== "directory") throw new Error("expected a directory node");
    expect(dir.additions).toBe(4);
    expect(dir.deletions).toBe(2);
  });
});

describe("flattenTreeRows", () => {
  test("a collapsed directory hides its whole subtree from the row list", () => {
    const files = [change("dir/a.ts"), change("dir/b.ts"), change("top.ts")];
    const tree = buildFileTree(filterFiles(files, ""));
    const rows = flattenTreeRows(tree, () => false);
    expect(rows).toEqual([
      {
        kind: "directory",
        node: expect.objectContaining({ name: "dir" }),
        depth: 0,
        expanded: false,
      },
      { kind: "file", node: expect.objectContaining({ name: "top.ts" }), depth: 0 },
    ]);
  });

  test("an expanded directory's children appear right after it, one depth deeper", () => {
    const files = [change("dir/a.ts")];
    const tree = buildFileTree(filterFiles(files, ""));
    const rows = flattenTreeRows(tree, () => true);
    expect(rows.map((r) => [r.kind, r.depth])).toEqual([
      ["directory", 0],
      ["file", 1],
    ]);
  });
});

describe("capRows", () => {
  test("under the cap: nothing is hidden", () => {
    const rows = [{ kind: "file" as const, node: {} as never, depth: 0 }];
    expect(capRows(rows, 500)).toEqual({ visible: rows, hiddenCount: 0 });
  });

  test("over the cap: truncates and reports the hidden count", () => {
    const rows = Array.from({ length: 10 }, () => ({
      kind: "file" as const,
      node: {} as never,
      depth: 0,
    }));
    const capped = capRows(rows, 4);
    expect(capped.visible).toHaveLength(4);
    expect(capped.hiddenCount).toBe(6);
  });
});

describe("renameDisplay", () => {
  test("undefined for a non-rename", () => {
    expect(renameDisplay(change("a.ts"))).toBeUndefined();
  });

  test("a same-directory rename truncates the shared directory, keeping both filenames", () => {
    const c = change("src/new.ts", { kind: "renamed", originalPath: "src/old.ts" });
    expect(renameDisplay(c)).toEqual({ from: "old.ts", to: "new.ts" });
  });

  test("a rename that also moves directories keeps each side's own remaining path", () => {
    const c = change("dst/new.ts", { kind: "renamed", originalPath: "src/old.ts" });
    expect(renameDisplay(c)).toEqual({ from: "src/old.ts", to: "dst/new.ts" });
  });
});
