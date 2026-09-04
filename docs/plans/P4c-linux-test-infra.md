# P4c — Making the test suite runnable on Linux, without changing what the product claims

Plan for a **test/dev-infrastructure change**, not for one of `docs/SPEC.md` §10's numbered
phases. It sits after P4b and is numbered `P4c` for the same reason that one was: P0–P11 describe
what v1 builds, and this unit of work changes only how v1 is *tested*. Written before
implementation per `AGENTS.md`.

**The directive, in the user's own framing:** make the integration/E2E suite runnable on Linux —
specifically a headless, root-user, no-`DISPLAY` container that already has Xvfb and a `git`
binary and is where this repo's own sessions actually run — **without revising D27**.

**What that means concretely, and it is a boundary, not a nuance:**

1. **The shipped extension's supported-platforms claim does not move.** §2.1.2 stays *"macOS only
   for v1"*, D27 stays, §9's "Windows and Linux support" stays out of scope, and the `.vsix` is
   still a macOS-only product. Nothing here is a support claim, a CI matrix, or a promise.
2. **Only the ability to *run the suites* on Linux changes.** The user chose this scope explicitly
   over alternatives that would have revised D27 itself. An implementer who finds themselves
   editing D27's decision, adding a Linux row to §9, or claiming Linux support anywhere has left
   the scope this plan was written for.

The distinction is real and is worth stating in one line, because W8 has to make `docs/SPEC.md`
carry it: **the suite runs where the developer is; the product runs where D27 says.**

---

## What is already true — verified at planning time, against this tree, in this container

This is the part that reframes the task, so it comes first. Most of the suite already runs on
Linux. Measured, not assumed:

| Tier | Command | State on Linux, now |
|---|---|---|
| Unit (`packages`, `tests/unit`, `tests/fixtures`) | `bun test packages tests/fixtures tests/unit` | **498/498 pass**, 6,683 assertions, 47 files |
| Integration (`tests/integration`) | `bun test tests/integration` | **122/122 pass**, 35,521 assertions, 14 files, ~36 s |
| `bun run check`, `bun run test`, `bun run build`, `--project=harness` | | already green here — P4b's own Findings recorded 620/620 and 42/42 in this same Linux sandbox |
| `bun run test:perf` | | runs; `graphUi.ts`'s three known metrics fail as headless-compositor noise, attributed in P4/P4b |
| **`--project=vscode`** | `bunx playwright test --project=vscode` | **the one tier that has never run — anywhere, on any OS** |

Three facts follow, and they set this plan's shape:

- **620 = 498 + 122.** `bun run test` is green on Linux today. There is no macOS-specific
  assumption in `tests/integration/` to unpick: the fixture generators are POSIX-portable
  (`#!/bin/sh` fake-git scripts, `GIT_CONFIG_GLOBAL=/dev/null`, `HOME=<tmpdir>`, `mkdtemp`), no
  test hardcodes a path separator, a case-insensitive filesystem, or a macOS file mode. A
  planning-time grep for `darwin|macos|process\.platform|/usr/bin|/opt/homebrew|osascript` across
  `packages`, `apps`, `tests` and `scripts` returns exactly the entries listed in W1 and W2 plus
  inert string fixtures (`"/usr/bin/git"` as a harness scenario value, `capabilities.test.ts`'s
  cache-key strings, a `Mac OS X` user-agent test for `gitBlockedCopy.ts`). W7 re-runs that grep
  rather than trusting this paragraph.
- **The Playwright browser situation is already solved in this container.**
  `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` is set in the environment and
  `/opt/pw-browsers/chromium-1234` matches what `@playwright/test@1.62.1` expects, so
  `bunx playwright install` is not a prerequisite here. `KIRA_PLAYWRIGHT_CHROMIUM_PATH` (P0)
  remains the documented escape hatch when a revision mismatch reappears.
- **`tests/e2e/vscode/panel.spec.ts` has never executed.** P0's V3, P3's V3, P4 and P4b each
  recorded it as blocked on the VS Code download, so its launch code has never been exercised on
  *any* platform. This plan is where it runs for the first time, which means its bugs are this
  plan's bugs — see W6.

**And the download block appears to have lifted.** At planning time,
`GET https://update.code.visualstudio.com/api/update/linux-x64/stable/latest` returned **200**
with a real payload (`1.136.1`, a `vscode.download.prss.microsoft.com` URL and a `sha256hash`),
and a ranged `GET` of that URL returned **206** with content. Every prior phase recorded a 403 or
an aborted transfer. This is the single largest change in what is possible here, and W4 confirms
it with the real `downloadAndUnzipVSCode()` call rather than with `curl`.

---

## What the prior research got right, and the one thing it got wrong

The research handed to this plan flagged four items. Three survive; one is falsified, and saying so
plainly is more useful than quietly planning around it.

