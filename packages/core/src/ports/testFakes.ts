/**
 * In-memory doubles for the six P3 ports, one per port, controllable enough for W6/W7's unit
 * tests to assert on calls and drive events without a real filesystem watcher, VS Code
 * `Memento`, or native dialog. Not exported from `index.ts`: this is test scaffolding, not
 * product surface — `packages/git/src/testFakes.ts`'s precedent.
 */

import type { Clipboard } from "./clipboard.ts";
import type { Dialogs, PickFolderOptions } from "./dialogs.ts";
import type { Disposable } from "./disposable.ts";
import type {
  DocumentRef,
  EditorCapabilities,
  EditorIntegration,
  VirtualDocumentSource,
} from "./editorIntegration.ts";
import type { FileWatchEvent, FileWatcher, FileWatchOptions } from "./fileWatcher.ts";
import type { Logger, LogLevel } from "./logger.ts";
import type { Storage, StorageScope } from "./storage.ts";
import type { Theme, ThemeKind } from "./theme.ts";
import type { RepoCandidate, WorkspaceRoots } from "./workspaceRoots.ts";

export class FakeFileWatcher implements FileWatcher {
  readonly calls: Array<{ readonly paths: readonly string[]; readonly opts: FileWatchOptions }> =
    [];
  readonly #listeners = new Set<(event: FileWatchEvent) => void>();

  watch(
    paths: readonly string[],
    opts: FileWatchOptions,
    onEvent: (event: FileWatchEvent) => void,
  ): Disposable {
    this.calls.push({ paths, opts });
    this.#listeners.add(onEvent);
    return { dispose: () => this.#listeners.delete(onEvent) };
  }

  /** Fires `event` to every still-subscribed listener — the test's stand-in for a real fs
   *  change. */
  emit(event: FileWatchEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }
}

export class FakeWorkspaceRoots implements WorkspaceRoots {
  #candidates: readonly RepoCandidate[];
  readonly #listeners = new Set<() => void>();

  constructor(candidates: readonly RepoCandidate[] = []) {
    this.#candidates = candidates;
  }

  list(): Promise<readonly RepoCandidate[]> {
    return Promise.resolve(this.#candidates);
  }

  onChanged(fn: () => void): Disposable {
    this.#listeners.add(fn);
    return { dispose: () => this.#listeners.delete(fn) };
  }

  /** Replaces the candidate list and notifies every subscriber, as a real `WorkspaceRoots`
   *  would on a workspace-folder change. */
  setCandidates(candidates: readonly RepoCandidate[]): void {
    this.#candidates = candidates;
    for (const listener of this.#listeners) listener();
  }
}

export class FakeStorage implements Storage {
  readonly #scopes: Record<StorageScope, Map<string, unknown>> = {
    global: new Map(),
    workspace: new Map(),
  };

  get<T>(scope: StorageScope, key: string): T | undefined {
    return this.#scopes[scope].get(key) as T | undefined;
  }

  set(scope: StorageScope, key: string, value: unknown): Promise<void> {
    this.#scopes[scope].set(key, value);
    return Promise.resolve();
  }
}

export interface FakeLoggedEntry {
  readonly scope: string;
  readonly level: Exclude<LogLevel, "off">;
  readonly message: string;
  readonly data: unknown;
}

export class FakeLogger implements Logger {
  readonly entries: FakeLoggedEntry[];
  readonly #scope: string;

  constructor(scope = "", entries: FakeLoggedEntry[] = []) {
    this.#scope = scope;
    this.entries = entries;
  }

  log(level: Exclude<LogLevel, "off">, message: string, data?: unknown): void {
    this.entries.push({ scope: this.#scope, level, message, data });
  }

  /** Shares this logger's `entries` array, so a test can assert on everything logged by a
   *  child (or grandchild) from the root fake it created. */
  child(scope: string): Logger {
    const qualified = this.#scope.length > 0 ? `${this.#scope}.${scope}` : scope;
    return new FakeLogger(qualified, this.entries);
  }
}

export class FakeTheme implements Theme {
  #kind: ThemeKind;
  readonly #listeners = new Set<(kind: ThemeKind) => void>();

  constructor(initial: ThemeKind = "light") {
    this.#kind = initial;
  }

  current(): ThemeKind {
    return this.#kind;
  }

  onChanged(fn: (kind: ThemeKind) => void): Disposable {
    this.#listeners.add(fn);
    return { dispose: () => this.#listeners.delete(fn) };
  }

  /** Changes the resolved theme and notifies every subscriber. */
  setKind(kind: ThemeKind): void {
    this.#kind = kind;
    for (const listener of this.#listeners) listener(kind);
  }
}

export class FakeDialogs implements Dialogs {
  readonly calls: PickFolderOptions[] = [];
  /** Consumed in order by `pickFolder`; `null` (the default when empty) mirrors a user
   *  dismissing the dialog. */
  queuedResults: (string | null)[] = [];

  pickFolder(opts: PickFolderOptions): Promise<string | null> {
    this.calls.push(opts);
    return Promise.resolve(this.queuedResults.shift() ?? null);
  }
}

export class FakeClipboard implements Clipboard {
  readonly writes: string[] = [];
  /** Set to make the next `writeText` (and every one after, until reset to `undefined`) reject
   *  — a rejected clipboard write must propagate (P5, §6.4), and this is what a test drives. */
  rejectWith: Error | undefined;

  async writeText(text: string): Promise<void> {
    if (this.rejectWith) throw this.rejectWith;
    this.writes.push(text);
  }
}

export interface FakeEditorAction {
  readonly kind: "openDiff" | "reveal" | "resolveConflict";
  readonly left?: DocumentRef;
  readonly right?: DocumentRef;
  readonly title?: string;
  readonly ref?: DocumentRef;
  readonly line?: number;
  readonly path?: string;
}

export class FakeEditorIntegration implements EditorIntegration {
  capabilities: EditorCapabilities;
  readonly actions: FakeEditorAction[] = [];
  #source: VirtualDocumentSource | undefined;

  constructor(
    capabilities: EditorCapabilities = {
      openInEditor: true,
      goToFile: true,
      resolveConflict: true,
    },
  ) {
    this.capabilities = capabilities;
  }

  registerVirtualDocuments(source: VirtualDocumentSource): Disposable {
    this.#source = source;
    return { dispose: () => (this.#source = undefined) };
  }

  async openDiff(req: { left: DocumentRef; right: DocumentRef; title: string }): Promise<void> {
    this.actions.push({ kind: "openDiff", ...req });
  }

  async reveal(ref: DocumentRef, line: number): Promise<void> {
    this.actions.push({ kind: "reveal", ref, line });
  }

  async resolveConflict(req: { readonly path: string }): Promise<void> {
    this.actions.push({ kind: "resolveConflict", path: req.path });
  }

  /** Drives the registered `VirtualDocumentSource` directly, for a test asserting on what the
   *  content provider would show without a real VS Code URI in the loop. */
  provide(key: string): Promise<string | undefined> {
    return this.#source?.provide(key) ?? Promise.resolve(undefined);
  }
}
