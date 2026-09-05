# Kira Version — Specification

A visual Git graph tool. Primary delivery is a VS Code extension rendering into the
bottom panel (alongside the terminal), built as a host-agnostic core and UI behind narrow
capability ports (§3.3), of which VS Code is the one host implemented today. The UI bundle
itself is unmodified regardless of what mounts it — `apps/harness` proves this daily by
mounting the identical bundle against a mock bridge in a plain browser with no host present
at all (§2.2).

Status: **v1 requirements**. This document is the source of truth for scope, architecture,
and phasing. §11 logs every decision taken and why; §9 and §12 record what is deliberately
out of v1. Interactive rebase is explicitly v2.

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
| C1 | Every host capability the app needs is a narrow port in `packages/core/src/ports` (§3.3); no host API is reachable from outside its own host package. | Zero `import * as vscode` outside `packages/host-vscode`, enforced by lint rule and a build-time import check. `core`, `git`, `ipc` and `ui` therefore compile and run with no host present at all — which is what makes `apps/harness` a real Playwright target rather than a stub (§8.4, C4), what makes each capability independently fakeable in unit tests, and what makes a second host an addition rather than a rewrite (§2.2). |
| C2 | Speed is a feature, not a nice-to-have. | Explicit performance budget (§5.1). Graph layout off the main thread, a virtualized grid whose DOM is bounded by the viewport rather than by history, no Vue reactivity over the commit array. |
| C3 | Uses the user's own Git. | No bundled Git binary, no native bindings (§4.1). |
| C4 | Frontend is validated with Playwright. | The UI must be runnable in a plain browser against a mock host bridge (§8.4). This falls out of C1 for free — and is the *reason* C1 is worth keeping with only one host shipped, not merely a side effect of it. |

### 1.3 Naming

Product name: **Kira Version**. Extension id: `kira-version`. Panel view id:
`kiraVersion.graph`; sidebar view id (branch review, §6.8): `kiraVersion.review`. Command
namespace: `kiraVersion.*`.

---

## 2. Platform surface

### 2.1 VS Code

The **graph** lives in the **panel** (the area hosting the terminal), not the sidebar and not
an editor tab. That sentence is about the graph specifically and stays true: v1 contributes
exactly one other webview view — the branch-review view (§6.8) — and that one deliberately
lives in the sidebar, for the reasons under "Two surfaces, on purpose" below. The graph is a
webview view contributed to a panel view container:

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
  column *inside* the webview, not a separate VS Code view, so the panel owns its own layout
  at every breakpoint.
- The panel can be maximized (`workbench.action.toggleMaximizedPanel`) and moved left/right
  by the user. At narrow widths the detail pane collapses to an overlay drawer. Breakpoints
  in §6.3.
- Webview views are **destroyed and recreated** when the panel is hidden, unless
  `retainContextWhenHidden` is set — which is expensive. We instead persist UI state through
  `getState`/`setState` and re-hydrate the graph from the host cache on reveal (§5.4).

**Two surfaces, on purpose.** The branch-review view (§6.8) is contributed to its own
**activity-bar view container**, i.e. the sidebar, and this is a considered choice rather than
a place we ran out of room in the panel (D29). The two surfaces answer to different shapes of
use:

- The **graph is primary and long-lived**. It is opened once and revisited all day, resized
  constantly, and wants to keep its scroll position, selection and loaded pages across every
  hide/reveal — which is exactly what §5.4's rehydration contract is for. It is also
  horizontally dense (graph, message, author, date, sha), so the short-and-wide panel is the
  shape it wants.
- **Branch review is one-shot and drill-in.** The user opens it against one branch, reads
  down a list, expands the commits that interest them, closes it. That is the same shape as
  Search Results, the Explorer, or a Source Control view — a tall, narrow list you open, use
  and dismiss — which is what VS Code's own UX vocabulary reserves the sidebar for. It is also
  vertical: a list of commits, each expanding into a file tree, is a tree, and a tree at 300 px
  wide and full window height reads better than the same tree squeezed into a third region of a
  short panel.

Squeezing it into the existing panel webview the way the diff view is a third region of the
detail pane (§6.4) would have made the panel's narrow breakpoints carry a fourth region, and
would have put a one-shot flow inside the surface whose whole job is to stay put. Two view
containers cost one extra `WebviewViewProvider` (`reviewView.ts`, §3.1) and one manifest
contribution, and nothing else — both views mount the same `packages/ui` bundle (§6.8):

```jsonc
// alongside the panel container above, in the same "contributes" block
"viewsContainers": {
  "activitybar": [
    { "id": "kiraVersionReview", "title": "Branch Review", "icon": "resources/review-icon.svg" }
  ]
},
"views": {
  "kiraVersionReview": [
    { "id": "kiraVersion.review", "name": "Branch Review", "type": "webview" }
  ]
}
```

The review view is **temporary in the sense §6.8 defines**: it is revealed by the command that
opens it, holds one review session, and gets no rehydration guarantee — the destroy-on-hide
behaviour above applies to it too, and unlike the graph we simply let it go.

### 2.1.1 Supported VS Code contexts

**Local desktop VS Code only.** Remote contexts (SSH, WSL, Codespaces, dev containers) and
the browser build (vscode.dev, github.dev) are out of scope for v1 and are not tested. The
browser build is not merely untested but impossible as designed: it has no `git` process and
no child-process API, so §4 has nothing to spawn. Remote contexts would likely work — the
extension is a workspace extension and would run on the remote where git lives — but we make
no claim, run no CI for them, and will not treat a remote-only bug as a v1 defect. The
manifest declares this honestly (`extensionKind: ["workspace"]`, no `browser` entry point) so
VS Code does not offer the extension where it cannot function.

### 2.1.2 Supported operating systems

**macOS only for v1.** Windows and Linux are not supported, not tested, and not claimed.

This is a scope decision, not an architectural one, so the code leaves the seam open without
building anything for it: anything platform-conditional goes behind a named strategy selected
on `process.platform`, with the unimplemented platforms present as explicit cases that fail
with "platform not supported yet" rather than as missing branches that silently misbehave.
Today that is exactly one place — Git binary discovery (§4.2). Adding a platform later should
be implementing that case and running the suites there, not untangling assumptions.

Concretely this means: no Windows path handling, no `\r\n` line-ending special cases beyond
what git's own `core.autocrlf` does for us, no per-platform CI, and no Windows code-signing
identity to acquire (§11 D26).

This is a claim about the *product*, not about where its test suites can run. The unit,
integration, harness-Playwright and VS-Code-Playwright tiers are all runnable on headless Linux
for development — `docs/plans/P4c-linux-test-infra.md` — because that is where developers and
agent sessions working on this repo actually run. That is not a support claim, a tested platform,
or a CI matrix: it changes nothing above. No per-platform CI still holds, and D28 still holds.

### 2.2 A second host is an addition, not a rewrite

v1 ships one host: local desktop VS Code (§2.1.1, D6).

An Electron shell *was* built at P3 — a `BrowserWindow` loading the identical UI bundle, a main
process implementing the same ports over Electron IPC, a repo picker, and a theme shim emitting
the same CSS custom properties VS Code injects (§3.4) — and was removed when the standalone
desktop app left v1's scope; see `docs/plans/P4b-remove-electron.md` for the removal itself.
`docs/plans/P3.md` remains in the tree as the unedited record of how that host was built the
first time; this document does not pretend it never existed.

The port seam that host required is kept deliberately, for three reasons:

- **The harness is a real second consumer, running on every commit.** `apps/harness` mounts the
  identical `packages/ui` against a mock bridge in a plain browser with no host present at all.
  That is not a speculative future host — it is the Playwright suite's primary target (§8.4), and
  it only works because `core`/`ipc`/`ui` compile and run with no host API reachable from them.
  The seam is exercised continuously, not maintained on faith.
- **A narrow, named boundary is worth having for its own sake.** Thirteen small interfaces with one
  implementation each is a legible surface: it is the complete list of what the app asks of its
  environment, it makes each capability independently fakeable in unit tests
  (`ports/testFakes.ts` exists for exactly this), and it keeps `packages/ui` from growing
  host-shaped assumptions that are painful to unpick later.