**Falsified: `fs.watch({ recursive: true })` does not fail on Linux under either runtime we use.**
The premise was that Node only supports `recursive` on macOS and Windows. That was true, and is the
reason `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` exists — but Node added a Linux implementation in the
v20 line, in **userland JavaScript**, precisely because inotify has no recursive primitive. Verified
directly here, not from memory:

- `node --expose-internals -e "require('internal/fs/recursive_watch')"` loads and exports
  `{ FSWatcher, kFSWatchStart }`.
- `fs.watch(dir, { recursive: false })` returns an `FSWatcher` **with** a `_handle` (libuv/inotify);
  `fs.watch(dir, { recursive: true })` returns one **without** — the JS implementation.
- `require('node:fs').watch.toString()` shows the branch and Node's own comment for it:
  *"libuv does not support recursive file watch on all platforms, e.g. Linux due to the limitations
  of inotify."*
- Bun 1.3.11 also accepts it, and `tests/integration/nodeFileWatcher.test.ts`'s
  *"recursive: true also catches a write inside a nested subdirectory"* **passes** here.

So the shim the research proposed building already exists, shipped inside Node, and `chokidar` would
be a dependency added to solve a problem that does not exist. That is judgment call 3. What Node's
userland watcher *does* introduce on Linux is a different, narrower hazard — see W2.

Confirmed as real: the `PlatformGitLocator` gap (W1), the Xvfb requirement (W3), and root-vs-sandbox
(W5) — though W5's answer turns out to be "Playwright already does it, don't fight it".

---

## Scope boundary

**Changed:**

| | |
|---|---|
| `packages/git/src/discovery.ts` | a Linux branch in `platformFallbackCandidates()`; `win32` stays a named, throwing case |
| `tests/integration/discovery.test.ts` | the *"unsupported platform throws"* test currently pins `platform: "linux"` — it must move to `win32` or it asserts the opposite of what W1 lands |
| `packages/git/src/nodeFileWatcher.ts` | doc comment only: what `recursive: true` actually is on Linux, and the two consequences |
| `tests/integration/nodeFileWatcher.test.ts` | one assertion strengthened (exact path, not `includes`) |
| `tests/e2e/vscode/panel.spec.ts` | the launch: the Electron binary rather than the CLI wrapper, one shared helper instead of three copies, `--password-store=basic` |
| `package.json` | one `test:e2e:vscode` script; possibly the `engines.node` floor (W2) |
| `scripts/e2e-display.ts` | **new** — the Xvfb wrapper (W3) |
| `docs/SPEC.md` | §2.1.2, §4.2's step 4, §8.4's integration-suite paragraph, a clarifying clause on D27, a re-statement on D28 |
| `AGENTS.md` | a short "Running the suites in this sandbox" block |

**Untouched, deliberately:**

| | |
|---|---|
| `docs/SPEC.md` §9, §12, §10 | v1's scope does not change. No row moves, no note under the phasing table (unlike P4b, this delivers no product scope at all) |
| **D27's decision itself** | the claim stays *"macOS only for v1"*; it gains a pointer, not a revision (judgment call 7) |
| **D28's decision** | no CI. No `.github/workflows/`. See judgment call 1 |
| `packages/core/src/ports/fileWatcher.ts` | the port interface's shape does not change — nothing in this plan needs it to |
| `tests/e2e/harness/**` and its `-linux` snapshots | **no baseline is regenerated.** The `-darwin` set P0 flagged as owed stays owed |
| `packages/ui`, `packages/ipc`, `packages/core` (except doc-comment-free) | zero behaviour change |
| `tests/integration/` beyond the two files above | it already passes; do not "portability-proof" code that is demonstrably portable |

---

## Ordering

| # | Work item | Depends on |
|---|---|---|
| W1 | `discovery.ts`: a Linux `PlatformGitLocator` strategy, and the test that currently asserts its absence | — |
| W2 | `nodeFileWatcher.ts`: what Linux recursive watching really is, the stale-inode probe, and the Node floor | — |
| W3 | Xvfb: `scripts/e2e-display.ts` and a `test:e2e:vscode` script that is a no-op on macOS | — |
| W4 | The VS Code download and the `.vscode-test` cache: confirm the block has lifted, record the version | — |
| W5 | Root and the Chromium sandbox — its own item, not a footnote to W3 | W3, W4 |
| W6 | `panel.spec.ts`: launch the Electron binary, not the CLI wrapper; one helper, three tests | W3, W4, W5 |
| W7 | The already-green tiers: re-verify and record *why* they already work, change nothing | — |
| W8 | `docs/SPEC.md` §2.1.2, §4.2, §8.4, D27's clarifier, D28's restatement | W1, W6 |
| W9 | `AGENTS.md`: how to run the suites here | W3, W6 |
| W10 | Verification pass | all |

W1–W4 are independent and can land in any order. W6 is the only item that cannot be verified until
W3, W4 and W5 are all settled — it is also the only item whose subject has never run, so budget
accordingly: it is the risk in this plan, and everything else is small.

---

## W1 — A Linux `PlatformGitLocator` strategy

