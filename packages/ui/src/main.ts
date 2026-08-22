import type { Transport } from "@kira-version/ipc";
import { createApp, type App as VueApp } from "vue";
import AppRoot from "./App.vue";
import "./icons/codicon.css";
import "./theme/vscode-tokens.css";
import "./theme/density.css";

export interface MountHandle {
  unmount(): void;
}

/**
 * Mounts the app shell into `container`, wired to `transport`. Hosts and the harness call
 * this rather than each owning their own bootstrap — the UI is mounted unchanged everywhere
 * (§8.4), only the Transport implementation differs.
 */
export function mount(container: Element, transport: Transport): MountHandle {
  // §5.1 perf budgets are measured from navigation start (the implicit start of a
  // timeOrigin-relative measure); this marks the point the app's own bundle has parsed
  // and begun mounting. App.vue marks first-paint and layout-complete once mounted.
  performance.mark("kira:page-parsed");
  performance.measure("kira:page-parsed", undefined, "kira:page-parsed");

  const app: VueApp = createApp(AppRoot, { transport });
  app.mount(container);
  return {
    unmount(): void {
      app.unmount();
    },
  };
}