- **A future host is then an addition, not a rewrite.** What adding one actually costs, as a
  checkable list: a `Transport` implementation (§3.5), one file per port under
  `packages/host-<name>/src/ports/` (§3.3's table gains a column), an entry that mounts
  `packages/ui` unchanged, a build target in `scripts/build.ts`, a Biome override granting that
  package its host module, and a Playwright project. Nothing in `core`, `git`, `ipc` or `ui`
  changes. For Electron specifically, add back what P4b deleted: a main process and window, a
  preload `contextBridge`, a renderer HTML entry, a palette source for the `--vscode-*`
  variables VS Code would otherwise inject, and packaging.

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
├── playwright.config.ts            projects: harness (fast), vscode
├── docs/
│   ├── SPEC.md                     this document
│   ├── design/
│   │   └── panel-mockup.html       the approved visual reference (§6.9)
│   └── plans/                      phase plans, P0.md … P13.md
├── resources/
│   ├── icon.svg                    panel view container icon
│   ├── review-icon.svg             sidebar view container icon (§2.1, §6.8)
│   └── marketplace/                README assets, screenshots
├── scripts/
│   ├── build.ts                    bundles hosts + ui via bun build / vite
│   ├── package-vsix.ts             build then `vsce package --no-dependencies`
│   └── gen-settings.ts             writes contributes.configuration from core's settings schema (D25)
│
├── packages/
│   ├── core/                       pure domain. No I/O, no DOM, no git, no framework.
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── model/              commit.ts diff.ts ref.ts tag.ts stash.ts status.ts repo.ts conflict.ts
│   │       ├── store/              commitStore.ts   column-wise typed arrays (§5.5)
│   │       │                       shaTable.ts      20-byte binary sha storage + hex formatting
│   │       │                       intern.ts        string interning + concatenated subject buffer
│   │       ├── graph/              layout.ts lanes.ts edges.ts colors.ts types.ts
│   │       ├── search/             query.ts   parse toggles + scope into a query object
│   │       │                       matcher.ts client-side matching over the loaded store
│   │       │                       gitArgs.ts translate a query into git log arguments
│   │       ├── preflight/          checkout.ts stashPop.ts reset.ts revert.ts push.ts tag.ts
│   │       │                       types.ts   Hazard / Plan / Resolution unions
│   │       ├── settings/           schema.ts  SETTINGS, coerceSettings, toVsCodeConfiguration (D25)
│   │       ├── ports/              processRunner.ts fileWatcher.ts workspaceRoots.ts storage.ts
│   │       │                       secrets.ts githubAuth.ts clipboard.ts externalOpener.ts
│   │       │                       dialogs.ts notifications.ts editorIntegration.ts theme.ts
│   │       │                       logger.ts disposable.ts testFakes.ts index.ts
│   │       └── util/               nulSplit.ts result.ts assert.ts
│   │
│   ├── git/                        the only package that knows git exists
│   │   └── src/
│   │       ├── driver.ts           spawn discipline, env hygiene, write queue, cancellation (§4.3)
│   │       ├── nodeProcessRunner.ts the one real ProcessRunner (Node child_process) (§4.3)
│   │       ├── nodeFileWatcher.ts  the one real FileWatcher (Node fs.watch) (§4.5)
│   │       ├── discovery.ts        locate git, probe version, enforce the 2.38 floor (§4.2)
│   │       ├── capabilities.ts     per-repo facts: commit-graph, sparse, linked worktree
│   │       ├── catFile.ts          persistent `cat-file --batch` process
│   │       ├── logSession.ts       long-lived paged `git log` process (§5.1.1)
│   │       ├── watcher.ts          .git + worktree watching → refsChanged / worktreeChanged
│   │       ├── github.ts           origin URL → owner/repo; branch → PR lookup, cached (§6.7)
│   │       ├── repoService.ts      composes driver+logSession+store+watcher; cache/eviction (§5.4)
│   │       ├── rpcHandlers.ts      binds the ipc contract's keys to RepoService + W5's ports
│   │       ├── errors.ts           exit code + stderr → typed error union
│   │       ├── queries.ts          §4.4 read surface: argv + parser bound to typed queries
│   │       ├── parse/              log.ts refs.ts status.ts diffTree.ts diff.ts stash.ts mergeTree.ts
│   │       └── ops/                fetch.ts pull.ts push.ts stash.ts branch.ts tag.ts
│   │                               checkout.ts reset.ts revert.ts cherryPick.ts conflict.ts
│   │
│   ├── ipc/                        the contract every host and the UI share
│   │   └── src/
│   │       ├── contract.ts         request/response/event/stream type map, versioned
│   │       ├── transport.ts        Transport interface both hosts implement
│   │       ├── codec.ts            encode/decode incl. ArrayBuffer transfer lists
│   │       ├── rpc.ts              the one generic endpoint: correlation, stream credits,
│   │       │                       cancellation, version validation (P3 W2)
│   │       └── validate.ts         boundary validation; a schema mismatch fails loudly
│   │
│   ├── ui/                         Vue 3 app. Imports core + ipc only. Never `vscode`.
│   │   ├── vite.config.ts          one build, one entry (webview) (W13)
│   │   └── src/
│   │       ├── main.ts             mounts App or ReviewView per the host's injected view id (§6.8)
│   │       ├── App.vue
│   │       ├── bridge/             client.ts   typed client over the ipc contract
│   │       ├── state/              repo.ts graphView.ts selection.ts search.ts settings.ts
│   │       │                       detail.ts       P5's commit-detail pane state machine (§6.4)
│   │       │                       viewState.ts    persisted view state (§2.1, §5.4)
│   │       │                       review.ts       branch-review session state (§6.8)
│   │       │                       pullRequests.ts branch → PR records for the session (§6.7)
│   │       ├── graph/              graphColumn.ts   the graph column's SlickGrid definition + formatter
│   │       │                       rowSvg.ts        builds one row's <svg> slice from its segments
│   │       │                       hitTest.ts       arithmetic lane-within-gutter hit testing
│   │       │                       palette.ts       lane colour classes + HC outline metadata (§3.4)
│   │       │                       layoutStore.ts   reassembles layout chunks; per-row segment query
│   │       │                       layoutClient.ts  main-thread side of the layout worker
│   │       │                       layout.worker.ts lane assignment off the main thread
│   │       ├── components/
│   │       │   ├── Toolbar.vue RepoPicker.vue BranchPicker.vue RefreshButton.vue
│   │       │   ├── CommitGrid.vue  SlickGrid host: lifecycle, data view, events, a11y pass
│   │       │   ├── columns.ts      message/author/date/sha column defs and formatters
│   │       │   ├── refBadges.ts    badge element builder used by the message formatter
│   │       │   ├── LoadMoreButton.vue
│   │       │   ├── DetailPane.vue CommitMeta.vue FileTree.vue DiffView.vue
│   │       │   ├── fileTreeModel.ts P5's pure fold of FileChange[] into a directory tree (§6.4)
│   │       │   ├── SearchBox.vue SearchResults.vue ConflictBanner.vue
│   │       │   ├── StashList.vue TagList.vue
│   │       │   ├── review/         ReviewView.vue       the sidebar view's root (§6.8)
│   │       │   │                   ReviewCommitRow.vue  one commit, expanding to FileTree.vue
│   │       │   │                   BaseSelector.vue     comparison-base display + override
│   │       │   └── dialogs/        CheckoutDialog.vue ResetDialog.vue ForcePushDialog.vue
│   │       │                       StashDialog.vue TagDialog.vue RevertDialog.vue
│   │       ├── theme/              vscode-tokens.css  the token layer (§3.4)
│   │       │                       density.css        row heights, spacing scale
│   │       │                       readTokens.ts      getComputedStyle bridge for numeric metrics
│   │       └── icons/              codicon.css + the mapping of actions → codicon names
│   │
│   └── host-vscode/                the ONLY package permitted to import `vscode`
│       └── src/
│           ├── extension.ts        activate/deactivate, command registration
│           ├── panelView.ts        WebviewViewProvider for the panel container (§2.1)
│           ├── reviewView.ts       WebviewViewProvider for the sidebar container (§2.1, §6.8)
│           ├── html.ts             CSP, nonce, asset URIs, initial state injection
│           ├── transport.ts        postMessage Transport implementation
│           ├── webview/main.ts     browser-context entry mounted inside the webview; never imports `vscode`
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
    │   ├── topology.ts             in-memory hand-built commit topologies for graph-layout unit tests (P2)
    │   ├── fakeGit.ts              stand-in git binary for discovery.ts: version, hang, garbage output
    │   ├── recordPorcelain.ts      regenerates tests/fixtures/porcelain/ from real git, as raw bytes
    │   └── porcelain/              recorded git output for parser unit tests
    ├── unit/                       unit tests that cross a package's own tsc rootDir (e.g. a
    │                               packages/core test consuming tests/fixtures/topology.ts) —
    │                               colocation is impossible there without violating each
    │                               package's own tsconfig; mirrors tests/integration/'s pattern
    ├── e2e/                        Playwright against apps/harness
    ├── integration/                real git + real hosts (vscode)
    └── perf/                       time + heap budgets (§5.1), run locally (D28)