`platformFallbackCandidates()` in `packages/git/src/discovery.ts` implements `darwin` and throws for
everything else:

```ts
throw new Error(
  `git discovery: platform '${platform}' is not supported yet (v1 is macOS-only, D27)`,
);
```

**Why this matters more than "the test asserts a throw".** `locateGit()` reaches the fallback list
only after configured candidates *and* `PATH` are exhausted — so on this container, where
`/usr/bin/git` (2.43.0) is on `PATH`, discovery already succeeds and never touches this branch. But
when it *is* reached, it **throws** rather than returning a `GitResolution`, and
`RepoService.create()` (`packages/git/src/repoService.ts:166`) `await`s it with no `try`. An
extension host launched with a stripped `PATH` therefore crashes activation instead of reaching
§4.2's designed blocking state — the exact "explicit failing case rather than a missing branch that
silently misbehaves" §2.1.2 asks for, inverted into a worse failure than the one it was guarding.
That is true on any platform, and it is the strongest reason to close the Linux case rather than the
weakest.

**The strategy.** Small, and deliberately not clever:

- `/usr/bin/git` and `/usr/local/bin/git` — the distro and the built-from-source locations.
- `/opt/homebrew/bin/git` is macOS's; Linuxbrew's is `/home/linuxbrew/.linuxbrew/bin/git`. Include it
  or don't, but decide rather than copying the macOS list.
- **No `which`/`command -v` spawn.** Step 3 of §4.2 is already a `PATH` lookup (`searchPath()`,
  `accessSync(X_OK)` over `$PATH`), and it runs *before* the fallbacks. Shelling out to `which` here
  would re-do, less hermetically, work the resolution order has already done — and `runCapture`
  through a `ProcessRunner` is a spawn per candidate. Say this in a comment; it is the obvious thing
  a reader will otherwise "add".
- **No `xcode-select` analogue.** The macOS branch's `xcodeCommandLineToolsInstalled()` gate exists
  because `/usr/bin/git` on macOS is a CLT shim that pops a system dialog. Linux's `/usr/bin/git` is
  a binary. No gate, and one line saying why the branches are asymmetric.
- `win32` stays a named case that throws, with the message reworded so it names Windows rather than
  implying Linux is still in the throwing set.

**`tests/integration/discovery.test.ts` — read before editing.** Its test *"an unsupported platform
throws only once genuinely reached"* passes `platform: "linux"` and asserts `rejects.toThrow(/not
supported yet/)`. After W1 that assertion is false. Move it to `platform: "win32"` — the test's
subject is "the throw happens only after configured candidates and `PATH` are exhausted", not
"Linux throws", so it survives the platform swap intact. Then add the sibling the macOS strategy
never got: with `PATH` cleared and `platform: "linux"`, `locateGit` must reach the Linux fallbacks
and return `notFound` naming them in `probed` — the same shape as the existing `darwin` case two
tests above.

Note what W1 does **not** do: it does not touch `packages/ui/src/components/gitBlockedCopy.ts`,
whose `detectPlatform()` reads a browser user agent and already has a non-mac branch. If the blocked
state's copy is wrong on Linux, that is a cosmetic issue in a state this plan does not need to
reach; leave it, and note it in Findings if you see it.

## W2 — What `recursive: true` actually is on Linux, and the one thing to probe

No code change to the watcher's logic is planned here. Three things are:

**(a) The doc comment.** `nodeFileWatcher.ts`'s header explains FSEvents coalescing on macOS and
says nothing about Linux, because until now Linux was not a place this ran. Add the verified facts,
briefly:

- On Linux, Node routes `recursive: true` to a **userland** watcher
  (`internal/fs/recursive_watch`), because inotify has no recursive primitive. It `readdir`s the
  tree at start and puts a separate `fs.watch` on **every entry — files as well as directories** —
  adding watches for new entries as it sees them.
- **The `filename` contract is the same as macOS's:** every emit is
  `path.relative(rootPath, file)`, so `nodeFileWatcher.ts`'s `join(path, filename)` stays correct
  and `watcher.ts`'s `classify()` keeps receiving absolute paths under the watched root. This was
  the failure mode most worth checking and it does not occur; record that it was checked, because
  "the filename is already absolute" is exactly the bug a future reader will suspect.
- The start-up `readdir` emits a `'rename'` per pre-existing entry, but `fs.watch` attaches the
  caller's listener *after* `kFSWatchStart` runs, so that burst is never delivered. Verified by
  reading `fs.watch`'s own source; worth one clause, because a spurious `refsChanged` on every
  watch start would be a real bug and the next reader deserves to know it was ruled out.
- Cost: one inotify watch per file under `.git/refs`. Fine for a normal repo against this
  container's `fs.inotify.max_user_watches` (129,912 here); a repo with a very large loose-ref set
  could exhaust it, at which point `#watchOne`'s `catch` logs a `FileWatchError` and that one watch
  is silently skipped. **Do not fix this** — Linux is not a shipped platform (D27). Write it down.

