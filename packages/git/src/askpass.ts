/**
 * P8/W13 — the askpass broker. `docs/plans/P8.md`'s "The hard parts" §4: one of four independent
 * guarantees that no remote operation can ever hang on a credential prompt, and the only one this
 * file is responsible for (`GIT_TERMINAL_PROMPT=0` and `detached: true`/`setsid()` are
 * `driver.ts`'s; op-level cancel is `RepoService`'s).
 *
 * The mechanism: before a remote op spawns, `RepoService` (W14) calls `withOp(opId, prompt, fn)`.
 * Inside `fn`, the op is spawned with `GIT_ASKPASS` pointed at a tiny shim this broker wrote to a
 * per-session `0700` temp dir. If git needs a credential, it execs that shim with the prompt text
 * as `argv[1]`; the shim execs this same Node binary (`process.execPath`, not whatever "node"
 * happens to resolve to on `$PATH` — the extension host's own binary is the only one guaranteed
 * to exist) running a tiny helper script, which connects to a unix domain socket this broker
 * listens on, sends `{ token, opId, prompt }` as one NUL-free JSON line, and waits — bounded by
 * its OWN timeout, not this process's — for a `{ ok, answer? }` response line. On timeout,
 * broker-side rejection (bad token, unknown opId, or the registered `CredentialPrompt` dismissing
 * it), or the socket simply going away, the helper prints nothing and exits non-zero, which is
 * exactly probe 8's `terminal prompts disabled` shape — git dies, never hangs.
 *
 * **Per-op, not per-session, is the opId.** `start()` returns the three env vars that are
 * constant for the broker's whole lifetime (`GIT_ASKPASS`, `KIRA_ASKPASS_SOCK`,
 * `KIRA_ASKPASS_TOKEN` — one shim, one socket, one session-wide secret proving "this child was
 * spawned by our own `writeStreaming`", not "this is credential-bearing traffic" on its own).
 * `withOp` layers one more env var, `KIRA_ASKPASS_OPID`, onto that for the one spawn it wraps —
 * the caller merges `start()`'s `env` with `withOp`'s `opEnv` argument for that spawn only. Since
 * P8 rejects a second concurrent remote op outright (`OperationInProgress`, OQ7) rather than
 * queueing, at most one `opId` is ever registered at a time in practice — but the broker still
 * validates it on every message rather than assuming that invariant, so a stray or delayed
 * connection from a *previous*, already-finished op can never be answered by a *new* op's prompt.
 *
 * **We do not override the user's own askpass.** `shouldInterposeAskpass` is `RepoService`'s
 * gate, checked once per repo against `git config --get core.askPass` and the host environment's
 * own `GIT_ASKPASS`, before it ever calls `withOp` — a user who configured a credential manager
 * configured it deliberately (§4.1). This file only supplies the mechanism; deciding whether to
 * use it lives one level up.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialPrompt } from "@kira-version/core";

/** The default bound on how long a single credential prompt may stay open — both the helper's
 *  own wait and, mirrored broker-side, how long `prompt.ask()` is given before its `signal`
 *  fires. Probe 8's own middle row: git gives up and reports `terminal prompts disabled` well
 *  within this. */
export const DEFAULT_ASKPASS_TIMEOUT_MS = 120_000;

export interface AskpassSession {
  /** Merge into every remote-op spawn's env, alongside `withOp`'s per-op `opEnv`. Constant for
   *  this broker's whole lifetime. */
  readonly env: Readonly<Record<string, string>>;
  /** Closes the socket, deletes the session temp dir, and clears every registered op. Safe to
   *  call more than once. */
  dispose(): void;
}

export interface AskpassBrokerOptions {
  /** Overrides `DEFAULT_ASKPASS_TIMEOUT_MS` — tests use a small value so "the broker's own
   *  timeout" is provable in milliseconds, not two real minutes. */
  readonly timeoutMs?: number;
}

/** git's own two prompt shapes are `Username for '<url>': ` (never a secret — shown in the
 *  clear) and everything else (`Password for '<url>': `, `Enter passphrase for key '<path>': `,
 *  and any credential-helper-specific wording this file has never seen) — masked. Defaulting to
 *  masked on the unrecognised case errs toward hiding, per the plan's own "defaulting to masked"
 *  (`docs/plans/P8.md`'s §4): showing an unrecognised secret in the clear is the worse failure
 *  mode of the two. */