```

Unit tests are colocated (`foo.ts` / `foo.test.ts`, run by `bun test`) **except** where doing so
would import across a package's own tsc `rootDir` (a `packages/core` test needing
`tests/fixtures/topology.ts`, say) — those live under `tests/unit/` instead, discovered while
implementing P2 (a stray `.d.ts` `tsc -b` emitted into `tests/fixtures/` was the tell). Suites
that need a harness or a real repository still live under `tests/` as before.

**Dependency rule, enforced by `bun run check`** via Biome's `noRestrictedImports` plus a bundle check:
`core` and `ipc` depend on nothing; `git` depends on `core` + `ipc`; `ui` depends on `core` +
`ipc`; hosts depend on everything; **nothing depends on a host**. The string `vscode` appears
as an import specifier in exactly one package, and `bun:`/`Bun` in none (§8.1).

### 3.2 Process/thread topology

```
┌─ host process (extension host) ──────────────────────────────┐
│  RepoService ─ GitDriver ─ child_process(git)                │
│      │           └─ persistent `git cat-file --batch`        │
│      └─ RefWatcher (fs watch on .git)                        │
└──────────────────── typed RPC over ports ────────────────────┘
┌─ webview / renderer ─────────────────────────────────────────┐
│  Vue app (state, panes, dialogs)                             │
│      └─ Worker: parse + lane layout ─► transferable buffers  │
│      └─ SlickGrid rows; graph column = one <svg> per row     │
└──────────────────────────────────────────────────────────────┘
```

Git never runs in the renderer. The renderer never touches the filesystem.

### 3.3 Ports

Every host capability the app needs, as a narrow interface in `packages/core/src/ports`.
This list is the complete VS Code surface; anything not here must not be used. One column
below per shipped host — v1 ships one. A second host adds a *column* here (and a directory
under `packages/`) and changes nothing to the left of it (§2.2).

| Port | Purpose | VS Code impl — `packages/host-vscode/src/ports` |
|---|---|---|
| `ProcessRunner` | spawn/exec git, stream stdout, kill, env injection | `child_process` |
| `FileWatcher` | watch `.git` paths + worktree, debounced | `workspace.createFileSystemWatcher` / raw `fs.watch` for `.git` |
| `WorkspaceRoots` | candidate repository roots, add/remove events | `workspace.workspaceFolders` |
| `Storage` | small persisted key/value (per repo and global) | `Memento` (workspace + global) |
| `Secrets` | credentials the app itself holds (rare — Git owns auth) | `SecretStorage` |
| `GitHubAuth` | a host-brokered GitHub session token for §6.7's PR lookup, requested lazily and allowed to return none | `authentication.getSession('github', ['repo'])` |
| `Clipboard` | copy sha, branch, message | `env.clipboard` |
| `ExternalOpener` | open compare/PR URLs (§6.7's PR badge is what opens them) | `env.openExternal` |
| `Dialogs` | native confirm / pick folder / save file | `window.show*` |
| `Notifications` | toast + progress reporting | `window.withProgress`, `showMessage` |
| `EditorIntegration` | open a file at a revision, show a diff, **jump to a mapped line in the live or virtual file (D14a)** | `vscode.diff`, virtual `TextDocumentContentProvider`, `window.showTextDocument` with a `selection` |
| `Theme` | current theme kind + token CSS variables | injected by VS Code; we read |
| `Logger` | leveled log to an output channel | `window.createOutputChannel` |

A port with one shipped implementation, like `Secrets`, is still the app's complete statement
of what it needs from a host — the row stays even though nothing today exercises the gap a
second host's implementation would fill.

`EditorIntegration` is the one port whose contract is genuinely richer than a single call: v1
ships a **read-only unified diff view inside the UI**, because §6.4 makes clicking a file open
its diff in-panel the pane's primary interaction (D13, D14) — not because it works around a
gap in some other host. VS Code additionally offers "Open in editor" (`vscode.diff`) on top of
that baseline. Conflict resolution is exposed as an **optional capability the UI
feature-detects rather than assumes** — a host with no merge editor of its own still gets the
fallback affordances §7.11 describes.

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
- **The graph needs no colour code at all, because it is SVG.** SVG elements take `stroke` and
  `fill` from CSS, so a lane is drawn as `<path class="kv-lane-3">` and the stylesheet says
  `stroke: var(--kv-graph-lane-3)`. The theme switch re-cascades over the graph exactly as it
  does over everything else, with no observer, no re-read and no repaint on our side. This is
  the single largest reason the graph column is SVG rather than a `<canvas>`, which cannot
  consume CSS variables and would need a resolved colour string plus a `MutationObserver` and a
  forced repaint to avoid keeping its old colours after a theme switch — the most visible
  possible bug, here designed out rather than defended against.
- **`theme/readTokens.ts` survives with a narrower job**: resolving the *numeric* metrics the
  grid needs as JavaScript values — `--kv-row-height` above all, which the row virtualizer takes
  as a number, not as CSS. It still watches `<body>`'s class and style attributes, so a density
  change re-measures; it no longer carries any colour.
- **Graph lane colours** are the only palette we invent, since no workbench colour id means
  "branch lane 3". They are generated per theme kind for contrast against
  `--vscode-editor-background`, checked for WCAG contrast, and made distinguishable under the
  common colour-vision deficiencies. High-contrast themes get their own set plus outlines.
- We also expose our colours as **themable contribution points** (`contributes.colors`), so a
  user or theme author can override lane colours and badge colours from their own theme —
  the same courtesy other Git extensions extend.

**What the fallback chains are for, with only one host shipped.** No non-VS-Code host injects
`--vscode-*` today, so those fallback chains are what makes `vscode-tokens.css` legible outside
VS Code at all — which is the harness's everyday situation. The harness supplies a small
hand-written dev palette (`apps/harness/src/themeSwitcher.ts`), not the full contributed set,
so the token layer's own fallbacks carry the rest. A future host without VS Code's own theme
injection would sit on top of the same mechanism: supply (or generate) the `--vscode-*`
variables it can, and let the fallback chain cover what it can't.

**What we deliberately do not use:** `@vscode/webview-ui-toolkit` is deprecated and archived —
building on it would be building on something unmaintained. We use plain components styled
against the token layer, plus **`@vscode/codicons`**, the icon font VS Code itself ships, so
our chevrons, refresh, checkmarks, and git glyphs are the exact ones the user sees everywhere
else in the window.

### 3.5 RPC contract

`packages/ipc` defines a single typed contract used by both transports:

- **Requests** (UI → host, one response): `repo.open`, `graph.query`, `commit.detail`,
  `refs.list`, `status.get`, `search.run`, `review.resolveBase`, `branch.resolvePr`,
  `op.<name>`, `preflight.<name>`.
- **Events** (host → UI, push): `repo.changed`, `graph.invalidated`, `op.progress`,
  `op.finished`, `log`.
- **Streams** (host → UI, chunked with backpressure): `graph.stream` — commit records
  arrive in batches as the `git log` process produces them, so the first screenful renders
  before the walk completes.

Branch review (§6.8) adds one capability and reuses the rest: `graph.query`/`graph.stream`
take an **optional commit range**, so a `<base>..<branch>` walk is the existing streaming
walker with a different argv rather than a second pipeline, and `commit.detail` already
returns the per-commit file tree the review rows expand into. The one genuinely new request is
`review.resolveBase`, which answers "what should this branch be compared against" — a branch's
tracking branch, the repository's detected default branch, and the candidate list the override
picker offers. Wire format, chunking and version number are P7's plan to settle, not this
document's.

Pull request linking (§6.7) adds one request and no events or streams: `branch.resolvePr`,
which answers "which pull request, if any, belongs to this branch" with a PR number, title,
URL and state — or with an explicit *none*, which the UI renders as no badge rather than as a
failure. It is host-side by construction: the GitHub session and the token it yields stay in
the extension host and never cross the transport, so the webview asks for a PR record and
receives a PR record and nothing else. Answers are cached per branch and invalidated by the
same `refsChanged` signal (§4.5) that invalidates the ref list, so the UI re-requests after a
fetch without needing to know whether it is served from cache or re-resolved. Wire format,
whether a request carries one branch or the visible ref set, and the version number are P12's
plan to settle, not this document's.

The contract is defined once, in `packages/ipc`. A host supplies a `Transport`
(`packages/ipc/src/transport.ts`) rather than a protocol of its own — VS Code's is
`webview.postMessage` (structured clone, `ArrayBuffer` transferable). Every message is
versioned and validated at the boundary; a schema mismatch fails loudly rather than
half-working.

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
4. Platform fallbacks, behind a `PlatformGitLocator` strategy selected by `process.platform`.
   **The macOS and Linux strategies are implemented; Windows remains a named, unimplemented
   case** that throws a clear "platform not supported yet" error. macOS probes
   `/opt/homebrew/bin`, `/usr/local/bin`, then `/usr/bin/git` — the last being the Command Line
   Tools shim, where **running it when CLT is not installed pops a system install dialog**, so
   probe with `xcode-select -p` first and never spawn the shim blind. Linux probes `/usr/bin`,
   `/usr/local/bin`, then Linuxbrew's prefix, with no such gate — its `/usr/bin/git` is a real
   binary, not a shim that can pop a dialog. The Linux branch exists so the test suite can run
   on Linux (`docs/plans/P4c-linux-test-infra.md`); it is not a support claim (§2.1.2, D27) —
   without it, an unsupported-platform lookup **threw** past `RepoService.create()`'s unguarded
   `await` instead of reaching this section's own designed blocking state, which is a worse
   failure than the one this resolution order exists to produce. Adding the still-missing
   Windows strategy later is a single file, not a refactor.

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
`--all` is the default scope — a graph tool showing one branch is not a graph tool — with a
toggle for current-branch-only (`HEAD` in place of `--all`) for users who want the narrow
view. Paging (§5.1.1) removes the cost objection to `--all` being the default.
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

Branch review — base resolution and the range walk (§6.8):
```
git symbolic-ref --short refs/remotes/origin/HEAD   # detected default branch, where it is set
git merge-base <base> <branch>                      # unrelated-histories check before walking
git --no-optional-locks log <base>..<branch> …      # the walk above, with a range in place of --all
```
The tracking branch the resolution prefers is `%(upstream)` from the `for-each-ref` call
already listed — no extra process for the common case.

GitHub pull request linking (§6.7) needs exactly one git command; everything else it does is
an HTTP call, not a spawn:
```
git remote get-url origin     # parsed for owner/repo; any non-GitHub answer leaves it inert
```

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

These are checked by the perf harness against a synthetic repository generator; a regression
beyond 20% fails `bun run test:perf`. It is run locally, on demand and before closing a phase
(D28) - there is no CI to run it for us, which makes running it a habit rather than a
safety net. The 100k row is the ceiling test — reached by scripted "load more" presses — not
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

- **One virtualized grid owns every column, the graph included.** The commit list is
  [SlickGrid](https://github.com/6pac/SlickGrid) (MIT, the maintained fork) driven from a
  `CustomDataView` adapter over the typed-array store, so the DOM it holds is bounded by the
  viewport rather than by history: at 100k commits the grid renders the ~20–60 rows on screen
  plus a small buffer and removes the rest. Rows are `role="row"` divs of `role="gridcell"`
  divs; every column's content is produced by a synchronous cell formatter returning a real DOM
  element.
- **The graph column is a column, not an overlay.** Its formatter returns one small `<svg>`
  holding only the slice of the graph that passes through *that row's* height — the vertical
  runs of the lanes crossing it, the arc of any edge that changes lane inside it, and the
  commit's own node. A row therefore never needs to know about an edge as a whole, only about
  what enters and leaves its own band, which is what makes a windowed grid and a graph spanning
  40,000 rows compatible without a second, separately-positioned rendering surface. There is no
  `<canvas>` anywhere in the app.
- **Segments are grouped by lane colour into one `<path>` each**, so a row's SVG is typically
  four elements and never more than ten, rather than one element per segment.
- Text columns (message, author, date, ref badges) are real text in the same grid — for
  accessibility, selection, and theming.
- Hit testing is the grid's own row/cell event (`onClick` carries `row` and `cell`); *within*
  the graph cell, which lane was clicked is arithmetic on the cell-relative x, not DOM.
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
- **The rendered DOM is bounded by the viewport, not by history.** The grid's row cache holds
  the visible rows plus a small buffer and removes rows as they leave it, so the node count is
  flat from row 0 to row 99,999. Rows *are* created and destroyed as you scroll — that is the
  cost of DOM-native rendering, and it is bounded (a handful of elements per row, allocated for
  the rows newly scrolled into view in that frame), which is why §5.1's worst-frame budget is
  the thing that gates it rather than a rule about recycling.
- **Caches are bounded and evictable**: diff text LRU (cap by bytes, not entries) and the
  per-repo commit set, which is dropped when the repo is deselected and when the window has
  been hidden past a threshold.
- Memory is a **measured budget**, not an aspiration: the perf harness (P0) measures renderer
  heap after loading the 100k synthetic repo and fails on a >20% regression, alongside the
  timing budgets in §5.1.

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

**Open and close by clicking the row.** Clicking a commit opens the pane on it; clicking that
same commit again closes the pane and gives the width back to the graph. `Esc` also closes it.
The pane is a mode the user enters and leaves deliberately, not a region that is permanently
half the panel.

**Order within the pane, top to bottom: message, then files, then details.** The file tree is
what the user came for and sits where it can be reached without scrolling past reference
material; sha, parents, dates and refs are things you drop to when you need them, and they sit
below.

1. **Message** — subject, then body with URL and issue linkification, and trailers parsed out
   (`Co-authored-by`, `Signed-off-by`).
2. **File tree** — hierarchical, collapsible, with per-file status (A/M/D/R/C), rename arrows,
   and `+adds/−dels`. Directory rows aggregate their children's counts. Toggle between tree
   and flat list; a filter box within the tree.
3. **Details** — full and short sha, parents as clickable shas, author and committer with both
   timestamps when they differ, all refs pointing at this commit, and signature verification
   status (`%G?` from `git show`, for this commit only per D20).

**Clicking a sha copies it** — in the details block and in the list's sha column, which is a
button rather than text. Feedback is immediate and names what was copied. If the clipboard
write fails, say so; a copy affordance that silently does nothing is worse than none.
- **Clicking a file opens its diff for that commit** — this is the primary interaction of the
  pane, not a secondary action. The diff is `<parent> → <commit>` for that path (for merges,
  against the selected parent), rendered in the in-app unified diff view described in §3.3,
  which opens as a third region: on wide panels it takes over the detail pane with a back
  affordance to the file tree; on narrow panels it opens as a full-width overlay. Under
  VS Code an "Open in editor" action additionally hands the same diff to `vscode.diff` for a
  native side-by-side editor tab, and a **"Go to file"** action (D14a) goes one step further:
  it maps whichever line the cursor/selection sits on in the diff to the corresponding line in
  the target revision, then opens *that* — the real working-tree file at that line when the
  path exists in the current checkout, or the same read-only virtual blob content the diff
  itself is already rendered from (git object content by sha) when it doesn't — because the
  file was deleted or renamed since, or because it **doesn't exist on disk at all**: it was
  only ever added on a commit that isn't an ancestor of what's checked out (a feature branch
  not yet merged, a commit on another branch entirely). It always lands somewhere, and always
  at the mapped line — it never simply fails because the branch isn't the one on disk. Arrow
  keys move between files in the tree with the diff
  following the selection, so a commit can be reviewed file by file without the mouse.
  Renames show the old → new path; binary files and LFS pointers are labelled rather than
  rendered as garbage.
- For merge commits, a parent selector controls which diff is shown.

**The pane carries no action row.** Commit actions live on the row's **context menu**
(right-click), which is where a list in this workbench is expected to keep them, and which
keeps the pane's vertical space for content in a panel that is short to begin with. The menu:
checkout this commit · create branch here · create tag here (§7.9) · revert this commit
(§7.10) · cherry-pick (v1: single commit, no conflict-resolution UI beyond reporting) · reset
to here with the three modes as a submenu (§7.7) · copy sha · copy message.

Reset and revert sit adjacent with their difference stated in the menu — revert adds a commit
and is safe on pushed branches; reset moves the branch pointer and is not.

Right-clicking a row **also selects it**, so the menu never acts on a commit the user cannot
see. The accepted cost of moving actions off-surface is discoverability: nothing on screen
advertises that these actions exist. We take it — every action is also in the command palette
and keyboard-reachable (§6.6) — and revisit if it proves to be a real complaint rather than a
predicted one.

### 6.5 VS Code integration points

Beyond the panel itself, three entry points and nothing more. Each is cheap and lands where
the user already looks; anything further (blame gutter, editor title actions) is v2.

- **Command palette** — `kiraVersion.*` commands for open panel, refresh, search, and each
  repo-scoped operation, so everything is keyboard-reachable and rebindable.
- **SCM view title button** — an "Open Git Graph" action contributed to `scm/title` in the
  `navigation` group. This is where someone already looking at their changes goes next.
- **Status bar item** — current branch plus ahead/behind (`⎇ main ↓2 ↑3`), clicking opens the
  panel. Visible only when a repository is open.

One honest caveat on the status bar: **VS Code's built-in Git extension already contributes a
branch-and-sync item there.** Ours would sit beside it and read as duplication for users who
have the built-in one enabled. So it carries a distinguishing icon rather than mimicking the
native item, sits to its right, and `kiraVersion.statusBar.enabled` turns it off in one
setting. We do not hide or fight the built-in item.

### 6.6 Interaction

Keyboard-first: `↑/↓` move selection, `Enter` open the detail pane (again on the same row
closes it, matching the click behaviour in §6.4), `Shift+F10` or the Menu key opens the row's
context menu, `/` focus search, `F5` refresh, `Ctrl/Cmd+F` search, `Esc` closes — in order —
an open menu, then the diff view, then the detail pane or drawer. Full keyboard reachability and ARIA roles
on the virtualized list are v1 requirements, not polish.

Every mutating action is available from a context menu on the row it applies to and from the
toolbar where it is repo-scoped.

### 6.7 GitHub pull request links

A local branch on a GitHub repository usually has a pull request, and its number is a fact the
user wants at hand — to quote it in a message, to find the branch again by it, or to open it
in the browser. v1 resolves that association and does exactly two things with it: it shows the
number as a badge on the branch, and it feeds the number and title to search (§7.8). It reads;
it does not overlay, review, or write (see "What it is not" below).

**How the link is resolved.**

1. **Is this a GitHub repository at all?** `git remote get-url origin`, parsed for `owner/repo`
   in either the https or the ssh form. Anything else — a GitLab remote, a bare path, no
   remote at all — and the feature is **inert**: no badge, no network call, no auth prompt,
   ever. This is the check that runs first, precisely so that the repositories the feature does
   not apply to never see any of it.
2. **A session from VS Code itself.** `vscode.authentication.getSession('github', ['repo'],
   { createIfNone: true })` through the `GitHubAuth` port (§3.3). VS Code ships a GitHub
   authentication provider in the box: there is no second extension to require, no OAuth
   application of ours to register, and no login flow we write — it is the GitHub account the
   user already gave their editor (D31). The session is requested **lazily**, on first actual
   need — the first badge render, or the first search that could match PR text — and never at
   activation. Declining is a normal outcome: we do not ask again for the session, and the app
   is otherwise unaffected.
3. **One REST call per branch.** `GET /repos/{owner}/{repo}/pulls?head={owner}:{branch}&state=all`,
   yielding number, title, URL and state. Merged is not a distinct GitHub state — a merged PR
   is closed with a merge timestamp — so we read both fields rather than reporting a merged PR
   as merely closed. The result (including "no PR") is cached per branch, bounded by the branch
   count, dropped with the repo's cached set (§5.4), and invalidated on `refsChanged` from the
   existing watcher (§4.5) like every other per-ref fact. Nothing polls.

**An installed GitHub extension is enrichment, never a requirement.** Where the GitHub Pull
Requests extension or GitLens is present, it may be feature-detected for state it has already
fetched. That is the same optional-capability shape §7.11 and D15 use for conflict resolution:
detected if there, ignored if not, and nothing in this feature degrades when it is absent —
which is also why the association is not built on those extensions' internals in the first
place (D31).

**The badge, in the two places branches are already first-class.** A small `#123` badge on the
toolbar branch picker's rows (`BranchPicker.vue`, §3.1) and on the inline branch ref badges in
the message column (`refBadges.ts`, §6.4). It is a ref badge in every visual respect — token
layer, density, shape vocabulary (§6.1) — with the PR state carried as styling rather than as
extra words, because badge width in a short panel is scarce. The tooltip names the title and
the state. **Clicking it opens the pull request in the browser through the `ExternalOpener`
port** (§3.3), whose stated purpose is already "open compare/PR URLs" — this feature is the
one that opens them, and it needs no new port to do it.

