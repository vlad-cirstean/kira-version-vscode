#!/usr/bin/env bun
/**
 * P16 W3 — regenerates `packages/ipc/src/generated/graphChunk.ts` from
 * `packages/ipc/schema/graphChunk.fbs` via the pinned `flatc` (`scripts/fetch-flatc.ts`).
 * Modelled on `gen-settings.ts`'s shape (a `main()`, a `--check` mode, a clear regenerate
 * message), diverging only where the native toolchain forces it.
 *
 * `--check` (what `bun run check` calls as `check:schema`) does NOT run `flatc` — `bun install`
 * and `bun run check` must stay network-free and flatc-free (D47). It checks two things
 * offline instead, from text alone:
 *
 *   1. Staleness — the generated file's header records the sha256 of the `.fbs` input it was
 *      built from; `--check` recomputes that digest and fails if it differs, naming
 *      `bun run gen:schema` as the fix. This catches the one failure that actually happens:
 *      someone edits the schema and forgets to regenerate.
 *   2. Source hygiene — `graphChunk.fields.json` (committed, written by a real `gen:schema` run)
 *      locks each table's field names in declaration order. `--check` re-parses the `.fbs` — a
 *      file this project owns, in a deliberately plain subset of the grammar — and fails unless
 *      the current field list is a prefix-preserving extension of the locked one: no renames, no
 *      reorders, no deletions (a retired field keeps its slot with `(deprecated)`), appends only.
 *
 * What this deliberately does not catch: a generated file hand-edited to something the schema
 * would not have produced. The generated directory carries a "do not edit" header and is
 * excluded from Biome, so a hand edit is visible in review; W14/V1 confirms a clean `gen:schema`
 * reproduces the committed file byte-for-byte.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureFlatc } from "./fetch-flatc.ts";

const ROOT = join(import.meta.dir, "..");
const SCHEMA_PATH = join(ROOT, "packages", "ipc", "schema", "graphChunk.fbs");
const FIELDS_LOCK_PATH = join(ROOT, "packages", "ipc", "schema", "graphChunk.fields.json");
const GENERATED_PATH = join(ROOT, "packages", "ipc", "src", "generated", "graphChunk.ts");
const FLATC_LOCK_PATH = join(ROOT, "scripts", "flatc.lock.json");

// ---------------------------------------------------------------------------------------
// A deliberately plain subset of the .fbs grammar: `table Name { field: type; ... }`, one
// field per line, an optional trailing `//` comment. Good enough for this project's own schema,
// which this generator owns — not a general FlatBuffers IDL parser.
// ---------------------------------------------------------------------------------------

type TableFields = ReadonlyMap<string, readonly string[]>;

function stripLineComment(line: string): string {
  const at = line.indexOf("//");
  return at === -1 ? line : line.slice(0, at);
}

function parseFbsTables(fbsText: string): TableFields {
  const tables = new Map<string, string[]>();
  const tableRe = /table\s+(\w+)\s*\{([^}]*)\}/g;
  for (const match of fbsText.matchAll(tableRe)) {
    const [, name, body] = match;
    if (!name || body === undefined) continue;
    const fields: string[] = [];
    for (const rawLine of body.split("\n")) {
      const line = stripLineComment(rawLine).trim();
      if (line.length === 0) continue;
      const fieldMatch = /^([A-Za-z_]\w*)\s*:/.exec(line);
      if (fieldMatch?.[1]) fields.push(fieldMatch[1]);
    }
    tables.set(name, fields);
  }
  return tables;
}

function tableFieldsToJson(tables: TableFields): string {
  const obj: Record<string, readonly string[]> = {};
  for (const [name, fields] of tables) obj[name] = fields;
  return `${JSON.stringify(obj, null, 2)}\n`;
}

/** The append-only rule (F7), made mechanical: `locked`'s field list for a table must be a
 *  prefix of `current`'s — same names, same order, only appended-to. A table present in
 *  `locked` but missing from `current` is also a violation (a table cannot be deleted either). */