**(b) The one thing genuinely worth probing, once, by hand.** Node's userland watcher keeps its
per-file `fs.watch` across a rename that replaces the file's inode: on the rename it stats, finds
the path still exists, emits `'change'`, and **does not re-watch**. Git updates refs by writing
`<ref>.lock` and renaming it onto `<ref>`. So the open question is whether a *second* update to an
already-known ref file still produces an event on Linux under Node, or whether the watch is now
pinned to a dead inode. `watcher.ts` watches directories for exactly this class of reason, and the
directory watch does fire for the `.lock` creation (which `stripLockSuffix()` already normalises) —
so the likely answer is "yes, still fires, via the `.lock` half of the pair". Likely is not
verified.

**This cannot be settled by `bun run test`.** `tests/integration/watcher.test.ts` passes here, but
`bun test` runs under **Bun**, whose `fs.watch` is a different implementation; the runtime that
matters (VS Code's extension host is Node) is never exercised by it. So: run a one-off Node probe —
`node --experimental-strip-types` or a two-line JS harness over `NodeFileWatcher` — that watches
`<repo>/.git/refs` with `recursive: true` and runs `git branch -f feature HEAD` **twice**, asserting
an event both times. Record the result in Findings either way. If it does *not* fire the second
time, the fix is not chokidar and not a rewrite: it is to add `refs/heads`, `refs/tags` and
`refs/remotes` to the **non-recursive** watch list alongside the recursive one (they are a known,
shallow set; a duplicate event costs nothing because `watcher.ts` debounces and coalesces by design).
Cost that fix at three lines in `watcher.ts` and one test.

**Explicitly declined:** adding a Node-based test runner so this is covered permanently. That is a
second test toolchain for one Linux-only, non-shipped-platform behaviour. A recorded manual probe
plus the doc comment is the proportionate answer; say so rather than leaving the gap unexplained.

**(c) The Node floor, if the changelog supports it.** `package.json` declares `"node": ">=20"`. The
Linux userland recursive watcher landed in the v20 line (v20.13.0), so on `20.0`–`20.12` a Linux
`fs.watch(..., {recursive:true})` throws `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` — which
`#watchOne` catches, logs, and skips, degrading to *no ref watching at all, silently*. **Confirm the
exact release from Node's own changelog before writing a number**, then either raise `engines.node`
to that floor or leave it and say why. This is a one-line honesty fix riding along; if the changelog
does not confirm the release cleanly, drop it rather than guessing (judgment call 9).

## W3 — Xvfb

Playwright's own Electron launcher watches the child's stderr for `Unable to open X display` and
answers it with: *"Use 'xvfb-run' on Linux to launch your tests with an emulated display server."*
This container has `/usr/bin/xvfb-run` and `/usr/bin/Xvfb`, no `DISPLAY`, and P3 already established
`xvfb-run -a` as this repo's idiom for the retired `electron` project.

The question is only where the wrapper lives. Three options, and the reason for the choice:

- **Document `xvfb-run -a bunx playwright test --project=vscode` and stop.** Zero machinery, but it
  is tribal knowledge — the exact failure it prevents is a 30-second timeout with a wall of Chromium
  logs, and the person who hits it is the person who did not read this plan.
- **A Playwright `globalSetup` that starts Xvfb.** Config-level `globalSetup` runs for the `harness`
  project too, which needs no display, and per-project global setup is not a thing in the pinned
  1.62.1 — so this buys a needless Xvfb per harness run.
- **A ~25-line `scripts/e2e-display.ts`** (chosen): if `process.platform === "linux"`, `DISPLAY` is
  unset, and `xvfb-run` is on `PATH`, exec `xvfb-run -a <playwright…>`; otherwise exec Playwright
  directly. On macOS it is a passthrough. Wire it as
  `"test:e2e:vscode": "bun run scripts/e2e-display.ts test --project=vscode"`.

This fits the `scripts/` convention already in the tree (`build.ts`, `gen-settings.ts`,
`check-tokens.ts` — small Bun scripts with a `#!/usr/bin/env bun` header and a doc comment). It is
process plumbing, not the "non-trivial infrastructure" `AGENTS.md`'s prefer-a-library rule is aimed
at; the packages that wrap this (`xvfb-maybe` and friends) are unmaintained and would be a worse
dependency than twenty lines. Note that reasoning in the file's header so the rule is visibly
applied rather than skipped.

`test:e2e` itself stays exactly as it is (`playwright test`), so the harness tier's command does not
change and nothing macOS-side moves.

## W4 — The VS Code download and the `.vscode-test` cache

`downloadAndUnzipVSCode()` fetches `update.code.visualstudio.com`, verifies a sha256, and unzips
into `.vscode-test/` (gitignored, line 126). Every prior phase recorded this as blocked; the
planning-time probes above suggest it no longer is.

- Run it for real, once, before touching `panel.spec.ts`. `curl` returning 200 proves reachability,
  not that the library's own request shape, redirect handling, sha256 check and unzip all survive
  the proxy. If it fails, stop here and record the failure mode precisely — the rest of W5/W6 is
  unverifiable and should be carried forward as inherited-open exactly as P0/P3/P4/P4b did, with the
  same closing command.
- **Record the resolved version in Findings.** `downloadAndUnzipVSCode()` with no argument tracks
  `stable`, which at planning time is `1.136.1`. A suite that drives VS Code's *own* UI
  (`.quick-input-widget`, the `Default Light Modern` / `Default Dark Modern` theme names,
  `.monaco-list-row`) is coupled to that build. Pinning is tempting and is **deliberately not done
  here** (judgment call 6): the pin interacts with D7's `engines.vscode` floor, which is P11's
  business, and this plan should not quietly make a release decision. Recording the version is what
  makes a future failure attributable.
- Note the download size (~130 MB) and that `.vscode-test/` must not be committed; confirm
  `git status` is clean after the first run.

## W5 — Root, and the Chromium sandbox

Its own item because it is its own failure, with its own message, and folding it into "Xvfb" is how
someone ends up debugging a sandbox error while re-reading Xvfb docs.

The situation: this container runs as **uid 0**. Chromium's setuid/user-namespace sandbox refuses to
initialise under root, and Electron therefore refuses to start — P0's V3 recorded exactly this and
closed it with `--no-sandbox`. VS Code adds a second, separate root check of its own and asks for an
explicit `--user-data-dir`.

What the implementer needs to know before writing a single flag:

- **Playwright already handles the sandbox flag, on Linux, automatically.** Verified by reading the
  Electron launcher inside `node_modules/playwright-core/lib/coreBundle.js`:

  ```js
  let electronArguments = ["--inspect=0", "--remote-debugging-port=0", ...options.args || []];
  if (os.platform() === "linux") {
    if (!options.chromiumSandbox && electronArguments.indexOf("--no-sandbox") === -1)
      electronArguments.unshift("--no-sandbox");
  }
  ```

  So: **do not set `chromiumSandbox`** (setting it `true` is the one way to break this), and do not
  hand-roll the flag. Passing `--no-sandbox` explicitly in `args` is harmless — the `indexOf` guard
  dedupes it — but it reads as though it were required, which is worse than a comment. **Leave the
  flag out and leave a comment saying why it is absent**, or the next reader adds it back.
- **`--user-data-dir` is already supplied and must not be dropped.**
  `resolveCliArgsFromVSCodeExecutablePath()` returns `[cliPath, --extensions-dir=…,
  --user-data-dir=…]`, the last two from `getProfileArguments()` pointing into
  `.vscode-test/`. W6 changes which element is used as the executable; it must keep both dir args,
  or VS Code's own root check fires.
- **`--disable-dev-shm-usage` is not needed here** and should not be added: `/dev/shm` is 16 GB in
  this container. Cargo-culting it would hide a real signal if the shm size ever changes.
- **Every shared library Electron needs is present** — `libnss3`, `libgtk-3`, `libasound2`,
  `libatk-1.0`, `libdrm`, `libgbm`, `libxkbcommon`, `libatspi`, `libcups`, `libXcomposite`,
  `libXdamage`, `libXrandr`, `libpango`, `libcairo`, `libnspr4` all resolve via `ldconfig -p`. If
  the launch fails, it is not a missing dependency; look at the sandbox and the display first.
- **Expect no D-Bus session bus.** P3's Findings established that this container has none, which is
  why Electron's `nativeTheme` OS-theme-change events were unreachable. `panel.spec.ts`'s theme test
  drives *VS Code's own* `Preferences: Color Theme` command, not the OS theme, so it should be
  unaffected — but if it hangs, suspect the keyring, not the theme (see W6's
  `--password-store=basic`).

## W6 — `panel.spec.ts`: launch the Electron binary, not the CLI wrapper

The substantive item, and the one this plan exists to de-risk. **Read the whole spec before editing
it**; its header comment is long and mostly still correct.

**The bug, stated mechanically.** The spec does:

```ts
const [cliPath, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
const app = await electron.launch({ executablePath: cliPath, args: [...cliArgs, …] });
```

`resolveCliArgsFromVSCodeExecutablePath()`'s first element is
`resolveCliPathFromVSCodeExecutablePath()`, which returns `…/bin/code` on Linux and
`…/Contents/Resources/app/bin/code` on macOS — in both cases **VS Code's `code` CLI shell script**,
not an Electron binary. That script re-execs the real Electron with `ELECTRON_RUN_AS_NODE=1` running
`out/cli.js`, which launches the actual window process detached.

Playwright's `_electron.launch` (source quoted in W5) appends `--inspect=0` and
`--remote-debugging-port=0` to the launched process and then waits for **both**
`Debugger listening on ws://…` **and** `DevTools listening on ws://…` on *that process's own*
stderr. Under the CLI wrapper, the flags land on a Node-mode `cli.js`; the window process that would
print the DevTools line is a detached grandchild with its own stdio. The launch cannot succeed by
construction — on Linux or macOS.

**The fix, and it is small.** `downloadAndUnzipVSCode()` already returns the real Electron
executable — `<dir>/code` on Linux, `Visual Studio Code.app/Contents/MacOS/<exe>` on macOS
(confirmed by reading `downloadDirToExecutablePath()` in the installed `@vscode/test-electron`). So:

- `executablePath: vscodeExecutablePath`.
- Keep `resolveCliArgsFromVSCodeExecutablePath()` **for its profile arguments only** — drop element
  0, keep `--extensions-dir=…` and `--user-data-dir=…` (W5 explains why the second is load-bearing
  under root). Rewrite `resolveCli()` accordingly, and rewrite its doc comment, which currently
  explains an `exactOptionalPropertyTypes` destructuring wrinkle for a value that no longer has a
  consumer.
- Add `--password-store=basic`. On Linux, Electron probes libsecret/gnome-keyring for its safe
  storage; with no D-Bus session bus that probe can stall the launch. This is a Linux-only need but
  is inert on macOS, so it goes in the shared args rather than behind a platform branch — one
  comment explaining that.
- Keep `--disable-extensions`, `--skip-release-notes`, `--skip-welcome`, the workspace folder
  argument, and `env: { ...process.env, KIRA_REPO: repo.dir }` exactly as they are.

**Factor the launch into one helper.** The three tests carry byte-identical 12-line launch blocks
today. The fix above must be made in one place, not three, and the next person changing a launch
flag should not have to find all of them. A single `launchVSCode(repo)` returning the
`ElectronApplication`, plus the existing `try/finally { app.close() }` at each call site.

**Also fix the header comment while there.** Its "Environment reality" paragraph states as fact that
`downloadAndUnzipVSCode()` is blocked by this sandbox's network policy and that the spec must be run
on macOS. W4 either falsifies or re-confirms that; either way the paragraph must end up describing
what is true, including — if it now runs headlessly — the `bun run test:e2e:vscode` command and the
fact that macOS remains where the *authoritative* result comes from (D27, §8.4).

**What may still fail, and how to read it.** These three tests drive VS Code's own workbench UI
through the command palette. If a locator (`.quick-input-widget input`, `.monaco-list-row`,
`iframe.webview.ready`, `#active-frame`) does not match on 1.136.x, that is a *stale-selector*
failure, not a Linux failure — attribute it correctly in Findings rather than filing it against this
plan's premise. Likewise, a theme test that reads `--kv-app-bg` through two nested frames is
sensitive to timing; the spec already uses `expect.poll`, and adding a retry there is fair game.

## W7 — The already-green tiers: verify, record, change nothing

The point of this item is to produce a written, checkable statement of *why* three tiers already
work on Linux, so the next person does not "fix" them:

- Re-run `bun run check`, `bun run test`, `bun run build`, `bunx playwright test --project=harness`
  and `bun run test:perf` and record the numbers, against P4b's recorded 620/620 and 42/42.
- Re-run the macOS-assumption grep across `packages`, `apps`, `tests`, `scripts` and paste the
  surviving hits into Findings with a one-line disposition each. The expected surviving set is: W1's
  `discovery.ts` branch, W2's `nodeFileWatcher.ts` comment, `gitBlockedCopy.ts`'s user-agent branch
  and its test, and inert `"/usr/bin/git"` string fixtures in harness scenarios, `codec.test.ts`,
  `schema.test.ts`, `capabilities.test.ts` and `rpcHandlers.test.ts`. Anything else is a finding.
- **Do not regenerate a single visual baseline.** The nine `graph.spec.ts` and four `shell.spec.ts`
  snapshots are `-linux` because P0/P4 generated them here, and P0's carried-forward action —
  produce the authoritative `-darwin` set on real macOS hardware — is *not* closed by this plan and
  must not be quietly reframed as closed. If a baseline shifts, stop: nothing in W1–W6 touches
  rendered output.
- Record `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` and the `chromium-1234` revision match as the
  reason `bunx playwright install` is not a prerequisite *here*, alongside the note that it is one
  on a fresh machine.

## W8 — `docs/SPEC.md`

Five edits, each small, each phrased so the D27 boundary is unmistakable. This is the item most
likely to drift into revising the product claim; the test for every sentence written here is *would
a reader conclude the extension supports Linux?* If yes, rewrite it.

- **§2.1.2 (Supported operating systems).** The heading claim — *"macOS only for v1. Windows and
  Linux are not supported, not tested, and not claimed"* — **does not change**. Add one sentence to
  the closing paragraph distinguishing the product from the workbench: the suites (unit,
  integration, harness Playwright and the VS Code Playwright tier) are runnable on headless Linux
  for development, per `docs/plans/P4c-linux-test-infra.md`; that is where developers and agent
  sessions run, and it is not a support claim, a tested platform, or a CI matrix. Keep *"no
  per-platform CI"* — it is still true, D28 still holds.
- **§4.2, resolution step 4.** *"**Only the macOS strategy is implemented** (D27)"* becomes false
  with W1 and must be rewritten: macOS and Linux are implemented, Windows remains a named case that
  throws. State the Linux strategy's motive in the same breath — it exists so the suite can run on
  Linux, and implementing a discovery branch is not a support claim (§2.1.2, D27). Keep the macOS
  detail (the `xcode-select -p` gate and *why*) verbatim; it is the interesting half.
- **§2.1.2's "exactly one place"** sentence names Git binary discovery as the only
  platform-conditional site. Still true — W1 adds a branch to that one place, it does not add a
  second place. No edit unless the count wording reads oddly after §4.2 changes.
- **§8.4, the Integration-suite paragraph.** *"Slower tier, run on demand, on macOS only (D27),
  against the Git the developer has installed"* → run on demand on macOS, which is where its result
  is authoritative for the shipped extension, **and** on headless Linux for development (Xvfb, a
  root container, `bun run test:e2e:vscode`). Keep the following sentence — *"The OS and Git-version
  matrix this tier is shaped for arrives with the second platform"* — because it remains exactly
  true: running the suite somewhere is not a matrix, and the distinction is the whole point.
- **§11 D27 and D28.** D27's decision text is unchanged; append one clause: the test suite is
  runnable on Linux for development (`docs/plans/P4c-linux-test-infra.md`), which is
  dev-infrastructure, not support — so the Linux branch in §4.2 is deliberate and not a leak to be
  tidied away. D28 needs no decision change, but is worth one clause for the same reason: running
  the suites on Linux locally is not a pipeline, and no workflow was added (judgment call 1).
- **§9, §10, §12: no edits.** §9's *"Windows and Linux support (2.1.2). macOS only, with the seam
  left open"* and *"Continuous integration"* both stay. Unlike P4b, no phase's deliverable changed,
  so §10 gets no row edit and no note under the table. If you find yourself wanting one, re-read the
  scope boundary.

## W9 — `AGENTS.md`

`AGENTS.md`'s own rule for what belongs there is *"a standing rule for how this team works or how to
run things in this sandbox"* — and "how to run the suites in this container" is squarely the second.
Add a short block (five or six lines, not a tutorial), under `## Structure` or a new `## Running the
suites` heading:

- `bun run check`, `bun run test`, `bun run test:e2e` (harness) and `bun run test:perf` run here
  as-is; `PLAYWRIGHT_BROWSERS_PATH` is preset.
- The VS Code tier is `bun run test:e2e:vscode`, which starts Xvfb itself on Linux and is a
  passthrough on macOS.
- One line that macOS remains the authoritative platform for results (D27) and that visual baselines
  in the tree are Linux baselines.

Do not restate the mechanism (why Xvfb, why no sandbox flag) — that is this plan's Findings and
`docs/SPEC.md`'s job. Keep `AGENTS.md` lean, per its own instruction, and prune anything it already
carries that this makes stale.

`docs/plans/README.md` needs **no** edit: it already says the directory holds *"the occasional
scope-reduction plan slotted between phases (e.g. `P4b-remove-electron.md`)"*, which covers this
one. Confirm rather than assume.

## W10 — Verification

1. `bun run check` — green.
2. `bun run test` — green, with the count against P4b's 620 and any delta explained (W1 adds at
   least one discovery test).
