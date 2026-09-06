#!/usr/bin/env bun
/**
 * P16 W1 — fetches the pinned `flatc` binary named in `flatc.lock.json`, verifies its digest,
 * and unzips it into `.flatc/<version>/flatc` (gitignored, `.vscode-test`'s precedent). Nothing
 * binary is committed; the lock's sha256 is the integrity mechanism (D47).
 *
 * Not a `postinstall`, and not called by `bun run check` — only `gen:schema` (and this file's own
 * CLI entry, `bun run fetch:flatc`) ever run it. `bun install`/`bun run check` stay network-free
 * and flatc-free (D47).
 *
 * Idempotent: if the pinned version's binary already exists on disk, this makes no network call.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const LOCK_PATH = join(ROOT, "scripts", "flatc.lock.json");
const FLATC_DIR = join(ROOT, ".flatc");

interface PlatformEntry {
  readonly asset: string;
  readonly url: string;
  readonly sha256: string;
}

interface FlatcLock {
  readonly version: string;
  readonly platforms: Readonly<Record<string, PlatformEntry>>;
}

function loadLock(): FlatcLock {
  return JSON.parse(readFileSync(LOCK_PATH, "utf8")) as FlatcLock;
}

/** D27's "platform-conditional code sits behind named strategies with the other platforms as
 *  explicit unimplemented cases" — this project has exactly two lanes (macOS, the platform of
 *  record; Linux, P4c's dev lane), so those are the only two keys `flatc.lock.json` carries. */
function platformKey(): string {
  if (process.platform === "linux" && process.arch === "x64") return "linux-x64";
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  throw new Error(
    `fetch-flatc: unsupported platform '${process.platform}-${process.arch}' — ` +
      "this project's flatc.lock.json only pins linux-x64 and darwin-arm64.",
  );
}

export function flatcBinaryPath(lock: FlatcLock = loadLock()): string {
  return join(FLATC_DIR, lock.version, "flatc");
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`fetch-flatc: GET ${url} failed with HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function sha256Of(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Ensures the pinned `flatc` is present at `flatcBinaryPath()` and returns that path. A no-op,
 * network-free, when the binary already exists — `gen:schema` calls this on every run, so a
 * developer who already fetched once pays nothing for it.
 */
export async function ensureFlatc(): Promise<string> {
  const lock = loadLock();
  const binaryPath = flatcBinaryPath(lock);
  if (existsSync(binaryPath)) return binaryPath;

  const key = platformKey();
  const entry = lock.platforms[key];
  if (!entry) {
    throw new Error(`fetch-flatc: flatc.lock.json has no entry for platform '${key}'`);
  }

  console.log(`fetch-flatc: downloading ${entry.asset} (flatc ${lock.version}) for ${key}...`);
  const zipBytes = await download(entry.url);
  const actualSha256 = sha256Of(zipBytes);
  if (actualSha256 !== entry.sha256) {
    throw new Error(
      `fetch-flatc: digest mismatch for ${entry.asset} — expected sha256:${entry.sha256}, ` +
        `got sha256:${actualSha256}. Refusing to use an unverified flatc binary.`,
    );
  }

  const scratch = mkdtempSync(join(tmpdir(), "kira-flatc-"));
  try {
    const zipPath = join(scratch, entry.asset);
    await Bun.write(zipPath, zipBytes);
    const destDir = join(FLATC_DIR, lock.version);
    mkdirSync(destDir, { recursive: true });
    // The two pinned assets each contain exactly one top-level `flatc` file (verified at pin
    // time) — `unzip` is a plain system dependency of this dev-only script, never of the build.
    execFileSync("unzip", ["-o", zipPath, "-d", destDir], { stdio: "inherit" });
    chmodSync(join(destDir, "flatc"), 0o755);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  console.log(`fetch-flatc: verified sha256:${actualSha256} — flatc ${lock.version} ready.`);
  return binaryPath;
}

async function main(): Promise<void> {
  const binaryPath = await ensureFlatc();
  const version = execFileSync(binaryPath, ["--version"], { encoding: "utf8" }).trim();
  console.log(`fetch-flatc: ${binaryPath} -> ${version}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
