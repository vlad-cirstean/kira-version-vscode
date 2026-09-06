import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import type { CredentialPrompt, CredentialRequest } from "@kira-version/core";
import {
  AskpassBroker,
  type AskpassSession,
  deriveMasked,
  shouldInterposeAskpass,
} from "./askpass.ts";

/** A local double, not core's `FakeCredentialPrompt`: that fake is core's own test scaffolding
 *  (`ports/testFakes.ts`'s doc comment says so explicitly) and this package's other test files
 *  never reach into it either — `watcher.test.ts` imports only public `@kira-version/core`
 *  types. Mirrors its shape (queued answers, a `hang` mode driven only by `signal`) closely
 *  enough that the two would be interchangeable if this ever needed to move. */
class ScriptedCredentialPrompt implements CredentialPrompt {
  readonly calls: CredentialRequest[] = [];
  queuedAnswers: (string | undefined)[] = [];
  hang = false;

  ask(request: CredentialRequest): Promise<string | undefined> {
    this.calls.push(request);
    if (this.hang) {
      return new Promise((resolve) => {
        request.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
      });
    }
    return Promise.resolve(this.queuedAnswers.shift());
  }
}

interface ShimResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Spawns the real shim `start()` wrote to disk, exactly as `writeStreaming` would for a real
 *  remote op — the one difference is `envOverride`, which lets a test send a wrong token or a
 *  mismatched opId without `askpass.ts` itself growing a test-only backdoor. */
