import type { HostKind, Transport } from "@kira-version/ipc";
import { createApp, type App as VueApp } from "vue";
import AppRoot from "./App.vue";
import ReviewView from "./components/review/ReviewView.vue";
import type { ReviewTarget } from "./state/review.ts";
import type { ViewStateStore } from "./state/viewState.ts";
import "./icons/codicon.css";
import "./theme/vscode-tokens.css";
import "./theme/density.css";

export interface MountHandle {
  unmount(): void;
}

export interface MountOptions {
  readonly transport: Transport;
  readonly viewState: ViewStateStore;
  readonly host: HostKind;
  /** `docs/plans/P7.md` W9: which root to mount — `AppRoot` (the panel, P0-P6) or `ReviewView`
   *  (the sidebar, §6.8). Defaults to `"graph"` so every pre-P7 call site (and every test that
   *  constructs `MountOptions` without this field) keeps mounting exactly what it always did. */
  readonly view?: "graph" | "review";
  /** Only meaningful when `view === "review"` — the cold-bootstrap arm of D40's "how the view
   *  learns which branch to review" (see `ReviewView.vue`'s own doc comment). `undefined`/`null`
   *  is the "no branch yet" state; ignored entirely for `view: "graph"`. */
  readonly target?: ReviewTarget | null;
}

/**
 * Mounts the app shell into `container`, wired to `transport` and `viewState`, told which
 * `host` it is running under. Hosts and the harness call this rather than each owning their
 * own bootstrap — the UI is mounted unchanged everywhere (§8.4), only these pieces differ.
 * `viewState` is what P3 W9 adds: without it, the panel would have to keep
 * `retainContextWhenHidden` on to avoid losing scroll/selection/loaded-row state every time a
 * VS Code webview is hidden and recreated (§2.1). `view` is what P7 W9 adds: one build, one
 * entry (§6.8/D41) — the host's own injected initial state says which root this call mounts,
 * never a second bundle. Both are breaking changes to the one function every host and the
 * harness calls, and both were made the same way: every call site moves in the same commit.
 */
export function mount(container: Element, opts: MountOptions): MountHandle {
  // §5.1 perf budgets are measured from navigation start (the implicit start of a
  // timeOrigin-relative measure); this marks the point the app's own bundle has parsed
  // and begun mounting. App.vue/ReviewView.vue each mark first-paint once mounted (W18 needs it
  // from both roots).
  performance.mark("kira:page-parsed");
  performance.measure("kira:page-parsed", undefined, "kira:page-parsed");

  const { view = "graph", target, ...rest } = opts;
  const app: VueApp =
    view === "review"
      ? createApp(ReviewView, { ...rest, target })
      : createApp(AppRoot, { ...rest });
  app.mount(container);
  return {
    unmount(): void {
      app.unmount();
    },
  };
}
