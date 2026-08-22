# Kira Version — Specification

A visual Git graph tool. Primary delivery is a VS Code extension rendering into the
bottom panel (alongside the terminal); the same application must run unmodified as a
standalone Electron desktop app.

Status: **v1 requirements**. This document is the source of truth for scope, architecture,
and phasing. Interactive rebase and everything under §9 are explicitly v2. Settled questions
and their reasoning are logged in §11; §12 is what still needs an answer.

---

## 1. Goals and constraints

### 1.1 Product goals

- Read a repository's history and render it as a commit graph, fast, at repositories of
  100k+ commits.
- Make the common history operations (fetch, pull, push, stash, branch, checkout, reset,
  search) directly reachable from the graph, with enough pre-flight analysis that the user
  is not surprised by a failure or a dirty working tree.
- Never lose user work. Every destructive operation is either pre-validated, reversible via
  reflog, or explicitly confirmed with the consequence spelled out.

### 1.2 Hard constraints

| # | Constraint | Consequence |
|---|---|---|
| C1 | The whole app must run in a plain Electron shell with no VS Code present. | Every VS Code API touch lives behind a port (§3.3). Zero `import * as vscode` outside `packages/host-vscode`. Enforced by lint rule and a build-time import check. |
| C2 | Speed is a feature, not a nice-to-have. | Explicit performance budget (§5.1). Graph layout off the main thread, canvas rendering, no Vue reactivity over the commit array. |
| C3 | Uses the user's own Git. | No bundled Git binary, no native bindings (§4.1). |
| C4 | Frontend is validated with Playwright. | The UI must be runnable in a plain browser against a mock host bridge (§8.4). This falls out of C1 for free. |

### 1.3 Naming

Product name: **Kira Version**. Extension id: `kira-version`. Panel view id:
`kiraVersion.graph`. Command namespace: `kiraVersion.*`.

---

## 2. Platform surface

### 2.1 VS Code

The graph lives in the **panel** (the area hosting the terminal), not the sidebar and not
an editor tab. This is a webview view contributed to a panel view container:

```jsonc
"contributes": {
  "viewsContainers": {
    "panel": [{ "id": "kiraVersion", "title": "Git Graph", "icon": "resources/icon.svg" }]
  },
  "views": {
    "kiraVersion": [{ "id": "kiraVersion.graph", "name": "Graph", "type": "webview" }]
  }
}
```

Consequences of the panel choice, all of which the layout must handle:

- The panel is **short and wide** by default and is frequently resized. The graph is
  horizontally dense and vertically virtualized; the commit detail pane is a right-hand
  column *inside* the webview, not a separate VS Code view, so it behaves identically in
  Electron.
- The panel can be maximized (`workbench.action.toggleMaximizedPanel`) and moved left/right
  by the user. At narrow widths the detail pane collapses to an overlay drawer. Breakpoints
  in §6.3.
- Webview views are **destroyed and recreated** when the panel is hidden, unless
  `retainContextWhenHidden` is set — which is expensive. We instead persist UI state through
  `getState`/`setState` and re-hydrate the graph from the host cache on reveal (§5.4).

### 2.1.1 Supported VS Code contexts

**Local desktop VS Code only.** Remote contexts (SSH, WSL, Codespaces, dev containers) and
the browser build (vscode.dev, github.dev) are out of scope for v1 and are not tested. The
browser build is not merely untested but impossible as designed: it has no `git` process and
no child-process API, so §4 has nothing to spawn. Remote contexts would likely work — the
extension is a workspace extension and would run on the remote where git lives — but we make
no claim, run no CI for them, and will not treat a remote-only bug as a v1 defect. The
manifest declares this honestly (`extensionKind: ["workspace"]`, no `browser` entry point) so
VS Code does not offer the extension where it cannot function.

### 2.2 Electron

`packages/host-electron` provides a `BrowserWindow` loading the identical UI bundle, a main
process implementing the same ports over Electron IPC, a repo picker (native dialog), and a
theme shim that emits the same CSS custom properties VS Code injects (§3.4). No feature is
VS Code-only.

---

## 3. Architecture

### 3.1 Package layout

A Bun workspace monorepo. This tree is normative: P0 creates it, and later phases fill it in
rather than reorganising it. Files listed are the ones whose existence is a design decision;
obvious siblings (`package.json`, `tsconfig.json`, `index.ts` barrels) are implied per package
and omitted after the first example.

```
kira-version-vscode/
├── AGENTS.md                       working agreement (branch policy, plan-then-implement loop)
├── README.md
├── LICENSE
├── biome.json                      formatter + linter + import-boundary rules
├── bunfig.toml
├── package.json                    workspace root; scripts: check, check:fast, test, build, package
├── tsconfig.base.json              TS7-clean options, shared by every package
├── tsconfig.json                   solution file referencing all packages
├── playwright.config.ts            projects: harness (fast), electron, vscode
├── .github/
│   └── workflows/
│       ├── ci.yml                  check + unit + harness e2e, every push
│       └── integration.yml         real-git + electron + vscode matrix, PR and nightly
├── docs/
│   ├── SPEC.md                     this document
│   └── plans/                      Opus-authored phase plans, P0.md … P11.md
├── resources/
│   ├── icon.svg                    panel view container icon
│   └── marketplace/                README assets, screenshots
├── scripts/
│   ├── build.ts                    bundles hosts + ui via bun build / vite
│   ├── package-vsix.ts             build then `vsce package --no-dependencies`
│   └── gen-theme-palettes.ts       derives Electron palettes from VS Code theme JSON (§3.4)
│
├── packages/
│   ├── core/                       pure domain. No I/O, no DOM, no git, no framework.
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── model/              commit.ts ref.ts tag.ts stash.ts status.ts repo.ts conflict.ts
│   │       ├── store/              commitStore.ts   column-wise typed arrays (§5.5)
│   │       │                       shaTable.ts      20-byte binary sha storage + hex formatting
│   │       │                       intern.ts        string interning + concatenated subject buffer
│   │       ├── graph/              layout.ts lanes.ts edges.ts colors.ts types.ts
│   │       ├── search/             query.ts   parse toggles + scope into a query object
│   │       │                       matcher.ts client-side matching over the loaded store
│   │       │                       gitArgs.ts translate a query into git log arguments
│   │       ├── preflight/          checkout.ts stashPop.ts reset.ts revert.ts push.ts tag.ts
│   │       │                       types.ts   Hazard / Plan / Resolution unions
│   │       ├── ports/              processRunner.ts fileWatcher.ts workspaceRoots.ts storage.ts
│   │       │                       secrets.ts clipboard.ts externalOpener.ts dialogs.ts
│   │       │                       notifications.ts editorIntegration.ts theme.ts logger.ts
│   │       │                       index.ts
│   │       └── util/               nulSplit.ts result.ts assert.ts
│   │
│   ├── git/                        the only package that knows git exists
│   │   └── src/
│   │       ├── driver.ts           spawn discipline, env hygiene, write queue, cancellation (§4.3)
│   │       ├── discovery.ts        locate git, probe version, enforce the 2.38 floor (§4.2)
│   │       ├── capabilities.ts     per-repo facts: commit-graph, sparse, linked worktree
│   │       ├── catFile.ts          persistent `cat-file --batch` process
│   │       ├── logSession.ts       long-lived paged `git log` process (§5.1.1)
│   │       ├── watcher.ts          .git + worktree watching → refsChanged / worktreeChanged
│   │       ├── errors.ts           exit code + stderr → typed error union
│   │       ├── parse/              log.ts refs.ts status.ts diffTree.ts stash.ts mergeTree.ts
│   │       └── ops/                fetch.ts pull.ts push.ts stash.ts branch.ts tag.ts
│   │                               checkout.ts reset.ts revert.ts cherryPick.ts conflict.ts
│   │
│   ├── ipc/                        the contract every host and the UI share
│   │   └── src/
│   │       ├── contract.ts         request/response/event/stream type map, versioned
│   │       ├── transport.ts        Transport interface both hosts implement
│   │       ├── codec.ts            encode/decode incl. ArrayBuffer transfer lists
│   │       └── validate.ts         boundary validation; a schema mismatch fails loudly
│   │
│   ├── ui/                         Vue 3 app. Imports core + ipc only. Never `vscode`.
│   │   └── src/
│   │       ├── main.ts
│   │       ├── App.vue
│   │       ├── bridge/             client.ts   typed client over the ipc contract
│   │       ├── state/              repo.ts graphView.ts selection.ts search.ts settings.ts
│   │       ├── graph/              GraphCanvas.vue  canvas element + lifecycle
│   │       │                       renderer.ts      draws lanes/edges/nodes from typed arrays
│   │       │                       hitTest.ts       arithmetic row/lane hit testing
│   │       │                       palette.ts       reads theme tokens for canvas use (§3.4)
│   │       │                       layout.worker.ts lane assignment off the main thread
│   │       ├── components/
│   │       │   ├── Toolbar.vue RepoPicker.vue BranchPicker.vue RefreshButton.vue
│   │       │   ├── CommitList.vue CommitRow.vue LoadMoreButton.vue RefBadge.vue
│   │       │   ├── DetailPane.vue CommitMeta.vue FileTree.vue DiffView.vue
│   │       │   ├── SearchBox.vue SearchResults.vue ConflictBanner.vue
│   │       │   ├── StashList.vue TagList.vue
│   │       │   └── dialogs/        CheckoutDialog.vue ResetDialog.vue ForcePushDialog.vue
│   │       │                       StashDialog.vue TagDialog.vue RevertDialog.vue
│   │       ├── theme/              vscode-tokens.css  the token layer (§3.4)
│   │       │                       density.css        row heights, spacing scale
│   │       │                       readTokens.ts      getComputedStyle bridge for canvas
│   │       └── icons/              codicon.css + the mapping of actions → codicon names
│   │
│   ├── host-vscode/                the ONLY package permitted to import `vscode`
│   │   └── src/
│   │       ├── extension.ts        activate/deactivate, command registration
│   │       ├── panelView.ts        WebviewViewProvider for the panel container (§2.1)
│   │       ├── html.ts             CSP, nonce, asset URIs, initial state injection
│   │       ├── transport.ts        postMessage Transport implementation
│   │       └── ports/              one file per port in core/src/ports
│   │
│   └── host-electron/
│       └── src/
│           ├── main/               index.ts window.ts menu.ts recentRepos.ts
│           ├── preload/            index.ts   contextBridge surface, nothing more
│           ├── renderer/           index.html mounts packages/ui unchanged
│           ├── theme/              palettes.generated.css  (from scripts/gen-theme-palettes.ts)
│           └── ports/              one file per port in core/src/ports
│
├── apps/
│   └── harness/                    browser-only dev server; the fast Playwright target
│       ├── index.html
│       ├── vite.config.ts
│       └── src/
│           ├── mockBridge.ts       implements the ipc contract from fixtures
│           ├── scenarios/          clean.ts dirty.ts conflicted.ts hugeRepo.ts authFailure.ts
│           └── themeSwitcher.ts    force light/dark/high-contrast for visual tests
│
└── tests/
    ├── fixtures/
    │   ├── generateRepo.ts         builds real repos: topologies, sizes, conflicts
    │   └── porcelain/              recorded git output for parser unit tests
    ├── e2e/                        Playwright against apps/harness
    ├── integration/                real git + real hosts (electron, vscode)
    └── perf/                       time + heap budgets (§5.1), CI-enforced
```