**Inert, never noisy.** No GitHub remote, no matching pull request, the setting off, the auth
declined, or the lookup failed — every one of those renders as *no badge*. Never a spinner in
a virtualized grid row, never an error badge, never a retry loop; a failed lookup is a
`Logger` line and nothing on screen. A row in the commit list is the worst surface in the app
on which to display a pending network state, and this is the only feature that could have put
one there (D32).

**The setting.** `kiraVersion.github.enabled`, default on — but "on" does nothing without a
GitHub-shaped remote. Off means no session is requested, no request is made, no badge is
rendered, and search behaves exactly as it did before. It earns its own switch because this is
the one thing the app does that touches no local git state and leaves the machine on its own
initiative, and some users will not want their editor's GitHub session spent on it.

**Search.** §7.8's `Refs` scope also matches a branch on its PR number and title. The match
runs over the cached records described above, so it costs no network round trip per keystroke
and the ≤120 ms budget in §5.1 is untouched.

**What it is not.**

- **Not PR overlays.** No pull request state is drawn onto commits, rows, or the graph, and no
  view mode is added. §9's forge-integration exclusion is about exactly that and still stands:
  a number that links out, plus text that search can find, is a link — not the forge inside
  the editor.
- **Not a review or comment UI.** Nothing reads, renders, or posts a review, a comment, or a
  reviewer list. §6.8 is how you read a branch's changes, locally and without a forge; this
  section only tells you which pull request that branch belongs to.