3. `bun run build` — green.
4. `bunx playwright test --project=harness` — green, **with no regenerated baselines**.
5. **`bun run test:e2e:vscode` — the criterion this plan exists for.** All three `panel.spec.ts`
   tests pass headlessly here, or the failure is recorded with its precise cause and category
   (download, display, sandbox, stale VS Code selector, or a genuine extension bug — they are
   different things and Findings must not blur them).
6. `bun run test:perf` — at parity with P4b's recorded figures; `graphUi.ts`'s three known metrics
   attributed as before, not re-litigated.
7. The macOS-assumption grep from W7, with its surviving-hit list pasted into Findings.
8. `git status` clean — no `.vscode-test/`, no `test-results/`, no baseline churn.
9. **The scope check, stated explicitly.** `git diff` on `docs/SPEC.md` must show **no change to
   §9, §10 or §12**, and D27's decision sentence (*"macOS only for v1. Windows and Linux are not
   supported or tested…"*) must still be present verbatim. This is the user's actual boundary and it
   deserves a mechanical check, not a promise.

---

## Exit criteria

- [ ] `bun test tests/integration` and `bun test packages tests/fixtures tests/unit` green on Linux,
      with the count reconciled against P4b's 620.
- [ ] `locateGit()` resolves on Linux through the real §4.2 order, and the Linux fallback list is
      reachable and tested; `win32` is the only throwing case; `RepoService.create()`'s unguarded
      `await` is documented as the reason the throw matters.