Unit tests are colocated (`foo.ts` / `foo.test.ts`, run by `bun test`); only the suites that
need a harness or a real repository live under `tests/`.

**Dependency rule, enforced in CI** by Biome's `noRestrictedImports` plus a bundle check:
`core` and `ipc` depend on nothing; `git` depends on `core` + `ipc`; `ui` depends on `core` +
`ipc`; hosts depend on everything; **nothing depends on a host**. The string `vscode` appears
as an import specifier in exactly one package, and `bun:`/`Bun` in none (§8.1).

### 3.2 Process/thread topology

```
┌─ host process (extension host | electron main) ──────────────┐
│  RepoService ─ GitDriver ─ child_process(git)                │
│      │           └─ persistent `git cat-file --batch`        │
│      └─ RefWatcher (fs watch on .git)                        │
└──────────────────── typed RPC over ports ────────────────────┘
┌─ webview / renderer ─────────────────────────────────────────┐
│  Vue app (state, panes, dialogs)                             │
│      └─ Worker: parse + lane layout ─► transferable buffers  │
│      └─ Canvas graph renderer                                │
└──────────────────────────────────────────────────────────────┘
```

Git never runs in the renderer. The renderer never touches the filesystem.

### 3.3 Ports

Every host capability the app needs, as a narrow interface in `packages/core/src/ports`.
This list is the complete VS Code surface; anything not here must not be used.

| Port | Purpose | VS Code impl | Electron impl |
|---|---|---|---|
| `ProcessRunner` | spawn/exec git, stream stdout, kill, env injection | `child_process` | `child_process` |
| `FileWatcher` | watch `.git` paths + worktree, debounced | `workspace.createFileSystemWatcher` / raw `fs.watch` for `.git` | `chokidar`-class watcher |
| `WorkspaceRoots` | candidate repository roots, add/remove events | `workspace.workspaceFolders` | recent-repos store + native dialog |
| `Storage` | small persisted key/value (per repo and global) | `Memento` (workspace + global) | JSON file in `app.getPath('userData')` |
| `Secrets` | credentials the app itself holds (rare — Git owns auth) | `SecretStorage` | `safeStorage` |
| `Clipboard` | copy sha, branch, message | `env.clipboard` | `clipboard` |
| `ExternalOpener` | open compare/PR URLs | `env.openExternal` | `shell.openExternal` |
| `Dialogs` | native confirm / pick folder / save file | `window.show*` | `dialog.show*` |
| `Notifications` | toast + progress reporting | `window.withProgress`, `showMessage` | in-app toast component |
| `EditorIntegration` | open a file at a revision, show a diff | `vscode.diff`, virtual `TextDocumentContentProvider` | internal diff view (§9) |
| `Theme` | current theme kind + token CSS variables | injected by VS Code; we read | shim emits the same variable names |
| `Logger` | leveled log to an output channel | `window.createOutputChannel` | file + devtools |

`EditorIntegration` is the one port whose Electron implementation is genuinely different
rather than merely a different call: in VS Code we hand the diff to the editor, in Electron
we render it in-app. v1 ships a **read-only unified diff view inside the UI** used by both,
with VS Code additionally offering "Open in editor" — this keeps the port honest and avoids
an Electron feature hole.

### 3.4 Theming — VS Code propagates its theme, and we build on that

**Yes: VS Code pushes the active theme into every webview automatically, and keeps it in
sync.** This is the mechanism that makes "looks native" achievable rather than an endless
chase, so the design leans on it hard.

What VS Code injects into the webview document, with no API call on our side:

1. **CSS custom properties for the entire workbench colour palette.** Every theme colour id
   becomes a variable under a mechanical renaming — dots to dashes, camelCase preserved:

   | Workbench colour id | CSS variable |
   |---|---|
   | `editor.background` | `--vscode-editor-background` |
   | `panel.border` | `--vscode-panel-border` |
   | `list.activeSelectionBackground` | `--vscode-list-activeSelectionBackground` |
   | `gitDecoration.modifiedResourceForeground` | `--vscode-gitDecoration-modifiedResourceForeground` |

   Several hundred of them, covering every surface the workbench itself paints. Whatever
   theme the user has installed — built-in or from the marketplace — its colours are simply
   there.

2. **Font variables**: `--vscode-font-family`, `--vscode-font-size`, `--vscode-font-weight`,
   and `--vscode-editor-font-family` / `--vscode-editor-font-size` for the monospace faces.
   Using these is what makes shas and diffs match the user's editor exactly.

3. **Theme-kind signals on the document**: the classes `vscode-light`, `vscode-dark`,
   `vscode-high-contrast` (plus `vscode-high-contrast-light`) on `<body>`, and a
   `data-vscode-theme-kind` attribute. These carry the information colours alone cannot —
   whether to draw borders that high-contrast themes require, and which of two equally-legible
   graph palettes to pick.

4. **Live updates.** When the user switches theme, the variables and body classes change in
   place. No reload, no extension round-trip, no `onDidChangeActiveColorTheme` handler needed
   for styling — CSS re-cascades on its own.

**How the app uses it.**

- `packages/ui/src/theme/vscode-tokens.css` defines a **small, named token layer** — roughly
  40 tokens like `--kv-row-bg-hover`, `--kv-graph-lane-1`, `--kv-badge-remote-fg` — each
  mapped to a `--vscode-*` variable with a `var(--vscode-x, var(--vscode-y, <fallback>))`
  chain. Components reference only `--kv-*`. Two reasons: not every theme defines every
  colour id (the fallback chain matters), and one indirection layer means retheming a
  component is one line in one file rather than a search across the codebase.
- **The canvas is the one place this needs code.** A `<canvas>` cannot consume CSS variables;
  `renderer.ts` needs real colour strings. So `theme/readTokens.ts` resolves the token layer
  once via `getComputedStyle(document.documentElement)`, caches it, and a
  `MutationObserver` on `<body>`'s class and style attributes re-reads and triggers a full
  repaint when the theme changes. Without this the graph would keep its old colours after a
  theme switch while everything around it updated — the most visible possible bug.
- **Graph lane colours** are the only palette we invent, since no workbench colour id means
  "branch lane 3". They are generated per theme kind for contrast against
  `--vscode-editor-background`, checked for WCAG contrast, and made distinguishable under the
  common colour-vision deficiencies. High-contrast themes get their own set plus outlines.
- We also expose our colours as **themable contribution points** (`contributes.colors`), so a
  user or theme author can override lane colours and badge colours from their own theme —
  the same courtesy other Git extensions extend.

**The Electron side.** No VS Code, so nothing is injected. `scripts/gen-theme-palettes.ts`
reads the JSON of VS Code's built-in Default Dark Modern, Default Light Modern, and the two
high-contrast themes, and emits `palettes.generated.css` defining the same `--vscode-*`
variable names for the subset we actually consume. The Electron host applies one based on the
OS `prefers-color-scheme`, with a manual override. Result: **one stylesheet, no per-host
branching, and the Electron build looks like VS Code because it is literally wearing VS Code's
palette.** Because the generator reads theme files rather than hardcoding hex values,
refreshing the palettes when VS Code updates its defaults is a script run.

**What we deliberately do not use:** `@vscode/webview-ui-toolkit` is deprecated and archived —
building on it would be building on something unmaintained. We use plain components styled
against the token layer, plus **`@vscode/codicons`**, the icon font VS Code itself ships, so
our chevrons, refresh, checkmarks, and git glyphs are the exact ones the user sees everywhere
else in the window.

### 3.5 RPC contract

`packages/ipc` defines a single typed contract used by both transports:

- **Requests** (UI → host, one response): `repo.open`, `graph.query`, `commit.detail`,
  `refs.list`, `status.get`, `search.run`, `op.<name>`, `preflight.<name>`.
- **Events** (host → UI, push): `repo.changed`, `graph.invalidated`, `op.progress`,
  `op.finished`, `log`.
- **Streams** (host → UI, chunked with backpressure): `graph.stream` — commit records
  arrive in batches as the `git log` process produces them, so the first screenful renders
  before the walk completes.