function runShim(
  session: AskpassSession,
  opEnv: Readonly<Record<string, string>>,
  promptText: string,
  envOverride: Readonly<Record<string, string>> = {},
): Promise<ShimResult> {
  return new Promise((resolve, reject) => {
    const shimPath = session.env.GIT_ASKPASS;
    if (shimPath === undefined) {
      reject(new Error("session.env.GIT_ASKPASS is missing"));
      return;
    }
    const child = spawn(shimPath, [promptText], {
      env: { ...process.env, ...session.env, ...opEnv, ...envOverride },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("deriveMasked", () => {
  test("a Username prompt is not masked", () => {
    expect(deriveMasked("Username for 'https://github.com': ")).toBe(false);
  });

  test("a Password prompt is masked", () => {
    expect(deriveMasked("Password for 'https://alice@github.com': ")).toBe(true);
  });

  test("an SSH passphrase prompt is masked", () => {
    expect(deriveMasked("Enter passphrase for key '/home/x/.ssh/id_ed25519': ")).toBe(true);
  });

  test("an unrecognised prompt defaults to masked, erring toward hiding", () => {
    expect(deriveMasked("Some credential-helper wording this file has never seen")).toBe(true);
  });
});

describe("shouldInterposeAskpass", () => {
  test("neither core.askPass nor an inherited GIT_ASKPASS: interpose", () => {
    expect(shouldInterposeAskpass({ coreAskPass: undefined, inheritedGitAskpass: undefined })).toBe(
      true,
    );
  });

  test("both present but empty strings: interpose", () => {
    expect(shouldInterposeAskpass({ coreAskPass: "", inheritedGitAskpass: "" })).toBe(true);
  });

  test("core.askPass configured: never interpose", () => {
    expect(
      shouldInterposeAskpass({
        coreAskPass: "/usr/bin/my-credential-manager",
        inheritedGitAskpass: undefined,
      }),
    ).toBe(false);
  });

  test("an inherited GIT_ASKPASS in the host environment: never interpose", () => {
    expect(
      shouldInterposeAskpass({ coreAskPass: undefined, inheritedGitAskpass: "/usr/bin/other" }),
    ).toBe(false);
  });
});

describe("AskpassBroker", () => {
  test("start() twice on the same instance rejects rather than handing back a second session", async () => {
    const broker = new AskpassBroker();
    const session = await broker.start();
    await expect(broker.start()).rejects.toThrow(/twice/);
    session.dispose();
  });

  test("a real answer round-trips through the real shim, unix socket, and helper process", async () => {
    const broker = new AskpassBroker();
    const session = await broker.start();
    const prompt = new ScriptedCredentialPrompt();
    prompt.queuedAnswers = ["hunter2"];

    const result = await broker.withOp("op1", prompt, (opEnv) =>
      runShim(session, opEnv, "Password for 'https://alice@github.com': "),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("hunter2\n");
    expect(prompt.calls).toHaveLength(1);
    expect(prompt.calls[0]?.prompt).toBe("Password for 'https://alice@github.com': ");
    expect(prompt.calls[0]?.masked).toBe(true);

    session.dispose();
  });

  test("a Username prompt reaches the CredentialPrompt with masked: false", async () => {
    const broker = new AskpassBroker();
    const session = await broker.start();
    const prompt = new ScriptedCredentialPrompt();
    prompt.queuedAnswers = ["alice"];

    const result = await broker.withOp("op1", prompt, (opEnv) =>
      runShim(session, opEnv, "Username for 'https://github.com': "),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("alice\n");
    expect(prompt.calls[0]?.masked).toBe(false);

    session.dispose();
  });

  test("a dismissed prompt (queue empty) exits non-zero with nothing on stdout — probe 8's shape", async () => {
    const broker = new AskpassBroker();
    const session = await broker.start();
    const prompt = new ScriptedCredentialPrompt();

    const result = await broker.withOp("op1", prompt, (opEnv) =>
      runShim(session, opEnv, "Password for 'https://x': "),
    );

    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(prompt.calls).toHaveLength(1);

    session.dispose();
  });

  test("a wrong token is rejected before ever reaching the CredentialPrompt", async () => {
    const broker = new AskpassBroker();
    const session = await broker.start();
    const prompt = new ScriptedCredentialPrompt();
    prompt.queuedAnswers = ["should-never-be-asked-for"];

    const result = await broker.withOp("op1", prompt, (opEnv) =>
      runShim(session, opEnv, "Password for 'https://x': ", {
        KIRA_ASKPASS_TOKEN: "wrong-token-entirely",
      }),
    );

    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(prompt.calls).toHaveLength(0);

    session.dispose();
  });

  test("an opId the broker never registered is rejected the same way", async () => {
    const broker = new AskpassBroker();
    const session = await broker.start();
    const prompt = new ScriptedCredentialPrompt();
    prompt.queuedAnswers = ["nope"];

    // withOp registers "op1"; the override tells the shim to claim a different, unregistered id.
    const result = await broker.withOp("op1", prompt, (opEnv) =>
      runShim(session, opEnv, "Password for 'https://x': ", { KIRA_ASKPASS_OPID: "op2" }),
    );

    expect(result.code).not.toBe(0);
    expect(prompt.calls).toHaveLength(0);

    session.dispose();
  });

  test("a hanging prompt is unblocked by the broker's own bounded timeout (50ms here, never a real 120s wait)", async () => {
    const broker = new AskpassBroker({ timeoutMs: 50 });
    const session = await broker.start();
    const prompt = new ScriptedCredentialPrompt();
    prompt.hang = true;

    const started = Date.now();
    const result = await broker.withOp("op1", prompt, (opEnv) =>
      runShim(session, opEnv, "Password for 'https://x': "),
    );
    const elapsedMs = Date.now() - started;

    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    // Comfortably under the helper's own default 120s client-side timeout — proves the
    // broker's `AbortController`, not the helper's own bound, is what actually unblocked this.
    expect(elapsedMs).toBeLessThan(5_000);

    session.dispose();
  }, 10_000);

  test("withOp unregisters its opId afterwards — a stray later connection reusing it finds nothing", async () => {
    const broker = new AskpassBroker();
    const session = await broker.start();
    const first = new ScriptedCredentialPrompt();
    first.queuedAnswers = ["first-answer"];

    await broker.withOp("op1", first, (opEnv) =>
      runShim(session, opEnv, "Password for 'https://x': "),
    );

    const stray = await runShim(
      session,
      { KIRA_ASKPASS_OPID: "op1" },
      "Password for 'https://x': ",
    );
    expect(stray.code).not.toBe(0);

    session.dispose();
  });

  test("dispose() removes the whole session dir — shim, helper, and socket all gone, not just closed", async () => {
    const broker = new AskpassBroker();
    const session = await broker.start();
    const shimPath = session.env.GIT_ASKPASS;
    expect(shimPath).toBeDefined();

    session.dispose();

    // Give the fire-and-forget `rm` a turn to run before checking — `dispose()` is
    // synchronous-looking but its cleanup is best-effort async (this file's own doc comment).
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(access(shimPath as string)).rejects.toThrow();
  });

  test("dispose() is idempotent", async () => {
    const broker = new AskpassBroker();
    const session = await broker.start();
    session.dispose();
    expect(() => session.dispose()).not.toThrow();
  });

  test("start()'s env carries exactly the three documented keys", async () => {
    const broker = new AskpassBroker();
    const session = await broker.start();
    expect(Object.keys(session.env).sort()).toEqual([
      "GIT_ASKPASS",
      "KIRA_ASKPASS_SOCK",
      "KIRA_ASKPASS_TOKEN",
    ]);
    session.dispose();
  });
});