function checkAppendOnly(current: TableFields, locked: TableFields): string[] {
  const violations: string[] = [];
  for (const [table, lockedFields] of locked) {
    const currentFields = current.get(table);
    if (!currentFields) {
      violations.push(`table '${table}' was removed — the append-only rule forbids deleting it`);
      continue;
    }
    const prefixOk =
      lockedFields.length <= currentFields.length &&
      lockedFields.every((field, i) => currentFields[i] === field);
    if (!prefixOk) {
      violations.push(
        `table '${table}': fields [${currentFields.join(", ")}] are not a prefix-preserving ` +
          `extension of the locked order [${lockedFields.join(", ")}] — no renames, reorders or ` +
          "deletions; retire a field with '(deprecated)' and keep its slot, append new ones only",
      );
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------------------
// flatc invocation + post-processing. flatc's `--ts --ts-flat-files` emits one file per table
// (despite the flag's name) with relative `.js`-suffixed cross-file imports — this generator
// concatenates them into the single, import-free file this phase requires (D45), in dependency
// order, with one `flatbuffers` import at the top.
// ---------------------------------------------------------------------------------------

interface GeneratedTable {
  readonly className: string;
  readonly deps: readonly string[];
  readonly body: string;
}

function findGeneratedTableFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) findGeneratedTableFiles(full, out);
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function parseGeneratedTable(fileText: string): GeneratedTable | undefined {
  const classMatch = /export class (\w+)/.exec(fileText);
  if (!classMatch?.[1]) return undefined; // a pure re-export entry-point file — not a table

  const deps: string[] = [];
  const importRe = /^import \{ (\w+) \} from '\.[^']*';\s*$/gm;
  for (const match of fileText.matchAll(importRe)) {
    if (match[1]) deps.push(match[1]);
  }

  // Drop the boilerplate header, the flatbuffers import and every local relative import —
  // what remains is exactly the `export class ... { ... }` block, concatenated with its peers.
  const body = fileText
    .split("\n")
    .filter((line) => {
      if (/^\/\/ automatically generated/.test(line)) return false;
      if (/^\/\* eslint-disable/.test(line)) return false;
      if (/^import \* as flatbuffers from 'flatbuffers';$/.test(line)) return false;
      if (/^import \{ \w+ \} from '\.[^']*';$/.test(line)) return false;
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { className: classMatch[1], deps, body };
}

/** Kahn's algorithm, stable on ties (original discovery order) — a dependency (e.g.
 *  `DecorationRef`) is emitted before whatever references it, so the concatenated file reads
 *  top-down even though runtime order does not actually matter for class declarations used only
 *  inside method bodies. */
function topoSortTables(tables: readonly GeneratedTable[]): GeneratedTable[] {
  const byName = new Map(tables.map((t) => [t.className, t]));
  const visited = new Set<string>();
  const ordered: GeneratedTable[] = [];

  function visit(table: GeneratedTable): void {
    if (visited.has(table.className)) return;
    visited.add(table.className);
    for (const dep of table.deps) {
      const depTable = byName.get(dep);
      if (depTable) visit(depTable);
    }
    ordered.push(table);
  }

  for (const table of tables) visit(table);
  return ordered;
}

function runFlatc(flatcPath: string, schemaSha256: string, flatcVersion: string): string {
  const scratch = mkdtempSync(join(tmpdir(), "kira-gen-schema-"));
  try {
    execFileSync(flatcPath, ["--ts", "--ts-flat-files", "-o", scratch, SCHEMA_PATH], {
      stdio: "inherit",
    });
    const tableFiles = findGeneratedTableFiles(scratch)
      .map((path) => parseGeneratedTable(readFileSync(path, "utf8")))
      .filter((table): table is GeneratedTable => table !== undefined);
    const ordered = topoSortTables(tableFiles);

    const header = [
      "// GENERATED by scripts/gen-schema.ts — do not edit.",
      `// flatc ${flatcVersion}; schema packages/ipc/schema/graphChunk.fbs sha256:${schemaSha256}`,
      "//",
      "// P16 D46/D47 — CONTRACT_VERSION (packages/ipc/src/validate.ts) remains the sole",
      "// compatibility authority; FlatBuffers' own append-only field-order discipline is",
      "// enforced as source hygiene by `bun run check:schema`, not as a wire version. Run",
      "// `bun run gen:schema` to regenerate; never hand-edit this file.",
      "",
      'import * as flatbuffers from "flatbuffers";',
      "",
    ].join("\n");

    return `${header}${ordered.map((t) => t.body).join("\n\n")}\n`;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function sha256Of(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function loadFlatcVersion(): string {
  const lock = JSON.parse(readFileSync(FLATC_LOCK_PATH, "utf8")) as { readonly version: string };
  return lock.version;
}

/** The `schema-sha256` recorded in a generated file's own header — the thing `--check` compares
 *  against a fresh digest of the `.fbs` it claims to describe. */
function recordedSchemaDigest(generatedText: string): string | undefined {
  return /sha256:([0-9a-f]{64})/.exec(generatedText)?.[1];
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const schemaText = readFileSync(SCHEMA_PATH, "utf8");
  const currentTables = parseFbsTables(schemaText);
  const schemaSha256 = sha256Of(schemaText);

  if (check) {
    const problems: string[] = [];

    if (!existsSync(GENERATED_PATH)) {
      problems.push(`${GENERATED_PATH} does not exist — run \`bun run gen:schema\`.`);
    } else {
      const recorded = recordedSchemaDigest(readFileSync(GENERATED_PATH, "utf8"));
      if (recorded !== schemaSha256) {
        problems.push(
          "packages/ipc/src/generated/graphChunk.ts is stale (schema digest mismatch) — " +
            "run `bun run gen:schema` to regenerate.",
        );
      }
    }

    if (!existsSync(FIELDS_LOCK_PATH)) {
      problems.push(`${FIELDS_LOCK_PATH} does not exist — run \`bun run gen:schema\`.`);
    } else {
      const locked = new Map(
        Object.entries(
          JSON.parse(readFileSync(FIELDS_LOCK_PATH, "utf8")) as Record<string, string[]>,
        ),
      );
      problems.push(...checkAppendOnly(currentTables, locked));
    }

    if (problems.length > 0) {
      console.error("check:schema: failed —");
      for (const problem of problems) console.error(`  - ${problem}`);
      process.exit(1);
    }
    console.log("check:schema: packages/ipc/schema/graphChunk.fbs and its generated code agree.");
    return;
  }

  // A real `gen:schema` run still enforces the append-only rule against whatever is currently
  // locked, so the rule cannot be bypassed by regenerating instead of running --check.
  if (existsSync(FIELDS_LOCK_PATH)) {
    const locked = new Map(
      Object.entries(
        JSON.parse(readFileSync(FIELDS_LOCK_PATH, "utf8")) as Record<string, string[]>,
      ),
    );
    const violations = checkAppendOnly(currentTables, locked);
    if (violations.length > 0) {
      console.error("gen-schema: refusing to regenerate — the append-only rule was violated:");
      for (const violation of violations) console.error(`  - ${violation}`);
      process.exit(1);
    }
  }

  const flatcPath = await ensureFlatc();
  const flatcVersion = loadFlatcVersion();
  const generated = runFlatc(flatcPath, schemaSha256, flatcVersion);

  mkdirSync(join(ROOT, "packages", "ipc", "src", "generated"), { recursive: true });
  writeFileSync(GENERATED_PATH, generated);
  writeFileSync(FIELDS_LOCK_PATH, tableFieldsToJson(currentTables));
  // graphChunk.fields.json is ordinary (Biome-formatted) source, unlike src/generated — run the
  // already-installed formatter on it so `bun run format:check` never disagrees with this writer.
  execFileSync(join(ROOT, "node_modules", ".bin", "biome"), [
    "format",
    "--write",
    FIELDS_LOCK_PATH,
  ]);
  console.log(`gen-schema: wrote ${GENERATED_PATH} and ${FIELDS_LOCK_PATH}.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