- **No CI or check status.** Not fetched, not shown. A red build is a thing to act on, and
  acting on it is not in v1.
- **No writes.** Nothing is created, merged, closed, commented on, or updated on GitHub. The
  `repo` scope is requested to read private repositories' pull requests, not to change them.
- **GitHub only.** GitLab, Bitbucket and self-hosted forges are v2 (§9), as is issue linking.

### 6.8 Review branch changes

Reading a branch end to end — every commit it adds, and for each of those commits every file
it touched — is a different task from reading history. The graph answers "what happened, and
where does this commit sit". This answers "what would merging this branch bring in", one
commit at a time. It is the question a pull request's *Commits* tab answers, asked locally,
before the pull request exists and without leaving the editor.

**Entry points.** A **Review branch changes** item on the context menu of a branch, wherever a
branch is already right-clickable:

- the toolbar's branch picker (`BranchPicker.vue`, §3.1) — right-clicking any branch in the
  dropdown, local or remote-tracking;
- the inline branch ref badges in the message column (§6.4's badges, built by `refBadges.ts`,
  §3.1) — right-clicking the badge reviews *that* branch, not the commit under it, which is
  the one place in the app where a right-click on a row means something other than "act on
  this commit"; the menu is titled with the branch name so it cannot be misread.
- `kiraVersion.reviewBranch` in the command palette, prompting for the branch. This is not a
  fourth integration point — §6.5's rule is already that every action is palette-reachable.

**It opens in the sidebar** (§2.1, D29), in its own activity-bar container, and reveals itself
when the command runs. It does not disturb the panel: the graph keeps its scroll position and
selection, and the two surfaces can be read side by side, which is most of the point of not
putting the review inside the panel.

**Comparison base** (D30). The review is `git log <base>..<branch>` — the commits reachable
from the branch and not from the base, which is exactly the set a pull request would call
"this branch's commits", and exactly what merging into the base would introduce. Two-dot, not
three-dot: we want the branch's own commits, not the symmetric difference.

The base is **resolved, not asked for**, in this order:

1. **The branch's upstream/tracking branch, when it names a different branch.** `%(upstream)`
   already comes back from the `for-each-ref` call in §4.4, so this costs no extra process.
   The qualification carries the weight: the ordinary case — `feature-x` tracking
   `origin/feature-x` — is the same branch on a remote and says nothing about what the branch
   introduces (comparing against it would show only the commits not yet pushed), so it falls
   through to step 2. An upstream naming a *different* branch (`feature-x` tracking
   `origin/develop`) is a deliberate statement of what this branch forked from, and we honour
   it.
2. **The repository's detected default branch** — `origin/HEAD` where it resolves
   (`git symbolic-ref refs/remotes/origin/HEAD`), else the first of
   `kiraVersion.review.baseCandidates` (default `main`, `master`) that actually exists as a
   local or remote-tracking ref.
3. **Nothing detected → we ask**, with the base picker focused and the commit list empty. We
   never silently review against a guess; a review against the wrong base is worse than no
   review, because it looks right.

**Override, always available.** The resolved base is shown in the view's header as a picker —
never as static text — naming the base and how it was resolved ("upstream", "default branch").
Changing it re-runs the comparison in place, without reopening the view. The override holds
for the session, per branch; it is deliberately not persisted, because the branch this one
forked from is a fact about the moment, and a stale remembered base is the same failure mode
as a wrong detected one. This is the same defaults-with-override shape as the history scope in
§4.4 (`--all` with a current-branch toggle) and pull's strategy in §7.3: we pick, we say what
we picked, and we let the user say otherwise.

**Empty and degenerate cases are stated, not blank.** A branch fully merged into its base, or
the base itself, produces "nothing to review — `<branch>` adds no commits to `<base>`" naming
both refs, not an empty list. A branch sharing **no merge base** with the chosen base — where
`<base>..<branch>` would silently list the branch's entire history as though it were all new —
says so instead, detected with a `git merge-base` check before the walk rather than discovered
by the user halfway down a very long list.

**Lifecycle: temporary, and outside §5.4's guarantee.** The view holds exactly one review
session. Reviewing another branch replaces its contents rather than opening a second view. It
persists no view state through `setState`, is not rehydrated from the host cache on reveal,
and takes no part in §5.4's "the same rows repaint without re-running git" contract — when the
sidebar is hidden and the webview disposed, the session is simply gone, and reopening
re-resolves the base and re-runs the walk. This is affordable precisely because the walk is
bounded: a branch's own commits are tens or hundreds, not the 100k the graph is built for. The
range walk uses the same streaming machinery and the same page size (§5.1.1), so the rare
enormous range gets the same **Load more** button rather than a special case.

**The interaction, top to bottom.**

1. **A commit list**, newest first, in the same topological order the walk produces. Each row
   is subject, short sha, author and relative date — the message column's content, minus the
   graph, because a range of one branch has nothing interesting to draw.
2. **Each row expands** — disclosure triangle, `→`/`←` or `Enter` on the keyboard — into
   **that commit's file tree**: the same `FileTree.vue` §6.4 specifies, with the same per-file
   status (A/M/D/R/C), rename arrows, `+adds/−dels`, and directory rows aggregating their
   children. Several commits can be expanded at once; the tree for a commit is fetched on
   first expansion (`commit.detail`, §3.5) and kept for the session.
3. **Clicking a file opens its diff** — the same in-app unified diff view (§3.3, D13, D14),
   `<parent> → <commit>` for that path, with the same parent selector on merge commits. At
   sidebar widths the diff opens as a **full-height overlay over the commit list with a back
   affordance**, which is the treatment §6.4 already defines for the panel's narrow
   breakpoint, reused rather than reinvented. Arrow keys move between files with the diff
   following the selection, so a commit is reviewed file by file without the mouse; `Esc`
   closes the diff, then collapses the row.
4. **"Open in editor" and "Go to file" (D14a) come along unchanged.** The sidebar is narrow,
   which makes the native side-by-side editor tab (`vscode.diff`) the natural move for a diff
   worth reading closely — an argument for the secondary action mattering more here, not for a
   second diff implementation. "Go to file" is worth more here than anywhere else in the app:
   reviewing a branch you have *not* checked out is the normal case, so the files it lands on
   are routinely files that do not exist on disk, which is exactly the virtual-blob fallback
   D14a exists for.

**What it reuses, and why that is the whole point.** The file tree, the diff view, "Go to
file", the streaming walk, `commit.detail`, the token layer and the codicon set are P5's and
P2's, used as they stand. The review view mounts the same `packages/ui` bundle with a
different root component, selected from the initial state the host injects (`html.ts`, §3.1),
so `vite.config.ts`'s one-build-one-entry rule still holds and there is no second UI to keep
in visual step with the first. What P7 genuinely adds is the sidebar view provider, the base
resolver, the range-scoped walk, and a commit list whose rows expand.

**What it is not.**

- **Not forge integration.** The review itself reads, creates and comments on no pull request,
  and nothing about it leaves the machine — §6.7's PR link is a separate feature that adds
  nothing to this view. It is a local `<base>..<branch>` read, and it works on a branch that
  has never been pushed. Forge overlays remain v2 (§9).
- **Not a persistent filtered graph view.** It draws no lanes and has no view mode to leave
  behind; the graph's own scope is untouched while it is open (§9's filtered-walks exclusion
  stands).