Transport in VS Code is `webview.postMessage` (structured clone, `ArrayBuffer` transferable);
in Electron it is `ipcRenderer.invoke` + `MessagePort` for streams. Both implement the same
`Transport` interface. Every message is versioned and validated at the boundary; a schema
mismatch fails loudly rather than half-working.

---

## 4. Git operations — how they actually work

### 4.1 System Git, not a bundled one. Not native bindings.

**Decision: shell out to the user's installed `git`.** This is what VS Code's own Git
extension does, and it is the correct choice here for reasons that are not primarily about
binary size:

- **Credentials.** Authentication is the hard part of `fetch`/`pull`/`push`. It lives in
  credential helpers (`osxkeychain`, `wincred`, `libsecret`, `gh auth`, corporate helpers),
  SSH agents, `~/.ssh/config`, and provider-specific helpers. A bundled Git would need its
  own helper configuration and would silently fail to reuse the credentials the user already
  has. This alone decides it.
- **Configuration and policy.** `core.autocrlf`, `core.hooksPath`, `include`/`includeIf`,
  `commit.gpgsign`, custom merge drivers, `safe.directory`, corporate system config. A
  bundled Git ignoring system config produces behaviour that differs from the user's terminal
  — the worst possible outcome for a tool whose job is showing you the truth about your repo.
- **Extensions in the wild.** Git LFS, `git-crypt`, sparse checkout, worktrees, submodule
  helpers. All are installed against the system Git.
- **Distribution.** Git is GPLv2; shipping it means shipping source-offer obligations and
  ~40–120 MB per platform × 3 platforms in the `.vsix`, against a marketplace that expects
  extensions in the single-digit MB.

Rejected alternatives:

- **libgit2 / NodeGit** — native addon, must be prebuilt per platform *and* per Electron ABI,
  which drifts with every VS Code release; no credential-helper support (you reimplement auth);
  historically fragile packaging.
- **isomorphic-git** — pure JS, no native dep, but substantially slower on large histories,
  incomplete coverage (no `merge-tree`, partial stash/reflog), and it too reimplements auth.

We are a *viewer and driver* of the user's Git, and the user's Git is the definition of
correct. We accept the dependency and manage it explicitly (§4.2).

### 4.2 Git discovery and capability gating

Resolution order:
1. `kiraVersion.git.path` (our setting), if set.
2. VS Code's `git.path` setting, when running in VS Code — reuse the user's existing config.
3. `PATH` lookup.
4. Platform fallbacks: Windows `%ProgramFiles%\Git\cmd\git.exe`, `%LocalAppData%\Programs\Git\cmd\git.exe`;
   macOS — probe `/usr/local/bin`, `/opt/homebrew/bin`, then `/usr/bin/git` (which is the
   Command Line Tools shim: **running it when CLT is not installed pops a system install
   dialog**, so probe with `xcode-select -p` first and never spawn the shim blind).

**Minimum version: Git 2.38 — a hard requirement, not a soft floor.** `git merge-tree
--write-tree` (2.38, Oct 2022) is what makes the checkout and stash-pop conflict predictions
in §7.5–7.6 possible at all, and those predictions are a headline feature rather than a
nicety. Maintaining a second, weaker code path for older Git would double the test matrix to
produce an experience we would not want to ship.

The target is a developer workstation, where Git is current. Below 2.38 the app does not
start into a degraded mode; it shows a single clear blocking state naming the detected
version, the required version, and the platform's upgrade command, plus the
`kiraVersion.git.path` setting in case a newer Git is installed elsewhere on the machine.
This is checked once at repo open, off the version probe we already run.

Capabilities are probed once per Git binary and cached by version + path:

| Capability | Needs | Used for |
|---|---|---|
| `mergeTreeWriteTree` | 2.38 | conflict prediction without touching the worktree |
| `commitGraph` | 2.24 | fast topological walks (also: is a graph file present for this repo?) |
| `sparseCheckout` | 2.25 | detect a sparse worktree, which changes what "dirty" means |

Everything below 2.38 (`--force-if-includes` 2.30, porcelain v2 2.11, `stash push` 2.13) is
implied by the floor and needs no probe. The probe remains because capability detection is
still needed for *repository* facts (is a commit-graph file present, is this worktree sparse,
is it a linked worktree) and because the floor will move over time.

### 4.3 Invocation discipline

Every spawn goes through one `GitDriver`. Non-negotiable rules:

- **Never parse human-readable output.** Only porcelain/plumbing with explicit formats.
- **NUL-delimited everything.** `-z` where supported, `%x00` record separators and `%x1f`
  field separators in `--format`, so commit messages containing newlines are unambiguous.
- **`-c core.quotepath=false`** so non-ASCII paths come back as UTF-8 bytes rather than
  escaped octal.
- **`git --no-optional-locks`** on every read command, and `GIT_OPTIONAL_LOCKS=0` in the env,
  so background reads never fight the user's terminal for `index.lock`.
- **`GIT_TERMINAL_PROMPT=0`** always. Git must never block on an invisible TTY prompt. Auth
  goes through the askpass path in §7.4 or fails fast with a typed error.
- **No `git pull`** (see §7.3), **no `git log --graph`** (see §5.2), **no `git checkout` where
  `git switch`/`git restore` is clearer**.
- **Streaming, not buffering.** `git log` output is consumed as a stream with an incremental
  NUL-splitting parser; nothing waits for process exit. Every long-running spawn is
  cancellable via `AbortSignal` and is killed when its query is superseded.
- **Serialized writes.** A per-repository queue serializes mutating operations; reads run
  concurrently up to a bounded pool. A mutating op invalidates the graph cache on completion.
- **Persistent `git cat-file --batch`** per repo for object reads (blobs for diffs, commit
  bodies on demand), avoiding process spawn per file.
- Errors are classified into a typed union (`AuthFailed`, `NonFastForward`, `Conflict`,
  `DirtyWorktree`, `LockHeld`, `NotFound`, `HookRejected`, `Unknown`) from exit code +
  stderr pattern matching, with the raw stderr always preserved and surfacable.

### 4.4 The commands

Discovery and identity:
```
git rev-parse --show-toplevel --git-dir --git-common-dir --is-bare-repository
git rev-parse --abbrev-ref HEAD          # or detached detection via symbolic-ref
git version
```

History walk (the hot path):
```
git --no-optional-locks log --topo-order -z \
    --format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%D%x1f%s \
    --all --glob=refs/stash --max-count=<page>
```
`--all` covers heads/tags/remotes but **not** `refs/stash`, hence the explicit `--glob`.
Bodies are fetched lazily per selected commit, never in the bulk walk. `--topo-order` is
required for stable lane assignment; where a commit-graph file exists it is dramatically
faster, and `kiraVersion.git.maintainCommitGraph` (default off, since it writes into `.git`)
can opportunistically run `git commit-graph write --reachable --split`.

Refs:
```
git for-each-ref --format=%(refname)%1f%(objectname)%1f%(objecttype)%1f%(upstream)%1f%(upstream:track)%1f%(committerdate:unix)%1f%(HEAD) \
    refs/heads refs/remotes refs/tags
```

Working tree state:
```
git --no-optional-locks status --porcelain=v2 --branch --untracked-files=normal -z
```

Commit detail (metadata + file tree):
```
git show -s --format=<full fmt> <sha>                       # body, trailers, signature
git diff-tree -r -m --no-commit-id --numstat -z <sha>       # per-file adds/dels
git diff-tree -r -m --no-commit-id --name-status -M -C -z <sha>  # rename/copy detection
```
Merge commits use `-m` and the UI offers a parent selector (default: first parent).

Diffs: `git diff <base> <head> -- <path>` for the in-app unified view; blob content via the
persistent `cat-file --batch`.

Conflict prediction without touching the worktree (§7.5, §7.6):
```
git merge-tree --write-tree --messages --name-only <base> <other>
```
Exit code 0 = clean merge, 1 = conflicts (listed on stdout), >1 = error.

Mutating operations are listed per feature in §7.

### 4.5 Change detection

An `fs.watch`-based watcher on `.git/HEAD`, `.git/refs/**`, `.git/packed-refs`,
`.git/index`, `.git/FETCH_HEAD`, `.git/MERGE_HEAD`, `.git/rebase-merge|rebase-apply`, plus
the worktree via the `FileWatcher` port (respecting `.gitignore`). Events are debounced
(200 ms) and coalesced into two signals: `refsChanged` (re-run the ref query, re-render
decorations, possibly re-walk) and `worktreeChanged` (re-run status only). We never poll on
a timer while the window is hidden.

---

## 5. Performance

### 5.1 Budget

Measured on a 100k-commit repository, mid-range laptop, warm OS cache:

| Metric | Budget |
|---|---|
| Panel open → first commits painted | ≤ 300 ms |
| First page (5k commits) parsed + laid out | ≤ 400 ms (streaming; UI interactive throughout) |
| "Load more" press → appended rows painted | ≤ 400 ms, scroll position unchanged |
| Scroll | 60 fps sustained, no frame > 32 ms |
| Commit select → detail pane populated | ≤ 80 ms |
| Incremental search keystroke → results | ≤ 120 ms for already-loaded history |
| Idle memory, first page | ≤ 80 MB renderer |
| Idle memory, full 100k loaded | ≤ 250 MB renderer |

These are CI-checked with a synthetic repository generator; a regression beyond 20% fails
the build. The 100k row is the ceiling test — reached by scripted "load more" presses — not
the default experience.

### 5.1.1 Paging: an explicit "Load more", not infinite scroll

History is loaded in **pages of 5,000 commits** (`kiraVersion.graph.pageSize`), with an
explicit **Load more** button pinned at the bottom of the list. Not infinite scroll.

This is a deliberate trade against the streaming-everything design, and it is the right one:

- Memory stays proportional to what the user actually looked at. A monorepo with 800k commits
  costs the same on open as a 200-commit one.
- Loading is a decision the user makes, so it never competes for CPU with their scrolling.
  Infinite scroll's failure mode is jank at exactly the moment the user is moving fast.
- Scroll position is meaningful. With infinite scroll the scrollbar lies — it shrinks under
  the user as content appends. With paging the thumb is honest between loads.
- `git log` is still walked lazily either way; the difference is who decides when.

Mechanics: the walk is `git log --skip=<n> --max-count=<pageSize>` continued from the
previous page, or better, a single long-lived `git log` process per repo that we read
`pageSize` records from and then **pause** (stop reading; the OS pipe buffer applies
backpressure and git blocks), resuming on Load more. The second form avoids re-walking and is
what P2 implements, with `--skip` as the fallback if a repo's process was reclaimed.

The button shows what it will do — "Load 5,000 more (127,400 remaining)" — with the remaining
count from a cheap `git rev-list --count --all` run once per refresh. A modifier-click loads
everything, for the user who knows what they are asking for and accepts the memory. Loading
more never moves the viewport, never disturbs selection, and is cancellable.

Search (§7.8) is unaffected: it queries git across the *whole* history regardless of what is
loaded, so a commit from page 40 is findable without loading pages 1–39. Selecting such a
result loads the pages up to it.

### 5.2 Graph layout

Lane assignment is computed by us, in a worker, never by `git log --graph` (which is ASCII,
unstable under filtering, and forces git to do work we then have to reverse-engineer).

The algorithm is a single forward pass over the topologically ordered commit list
maintaining an array of open lanes; for each commit, claim the leftmost lane whose expected
child is this commit, route remaining parents into free or newly-allocated lanes, and emit
edge segments. Output is packed into flat `Uint32Array`/`Float32Array` buffers
(row → lane, colour index, edge segment list) and **transferred**, not cloned, to the main
thread.

### 5.3 Rendering

- The graph column is a single `<canvas>`, redrawn per frame for the visible row window
  only, `devicePixelRatio`-aware. Hit testing is arithmetic (row = `floor(y / rowHeight)`),
  not DOM.
- Text columns (message, author, date, ref badges) are virtualized DOM rows — real text for
  accessibility, selection, and theming — with a recycled row pool.
- Commit data lives in `markRaw`/`shallowRef` structures backed by typed arrays. Vue's
  reactivity never traverses the commit set; only the view window, selection, and filter
  state are reactive.
- Strings (messages, authors) are interned in a shared table so a repo with one author
  stores one string.

### 5.4 Caching and rehydration

The host keeps the parsed commit set per repo in memory for the session — **only the pages
actually loaded** (§5.1.1). When the panel is hidden and the webview disposed, the UI persists
view state (scroll offset, selection, filters, column widths, **and how many pages were
loaded**) via `setState`; on reveal it re-requests the stream, which the host serves from
cache — the same rows repaint without re-running git and without the user having to press
Load more again. The cached set is dropped when the repo is deselected or the window has been
hidden past a threshold (§5.5).

### 5.5 Memory discipline

Being light on memory is a stated requirement, and on a 100k-commit repository the naive
representation is the whole problem: an array of 100k plain objects with eight string fields
each is roughly 60–120 MB of JS heap before any UI exists, and it is heap that the GC must
walk on every major collection — which is what turns into scroll jank.

Rules:

- **Commits are stored column-wise in typed arrays, not row-wise as objects.** Parallel
  `Uint32Array`s hold row → sha-table index, parent indices, author-table index, timestamps,
  lane, colour. A commit "object" is materialized on demand for the ≤ 60 rows on screen and
  the one selected commit, then discarded. 100k commits cost single-digit MB.
- **Shas are stored as 20-byte binary in a single flat `Uint8Array`**, not as 40-char hex
  strings (which cost ~120 bytes each in V8). Hex is formatted only for display.
- **Strings are interned.** Author names, emails, and ref names go into a dedupe table; a
  repo with 20 authors stores 20 strings, not 100k. Commit subjects are the one genuinely
  large set and are kept in a single concatenated buffer with an offset index rather than
  100k separate string objects.
- **Bodies are never loaded in bulk** — only for the selected commit, via the persistent
  `cat-file --batch`.
- **Worker → main transfers are `ArrayBuffer` transfers, not clones**, so layout output is
  never duplicated across threads.
- **The DOM row pool is fixed-size** (visible rows + small overrun). No row is created during
  scrolling; nodes are recycled and their text updated.
- **Caches are bounded and evictable**: diff text LRU (cap by bytes, not entries), rendered
  canvas tiles, and the per-repo commit set, which is dropped when the repo is deselected and
  when the window has been hidden past a threshold.
- Memory is a **CI-checked budget**, not an aspiration: the perf harness (P0) measures
  renderer heap after loading the 100k synthetic repo and fails the build on a >20%
  regression, alongside the timing budgets in §5.1.

---

## 6. User interface

### 6.1 Visual language: indistinguishable from VS Code

The target is that a user opening the panel cannot tell where VS Code stops and this
extension starts. That is a stricter goal than "themed correctly", and it is mostly about
restraint — every place we invent a visual decision is a place we drift.

Rules:

- **No colour that is not a theme token.** No hardcoded hex anywhere in `packages/ui`,
  enforced by a lint rule. Colours come from the `--kv-*` token layer, which comes from
  `--vscode-*` (§3.4). The graph lane palette is the single exception and is generated,
  contrast-checked, and user-overridable.
- **VS Code's own components are the reference for ours.** The commit list borrows the
  workbench list's metrics and states — 22px rows at default density, hover, focus and
  selection backgrounds from `--vscode-list-*`, the focus outline from
  `--vscode-focusBorder`. The toolbar borrows the panel title bar's height and button
  treatment. Dialogs borrow the quick-input surface. Where VS Code has already solved a
  layout, we copy it rather than design a second answer.
- **Codicons only** (§3.4), never a second icon set. Refresh, chevrons, git glyphs, check
  marks, and the ellipsis menu are the exact glyphs used elsewhere in the window.
- **The user's fonts.** `--vscode-font-family` for UI text, `--vscode-editor-font-family` for
  shas, diffs, and anything monospace, so the diff view matches the editor beside it.
- **VS Code's density, not a web app's.** Tight vertical rhythm, no decorative padding, no
  drop shadows beyond `--vscode-widget-shadow`, no rounded corners where the workbench has
  square ones, no animation beyond the ~100ms transitions VS Code itself uses. The panel is
  short; every wasted pixel of chrome is a commit the user cannot see.
- **Git status colours come from git's own tokens** —
  `--vscode-gitDecoration-modifiedResourceForeground` and siblings — so a modified file in our
  file tree is the same colour as in the Explorer.
- **All four theme kinds are first-class**: light, dark, high-contrast dark, high-contrast
  light. High contrast is not an afterthought; it requires explicit borders where other
  themes use background fills alone, and the visual regression suite covers all four.

This is verified, not asserted: the Playwright suite screenshots every surface in all four
theme kinds (the harness can force a kind via `themeSwitcher.ts`), and P4's review includes
a side-by-side against the native workbench list at the same density.

### 6.2 Layout

```
┌ Toolbar ─────────────────────────────────────────────────────────────────────┐
│ [repo ▾] [branch ▾] │ ⟳ │ Fetch  Pull  Push │ Stash ▾ │ Search […]  ⚙ │
├ Graph ──────────────────────────────────────┬ Detail (right, resizable) ─────┤
│ ●─┐  feat: …            alice   2h   [main] │ sha, author, committer, dates  │
│ │ ●  fix: …             bob     3h          │ full message + trailers        │
│ ●─┘  Merge pull request…  alice 5h  [origin/│ parents (clickable), refs      │
│ …virtualized…                               │ ── File tree ────────────────  │
│ [ Load 5,000 more (127,400 remaining) ]     │  src/  ▸ 3 files  +42 −7       │
└─────────────────────────────────────────────┴────────────────────────────────┘
```

Columns: graph, message (with inline ref badges), author, date, sha. All resizable and
persisted; date column switches between relative and absolute on click.

**Refresh** (`⟳`, leftmost action; `F5` and `Ctrl/Cmd+R` when the panel has focus) forces a
full re-query — refs, status, and history walk — bypassing every cache, and is the escape
hatch for anything the watcher (§4.5) missed: a `git` command run in the terminal on a
filesystem where watching is unreliable (network shares, some container mounts, WSL crossing
the 9p boundary). It is distinct from the automatic invalidation the watcher performs, which
is incremental and does not re-walk. The button shows a spinner while in flight, is
idempotent (a second press while running is a no-op, not a queued second walk), and preserves
selection and scroll position across the refresh.

### 6.3 Responsive behaviour

The panel is short and often narrow. Breakpoints on the webview's own width:

- `≥ 900 px` — detail pane docked right, default 380 px, resizable, persisted.
- `600–900 px` — detail pane docked right but collapsed by default; opens on selection.
- `< 600 px` — detail pane becomes an overlay drawer over the graph, dismissible.

Vertically the graph is virtualized to whatever height the panel has, down to ~3 rows.

### 6.4 Detail pane (on commit click)

- **Metadata**: full and short sha (click to copy), subject, body with URL/issue linkification,
  author + committer with avatar initials and both timestamps when they differ, parents as
  clickable shas, all refs pointing at this commit, signature verification status
  (`%G?` from `git show`), and trailers parsed out (`Co-authored-by`, `Signed-off-by`).
- **File tree**: hierarchical, collapsible, with per-file status (A/M/D/R/C), rename arrows,
  and `+adds/−dels`. Directory rows aggregate their children's counts. Clicking a file opens
  the diff (in-app unified view; "Open in editor" additionally offered under VS Code).
  Toggle between tree and flat list; a filter box within the tree.
