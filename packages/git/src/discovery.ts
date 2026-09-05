/**
 * §4.2: locate git, probe its version, enforce the 2.38 floor, and read repository identity.
 * Nothing here spawns through `driver.ts` (W7) — discovery happens *before* a `GitDriver`
 * exists, so every function here takes a `ProcessRunner` directly.
 *
 * The 2.38 floor is a type-level guarantee, not a runtime check a call site can forget:
 * `ResolvedGit`'s constructor is not exported, so the only way to produce one is
 * `locateGit()` returning `{ kind: "ok" }`, and that branch is unreachable for a sub-2.38
 * git. A `GitDriver` (W7) will require a `ResolvedGit` to open, so a driver for too-old git
 * cannot be constructed at all.
 */
import { accessSync, constants as fsConstants } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import type { HeadState, ProcessExit, ProcessRunner, RepoIdentity } from "@kira-version/core";
import { ProcessSpawnError } from "./nodeProcessRunner.ts";

export interface GitVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly raw: string;
}

/** git 2.38 (Oct 2022) — `merge-tree --write-tree` is what makes §7.5/§7.6 possible at all. */
export const MINIMUM_GIT_VERSION: GitVersion = { major: 2, minor: 38, patch: 0, raw: "2.38.0" };

export function compareVersions(a: GitVersion, b: GitVersion): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

export function meetsMinimumVersion(version: GitVersion): boolean {
  return compareVersions(version, MINIMUM_GIT_VERSION) >= 0;
}

// Matches "2.39.5 (Apple Git-154)", "2.38.0.windows.1", "2.38.0-rc1", and "2.38.GIT" (a
// non-numeric patch suffix used by builds made directly from a checkout) — the patch group is
// optional so the last form still yields major/minor with patch defaulted to 0.
const VERSION_PATTERN = /^git version (\d+)\.(\d+)(?:\.(\d+))?/;

export function parseGitVersion(rawOutput: string): GitVersion | undefined {
  const match = VERSION_PATTERN.exec(rawOutput.trim());
  if (!match?.[1] || !match[2]) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] !== undefined ? Number(match[3]) : 0,
    raw: rawOutput.trim(),
  };
}

/** Opaque: constructible only by this module, so a `GitResolution` of kind `"ok"` is the only
 *  way to obtain one — see the module doc comment. */
class ResolvedGitImpl {
  constructor(
    readonly path: string,
    readonly version: GitVersion,
  ) {}
}
export type ResolvedGit = ResolvedGitImpl;

export type GitResolution =
  | { readonly kind: "ok"; readonly git: ResolvedGit }
  | { readonly kind: "notFound"; readonly probed: readonly string[] }
  | {
      readonly kind: "tooOld";
      readonly path: string;
      readonly detected: GitVersion;
      readonly required: GitVersion;
    }
  | {
      readonly kind: "unusable";
      readonly path: string;
      readonly reason: string;
      readonly stderr: string;
    };

// ---------------------------------------------------------------------------------------
// Low-level spawn-and-capture, shared by every probe below.
// ---------------------------------------------------------------------------------------

interface CaptureResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const decoder = new TextDecoder("utf-8", { fatal: false });

function sanitizedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Runs one command to completion. `undefined` means the executable could not be spawned at
 *  all (e.g. it does not exist) — distinct from git existing but exiting non-zero. */