- [ ] `nodeFileWatcher.ts` documents Linux's userland recursive watcher, the relative-`filename`
      contract, the per-file inotify cost, and the result of the Node stale-inode probe.
- [ ] `bun run test:e2e:vscode` starts Xvfb on Linux, is a passthrough on macOS, and launches VS
      Code's real Electron binary — or its failure is recorded with a precise, correctly-categorised
      cause and carried forward with the exact closing command.
- [ ] `panel.spec.ts` has **one** launch helper, no CLI-wrapper `executablePath`, and no hand-rolled
      `--no-sandbox`.
- [ ] No `.github/` directory exists; no CI workflow was added (judgment call 1).
- [ ] `docs/SPEC.md` §2.1.2, §4.2 and §8.4 describe a suite that runs on Linux and a product that
      does not, and **§9, §10, §12 and D27's decision sentence are unchanged**.
- [ ] `AGENTS.md` tells the next agent how to run every suite here, in five or six lines.
- [ ] No visual baseline regenerated; P0's owed `-darwin` baseline action still recorded as open.

---

## Judgment calls this plan made

Recorded so the implementer knows which lines were decided rather than derived, and can overrule one
with a reason rather than by accident.

1. **No CI job, and this is a deliberate answer to an explicitly-asked question.** There is no
   `.github/` directory in the tree. D28 decides *"None for now. No workflows, no hosted runners…
   The scripts are written to be CI-callable so adding a pipeline later is configuration, not
   rework"*, and §9 lists "Continuous integration" as out of scope for v1. Adding a Linux Actions
   job would revise **D28** — a different decision from D27, and one the user did not put on the
   table when they chose "test/dev-only". So this stays a local/manual capability, and the
   deliverable is a `test:e2e:vscode` script plus six lines in `AGENTS.md`, not a workflow. The
   competing argument — a Linux job is exactly what "runnable on Linux" is *for* — is real, and is
   the thing to raise with the user rather than to decide inside this plan.