const UNMASKED_PROMPT = /^Username/i;

export function deriveMasked(promptText: string): boolean {
  return !UNMASKED_PROMPT.test(promptText);
}

/** `RepoService`'s own gate (§4.1's config-fidelity rule), pure so it needs no git spawn to
 *  test: pass whatever `git config --get core.askPass` and the host environment's own
 *  `GIT_ASKPASS` actually are (both `undefined`/empty when unset) and this says whether the
 *  broker should be used at all for that repo's spawns. Either one being non-empty means the
 *  user configured their own — leave it alone entirely. */
export function shouldInterposeAskpass(config: {
  readonly coreAskPass: string | undefined;
  readonly inheritedGitAskpass: string | undefined;
}): boolean {
  if (config.coreAskPass !== undefined && config.coreAskPass.length > 0) return false;
  if (config.inheritedGitAskpass !== undefined && config.inheritedGitAskpass.length > 0) {
    return false;
  }
  return true;
}

interface BrokerMessage {
  readonly token: string;
  readonly opId: string;
  readonly prompt: string;
}

function isBrokerMessage(value: unknown): value is BrokerMessage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.token === "string" && typeof v.opId === "string" && typeof v.prompt === "string";
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

/** The helper's own source, written verbatim into the session dir and exec'd by the shim —
 *  plain CommonJS, no dependency beyond `node:net`, since this runs standalone (not through this
 *  package's own bundler) as whatever `process.execPath` the extension host resolved to. Never
 *  edited on disk; regenerated fresh by every `start()`. */
function helperScriptSource(): string {
  return `"use strict";
const net = require("node:net");

const promptText = process.argv[2] || "";
const sockPath = process.env.KIRA_ASKPASS_SOCK;
const token = process.env.KIRA_ASKPASS_TOKEN;
const opId = process.env.KIRA_ASKPASS_OPID;
const timeoutMs = Number(process.env.KIRA_ASKPASS_TIMEOUT_MS || ${DEFAULT_ASKPASS_TIMEOUT_MS});

function fail(message) {
  if (message) process.stderr.write(message + "\\n");
  process.exit(1);
}

if (!sockPath || !token || !opId) fail("askpass: missing broker environment");

let settled = false;
let buffer = "";
const socket = net.createConnection(sockPath);

const timer = setTimeout(() => {
  if (settled) return;
  settled = true;
  socket.destroy();
  fail("askpass: timed out waiting for an answer");
}, timeoutMs);
// Never keeps the helper process alive on its own — the socket connection is what does that.
timer.unref();

socket.on("connect", () => {
  socket.write(JSON.stringify({ token: token, opId: opId, prompt: promptText }) + "\\n");
});

socket.on("data", (chunk) => {
  if (settled) return;
  buffer += chunk.toString("utf8");
  const nl = buffer.indexOf("\\n");
  if (nl === -1) return;
  settled = true;
  clearTimeout(timer);
  const line = buffer.slice(0, nl);
  socket.end();
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    fail("askpass: malformed broker response");
    return;
  }
  if (parsed && parsed.ok === true && typeof parsed.answer === "string") {
    process.stdout.write(parsed.answer + "\\n");
    process.exit(0);
  } else {
    fail();
  }
});

socket.on("error", () => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  fail("askpass: could not reach the broker");
});

socket.on("close", () => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  fail("askpass: broker closed the connection");
});
`;
}

function posixShimSource(execPath: string, helperPath: string): string {
  return `#!/bin/sh\nexec "${execPath}" "${helperPath}" "$1"\n`;
}

/** Windows shim (OQ8: shipped, explicitly untested by CI — this repo's integration tier runs on
 *  Linux, `docs/plans/P8.md`'s "Windows is a named gap"). `%*` forwards every argument rather
 *  than only `%1`, since batch's own quoting of a single `%1` containing spaces is unreliable. */
function windowsShimSource(execPath: string, helperPath: string): string {
  return `@echo off\r\n"${execPath}" "${helperPath}" %*\r\n`;
}

/**
 * One broker per `RepoService` (or per extension-host process — either lifetime is fine, since
 * `start()` is idempotent-by-construction-failure: calling it twice on the same instance throws
 * rather than silently handing back a second, orphaned session).
 */