- **Clicking a file opens its diff for that commit** — this is the primary interaction of the
  pane, not a secondary action. The diff is `<parent> → <commit>` for that path (for merges,
  against the selected parent), rendered in the in-app unified diff view described in §3.3,
  which opens as a third region: on wide panels it takes over the detail pane with a back
  affordance to the file tree; on narrow panels it opens as a full-width overlay. Under
  VS Code an "Open in editor" action additionally hands the same diff to `vscode.diff` for a
  native side-by-side editor tab. Arrow keys move between files in the tree with the diff
  following the selection, so a commit can be reviewed file by file without the mouse.
  Renames show the old → new path; binary files and LFS pointers are labelled rather than
  rendered as garbage.
- **Actions**: checkout this commit, create branch here, **create tag here (§7.9)**,
  reset to here (§7.7), **revert this commit (§7.10)**, cherry-pick (v1: single commit, no
  conflict-resolution UI beyond reporting), copy sha, copy message. Reset and revert sit
  adjacent with their difference stated inline — revert adds a commit and is safe on pushed
  branches; reset moves the branch pointer and is not.
- For merge commits, a parent selector controls which diff is shown.

### 6.5 Interaction

Keyboard-first: `↑/↓` move selection, `Enter` open detail, `/` focus search, `F5` refresh,
`Ctrl/Cmd+F` search, `Esc` close overlay/drawer. Full keyboard reachability and ARIA roles
on the virtualized list are v1 requirements, not polish.

Every mutating action is available from a context menu on the row it applies to and from the
toolbar where it is repo-scoped.

---

## 7. Feature specifications

Every operation below follows the same shape: **pre-flight** (compute what will happen and
whether it can happen) → **confirm** (only when destructive or when pre-flight found a
hazard) → **execute** (queued, cancellable, progress-reported) → **reconcile** (invalidate,
re-query, restore selection). Pre-flight logic lives in `packages/core` as pure functions
over queried state, so it is unit-testable without a repository.

### 7.1 Fetch

`git fetch --prune --prune-tags <remote|--all>`. Progress parsed from stderr's counting
output. Prune is on by default with a setting to disable. Post-fetch the UI shows an
ahead/behind delta per branch from `%(upstream:track)`.

**Automatic background fetch: implemented, `kiraVersion.fetch.autoInterval` defaults to `0`
(off).** Setting it to a positive number of minutes enables a periodic fetch. When enabled:
the timer only runs while the window is focused and the panel visible, it never runs while
another operation holds the write queue, a failure disables the timer for the rest of the
session rather than retrying into a rate limit or a repeated auth prompt, and — because
`GIT_TERMINAL_PROMPT=0` is always set (§4.3) — a credential-less remote fails fast instead of
hanging. Auto-fetch and force-push safety interact: a background fetch advances the
remote-tracking ref, which is exactly why §7.4 always passes an explicitly observed lease sha
rather than relying on bare `--force-with-lease`.

### 7.2 Push

`git push <remote> <local>:<remote-branch>`, with `--set-upstream` when no upstream exists
(offered, not silent). Pre-flight computes ahead/behind from the last known remote-tracking
ref and warns when behind. `HookRejected` and `NonFastForward` are distinguished in the
error surface, the latter offering "fetch and review" rather than "force" as the primary
action.

### 7.3 Pull

**Never plain `git pull`.** Pull is decomposed:
```
git fetch <remote>
git merge --ff-only <upstream>     # or: git merge <upstream>  |  git rebase <upstream>
```
The strategy (ff-only / merge / rebase) is a setting defaulting to **ff-only**, with the UI
offering the other two when ff-only is not possible and telling the user why. Rationale: the
user's `pull.rebase` config makes plain `git pull` do different things on different machines,
and a graph tool that surprises you about which one it did is worse than useless. We read
`pull.rebase`/`pull.ff` and default our offer to match the user's config, but we always show
which one we are about to run.