2. **The Linux `PlatformGitLocator` is implemented, in product code, under a test-infra plan.** The
   justification is not "the tests need it" (they do not — `PATH` lookup already resolves git here);
   it is that the unsupported-platform case **throws** past `RepoService.create()`'s unguarded
   `await`, so it fails worse than the blocking state §4.2 designed. §2.1.2's own words are that
   adding a platform "should be implementing that case"; doing so does not move D27, which is a
   claim about what is supported and tested, not about which branches exist. W8 rewords §4.2's
   *"Only the macOS strategy is implemented"* so a spec-literalist does not read the branch as a
   contradiction — and so nobody reverts it as a stray leak.
3. **No `chokidar`, and no hand-rolled recursive shim.** The premise that Node cannot watch
   recursively on Linux is false as of the v20 line: Node ships a userland implementation for
   exactly this reason, its `filename` contract matches macOS's, and Bun's works too — all three
   verified directly, and the repo's own `recursive: true` integration test already passes here.
   Adopting a dependency (or writing our own tree-walker) to solve a solved problem would be the
   opposite of `AGENTS.md`'s prefer-a-library rule, which exists to stop us hand-rolling, not to
   make us add packages. What survives from the concern is W2's narrow stale-inode probe.
4. **`panel.spec.ts` launches the Electron binary rather than the CLI wrapper — a change that also
   alters the macOS path, made anyway.** The spec has never run on any platform, and the
   CLI-wrapper form cannot work by construction (Playwright waits for a DevTools line on a process
   that never prints one). Fixing it only for Linux would leave a known-broken macOS path in the
   tree.
