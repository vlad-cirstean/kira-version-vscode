/**
 * The getComputedStyle bridge for the one surface that cannot consume CSS variables: a
 * `<canvas>` needs real colour strings, not custom properties (§3.4, §5.3). This resolves
 * the --kv-* token layer once, caches it, and re-reads on theme change via a MutationObserver
 * on <body> — otherwise the graph would keep its old colours after a theme switch while
 * everything else re-cascaded for free.
 *
 * Implemented fully in P0, ahead of anything that paints to canvas, because it is easy to
 * get subtly wrong and P4 would otherwise write it in a hurry while also writing a renderer.
 */
const TOKEN_NAMES = [
  "--kv-app-bg",
  "--kv-app-fg",
  "--kv-panel-bg",
  "--kv-panel-border",
  "--kv-row-fg",
  "--kv-row-hover-bg",
  "--kv-row-selected-bg",
  "--kv-row-selected-fg",
  "--kv-focus-border",
  "--kv-graph-lane-0",
  "--kv-graph-lane-1",
  "--kv-graph-lane-2",
  "--kv-graph-lane-3",
  "--kv-graph-lane-4",
  "--kv-graph-lane-5",
  "--kv-graph-lane-6",
  "--kv-graph-lane-7",
  "--kv-diff-added-fg",
  "--kv-diff-modified-fg",
  "--kv-diff-deleted-fg",
  "--kv-mono-font-family",
] as const;

export type TokenName = (typeof TOKEN_NAMES)[number];
export type TokenMap = Readonly<Record<TokenName, string>>;

export type TokenChangeListener = (tokens: TokenMap) => void;

function readAll(target: HTMLElement): TokenMap {
  const computed = getComputedStyle(target);
  const result = {} as Record<TokenName, string>;
  for (const name of TOKEN_NAMES) {
    result[name] = computed.getPropertyValue(name).trim();
  }
  return result;
}

export class TokenReader {
  #target: HTMLElement;
  #cache: TokenMap;
  #observer: MutationObserver | undefined;
  #listeners = new Set<TokenChangeListener>();

  constructor(target: HTMLElement = document.documentElement) {
    this.#target = target;
    this.#cache = readAll(target);
  }

  /** Cached token values as of the last read or theme-change re-read. */
  get tokens(): TokenMap {
    return this.#cache;
  }

  /** Force a synchronous re-read, bypassing the cache. */
  refresh(): TokenMap {
    this.#cache = readAll(this.#target);
    return this.#cache;
  }

  onChange(listener: TokenChangeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Watches <body>'s class/style attributes, the surface VS Code mutates on theme switch. */
  watch(body: HTMLElement = document.body): void {
    if (this.#observer) return;
    this.#observer = new MutationObserver(() => {
      const next = this.refresh();
      for (const listener of this.#listeners) listener(next);
    });
    this.#observer.observe(body, { attributes: true, attributeFilter: ["class", "style"] });
  }

  dispose(): void {
    this.#observer?.disconnect();
    this.#observer = undefined;
    this.#listeners.clear();
  }
}