- **Read-only.** No checkout, reset, revert, cherry-pick or branch operation is offered from
  it — copy sha and copy message are the only actions on a row. Reviewing is reading; the
  operations live where they already live (§6.4's row menu, §7), on a surface where the
  pre-flight, confirmation and undo machinery is already present.

---

### 6.9 Reference mockup

`docs/design/panel-mockup.html` is the approved visual reference for §6 — open it in a browser.
It is a static drawing, not an implementation, but it is not decoration either: the lane graph
is a real layout pass over a real commit topology, and the theme switcher demonstrates the token
bridge from §3.4 recolouring it on a theme change. The mockup draws that graph to a `<canvas>`;
the shipped app does not (§5.3). The canvas there is a convenience of a single static file with
no virtualization to satisfy, and it is a drawing technique of the mockup, not a design decision
this document carries — the geometry it shows (row height, lane pitch, node radii, the arc
shape) is what makes it the visual reference, and that geometry is identical in SVG.

It shows the panel in place beside the Terminal tab, all four theme kinds, the conflicted
state (§7.11), and the narrow-panel drawer breakpoint (§6.3). It shows **no branch-review
view** — the mockup predates §6.8 and draws the panel only. That is a gap in the picture, not
a claim about the design: §6.8 is normative and the review view's visual language is §6.1's,
inherited component for component from the detail pane it reuses.

Its standing: **where the mockup and this document disagree, this document wins** — the mockup
is a picture of one moment in the design and will drift. Where it shows something §6 does not
describe, that gap is a bug in §6, not licence to invent. It is not a P4 acceptance target;
the acceptance criteria are in §10.

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
commits that will become unreachable on the remote. For branches matching
`kiraVersion.protectedBranches` (default `main`, `master`, `release/*`) it requires a **typed
confirmation** — the user types the branch name — rather than being blocked outright. A hard
refusal would only send someone to the terminal, where there is no lease check at all; we
would lose the safety we were trying to add. Friction, not prohibition.

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
  confused with `v1.2.0` the branch. Same three toggles apply. A branch with a resolved pull
  request (§6.7) additionally matches on its **PR number** — with or without the leading `#` —
  and on its **PR title**, and surfaces as that same branch hit, carrying its badge. Matching
  runs over the PR records already cached in memory, so it adds no process and no network
  round trip to a keystroke. This part arrives with §6.7 at P12, not with the search phase
  itself; branches without a PR, and every repository without a GitHub remote, match exactly
  as they did before.
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
the same "only for the selected item" rule as commit signatures (D20). The tag query is
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
error. Deleting a tag that exists on a remote warns that the local delete does **not** touch
the remote copy, so the next `fetch` brings the tag straight back — only
`git push <remote> --delete <name>` removes it for good. That is the asymmetry that makes tag
deletion confusing, and it is what the warning must say.
Sorting the tag list is version-aware (`--sort=-v:refname`) so `v10` follows `v9`.

### 7.10 Revert

A **Revert commit** entry on the commit's row context menu (§6.4), which is where every commit
action lives — the detail pane deliberately carries no action row.

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

**Resolve is a VS Code capability the port advertises, not a hard requirement of the port
itself** (§3.3) — `EditorIntegration` exposes conflict resolution as an optional capability the
UI feature-detects rather than assumes. A host without a merge editor to delegate to (none
ships in v1, but the port is written for the case) falls back to Abort, Continue, "open the
conflicted file in the system default editor" (`ExternalOpener`), and a read-only view of the
conflict hunks — the same UI VS Code's own Continue/Abort already offer, minus Resolve. A
built-in resolution UI is v2 (§9).

**Non-goal:** we never auto-resolve, never pick a side, and never run `git checkout --theirs`
on the user's behalf.

### 7.12 Undo

A single-level **Undo last operation** in the toolbar, active for a bounded window after any
destructive operation and labelled with what it will undo ("Undo reset of `main`").

This is cheap because Git already holds the recovery data — we are surfacing it, not
implementing it:

| Operation | Recovery |
|---|---|
| Reset (any mode) | previous HEAD from the reflog; `reset --hard`/`--soft` back to it (7.7) |
| Branch delete | the sha we recorded before deleting; `git branch <name> <sha>` |
| Tag delete | same, recreating annotated tags from the captured tag object |
| Stash drop | `git stash store` the dropped `stash@{n}` commit, which survives until gc |

Scope and honesty about its limits, both stated in the UI:

- **One level.** Not an operation history. Performing another operation clears the undo slot.
- **It does not restore uncommitted work.** A `reset --hard` destroyed the working tree; undo
  moves the branch pointer back and nothing more. The reset confirmation already says this
  (7.7), and the undo affordance repeats it rather than implying a rescue it cannot perform.
- Operations that are not reversible this way (push, force-push, fetch) never offer undo. We
  never present an undo we cannot honour.
- The captured recovery sha is shown alongside the button, so the user can recover manually
  even after the slot is cleared.

Implemented as an `UndoSlot` in `core` populated by each op's executor, so adding a new
destructive operation without an undo entry is a visible omission rather than a silent one.

### 7.13 Other v1 operations

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
faster checks. Nothing about it conflicts with VS Code: **nothing is compiled by
`tsc` at all.** Transformation is done by esbuild/Vite/`bun build`; TypeScript runs
`noEmit` as a pure type checker. So the choice affects check wall-clock and editor feedback
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
- **`bun run check` runs a single checker**, TS 5.x, until `vue-tsc` ships TS 7 support.
- **tsgo is installed and available as an optional fast local check** over the pure-`.ts`
  packages (`bun run check:fast`). Sub-second feedback in the inner loop, no effect on `check`,
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
   screenshot comparison on the graph column, in both light and dark themes.
2. **Integration suite.** The real host, real Git, real repositories built by a fixture
   generator, driving actual operations and asserting on the repository state afterwards.
   Playwright drives VS Code's own Electron binary directly (launch the downloaded build with
   the extension installed, then work through the webview frame); `@vscode/test-electron`
   remains available for extension-host-level tests that need the VS Code API rather than the
   UI. Slower tier, run on demand — on macOS, which is where its result is authoritative for the
   shipped extension (D27), and also on headless Linux for development (Xvfb, a root container,
   `bun run test:e2e:vscode`; `docs/plans/P4c-linux-test-infra.md`). The OS and Git-version
   matrix this tier is shaped for arrives with the second platform: running the suite somewhere
   is not a matrix.

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

- The hot paths are deliberately outside the framework — more so than when this was first
  written. The commit list is SlickGrid, which renders its own rows and cells imperatively from
  typed arrays; layout is in a worker; commit data is column-wise typed arrays explicitly kept
  out of the reactivity system (§5.3, §5.5). The framework renders a toolbar, a detail pane,
  dialogs, and the host element the grid mounts into — it renders **no rows at all**. Vue's
  VDOM overhead over that surface is not measurable against a 16 ms frame.
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

**Verdict: stay with Vue.** The memory and speed requirements are met by §5.3/§5.5 — a
viewport-bounded virtualized grid, per-row SVG, workers, typed arrays, interning — and those
apply identically under either framework. Re-evaluate only if the P4 perf harness shows framework overhead in the
frame budget.

### 8.6 The rest

Vue 3.5+ (`<script setup>`, no Options API), `slickgrid` (the 6pac fork, MIT) for the commit
list's virtualization and column model, Vite for the UI bundle and the harness dev
server, esbuild (or `bun build`) for the host bundles, `@vscode/vsce` + `ovsx` for
publishing.

---

## 9. Out of scope for v1

Deferred to v2, listed so the v1 architecture does not preclude them:

- **Rebase, including interactive rebase.** Explicitly v2. The graph must already model
  in-progress rebase state (§4.5 watches `rebase-merge`/`rebase-apply`) so v1 can *report*
  a rebase in progress and refuse to interfere.
- **Remote and browser VS Code contexts** (2.1.1): SSH, WSL, Codespaces, dev containers,
  vscode.dev. Local desktop VS Code only.
- **Support for Git older than 2.38** (4.2). Hard floor, not a degraded mode.
- **Infinite scroll / eager full-history load** (5.1.1). Paged with an explicit Load more.
- **Side-by-side diff.** v1 ships unified only; "Open in editor" already gives VS Code users a
  native side-by-side view via `vscode.diff`, so building a second one would duplicate the
  editor for the one host v1 ships.
- **Localization.** English only, and no l10n infrastructure - no bundle, no string-id
  indirection. If it is ever wanted it is a mechanical change made then, not scaffolding
  carried now.