Pre-flight: dirty working tree + a non-ff pull is a hazard → offer autostash (implemented as
our own stash/pop, so the pop is under our conflict handling, not `--autostash`'s).

### 7.4 Force push

Default and preferred form:
```
git push --force-with-lease=<refname>:<sha-we-last-observed> --force-if-includes <remote> <ref>
```
`--force-with-lease` without an explicit expected sha is unsafe in a tool that fetches in the
background (a background fetch updates the remote-tracking ref and the lease then protects
nothing), so we **always** pass the explicit sha we last displayed to the user.
`--force-if-includes` (Git ≥ 2.30) additionally guarantees the local ref actually incorporates
that remote state.

Plain `--force` is available only behind a second, explicit confirmation that names the
commits that will become unreachable on the remote, and is disabled entirely for branches
matching `kiraVersion.protectedBranches` (default `main`, `master`, `release/*`).

Confirmation dialog states: remote, ref, the sha being overwritten, the commit count being
dropped, and whether the lease is intact.

### 7.5 Branching and checkout (smart)

Create branch: `git branch <name> <start-point>` or `git switch -c <name> <start-point>`,
with name validation via `git check-ref-format --branch` before spawning, and optional
"set upstream" and "checkout after create".

Switch branch: `git switch <branch>`; detached checkout of a commit: `git switch --detach <sha>`.

**Pre-flight — can this checkout happen?** This is the "smart enough to determine if it can
be done" requirement, computed before we run anything:

1. `git status --porcelain=v2 -z` → the set of locally modified/staged/untracked paths `D`.
2. `git diff --name-only HEAD <target>` → the set of paths the checkout will rewrite `T`.
3. Classify:
   - `D ∩ T = ∅` → **clean carry**. Git will carry the local changes across. Proceed with no
     prompt.
   - `D ∩ T ≠ ∅` → **blocked**. Git will refuse ("local changes would be overwritten"). We
     name the exact files and offer three routes: stash-and-carry (§7.6 prediction runs
     first), discard, or cancel.
   - Untracked file in `T` that exists in the target tree → **blocked by untracked**. Named
     explicitly, since git's own message here is a common confusion.
4. In-progress operation (merge/rebase/cherry-pick, detected from `.git` state files) →
   blocked outright with an explanation and no auto-resolution.

### 7.6 Stash

Operations: `git stash push [-u] [-m <msg>] [-- <pathspec>]`, `git stash list`,
`git stash show -p <ref>`, `git stash apply/pop/drop <ref>`, `git stash branch`.

Stashes are visible in two places: a dedicated stash list (with message, date, base commit,
file count) and as nodes in the graph itself (they are commits; `--glob=refs/stash` in the
walk puts them there), visually distinguished.

**Pre-flight — "would stashing and popping on the other branch work?"** Before offering
stash-and-carry as a resolution to a blocked checkout, we predict the pop:

1. The stash entry is a merge commit whose first parent is its base commit; the working-tree
   changes are the diff `stash^ → stash`. (With `-u`, the third parent holds the untracked
   set.)
2. Predict with `git merge-tree --write-tree --messages --name-only <target-commit> <stash-commit>`
   using `stash^` as the merge base — this is exactly the three-way merge `git stash pop`
   performs, computed entirely in the object database with no worktree writes and no side
   effects.
3. Exit 0 → **"will apply cleanly"**; the flow runs stash → switch → pop automatically.
   Exit 1 → **"will conflict in these files: …"**; we list them and let the user choose
   stash-and-switch-without-popping (the stash stays safely in the list) or cancel.
4. The prediction is exact, not heuristic — it is the same merge git would run — so the UI
   states it as fact. This is what the 2.38 floor (§4.2) buys.

If a pop is executed and does conflict anyway (a race), we report it, and critically: `pop`
that conflicts **does not drop the stash** — we say so, so the user knows their work is still
recoverable.

### 7.7 Reset

All three modes, from a commit in the graph:

| Mode | Command | What the UI must say |
|---|---|---|
| Soft | `git reset --soft <sha>` | Branch pointer moves. Index and working tree untouched; the difference appears as staged changes. Nothing is lost. |
| Mixed | `git reset --mixed <sha>` | Branch pointer moves, index reset. Changes appear unstaged. Working tree files untouched. Nothing is lost. |
| Hard | `git reset --hard <sha>` | Branch pointer, index, **and working tree** reset. **Uncommitted changes are destroyed and are not recoverable.** Commits left behind remain in the reflog for `gc.reflogExpire` (default 90 days). |

Pre-flight before any reset: current dirty file count, and the count/list of commits that
will leave the branch (`git rev-list --count <sha>..HEAD`). Hard reset with a dirty tree
requires a typed confirmation and offers "stash first" as the primary alternative. After any
reset we surface the previous HEAD sha with a one-click "undo" (`git reset --hard <prev>` for
hard; `git reset --soft <prev>` otherwise), backed by the reflog.

Reset is disabled while a merge/rebase is in progress, and on a detached HEAD it is presented
as what it is — moving nothing but HEAD.

### 7.8 Search

A single input with three independent toggles and a scope selector, matching the shape the
user expects from VS Code's own find widget.

**Toggles** (persisted): `Aa` case sensitive · `ab|` whole word · `.*` regex.

**Scope**: `Commits` · `Refs` (branches **and tags**) · **`Both` (default)**.

Semantics:

- **Commits.** Matches over subject, body, author name/email, committer name/email, and sha
  prefix. Executed **client-side over already-loaded commits** for instant feedback — this is
  what makes the ≤120 ms budget achievable — and simultaneously handed to git for the
  not-yet-walked tail:
  `git log --all -z --format=… -i? -E? --grep=<pat> --author=<pat> --all-match?` with
  `--regexp-ignore-case` for case-insensitive, `--extended-regexp`/`--perl-regexp` for regex,
  `--fixed-strings` for literal. Whole-word is implemented by wrapping the pattern in `\b…\b`
  (regex mode) or by post-filtering on token boundaries (literal mode), since git has no
  word-boundary flag.
- **Refs.** Matches local branches, remote-tracking branches, **and tags** by name, over the
  ref list already in memory. Tags additionally match on their annotation message. Results
  are grouped and labelled by kind (local / remote / tag) so `v1.2.0` the tag is never
  confused with `v1.2.0` the branch. Same three toggles apply.
- **Both.** Two result groups in one dropdown, refs first (they are few and usually what you
  meant), then commits. Selecting a ref scrolls to and highlights the commit it points at
  (for an annotated tag, the commit it dereferences to); selecting a commit selects it in the
  graph.

Behaviour: results are highlighted in place *and* navigable with `Enter`/`Shift+Enter`
(next/previous match), with a match count. An invalid regex is reported inline as you type,
never thrown. Search never blocks the UI; a superseded query aborts its git process.

A separate, explicitly-labelled **file-content search** (`git log -S`/`-G` pickaxe) is v2 —
it is a different mental model and does not belong behind the same box.

### 7.9 Tags

Tags are first-class in v1, not a side effect of the ref list.

**Display.** Tags render as badges on their commit, visually distinct from branch badges
(different shape and colour), and appear in a dedicated tags list alongside the branch list.
Annotated and lightweight tags are distinguished, since they behave differently: an annotated
tag is its own object with a tagger, date, and message, and the graph must dereference it
(`^{commit}`) to place the badge. Signed tags show verification status on selection, under
the same "only for the selected item" rule as commit signatures (§12 Q7). The tag query is
part of the `for-each-ref` call in §4.4 — no extra process:

```
git for-each-ref --format=%(refname)%1f%(objectname)%1f%(objecttype)%1f%(*objectname)%1f%(taggername)%1f%(taggerdate:unix)%1f%(contents:subject) refs/tags
```
`%(*objectname)` is the dereferenced commit for annotated tags and empty for lightweight ones,
which is also how we tell the two apart in one pass.

**Search.** Covered by the `Refs` scope in §7.8, including annotation text.

**Manipulation**, from the tag list and from a commit's context menu:

| Action | Command | Notes |
|---|---|---|
| Create lightweight | `git tag <name> <sha>` | name validated with `git check-ref-format` before spawning |
| Create annotated | `git tag -a <name> -m <msg> <sha>` | message required; `-s` when `tag.gpgSign` or the user opts in |
| Delete local | `git tag -d <name>` | confirmation names the commit it pointed at; the sha is surfaced afterwards so it can be recreated |
| Delete on remote | `git push <remote> --delete <name>` | separate, explicitly-labelled action — deleting locally must never silently touch the remote |
| Push one tag | `git push <remote> <name>` | |
| Push all tags | `git push <remote> --tags` | explicit action, never implied by a normal push |
| Checkout | `git switch --detach <name>` | goes through the §7.5 pre-flight like any other checkout, and says plainly that it results in a detached HEAD |

Pre-flight: creating a tag whose name already exists is detected before spawning and offers
"move it" (`-f`) as an explicit, separately-confirmed choice rather than failing with git's
error. Deleting a tag that exists on a remote warns that a `fetch` will not bring it back
unless the remote copy is also deleted — the asymmetry that makes tag deletion confusing.
Sorting the tag list is version-aware (`--sort=-v:refname`) so `v10` follows `v9`.

### 7.10 Revert

A **Revert commit** button in the commit detail pane's action row (§6.4) and in the row
context menu.

```
git revert --no-edit <sha>                       # single parent
git revert --no-edit -m <parent-number> <sha>    # merge commit
```

Semantics the UI states before running: revert creates a *new* commit that undoes the
selected one; it does not remove it from history and is safe on pushed branches — the
opposite of reset (§7.7), and the two are deliberately adjacent in the menu with that
distinction spelled out.

Pre-flight:
- Dirty working tree → git will refuse. Detected first, with "stash first" offered (§7.6).
- **Merge commit** → a mainline parent is mandatory. We detect the merge and require the user
  to pick which parent's changes to keep, rather than guessing `-m 1`.
- **Conflict prediction**: `git merge-tree` against the inverse patch tells us whether the
  revert applies cleanly. When it will not, we say which files conflict and offer
  `--no-commit` (stage the revert without committing, so the user resolves in their editor)
  or cancel. v1 does not resolve conflicts itself, but it must never leave the user stranded
  mid-revert without saying so — `git revert --abort` is offered from the in-progress state
  banner (§7.11).
- Detached HEAD → allowed, with a note that the new commit will not be on any branch.

Reverting multiple selected commits is supported as a single `git revert` invocation with
several shas (git applies them newest-first), all-or-nothing.

### 7.11 In-progress and conflicted repository state

v1 performs operations that can leave the repository mid-conflict — a stash pop, a
cherry-pick, a revert — and it does **not** build a conflict-resolution UI. What it must do
instead is detect the state, make it impossible to miss, and hand the user to a resolver.

**Detection.** `.git` state files, read on every watcher tick (§4.5): `MERGE_HEAD`,
`CHERRY_PICK_HEAD`, `REVERT_HEAD`, `BISECT_LOG`, `rebase-merge/`, `rebase-apply/`, plus
unmerged entries from `status --porcelain=v2` (the `u` records, which carry the stage-1/2/3
object ids).

**Presentation.** A persistent banner across the top of the panel naming the operation in
progress and listing the unmerged paths, plus per-file conflict markers in the detail pane.
While this state holds, mutating operations that git would refuse anyway — checkout, reset,
revert, another stash pop — are disabled with the banner as the explanation, rather than
being offered and then failing.

**Resolution: delegated, and in VS Code that delegation is genuinely complete.** VS Code
resolves merge conflicts natively — the built-in `merge-conflict` extension decorates
conflict markers in any file with inline *Accept Current / Accept Incoming / Accept Both /
Compare* actions, and the Git extension's SCM view surfaces a **Merge Changes** group whose
files open in the **three-way merge editor** (Current / Incoming / Result). This works on
conflicts regardless of which tool created them: they are ordinary conflict markers and index
stages in the user's repository. So under VS Code we do not reimplement any of it. The banner
offers:

- **Resolve in VS Code** → reveals the SCM view and opens the first unmerged file in the merge
  editor, via the `EditorIntegration` port.
- **Continue** → `git <op> --continue`, enabled only once `status` reports no unmerged paths.
  We watch `.git/index` and enable it the moment the user finishes resolving, so the flow
  returns to our UI without a manual refresh.
- **Abort** → `git <op> --abort`, always available.

**The Electron gap, stated plainly.** A standalone Electron build has no merge editor and no
host editor to delegate to. v1 does not close that gap. There, the banner offers Abort,
Continue, "open the conflicted file in the system default editor" (`ExternalOpener`), and a
read-only view of the conflict hunks. This is the one place where the Electron build is
deliberately weaker than the VS Code build, and it is why `EditorIntegration` exposes conflict
resolution as an **optional capability** the UI feature-detects rather than assumes. A built-in
resolution UI is v2 (§9).

**Non-goal:** we never auto-resolve, never pick a side, and never run `git checkout --theirs`
on the user's behalf.

### 7.12 Other v1 operations

Cherry-pick (single commit), delete branch (with "not fully merged" detection and an explicit
force path), rename branch, and copy sha/message/branch/tag name. Each follows the
pre-flight → confirm → execute → reconcile shape.

---

## 8. Toolchain

### 8.1 Bun — **compatible as tooling, not as runtime**

- **Runtime: no.** A VS Code extension's host process is Node.js, supplied by VS Code. We
  cannot choose the runtime. Therefore: no `Bun.*` APIs, no `bun:*` imports, no Bun-only
  behaviour anywhere in `core`, `git`, `ipc`, `ui`, or `host-vscode`. Enforced by a lint rule
  banning the `bun:` specifier and `Bun` global outside test files, plus a check that the
  built extension bundle contains no Bun references.
- **Package manager, script runner, bundler, test runner: yes.** `bun install`, `bun run`,
  `bun build`, `bun test` are all fine — they are development-time only, and the artifact we
  ship is plain bundled JS.
- **One packaging wrinkle.** `@vscode/vsce` hardcodes `npm` for the `vscode:prepublish`
  hook and does not detect `bun.lock`. Mitigation, which is also good practice independently:
  we **do not define a `vscode:prepublish` script**. The build is run explicitly
  (`bun run build`) and packaging is `bunx @vscode/vsce package --no-dependencies`, which is
  valid because we bundle all dependencies. Node/npm remain required on the release machine
  only.
- Electron likewise runs Node, not Bun — same rule, and it is the same rule, which is
  convenient.

**Verdict: adopt, with the runtime ban enforced mechanically.**

### 8.2 Biome — **compatible**

Formatter + linter for TS, JS, JSON, CSS. Replaces ESLint and Prettier entirely; zero runtime
footprint. Vue SFC support landed in Biome 2.3 (script, style, and template blocks are parsed
and formatted) and improved in 2.4 with Vue-specific CSS syntax (`:deep`, `:slotted`,
`v-bind()`).

**Caveat, worth knowing before you rely on it:** Vue support is still flagged experimental,
and cross-block rules — the ones that need to know a `<script setup>` binding is used in the
template — can emit false positives (e.g. "unused function" for a template-only handler).
Mitigations: pin the Biome version, keep logic in `.ts` files with thin SFCs (which we want
anyway for testability), and if a specific rule proves noisy, disable that rule for `*.vue`
rather than abandoning Biome. Biome also enforces our architectural boundaries via
`noRestrictedImports` (the `vscode` module outside `host-vscode`; the `bun:` ban above).

**Verdict: adopt.**

### 8.3 TypeScript 7 — **write TS7-clean now, switch the checker when `vue-tsc` supports it**

TypeScript 7.0 (the Go-native compiler, "Project Corsa") went stable in July 2026 with 8–12×
faster checks. Nothing about it conflicts with VS Code or Electron: **nothing is compiled by
`tsc` at all.** Transformation is done by esbuild/Vite/`bun build`; TypeScript runs
`noEmit` as a pure type checker. So the choice affects CI wall-clock and editor feedback
latency, and nothing about the shipped artifact. That also means it is reversible at any time,
which is why it does not deserve to become a risk.

**The blocker is Vue, and running both checkers does not route around it.** TS 7.0 does not
ship the stable programmatic compiler API. Volar — what `vue-tsc` and the Vue language service
are built on — embeds that API to type `.vue` template blocks, so `vue-tsc` cannot run on TS 7.
The API is slated for TS 7.1 (~October 2026), with `vue-tsc` expected to follow within a
release or two.

An earlier draft of this document proposed running tsgo over the `.ts` packages and `vue-tsc`
over `.vue`. **That plan was wrong, for the reason you would expect:** `vue-tsc` type-checks a
whole *program*, not a set of files — to type a `.vue` file it must check everything that file
imports. So a naive two-checker setup has TS 5.x checking the entire codebase anyway, with a
redundant fast pass layered on top. The slow checker stays the long pole and the win is
nearly zero. The premise "most of the code is still on TS 5" would have been accurate.

There are two ways out, and they differ in cost:

1. **Project references + declaration emit.** Give `packages/ui` its own tsconfig that consumes
   `core`/`git`/`ipc` as built `.d.ts` rather than as source. Then `vue-tsc` only checks the UI
   package and tsgo checks the bulk, and the split is real rather than notional. This works,
   but it buys a genuine speedup only once the codebase is big enough for it to matter, and it
   costs a build graph, a `.d.ts` emit step, and staleness bugs when a reference is not rebuilt.
2. **Run one checker.** Pick TS 5.x now, flip to TS 7 in a single commit when `vue-tsc`
   supports it.

**Recommendation: option 2.** Concretely:

- **Write TS7-clean code from day one** — no legacy decorators, no `namespace`, no
  `enum` where a union or `as const` works, `verbatimModuleSyntax`, `isolatedModules`, explicit
  `import type`. This is what actually determines whether the eventual switch is a one-line
  change or a migration, and it costs nothing because it is also just good modern TypeScript.
- **CI runs a single checker**, TS 5.x, until `vue-tsc` ships TS 7 support.
- **tsgo is installed and available as an optional fast local check** over the pure-`.ts`
  packages (`bun run check:fast`). Sub-second feedback in the inner loop, zero CI dependency,
  and it keeps us honest about TS 7 semantics continuously rather than discovering divergence
  at switch time.
- **Flip when the ecosystem does.** TS 7.1 is expected around October 2026, which lands inside
  this project's P0–P4 window. The switch is then: change one dependency, delete `check:fast`,
  done. If it slips, we have lost nothing.

The honest scale check: on a codebase this size, `tsc` 5 takes seconds, not minutes. The 8–12×
win is real but it is a win on a small number. It is not worth a two-checker build graph, and
it is definitely not worth blocking on.

**Verdict: TS 7 as the stated target and the code written for it; TS 5.x as the checker until
`vue-tsc` catches up. Re-confirm the `vue-tsc`/TS-7 state at P0 and again at P4 — this area is
moving month to month, and it may well already be resolved by P4.**

### 8.4 Playwright — **compatible, and the reason `apps/harness` exists**

Two suites:

1. **Frontend suite (primary).** `apps/harness` serves the Vue app in a plain browser with a
   mock host bridge backed by JSON fixtures and, for realism, by real repositories generated
   on the fly by a fixture script. This exercises rendering, virtualization, search toggles,
   detail pane, dialogs, keyboard nav, and every pre-flight *presentation* path (including
   error and conflict states, which are trivial to induce with a mock and painful to induce
   for real). Fast, hermetic, runs on every commit. Visual regression via Playwright
   screenshot comparison on the canvas graph, in both light and dark themes.
2. **Integration suite.** The real host, real Git, real repositories built by a fixture
   generator, driving actual operations and asserting on the repository state afterwards.
   Under Electron this is Playwright's `_electron.launch` directly. Under VS Code, Playwright
   can also drive the VS Code Electron binary (launch the downloaded build with the extension
   installed, then work through the webview frame); `@vscode/test-electron` remains available
   for extension-host-level tests that need the VS Code API rather than the UI. Slower tier,
   runs on PRs and nightly across Linux/macOS/Windows and across a matrix of Git versions
   (oldest supported, current) to keep the capability gating in §4.2 honest.

Layer beneath both: `bun test` unit tests over `core` (layout, search, pre-flight planners)
and `git` (porcelain parsers, against recorded fixtures).

**Verdict: adopt.**

### 8.5 Svelte instead of Vue? — evaluated, **stay with Vue**

Worth asking, since the requirement is "as fast as possible and light on memory" and Svelte's
pitch is exactly that. The honest answer is that it would help less than it looks, because
this application's performance does not live in the framework.

Where Svelte 5 genuinely wins:

- **Runtime size.** ~3–10 KB gzipped vs Vue's ~35 KB. Real, but this is a locally-loaded
  webview, not a page over a network. It affects cold-start by low single-digit milliseconds.
- **No virtual DOM.** Compiled fine-grained reactivity updates nodes directly, so per-update
  allocation and GC pressure are lower — which is precisely the thing that causes scroll jank.
- **Lower baseline memory** per component instance, from having no VDOM tree and no reactive
  proxy objects.

Why it does not matter much *here*:

- The hot paths are deliberately outside the framework. The graph is a `<canvas>` drawn from
  typed arrays; layout is in a worker; commit data is column-wise typed arrays that are
  explicitly kept out of the reactivity system (§5.3, §5.5). The framework renders a toolbar,
  a fixed-size pool of ~60 recycled row components, a detail pane, and dialogs. Vue's VDOM
  overhead over that surface is not measurable against a 16 ms frame.
- Vue's reactivity cost is opt-in, and we already opt out with `shallowRef`/`markRaw`. The
  comparison is not "Vue's proxies over 100k commits vs Svelte's runes" — nothing is reactive
  over 100k commits in either case.
- **Neither framework escapes the TypeScript 7 problem** (§8.3). `svelte-check` embeds the
  same TypeScript programmatic API that `vue-tsc` does and is blocked on the same TS 7.1 API.
  Switching buys nothing there.
- **Biome treats them the same** — Svelte support landed in the same 2.3 release as Vue and
  carries the same experimental caveat.
- Vue's ecosystem and tooling maturity are better, and the VS Code webview world has more Vue
  prior art to crib from.

If the framework ever does show up in a profile, the escape hatch is cheap by construction:
the UI depends only on the `packages/ipc` contract, so `packages/ui` is replaceable without
touching anything else. The decision to revisit would be driven by a measurement, not a
preference.

**Verdict: stay with Vue.** The memory and speed requirements are met by §5.3/§5.5 —
canvas, workers, typed arrays, interning, row recycling — and those apply identically under
either framework. Re-evaluate only if the P4 perf harness shows framework overhead in the
frame budget.

### 8.6 The rest

Vue 3.5+ (`<script setup>`, no Options API), Vite for the UI bundle and the harness dev
server, esbuild (or `bun build`) for the host bundles, `@vscode/vsce` + `ovsx` for
publishing, `electron-builder` for the desktop app.

---

## 9. Out of scope for v1

Deferred to v2, listed so the v1 architecture does not preclude them:

- **Rebase, including interactive rebase.** Explicitly v2. The graph must already model
  in-progress rebase state (§4.5 watches `rebase-merge`/`rebase-apply`) so v1 can *report*
  a rebase in progress and refuse to interfere.
- Merge with conflict-resolution UI, and a **built-in three-way merge editor for the Electron
  build** (7.11 - under VS Code the native merge editor already covers this, so the gap is
  Electron-only).
- **Remote and browser VS Code contexts** (2.1.1): SSH, WSL, Codespaces, dev containers,
  vscode.dev. Local desktop VS Code only.
- **Support for Git older than 2.38** (4.2). Hard floor, not a degraded mode.
- **Infinite scroll / eager full-history load** (5.1.1). Paged with an explicit Load more.
- Commit creation, staging/unstaging (this is a history tool, not a replacement for VS Code's
  SCM view — v1 reads the working tree, it does not edit it, except via the documented
  operations here).
- Submodules, worktree switching, sparse-checkout management.
- Pickaxe/file-content search (`-S`/`-G`), file history / blame views.
- Forge integration (PR overlays for GitHub/GitLab).
- Graph filtering by ref/author/path as a persistent view mode (v1 has search, not filtered
  walks).
- Multi-repo unified graph. (v1 handles multiple repos as a switcher, one at a time.)

---

## 10. Phasing

Each phase is planned by Opus into `docs/plans/` before implementation (see `AGENTS.md`).
Phases are sequential; each ends at a checkpoint.

| # | Phase | Deliverable | Exit criteria |
|---|---|---|---|
| **P0** | Foundation | Monorepo per the normative tree in 3.1, Bun workspaces, Biome, **single TS 5.x checker with TS7-clean compiler options plus `tsgo` as an optional `check:fast`** (8.3), Vite, CI, `packages/ipc` contract skeleton, `apps/harness` with mock bridge, Playwright wired to it, fixture-repo generator, perf-budget harness (time **and** heap). | `bun install && bun run check && bun run test` green in CI; harness renders a placeholder UI; one Playwright test passes; `vue-tsc`/TS-7 state re-confirmed and versions pinned. |
| **P1** | Git driver | `GitDriver`: discovery, version probe with the **2.38 hard-floor block state**, repo capability probe, spawn discipline (§4.3), streaming NUL parser, cancellation, write queue, `cat-file --batch`, typed error classification. | Unit tests over recorded porcelain fixtures; integration tests against generated repos; sub-2.38 Git produces the block state, never a half-working app. |
| **P2** | History pipeline | Streaming `git log` walk with **paused long-lived-process paging (5.1.1)** and remaining-count query, ref query, status query, lane layout in a worker, packed transferable buffers, column-wise typed-array store with string interning (5.5). | First page within budget; repeated Load more to 100k within time **and heap** budget; layout unit tests over hand-built topologies incl. octopus merges. |
| **P3** | Host bridge | RPC transport for both hosts, VS Code panel webview view registered and reachable, Electron shell booting the same bundle, state persistence/rehydration, theme token layer, `readTokens` canvas bridge, and Electron palette generation from VS Code theme JSON (3.4). | Panel opens in VS Code and shows live data; Electron app shows the same; hide/reveal rehydrates without re-running git; switching VS Code theme restyles the panel live, canvas included, with no reload. |
| **P4** | Graph UI | Vue shell, virtualized row list, **Load more button with remaining count and viewport/selection preservation**, canvas graph renderer, branch/tag ref badges, columns, selection, refresh action, keyboard nav, responsive breakpoints (§6.3). | 60 fps scroll on the 100k repo; Playwright visual + interaction suite; accessibility pass on the virtualized list; visual regression green across all four theme kinds; side-by-side density review against the native workbench list (6.1). |
| **P5** | Commit detail | Right pane: metadata, message/trailers/signature, parents, file tree with statuses and counts, **click-a-file-opens-its-diff** via the in-app unified diff view, copy actions. | Detail populated ≤80 ms; diff opens from tree click and follows keyboard selection; tree correct for renames, merges (parent selector), binary/LFS files. |
| **P6** | Refs & checkout | Branch list and **tag list with full tag manipulation (§7.9)**, create branch, switch branch, detached checkout, delete/rename, **revert (7.10)**, the **in-progress/conflicted-state banner with VS Code merge-editor delegation, continue and abort (7.11)**, and the full checkout pre-flight engine (§7.5). | Pre-flight classification unit-tested exhaustively; integration tests cover clean-carry, blocked-by-tracked, blocked-by-untracked, in-progress-op; tag create/delete/push incl. annotated and remote-delete asymmetry; revert incl. merge-parent selection; an induced conflicting revert reaches the banner, gates other operations, and both continues and aborts cleanly. |
| **P7** | Remote ops | Fetch (incl. **opt-in background auto-fetch, default off**), push, decomposed pull with strategy selection, force-push with lease + `--force-if-includes`, protected branches, askpass path, progress + typed auth errors. | Integration tests against a local bare remote incl. non-ff rejection, lease violation, hook rejection; no operation can hang on a prompt. |
| **P8** | Stash | Stash create (incl. `-u`, message, pathspec), list, show, apply/pop/drop/branch, stashes rendered in the graph, and the pop-prediction engine via `merge-tree` (§7.6) wired into checkout resolution. | Prediction verified against actually-executed pops across clean and conflicting cases; degraded path exercised on a pre-2.38 Git. |
| **P9** | Reset | Soft/mixed/hard with per-mode consequence copy, pre-flight counts, typed confirmation for hard-with-dirty, reflog-backed undo. | Integration tests assert repository state per mode; undo restores; guarded during in-progress operations. |
| **P10** | Search | Input with case/whole-word/regex toggles, commit/refs(branches+tags)/both scope, hybrid client-side + git-backed matching, next/prev navigation, live regex validation, abort-on-supersede. | Semantics table fully covered by tests (each toggle × scope); ≤120 ms budget met; malformed regex never throws. |
| **P11** | Ship | Electron packaging (`electron-builder`), `.vsix` packaging without `vscode:prepublish`, `extensionKind`/no-browser manifest declarations (2.1.1), marketplace + OpenVSX metadata, cross-platform CI matrix (OS x recent Git versions), docs, settings surface, telemetry-free release checklist. | Installable `.vsix` and signed desktop builds; full Playwright matrix green on Linux/macOS/Windows. |

---

## 11. Decisions taken

Answered during requirements gathering. Recorded here because the reasoning matters as much
as the answer, and because several of them are load-bearing elsewhere in this document.

| # | Question | Decision |
|---|---|---|
| D1 | History loading strategy | **Paged with an explicit "Load more" button, 5,000 per page. Not infinite scroll.** See 5.1.1 for the mechanics and the reasoning. |
| D2 | Minimum Git version | **2.38 as a hard requirement**, no degraded path. The target is a developer workstation running current Git; below the floor the app shows a blocking upgrade state (4.2). This is what makes the conflict predictions exact rather than heuristic. |
| D3 | Background auto-fetch | **Implemented and configurable, default off** (`kiraVersion.fetch.autoInterval = 0`). Guardrails in 7.1. |
| D4 | Supported hosts | **Local desktop VS Code, plus the standalone Electron build.** Remote contexts (SSH, WSL, Codespaces, dev containers) and browser VS Code (vscode.dev) are out of scope and untested (2.1.1). |
| D5 | Conflict resolution | **Delegated, not built.** VS Code already resolves conflicts natively - the `merge-conflict` extension's inline actions and the SCM view's three-way merge editor work on any conflict markers, whoever created them. We detect the state, surface it, gate operations, and hand off; we never auto-resolve. The Electron build is deliberately weaker here and gets a built-in resolver in v2 (7.11). |
| D6 | TypeScript 7 | **Write TS7-clean code from day one, run a single TS 5.x checker until `vue-tsc` supports TS 7** (expected ~7.1, October 2026, inside this project's P0-P4 window). The originally-proposed two-checker split was wrong: `vue-tsc` checks whole programs, so TS 5.x would have been checking everything anyway and the fast pass would have been redundant. Full reasoning in 8.3. |
| D7 | Frontend framework | **Vue.** Svelte's advantages are real but land outside this app's hot paths, which are canvas, workers and typed arrays. Evaluated in 8.5. |
| D8 | Git integration approach | **System Git via child process.** Not bundled, not libgit2/NodeGit, not isomorphic-git. Reasoning in 4.1. |
| D9 | Theme | **Ride VS Code's injected theme.** It pushes the full workbench palette as `--vscode-*` CSS variables plus theme-kind body classes into every webview and keeps them live across theme switches, so matching the user's theme costs nothing. Electron wears the same variable names, generated from VS Code's own built-in theme JSON. Details in 3.4; the wider aesthetic rules in 6.1. |
| D10 | v1 branch | **All v1 work lands on `feature/kickoff`.** Agents branch from it and add on top for as long as phases remain unfinished. See `AGENTS.md`. |

---

## 12. Open questions

Still unanswered. Nothing here blocks P0.

**Product**

1. **Multiple repositories.** A VS Code workspace can hold several. v1 assumes a switcher
   (one active repo at a time). Is that right, or should the multi-root case be first-class
   earlier? Related: submodules - treat as separate repos in the switcher, or ignore in v1?
2. **Linked worktrees.** `git worktree` setups share a `.git` dir. Do we support opening one,
   and do we show the other worktrees' HEADs in the graph? Cheap at P1, expensive to retrofit.
   (D2 makes the detection itself free - the capability probe already looks at
   `--git-common-dir`.)
3. **Default history scope.** `--all` (every ref) vs current branch only vs an explicit ref
   picker. I've assumed `--all` with a toggle; D1's paging removes most of the cost objection,
   so this is now purely a question of what you want to see by default.
4. **Diff view.** 3.3 specs an in-app unified diff so Electron isn't feature-poor. Side-by-side
   too in v1, or is unified enough until v2? Side-by-side is a meaningful chunk of P5.
5. **Where does a file open?** Clicking a file opens its diff in-panel (6.3), with "Open in
   editor" as a secondary action handing it to `vscode.diff`. Confirm that's the right
   default rather than the reverse.

**Behaviour**

6. **Protected branches.** I defaulted to `main`, `master`, `release/*` for the force-push
   block. Right list? Hard refusal or extra confirmation?
7. **Signature verification.** Verifying costs a `--show-signature` per commit, far too slow in
   bulk, so it's specced for the selected commit only. Any need for a bulk indicator?
8. **`commit-graph` maintenance.** Writing one makes large repos much faster but writes into
   the user's `.git`. Defaulted **off**. Is a first-run prompt ("this repo is large, enable
   commit-graph?") acceptable, or should we never write?
9. **Undo.** 7.7 gives reset a reflog-backed undo. I'd argue for a general "undo last
   operation" across branch delete, reset and stash drop - all recoverable via reflog or
   `stash@{}`. Worth doing in v1?

**Project**

10. **VS Code minimum version** (`engines.vscode`). A recent floor unlocks newer webview and
    theming APIs; an old one widens reach. Needs a number.
11. **VS Code integration points beyond the panel.** SCM view decorations, status bar item,
    "open Git Graph at this commit" from the blame gutter. Currently only the command palette
    is specced.
12. **Licensing and distribution.** Repo is MIT. Publishing to both the Marketplace and
    OpenVSX? A publisher id and a signing identity for the Electron builds must exist before
    P11.
13. **Telemetry.** Assumed **none**. Confirm - easier to never start than to remove later.
14. **Localization.** Assumed English-only for v1, but string extraction is far cheaper done
    from the start than retrofitted.
15. **Settings surface.** ~15 settings are implied across this document. In VS Code they're
    `contributes.configuration`; Electron needs its own settings UI. Worth one shared schema
    driving both, defined at P3 rather than accreting.
16. **LFS.** Diffing an LFS pointer shows the pointer, not the content. Detect and label
    (currently specced in 6.3), or go further?
