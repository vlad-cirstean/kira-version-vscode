/**
 * Forces one of VS Code's four theme kinds on <body>, the same signals §3.4 documents VS
 * Code injecting automatically, plus a small hand-written dev palette for the --vscode-*
 * tokens the placeholder shell reads. This is P0 fidelity, not P3's: the real
 * generated-from-VS-Code palettes (scripts/gen-theme-palettes.ts) land later. P0 only needs
 * four switchable kinds for the visual-regression baseline and the token-desync test (W8).
 */
export const THEME_KINDS = [
  "vscode-light",
  "vscode-dark",
  "vscode-high-contrast",
  "vscode-high-contrast-light",
] as const;

export type ThemeKind = (typeof THEME_KINDS)[number];

export function isThemeKind(value: string): value is ThemeKind {
  return (THEME_KINDS as readonly string[]).includes(value);
}

const PALETTES: Readonly<Record<ThemeKind, Readonly<Record<string, string>>>> = {
  "vscode-dark": {
    "--vscode-editor-background": "#1e1e1e",
    "--vscode-editor-foreground": "#cccccc",
    "--vscode-panel-background": "#1e1e1e",
    "--vscode-panel-border": "#2b2b2b",
    "--vscode-list-hoverBackground": "#2a2d2e",
    "--vscode-list-activeSelectionBackground": "#094771",
    "--vscode-list-activeSelectionForeground": "#ffffff",
    "--vscode-focusBorder": "#007fd4",
  },
  "vscode-light": {
    "--vscode-editor-background": "#ffffff",
    "--vscode-editor-foreground": "#3b3b3b",
    "--vscode-panel-background": "#f3f3f3",
    "--vscode-panel-border": "#e5e5e5",
    "--vscode-list-hoverBackground": "#e8e8e8",
    "--vscode-list-activeSelectionBackground": "#0060c0",
    "--vscode-list-activeSelectionForeground": "#ffffff",
    "--vscode-focusBorder": "#005fb8",
  },
  "vscode-high-contrast": {
    "--vscode-editor-background": "#000000",
    "--vscode-editor-foreground": "#ffffff",
    "--vscode-panel-background": "#000000",
    "--vscode-panel-border": "#6fc3df",
    "--vscode-list-hoverBackground": "#1a1a1a",
    "--vscode-list-activeSelectionBackground": "#000000",
    "--vscode-list-activeSelectionForeground": "#ffffff",
    "--vscode-focusBorder": "#f38518",
    "--vscode-contrastActiveBorder": "#f38518",
  },
  "vscode-high-contrast-light": {
    "--vscode-editor-background": "#ffffff",
    "--vscode-editor-foreground": "#000000",
    "--vscode-panel-background": "#ffffff",
    "--vscode-panel-border": "#0f4a85",
    "--vscode-list-hoverBackground": "#e9e9e9",
    "--vscode-list-activeSelectionBackground": "#ffffff",
    "--vscode-list-activeSelectionForeground": "#000000",
    "--vscode-focusBorder": "#0f4a85",
    "--vscode-contrastActiveBorder": "#0f4a85",
  },
};

export function applyThemeKind(
  kind: ThemeKind,
  root: HTMLElement = document.documentElement,
  body: HTMLElement = document.body,
): void {
  for (const cls of THEME_KINDS) body.classList.remove(cls);
  body.classList.add(kind);
  body.setAttribute("data-vscode-theme-kind", kind);
  for (const [prop, value] of Object.entries(PALETTES[kind])) {
    root.style.setProperty(prop, value);
  }
}
