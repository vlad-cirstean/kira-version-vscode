/**
 * The webview-side bootstrap (P3 W10) — this package's *other* entry point, built and loaded
 * exactly like `apps/harness/src/main.ts`, except it runs inside a VS Code webview iframe
 * rather than a plain browser tab. Never imports `vscode` (that module exists only in the
 * extension host); the one VS Code-specific thing it touches is `acquireVsCodeApi()`, the
 * function VS Code injects into every webview's global scope for exactly this purpose.
 *
 * `html.ts` is what actually loads this file (via a built, `asWebviewUri`-rewritten `<script
 * type="module">` tag) and hands it nothing at runtime beyond the DOM — `#kira-bootstrap`'s
 * JSON island is this file's only input, read below.
 */
import type { MessageChannelLike } from "@kira-version/ipc";
import { createRpcClient, VSCODE_WEBVIEW_BUFFER_ENCODING } from "@kira-version/ipc";
import type { ViewStateStore } from "@kira-version/ui";
import {
  DEFAULT_COLUMN_WIDTHS,
  DEFAULT_DETAIL_WIDTH,
  mount,
  type PersistedViewState,
  parsePersistedViewState,
} from "@kira-version/ui";

declare function acquireVsCodeApi<T = unknown>(): {
  getState(): T | undefined;
  setState(state: T): void;
  postMessage(message: unknown): void;
};

interface Bootstrap {
  readonly host: "vscode";
  readonly contractVersion: number;
  /** `KIRA_REPO`, forwarded through `html.ts`'s bootstrap island — dev/e2e only, see there. */
  readonly repo: string | null;
}

function readBootstrap(): Bootstrap {
  const el = document.getElementById("kira-bootstrap");
  if (!el?.textContent) throw new Error("webview: #kira-bootstrap script tag is missing");
  return JSON.parse(el.textContent) as Bootstrap;
}

/** §2.1's `getState`/`setState` — the mechanism a hidden/recreated webview view survives
 *  through, since `retainContextWhenHidden` is deliberately left off (panelView.ts). */
class VsCodeApiViewStateStore implements ViewStateStore {
  readonly #api: ReturnType<typeof acquireVsCodeApi<unknown>>;

  constructor(api: ReturnType<typeof acquireVsCodeApi<unknown>>) {
    this.#api = api;
  }

  read(): PersistedViewState | null {
    return parsePersistedViewState(this.#api.getState());
  }

  write(state: PersistedViewState): void {
    this.#api.setState(state);
  }
}

/** The webview's own half of the channel `host-vscode/src/transport.ts` opens — see that file's
 *  doc comment for why this declares `"base64"` (P15's W1 finding) and why the two sides share
 *  `VSCODE_WEBVIEW_BUFFER_ENCODING` rather than each spelling out the same literal. */
function createVsCodeChannel(
  api: ReturnType<typeof acquireVsCodeApi<unknown>>,
): MessageChannelLike {
  return {
    bufferEncoding: VSCODE_WEBVIEW_BUFFER_ENCODING,
    post(message): void {
      api.postMessage(message);
    },
    onMessage(handler): () => void {
      const listener = (event: MessageEvent): void => handler(event.data);
      window.addEventListener("message", listener);
      return () => window.removeEventListener("message", listener);
    },
    close(): void {},
  };
}

const container = document.getElementById("app");
if (!container) throw new Error("webview: #app container missing from html.ts's document");

const vscodeApi = acquireVsCodeApi();
const bootstrap = readBootstrap();
const viewState = new VsCodeApiViewStateStore(vscodeApi);

// There is no repo-picker UI yet (P4+), so on a genuinely first-ever resolve (no state
// `setState` has ever recorded for this view) `KIRA_REPO` is the only way to get a repo open —
// mirrors `apps/harness/src/main.ts`'s own `setRaw` seeding. A *later* resolve (the webview is
// destroyed and recreated on every hide/reveal, §2.1) must never re-seed over real persisted
// state — that would defeat the rehydration this same state exists to prove.
if (bootstrap.repo && !viewState.read()) {
  viewState.write({
    version: 3,
    repoId: bootstrap.repo,
    loadedRows: 0,
    detailOpen: true,
    scrollRow: 0,
    selectedSha: null,
    columnWidths: DEFAULT_COLUMN_WIDTHS,
    dateFormat: "relative",
    detailWidth: DEFAULT_DETAIL_WIDTH,
    fileListMode: "tree",
  });
}

mount(container, {
  transport: createRpcClient(createVsCodeChannel(vscodeApi)),
  viewState,
  host: bootstrap.host,
});