- **Telemetry of any kind.** Nothing is collected, so there is no opt-out to design.
- **Multi-level operation history.** Undo is one level (7.12).
- **Windows and Linux support** (2.1.2). macOS only, with the seam left open.
- **Continuous integration.** No pipeline, no workflows, no hosted runners (D28).
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
| **P0** | Foundation | Monorepo per the normative tree in 3.1, Bun workspaces, Biome, **single TS 5.x checker with TS7-clean compiler options plus `tsgo` as an optional `check:fast`** (8.3), Vite, `packages/ipc` contract skeleton, `apps/harness` with mock bridge, Playwright wired to it, fixture-repo generator, perf-budget harness (time **and** heap). | `bun install && bun run check && bun run test` green locally on macOS; harness renders a placeholder UI; one Playwright test passes; `vue-tsc`/TS-7 state re-confirmed and versions pinned. |
| **P1** | Git driver | `GitDriver`: discovery, version probe with the **2.38 hard-floor block state**, repo capability probe, spawn discipline (§4.3), streaming NUL parser, cancellation, write queue, `cat-file --batch`, typed error classification. | Unit tests over recorded porcelain fixtures; integration tests against generated repos; sub-2.38 Git produces the block state, never a half-working app. |
| **P2** | History pipeline | Streaming `git log` walk with **paused long-lived-process paging (5.1.1)** and remaining-count query, ref query, status query, lane layout in a worker, packed transferable buffers, column-wise typed-array store with string interning (5.5). | First page within budget; repeated Load more to 100k within time **and heap** budget; layout unit tests over hand-built topologies incl. octopus merges. |
| **P3** | Host bridge | RPC transport, VS Code panel webview view registered and reachable, state persistence/rehydration, **the shared settings schema (D25)**, theme token layer, the `readTokens` bridge. | Panel opens in VS Code and shows live data; hide/reveal rehydrates without re-running git; switching VS Code theme restyles the panel live, the graph surface included, with no reload. |
| **P4** | Graph UI | Vue shell, the SlickGrid commit list over the typed-array store, **Load more button with remaining count and viewport/selection preservation**, the SVG graph column, branch/tag ref badges, columns, selection, refresh action, keyboard nav, responsive breakpoints (§6.3). | 60 fps scroll on the 100k repo; Playwright visual + interaction suite; accessibility pass on the virtualized list; visual regression green across all four theme kinds; side-by-side density review against the native workbench list (6.1). |
| **P5** | Commit detail | Right pane: metadata, message/trailers/signature, parents, file tree with statuses and counts, **click-a-file-opens-its-diff** via the in-app unified diff view, **a line-mapped "Go to file" action (D14a) that opens the live file or falls back to the historical virtual blob**, copy actions. | Detail populated ≤80 ms; diff opens from tree click and follows keyboard selection; tree correct for renames, merges (parent selector), binary/LFS files; "Go to file" lands on the mapped line in the live file when the path exists in the current checkout, and in the virtual historical blob at that same mapped line when it doesn't (deleted, renamed, or belonging to a commit that isn't an ancestor of what's checked out). |
| **P6** | Refs & checkout | Branch list and **tag list with full tag manipulation (§7.9)**, create branch, switch branch, detached checkout, delete/rename, **revert (7.10)**, **linked-worktree detection (D12)**, the **undo slot (7.12) seeded by branch and tag deletion**, the **in-progress/conflicted-state banner with VS Code merge-editor delegation, continue and abort (7.11)**, and the full checkout pre-flight engine (§7.5). | Pre-flight classification unit-tested exhaustively; integration tests cover clean-carry, blocked-by-tracked, blocked-by-untracked, in-progress-op; tag create/delete/push incl. annotated and remote-delete asymmetry; revert incl. merge-parent selection; an induced conflicting revert reaches the banner, gates other operations, and both continues and aborts cleanly; undo restores a deleted branch and a deleted annotated tag. |
| **P7** | Branch review | The sidebar webview view and its own activity-bar container (§2.1), **Review branch changes** on the branch-picker and ref-badge context menus, the base resolver (upstream → detected default branch → ask, never a silent guess) with the header base picker and `review.resolveBase` (§3.5), the `<base>..<branch>` range-scoped walk over P2's existing streaming machinery, and a commit list whose rows expand into **P5's file tree** and whose files open **P5's unified diff, "Open in editor" and line-mapped "Go to file" (D14a)** unchanged (§6.8). | Review opens from both context menus and the palette, first commits painted ≤300 ms on a 200-commit range; base resolves to the tracking branch when it names a different branch, to the detected default branch when it does not, and to the ask-state when neither exists; the override re-runs the comparison in place without reopening the view; a fully-merged branch reports "nothing to review" naming both refs rather than an empty list; every row expands to the same tree P5 renders (renames, merge parent selector, binary/LFS) and every file opens the same diff, with "Go to file" landing on the mapped line in the virtual blob for a branch that is not checked out; hiding the view drops the session and reopening re-resolves and re-walks (no rehydration path, §5.4); Playwright interaction + visual coverage at sidebar widths across all four theme kinds. |
| **P8** | Remote ops | Fetch (incl. **opt-in background auto-fetch, default off**), push, decomposed pull with strategy selection, force-push with lease + `--force-if-includes`, protected branches, askpass path, progress + typed auth errors. | Integration tests against a local bare remote incl. non-ff rejection, lease violation, hook rejection; no operation can hang on a prompt. |
| **P9** | Stash | Stash create (incl. `-u`, message, pathspec), list, show, apply/pop/drop/branch, stashes rendered in the graph, and the pop-prediction engine via `merge-tree` (§7.6) wired into checkout resolution. | Prediction verified against actually-executed pops across clean and conflicting cases; a dropped stash is recoverable through the undo slot. |
| **P10** | Reset | Soft/mixed/hard with per-mode consequence copy, pre-flight counts, typed confirmation for hard-with-dirty, reflog-backed undo completing the undo slot (7.12). | Integration tests assert repository state per mode; undo restores; guarded during in-progress operations. |
| **P11** | Search | Input with case/whole-word/regex toggles, commit/refs(branches+tags)/both scope, hybrid client-side + git-backed matching, next/prev navigation, live regex validation, abort-on-supersede. | Semantics table fully covered by tests (each toggle × scope); ≤120 ms budget met; malformed regex never throws. |
| **P12** | GitHub PR links | Branch → pull request resolution (§6.7): GitHub-remote detection from `origin`, the `GitHubAuth` port over VS Code's built-in GitHub authentication provider (D31), the REST lookup, the per-branch cache invalidated by the watcher, `branch.resolvePr` (§3.5), the `#123` badge on branch-picker rows and message-column ref badges opening the PR via `ExternalOpener` (D32), `kiraVersion.github.enabled`, and PR number/title matching added to §7.8's `Refs` scope. | A branch with a pull request shows its badge in both places, distinguishes open/merged/closed, and opens the PR URL externally; search finds that branch by PR number and title within the ≤120 ms budget with no per-keystroke network call; no GitHub remote, no matching PR, the setting off, or a declined session each produce no badge, no request and no repeat prompt, with the rest of the app unaffected; the session is requested on first use only, never at activation, verified by an activation-time assertion. |
| **P13** | Ship | `.vsix` packaging without `vscode:prepublish`, `extensionKind`/no-browser manifest declarations (2.1.1), **`engines.vscode` floor confirmed (D7)**, **SCM title button and status bar item (6.5)**, the **`kiraVersion.*` command-palette audit** wiring a command for every mutating operation introduced across P6–P10 (6.5/6.6's "every action is palette-reachable", which no earlier row owns), marketplace + OpenVSX metadata, docs, settings surface, telemetry-free release checklist. | Installable `.vsix`; every mutating operation reachable from the palette; full Playwright suite green on macOS. |

**A note on P3's row, for anyone reconciling it against `docs/plans/P3.md`.** P3 originally also
built and shipped a second, standalone desktop host booting the identical UI bundle, plus the
palette generator that themed it from VS Code's own theme JSON — both real, working P3
deliverables. That desktop host was removed from v1's scope after P3 closed; the row above
describes the tree as it exists today, not as P3 left it. `docs/plans/P3.md` is kept unedited
as the accurate record of what P3 actually built; the removal itself, and why the port seam it
required is kept anyway, is recorded in `docs/plans/P4b-remove-electron.md`.

---

## 11. Decisions taken

Every question raised during requirements gathering, with its answer. The reasoning is
recorded because it matters as much as the answer, and because several of these are
load-bearing elsewhere in this document. **There are no open questions; §12 records what was
deliberately deferred rather than left undecided.**

### 11.1 Architecture and toolchain

| # | Question | Decision |
|---|---|---|
| D1 | Git integration approach | **System Git via child process.** Not bundled, not libgit2/NodeGit, not isomorphic-git. Credentials, config fidelity and ecosystem tooling all decide it. Reasoning in 4.1. |
| D2 | Minimum Git version | **2.38 as a hard requirement**, no degraded path. The target is a developer workstation running current Git; below the floor the app shows a blocking upgrade state (4.2). This is what makes the conflict predictions exact rather than heuristic. |
| D3 | Frontend framework | **Vue.** Svelte's advantages are real but land outside this app's hot paths, which are a viewport-bounded virtualized grid, workers and typed arrays — the framework renders no commit rows at all. Evaluated in 8.5. |
| D3a | Commit-list rendering | **SlickGrid (6pac fork, MIT) for every column, with the graph column rendered as one small `<svg>` per row. No `<canvas>`.** The grid supplies the virtualization AGENTS.md's "prefer a library" rule asks us not to hand-roll, and driving it from a `CustomDataView` over the typed-array store keeps §5.5 intact. SVG rather than canvas because a graph column that is a *column* needs no second positioned surface to keep in sync with the rows, and because SVG takes its lane colours from the same CSS variables as everything else, deleting the theme-repaint problem in §3.4 rather than solving it. Per-row cost is bounded by the viewport, so the 100k requirement is met by virtualization, not by the drawing technique. Rendering detail in 5.3, the full evaluation in `docs/plans/P4.md`. |
| D4 | TypeScript 7 | **Write TS7-clean code from day one, run a single TS 5.x checker until `vue-tsc` supports TS 7** (expected ~7.1, October 2026, inside this project's P0-P4 window). The originally-proposed two-checker split was wrong: `vue-tsc` checks whole programs, so TS 5.x would have been checking everything anyway. Full reasoning in 8.3. |
| D5 | Theme | **Ride VS Code's injected theme.** It pushes the full workbench palette as `--vscode-*` CSS variables plus theme-kind body classes into every webview and keeps them live across theme switches. Details in 3.4, aesthetic rules in 6.1. |
| D6 | Supported hosts | **Local desktop VS Code.** Remote contexts (SSH, WSL, Codespaces, dev containers) and browser VS Code are out of scope and untested (2.1.1). See §2.2 for why the port seam every host implementation sits behind outlives having only one host to show for it. |
| D7 | `engines.vscode` floor | **Roughly six months behind current stable — but raised without hesitation whenever a newer API genuinely earns it.** Reach is not worth working around a missing API. The concrete number is set at P0 from the then-current release and revisited at P13 (Ship). |
| D8 | v1 branch | **All v1 work lands on `feature/kickoff`.** Agents start from its tip and add on top for as long as phases remain unfinished; never rebased or force-pushed. A phase may be implemented on its own phase-scoped working branch rather than directly on `feature/kickoff`; once the phase is done, that branch's commits are replayed onto `feature/kickoff`, which stays the one history every later phase starts from regardless of which branch the implementation work happened on. See `AGENTS.md`. |

### 11.2 Product scope

| # | Question | Decision |
|---|---|---|
| D9 | History loading | **Paged behind an explicit "Load more" button, 5,000 per page. Not infinite scroll.** Mechanics and reasoning in 5.1.1. |
| D10 | Default history scope | **`--all`, with a current-branch-only toggle.** A graph tool showing one branch is not a graph tool, and paging removes the cost objection (4.4). |
| D11 | Multiple repositories | **A switcher, one active repo at a time.** Submodules are detected and listed as additional switcher entries — they are real repositories, so it is nearly free — but get no dedicated UI. |
| D12 | Linked worktrees | **Supported.** `--git-common-dir` already tells us we are in one, so detection is free at P1, and showing the other worktrees' HEADs as badges heads off the "why can't I check out this branch" confusion. Expensive to retrofit later. |
| D13 | Diff view | **Unified only in v1; side-by-side is v2.** "Open in editor" already gives VS Code users a native side-by-side view via `vscode.diff`, so building our own would duplicate the editor for the one host v1 ships. |
| D14 | Clicking a file | **Opens its diff in-panel** (6.4). Keeps the user in the graph and keeps both hosts behaving alike; "Open in editor" is the secondary action. |
| D14a | "Go to file" from the diff | **Line-mapped, and falls back to a virtual document rather than failing.** Computes the corresponding line in the target revision from the diff cursor position; opens the live working-tree file there when the path exists in the current checkout, otherwise the same read-only virtual blob content the diff view already renders from (git object content by sha, independent of what's checked out) — this covers a file deleted or renamed since, and just as much a file that **has never existed on disk at all**, because it was only ever added on a commit that isn't an ancestor of what's checked out. Goes further than VS Code's own diff-editor "Go to File" (which only handles the trivial case where the file exists at the checked-out path) — the precedent is GitLens's enhanced "Open File" (6.4). |
| D15 | Conflict resolution | **Delegated, not built.** VS Code resolves conflicts natively — the `merge-conflict` extension's inline actions and the SCM view's three-way merge editor work on any conflict markers, whoever created them. We detect, surface, gate operations and hand off; we never auto-resolve (7.11). |
| D16 | Undo | **Yes, in v1: single-level "undo last operation"** across reset, branch delete, tag delete and stash drop. The recovery data already exists in the reflog and `stash@{}` — we surface it rather than implement it. Limits stated in the UI, not hidden (7.12). |
| D17 | VS Code integration points | **Three: command palette, an "Open Git Graph" button in the SCM view title, and a status bar item** showing branch plus ahead/behind. The status bar item sits beside VS Code's built-in one with a distinguishing icon and a setting to disable it (6.5). Blame gutter and editor title actions are v2. |
| D29 | Where branch review lives | **The sidebar, in its own activity-bar view container — a second webview view, not a third region of the panel** (2.1, 6.8). The graph is the primary, long-lived, frequently-resized surface that wants to stay put and keep its state (5.4), and it is horizontally dense, which is what the short-and-wide panel is good for. Branch review is the opposite shape: one-shot, drill-in, vertical — a list you open against one branch, read down, and dismiss, which is what VS Code itself reserves the sidebar for (Search Results, Explorer, Source Control). Putting it in the panel would have added a fourth region to §6.3's narrow breakpoints and buried an ephemeral flow inside the surface whose job is permanence. The cost is one extra `WebviewViewProvider` and one manifest contribution: both views mount the same `packages/ui` bundle with a different root, so there is no second UI to keep in visual step. Deliberate scope, taken with the feature. |
| D30 | Branch review's comparison base | **Resolved by default, overridable always, never guessed silently.** `git log <base>..<branch>` (two-dot — the branch's own commits, the set a pull request calls "this branch's commits"), with `<base>` resolved as: the branch's upstream when it names a *different* branch, else the repository's detected default branch (`origin/HEAD`, else the first existing of `kiraVersion.review.baseCandidates` = `main`, `master`), else we ask with an empty list rather than reviewing against a guess — a review against the wrong base looks right, which is what makes guessing worse than asking. The resolved base is a picker in the view header, not static text, and says how it was resolved; changing it re-runs in place. The override is session-scoped and deliberately not persisted: what a branch forked from is a fact about the moment, and a stale remembered base fails exactly like a wrongly detected one (6.8). Same defaults-with-override shape as D10's `--all` scope and §7.3's pull strategy. |
| D31 | How a branch's pull request is resolved | **VS Code's own built-in GitHub authentication provider, plus a direct REST call — not another extension's internals.** `vscode.authentication.getSession('github', ['repo'], …)` ships inside VS Code: no second extension to require, no OAuth application of ours to register, no login flow to write, and the session is the GitHub account the user already granted their editor. The alternative — reading what the GitHub Pull Requests extension or GitLens has already fetched — was rejected because neither publishes a documented, stable API for "the pull request for branch X"; that association would be a dependency on undocumented internals, breaking on someone else's release, for a feature the user could not then repair. `owner/repo` comes from `origin`'s URL (https or ssh), the lookup is `GET /repos/{owner}/{repo}/pulls?head={owner}:{branch}&state=all`, and the answer is cached per branch and invalidated by §4.5's watcher like every other per-ref fact. The session is requested lazily on first real use, never at activation, and never at all without a GitHub-shaped remote or with `kiraVersion.github.enabled` off. An installed GitHub-aware extension may still be feature-detected as **enrichment only** — the same optional-capability shape as D15's conflict resolution, never a requirement and never a fallback we depend on (6.7). |
| D32 | What "linked" means in the UI | **A badge on the branch, not only a search index entry.** The number shows where branches are already first-class — the toolbar branch picker's rows and the message column's inline branch ref badges — and clicking it opens the pull request through the existing `ExternalOpener` port (§3.3), whose stated purpose is already "open compare/PR URLs"; no new port. Indexing the association for search alone would have made it real but unfindable: you would have to already know the number to search for it. The badge is **inert rather than noisy** — absent when there is no GitHub remote, no matching PR, the setting is off, or a lookup failed, and absent rather than a spinner or an error while one is in flight — because a row in a virtualized grid is the worst place in this app to display a pending network state (6.1, 6.7). PR number and title also join §7.8's `Refs` scope, so the badge and the search hit are one association surfaced twice, not two features. |

### 11.3 Behaviour and safety

| # | Question | Decision |
|---|---|---|
| D18 | Background auto-fetch | **Implemented and configurable, default off** (`kiraVersion.fetch.autoInterval = 0`). Guardrails in 7.1. |
| D19 | Protected branches | **Typed confirmation, not a hard refusal**, on `main`/`master`/`release/*`. Blocking outright would only send the user to the terminal, where there is no lease check at all — losing exactly the safety we were adding. Friction, not prohibition (7.4). |
| D20 | Signature verification | **Selected commit only.** `--show-signature` per commit is far too slow in bulk and a per-row trust badge is not worth a process spawn per visible row. |
| D21 | `commit-graph` maintenance | **Never written silently.** A one-time prompt, only when the repo is large and no graph file exists, with "don't ask again". It is what `git maintenance` does anyway, so it is safe — but writing into someone's `.git` unasked is not ours to do. |
| D22 | Git LFS | **Detect and label.** A pointer file is recognisable from its first line; we show "LFS object, not fetched" rather than rendering the pointer as though it were the file. |

### 11.4 Project

| # | Question | Decision |
|---|---|---|
| D23 | Telemetry | **None at all.** Nothing collected, so there is no opt-out to design and no privacy policy to write. Easier to never start than to remove later. |
| D24 | Localization | **English only, and no l10n infrastructure** — no bundle, no string-id indirection, no scaffolding carried for a future that may not come. If it is ever wanted, it is a mechanical change made then. |
| D25 | Settings | **One schema in `core`**, generating `contributes.configuration` for VS Code at build time. Defined at P3, before ~15 settings accrete in two places; a future host's own settings surface would generate from the same schema rather than inventing a second one. |
| D26 | Licensing and distribution | **MIT; published to both the VS Code Marketplace and OpenVSX.** The `.vsix` is not notarized. The Apple Developer account and notarization requirement this row used to flag as a decide-before-ship item belonged to the standalone desktop build (`docs/plans/P4b-remove-electron.md`) and was retired with it, not decided the hard way — no such cost or identity is needed for a `.vsix`. No Windows certificate is needed while D27 holds. |
| D27 | Operating systems | **macOS only for v1.** Windows and Linux are not supported or tested. Platform-conditional code sits behind named strategies with the other platforms as explicit unimplemented cases, so adding one later is implementation rather than untangling (2.1.2). The test suite is runnable on Linux for development (`docs/plans/P4c-linux-test-infra.md`) — that is dev-infrastructure, not support, so the Linux `PlatformGitLocator` branch this enabled (§4.2) is deliberate, not a leak to tidy away. |
| D28 | Continuous integration | **None for now.** No workflows, no hosted runners. `bun run check`, `bun test`, `test:e2e` and `test:perf` are run locally on macOS, and running them before closing a phase is part of the phase's exit criteria rather than something a pipeline enforces. The scripts are written to be CI-callable so adding a pipeline later is configuration, not rework. Running the suites on headless Linux locally (`docs/plans/P4c-linux-test-infra.md`) is the same kind of local run, not a pipeline — no workflow was added. |

---

## 12. Deferred, deliberately

Not open questions — decided, and decided to be v2. Listed separately from §9 because these
are the ones most likely to be asked about again.

- **Interactive rebase**, and rebase generally (§9). The single largest v2 item. v1 already
  models in-progress rebase state so it can report and refuse rather than corrupt.
- ~~A built-in conflict resolver for the standalone desktop build~~ (D15) — **resolved by the
  scope change, not carried to v2.** It existed to cover the one host with no native merge
  editor; v1 now ships only VS Code, which already has one (§7.11), so there is no gap left to
  defer. Re-adding a host without one would reopen this as a real v2 (or later) item.
- **Side-by-side diff** (D13).
- **Blame, file history, and pickaxe search** (`-S`/`-G`). Different mental models that do not
  belong behind v1's search box.
- **Forge integration** — PR overlays for GitHub/GitLab.
- **Multi-level operation history** beyond the single undo slot (D16).
- **Multi-repo unified graph** (D11 ships a switcher).