async function runCapture(
  runner: ProcessRunner,
  executable: string,
  argv: readonly string[],
  opts: { cwd?: string; signal?: AbortSignal } = {},
): Promise<CaptureResult | undefined> {
  const proc = runner.spawn(executable, {
    argv,
    cwd: opts.cwd ?? process.cwd(),
    env: sanitizedEnv(),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  const chunks: Uint8Array[] = [];
  try {
    for await (const chunk of proc.stdout) chunks.push(chunk);
  } catch {
    // A stream error here means the process died; `exit` below carries the real signal.
  }

  let exit: ProcessExit;
  try {
    exit = await proc.exit;
  } catch (err) {
    if (err instanceof ProcessSpawnError) return undefined;
    throw err;
  }

  return {
    exitCode: exit.code,
    stdout: decoder.decode(concatBytes(chunks)),
    stderr: decoder.decode(await proc.stderr),
  };
}

// ---------------------------------------------------------------------------------------
// Version probe
// ---------------------------------------------------------------------------------------

type SingleProbeResult =
  | { readonly kind: "ok"; readonly version: GitVersion }
  | { readonly kind: "notFound" }
  | { readonly kind: "unusable"; readonly reason: string; readonly stderr: string };

async function probeVersion(
  runner: ProcessRunner,
  path: string,
  timeoutMs: number,
): Promise<SingleProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const captured = await runCapture(runner, path, ["--no-optional-locks", "version"], {
      signal: controller.signal,
    });
    if (captured === undefined) return { kind: "notFound" };
    if (controller.signal.aborted) {
      return {
        kind: "unusable",
        reason: `git version did not respond within ${timeoutMs}ms`,
        stderr: "",
      };
    }
    if (captured.exitCode !== 0) {
      return {
        kind: "unusable",
        reason: `'${path} version' exited with code ${captured.exitCode}`,
        stderr: captured.stderr,
      };
    }
    const version = parseGitVersion(captured.stdout);
    if (!version) {
      return {
        kind: "unusable",
        reason: `could not parse '${path} version' output: ${JSON.stringify(captured.stdout)}`,
        stderr: captured.stderr,
      };
    }
    return { kind: "ok", version };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------------------
// PATH lookup and the macOS PlatformGitLocator (§4.2, D27)
// ---------------------------------------------------------------------------------------

function searchPath(executableName: string): string | undefined {
  const pathEnv = process.env.PATH;
  if (!pathEnv) return undefined;
  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, executableName);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Not present, or not executable, in this PATH entry — keep looking.
    }
  }
  return undefined;
}

/** `/usr/bin/git` is the Command Line Tools shim: running it when CLT is not installed pops a
 *  system install dialog. Gate it behind `xcode-select -p` succeeding; never spawn it blind. */
async function xcodeCommandLineToolsInstalled(runner: ProcessRunner): Promise<boolean> {
  const captured = await runCapture(runner, "xcode-select", ["-p"]);
  return captured !== undefined && captured.exitCode === 0;
}

async function platformFallbackCandidates(
  runner: ProcessRunner,
  platform: NodeJS.Platform,
): Promise<readonly string[]> {
  if (platform === "darwin") {
    const candidates = ["/opt/homebrew/bin/git", "/usr/local/bin/git"];
    if (await xcodeCommandLineToolsInstalled(runner)) candidates.push("/usr/bin/git");
    return candidates;
  }
  if (platform === "linux") {
    // Not a support claim (D27 stays macOS-only for v1): this branch exists so discovery
    // fails with `notFound` rather than throwing past `RepoService.create()`'s unguarded
    // `await` (see docs/plans/P4c-linux-test-infra.md, W1) when PATH doesn't already have
    // git. No `xcode-select`-style gate here — unlike macOS's CLT shim, Linux's
    // `/usr/bin/git` is a real binary, not something that pops an install dialog when run.
    return ["/usr/bin/git", "/usr/local/bin/git", "/home/linuxbrew/.linuxbrew/bin/git"];
  }
  // win32 (and any other platform) is a named, unimplemented case (D27) — adding a platform
  // later is a new branch here, not a refactor of everything that calls this.
  throw new Error(
    `git discovery: platform '${platform}' is not supported yet (v1 is macOS-only, D27; Windows is not implemented)`,
  );
}

// ---------------------------------------------------------------------------------------
// locateGit — the full §4.2 resolution order
// ---------------------------------------------------------------------------------------

const DEFAULT_VERSION_TIMEOUT_MS = 5000;

export interface LocateGitOptions {
  readonly runner: ProcessRunner;
  /** `kiraVersion.git.path` then VS Code's `git.path`, in that order — empty until P3 wires
   *  host settings in. The mechanism is real and tested now; the settings source is not. */
  readonly configuredCandidates?: readonly string[];
  readonly timeoutMs?: number;
  /** Overrides `process.platform`. Production code never sets this; it exists so tests can
   *  exercise the macOS strategy (and the "exhausted every candidate" `notFound` case) on
   *  whatever OS actually runs the test suite. */
  readonly platform?: NodeJS.Platform;
}