5. **Xvfb is a ~25-line `scripts/e2e-display.ts`, not a documented incantation and not a
   dependency.** A documented `xvfb-run` command is knowledge the next agent will not have; the
   packages that wrap this are unmaintained; per-project `globalSetup` does not exist in the pinned
   Playwright. Twenty-five lines of `spawn` is plumbing, not infrastructure.
6. **`downloadAndUnzipVSCode()` stays unpinned; the resolved version is recorded instead.** Pinning
   would make a UI-driving suite deterministic — a real argument — but it entangles D7's
   `engines.vscode` floor, which is P11's decision, and this plan should not make a release call in
   passing. If the tier proves flaky against a moving `stable`, pinning is the named follow-up.
7. **D27's row gains a clarifying clause rather than being left untouched.** Strictly, "do not
   revise D27" is satisfiable by editing nothing. But §4.2 will name a Linux strategy and §8.4 will
   name a Linux test run, and D27 is the row a future reader checks first — leaving it silent invites
   someone to "correct" the Linux locator back into a throw. The clause **reaffirms** the claim and
   points at this plan; it does not weaken it. If that reads as a revision to anyone, delete the
   clause and put the pointer in §2.1.2 only.
8. **No visual baseline is regenerated and the owed `-darwin` set stays owed.** Nothing here touches
   rendered output, so a shifted baseline is a signal, not a chore. P0's carried-forward action is
   not silently closed by this plan running on Linux more comfortably.
9. **`engines.node` is raised only if Node's changelog confirms the release cleanly.** A wrong floor
   is worse than a loose one; if the number cannot be confirmed, drop the sub-item and record why.

---

## Findings