export class AskpassBroker {
  readonly #timeoutMs: number;
  readonly #active = new Map<string, CredentialPrompt>();
  #server: net.Server | undefined;
  #dir: string | undefined;
  #token: string | undefined;

  constructor(opts: AskpassBrokerOptions = {}) {
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_ASKPASS_TIMEOUT_MS;
  }

  async start(): Promise<AskpassSession> {
    if (this.#dir !== undefined) {
      throw new Error("AskpassBroker.start() called twice on the same instance");
    }

    // `mkdtemp` creates the directory at mode 0700 itself (POSIX `mkdtemp(3)`'s own guarantee) —
    // nothing else in this process, and no other OS user, can read the shim, the helper, the
    // socket, or the session token that live inside it.
    const dir = await mkdtemp(join(tmpdir(), "kira-askpass-"));
    const token = randomHex(32);
    const sockPath = join(dir, "sock");
    const helperPath = join(dir, "helper.cjs");
    const shimPath = join(dir, process.platform === "win32" ? "askpass.bat" : "askpass.sh");

    await writeFile(helperPath, helperScriptSource(), { mode: 0o700 });
    const shimSource =
      process.platform === "win32"
        ? windowsShimSource(process.execPath, helperPath)
        : posixShimSource(process.execPath, helperPath);
    await writeFile(shimPath, shimSource, { mode: 0o700 });

    const server = net.createServer((socket) => this.#handleConnection(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(sockPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });

    this.#server = server;
    this.#dir = dir;
    this.#token = token;

    const env: Readonly<Record<string, string>> = {
      GIT_ASKPASS: shimPath,
      KIRA_ASKPASS_SOCK: sockPath,
      KIRA_ASKPASS_TOKEN: token,
    };
    return { env, dispose: () => this.#dispose() };
  }

  /**
   * Registers `prompt` as the answerer for `opId` for the duration of `fn`, then unregisters it
   * unconditionally (success, rejection, or throw) — a `CredentialPrompt` never outlives the op
   * it was supplied for. `fn` receives the one extra env var (`KIRA_ASKPASS_OPID`, plus the
   * timeout mirrored into `KIRA_ASKPASS_TIMEOUT_MS` so the helper's own bound matches this
   * broker's) to merge onto `start()`'s session env for that one spawn.
   */
  async withOp<T>(
    opId: string,
    prompt: CredentialPrompt,
    fn: (opEnv: Readonly<Record<string, string>>) => Promise<T>,
  ): Promise<T> {
    this.#active.set(opId, prompt);
    try {
      return await fn({
        KIRA_ASKPASS_OPID: opId,
        KIRA_ASKPASS_TIMEOUT_MS: String(this.#timeoutMs),
      });
    } finally {
      this.#active.delete(opId);
    }
  }

  #handleConnection(socket: net.Socket): void {
    let buffer = "";
    let settled = false;
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      buffer += chunk.toString("utf8");
      const nl = buffer.indexOf("\n");
      if (nl === -1) return;
      settled = true;
      void this.#handleMessage(buffer.slice(0, nl), socket);
    });
    // A client that connects and goes away without ever sending a complete line (or errors) is
    // simply never answered — no `CredentialPrompt` was ever invoked, so there is nothing to
    // clean up beyond letting the socket itself close.
    socket.on("error", () => {
      /* the far end going away is not this broker's problem */
    });
  }

  async #handleMessage(line: string, socket: net.Socket): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      socket.destroy();
      return;
    }
    if (!isBrokerMessage(parsed) || parsed.token !== this.#token) {
      socket.destroy();
      return;
    }
    const prompt = this.#active.get(parsed.opId);
    if (prompt === undefined) {
      socket.destroy();
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const answer = await prompt.ask({
        prompt: parsed.prompt,
        masked: deriveMasked(parsed.prompt),
        signal: controller.signal,
      });
      const response = answer === undefined ? { ok: false } : { ok: true, answer };
      socket.end(`${JSON.stringify(response)}\n`);
    } catch {
      socket.destroy();
    } finally {
      clearTimeout(timer);
    }
  }

  #dispose(): void {
    this.#server?.close();
    this.#server = undefined;
    this.#active.clear();
    const dir = this.#dir;
    this.#dir = undefined;
    this.#token = undefined;
    if (dir !== undefined) {
      // Best-effort: a session dir that fails to delete is orphaned in the OS temp dir, not a
      // correctness problem for this process (the socket is already closed, so it is inert).
      void rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