export async function locateGit(opts: LocateGitOptions): Promise<GitResolution> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_VERSION_TIMEOUT_MS;
  const platform = opts.platform ?? process.platform;
  const probed: string[] = [];

  async function tryCandidate(candidate: string): Promise<GitResolution | undefined> {
    probed.push(candidate);
    const result = await probeVersion(opts.runner, candidate, timeoutMs);
    if (result.kind === "notFound") return undefined;
    if (result.kind === "unusable") {
      return { kind: "unusable", path: candidate, reason: result.reason, stderr: result.stderr };
    }
    if (!meetsMinimumVersion(result.version)) {
      return {
        kind: "tooOld",
        path: candidate,
        detected: result.version,
        required: MINIMUM_GIT_VERSION,
      };
    }
    return { kind: "ok", git: new ResolvedGitImpl(candidate, result.version) };
  }

  for (const candidate of opts.configuredCandidates ?? []) {
    const outcome = await tryCandidate(candidate);
    if (outcome) return outcome;
  }

  const onPath = searchPath("git");
  if (onPath) {
    const outcome = await tryCandidate(onPath);
    if (outcome) return outcome;
  }

  // Only reached once configured candidates and PATH are exhausted — an unsupported platform
  // must not fail discovery for a machine whose PATH already has a perfectly good git.
  for (const candidate of await platformFallbackCandidates(opts.runner, platform)) {
    const outcome = await tryCandidate(candidate);
    if (outcome) return outcome;
  }

  return { kind: "notFound", probed };
}

// ---------------------------------------------------------------------------------------
// Repository identity (§4.4's "Discovery and identity" commands)
// ---------------------------------------------------------------------------------------

export type RepoIdentityResolution =
  | { readonly kind: "ok"; readonly identity: RepoIdentity }
  | { readonly kind: "notARepository"; readonly stderr: string };

function resolveHeadState(
  symbolicRef: CaptureResult | undefined,
  headSha: CaptureResult | undefined,
): HeadState {
  const symbolicOk = symbolicRef !== undefined && symbolicRef.exitCode === 0;
  const shaOk = headSha !== undefined && headSha.exitCode === 0;

  if (symbolicOk && symbolicRef) {
    const name = symbolicRef.stdout.trim().replace(/^refs\/heads\//, "");
    return shaOk ? { kind: "branch", name } : { kind: "unborn", name };
  }
  return { kind: "detached", sha: shaOk && headSha ? headSha.stdout.trim() : "" };
}

/**
 * One `rev-parse` call for identity plus HEAD resolution. `--show-toplevel` is deliberately
 * *not* combined with the rest: it hard-fails ("must be run in a work tree") for a bare repo
 * and takes the whole multi-flag invocation down with it, so it is probed separately and its
 * failure — expected for a bare repo — falls back to using the git dir as the root.
 */
export async function resolveRepoIdentity(
  git: ResolvedGit,
  runner: ProcessRunner,
  cwd: string,
): Promise<RepoIdentityResolution> {
  const [core, toplevel, symbolicRef, headSha] = await Promise.all([
    runCapture(
      runner,
      git.path,
      ["--no-optional-locks", "rev-parse", "--is-bare-repository", "--git-dir", "--git-common-dir"],
      { cwd },
    ),
    runCapture(runner, git.path, ["--no-optional-locks", "rev-parse", "--show-toplevel"], { cwd }),
    runCapture(runner, git.path, ["--no-optional-locks", "symbolic-ref", "--quiet", "HEAD"], {
      cwd,
    }),
    runCapture(
      runner,
      git.path,
      ["--no-optional-locks", "rev-parse", "--verify", "--quiet", "HEAD"],
      { cwd },
    ),
  ]);

  if (core === undefined || core.exitCode !== 0) {
    return { kind: "notARepository", stderr: core?.stderr ?? "" };
  }

  const [isBareRaw, gitDirRaw, commonDirRaw] = core.stdout.split("\n");
  const isBare = isBareRaw === "true";
  const gitDir = resolve(cwd, (gitDirRaw ?? "").trim());
  const commonDir = resolve(cwd, (commonDirRaw ?? "").trim());
  // A bare repo has no work tree, so --show-toplevel fails; the git dir doubles as the root.
  const root = toplevel !== undefined && toplevel.exitCode === 0 ? toplevel.stdout.trim() : gitDir;

  return {
    kind: "ok",
    identity: {
      root,
      gitDir,
      commonDir,
      isBare,
      isLinkedWorktree: gitDir !== commonDir,
      head: resolveHeadState(symbolicRef, headSha),
    },
  };
}
