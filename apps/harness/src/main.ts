import { mount, type TokenMap, TokenReader } from "@kira-version/ui";
import { createMockBridge } from "./mockBridge.ts";
import { applyThemeKind, isThemeKind, type ThemeKind } from "./themeSwitcher.ts";

declare global {
  interface Window {
    __kiraHarness: {
      setTheme(kind: ThemeKind): void;
      readTokens(): TokenMap;
    };
  }
}

const params = new URLSearchParams(location.search);
const scenarioName = params.get("scenario") ?? "clean";
const themeParam = params.get("theme") ?? "vscode-dark";

applyThemeKind(isThemeKind(themeParam) ? themeParam : "vscode-dark");

// Exercises the same getComputedStyle bridge the canvas renderer will use from P4 on —
// re-read on every theme switch via the same MutationObserver path, not a fresh instance.
const tokenReader = new TokenReader();
tokenReader.watch();

window.__kiraHarness = {
  setTheme(kind: ThemeKind): void {
    applyThemeKind(kind);
  },
  readTokens(): TokenMap {
    return tokenReader.tokens;
  },
};

const container = document.getElementById("app");
if (!container) {
  throw new Error("harness: #app container missing from index.html");
}

const transport = createMockBridge(scenarioName);
mount(container, transport);
