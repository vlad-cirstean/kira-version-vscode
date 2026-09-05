/**
 * P4 W4: the main-thread side of layout (§3.2 puts lane layout in a worker). Constructs
 * `layout.worker.ts`, tracks the request sequence and the `LayoutFrontier` between calls, and
 * exposes a promise-based `submit`. The worker itself is deliberately thin and stateless per
 * message (see its own doc comment); this file is where the state that makes incremental
 * layout possible actually lives, since `LayoutClient.submit`'s public signature hides the
 * frontier from its caller entirely — a page's layout resumes because *this* file threads the
 * previous response's frontier into the next request, not because the worker remembers it.
 *
 * **The direction of copying is the decision here.** `LayoutInput` carries `parentOffsets` and
 * `parentRows` — views over the *whole* `CommitStore`'s parent columns, absolute-indexed,
 * because the pass must see parents outside the new range to patch earlier edges. `submit`
 * never gives `postMessage` a transfer list for the outgoing request, so the default
 * structured-clone behaviour — copy, not detach — is what actually ships: transferring would
 * detach the store's own columns, and the store is what the row renderer reads on every frame.
 * The *response* (`worker.onmessage`, `layout.worker.ts`'s own `postMessage`) is transferred,
 * which is what §5.5 asks for and where the size actually is.
 *
 * Two consequences worth writing down before they are discovered (docs/plans/P4.md W4):
 * - `structuredClone` of a typed array clones its whole backing `ArrayBuffer`, not just the
 *   view's window. `CommitStore`'s columns are capacity-doubled, so the buffer behind a
 *   130k-slot `parentRows` view may be 256k slots — acceptable (W15 measures it; it is a
 *   memcpy against a 400ms page budget) and not a reason to switch to a transfer.
 * - The worker's own store-side view is stale by construction between pages, which is fine:
 *   `layoutAppend`'s contract is that the input carries everything the pass reads.
 *
 * **The fallback, which V1 decided (docs/plans/P4c-linux-test-infra.md's Findings).** A module
 * `Worker` cannot be constructed at all from a `--extensionDevelopmentPath` webview: its script
 * lives on the `vscode-resource.vscode-cdn.net` virtual host, a different origin than the
 * webview document's own `vscode-webview://` origin, and `new Worker()` across origins throws a
 * synchronous `SecurityError` — confirmed live, first time this ever ran a real webview (P4c).
 * Uncaught, that throw happens inside `createLayoutClient`'s default parameter, i.e. inside
 * `GraphViewModel`'s constructor, i.e. inside Vue's `setup()` — it aborted the whole app's mount,
 * not just layout. The fix: `submit` runs `layoutAppend` on the main thread instead, deferred one
 * macrotask per call so it never blocks the same turn that requested it. `createLayoutClient`'s
 * `workerFactory` parameter is what makes that a one-file change — every consumer above this file
 * is already written against a promise, unaffected either way.
 */
import { layoutAppend } from "@kira-version/core";
import type {
  LayoutChunk,
  LayoutFrontier,
  LayoutInput,
  LayoutRequest,
  LayoutResponse,
} from "@kira-version/core";

export interface LayoutClient {
  submit(input: LayoutInput): Promise<LayoutChunk>;
  /** Discards the tracked frontier and marks every not-yet-answered `submit()` stale — a
   *  refresh or a repo switch, where the next `submit()` must start a fresh pass at row 0
   *  rather than resume whatever the worker was mid-way through for a different repo. */
  reset(): void;
  dispose(): void;
}

/** The slice of a real `Worker` this file actually needs. Production gets a real `Worker`
 *  (`createRealWorker`); a unit test substitutes a fake that never touches a browser worker at
 *  all — see this file's own "Done when" in docs/plans/P4.md W4. */
export interface WorkerLike {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent<LayoutResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  terminate(): void;
}

/** Vite's own documented module-worker form: a literal `new URL(..., import.meta.url)`
 *  expression its static analysis recognizes and bundles as its own chunk. Kept in its own
 *  function, separate from the try/catch that calls it (`createWorker`, below) — the literal
 *  form has to stay exactly this shape for Vite to find it, so it may not be built up from a
 *  variable or wrapped in another call. */
function createRealWorker(): WorkerLike {
  return new Worker(new URL("./layout.worker.ts", import.meta.url), {
    type: "module",
  }) as unknown as WorkerLike;
}

/** The documented fallback above: runs `layoutAppend` on the main thread behind the same
 *  `WorkerLike` message-passing shape `layoutClient.ts` already drives everything through, so
 *  nothing above this file needs to know which one it got. `setTimeout` (not a microtask) is the
 *  deferral — matching a real worker's response, which always lands after at least one
 *  event-loop turn, and giving the browser a chance to paint a frame in between calls (this is
 *  what "never holds a frame" means for a fallback with no separate thread to hold it). */
function createMainThreadWorker(): WorkerLike {
  const worker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message) {
      const request = message as LayoutRequest;
      setTimeout(() => {
        const { chunk, frontier } = layoutAppend(request.input, request.frontier);
        const response: LayoutResponse = { sequence: request.sequence, chunk, frontier };
        worker.onmessage?.({ data: response } as MessageEvent<LayoutResponse>);
      }, 0);
    },
    terminate() {
      // Nothing to tear down — no thread, no pending browser-level handle.
    },
  };
  return worker;
}

/** `createLayoutClient`'s actual default: real worker when the webview will allow one,
 *  the main-thread fallback when it throws constructing it. */
function createWorker(): WorkerLike {
  try {
    return createRealWorker();
  } catch {
    return createMainThreadWorker();
  }
}

interface PendingSubmit {
  readonly resolve: (chunk: LayoutChunk) => void;
  readonly reject: (error: Error) => void;
}

/** What a `submit()` whose response arrived after an intervening `reset()` rejects with — the
 *  caller's promise settling (rather than hanging forever) is deliberate: a consumer that
 *  raced a repo switch against an in-flight layout request should see that request fail, not
 *  silently never resolve. */
export class LayoutClientStaleError extends Error {
  constructor(sequence: number) {
    super(`layoutClient: request ${sequence}'s response arrived after a reset() — dropped`);
    this.name = "LayoutClientStaleError";
  }
}

export function createLayoutClient(workerFactory: () => WorkerLike = createWorker): LayoutClient {
  const worker = workerFactory();
  const pending = new Map<number, PendingSubmit>();
  let nextSequence = 0;
  /** Any request whose `sequence` is strictly less than this was issued before the most recent
   *  `reset()` — its eventual response, however it turns out, must not be applied. */
  let staleBelow = 0;
  let frontier: LayoutFrontier | undefined;
  let disposed = false;

  function settleAllPending(error: Error): void {
    for (const [sequence, request] of pending) {
      request.reject(error);
      pending.delete(sequence);
    }
  }

  worker.onmessage = (event) => {
    const response = event.data;
    const request = pending.get(response.sequence);
    if (!request) return; // no longer tracked — a duplicate delivery, which never happens, or
    // a response for a sequence this client never submitted; either way, nothing to settle.
    pending.delete(response.sequence);
    if (response.sequence < staleBelow) {
      request.reject(new LayoutClientStaleError(response.sequence));
      return;
    }
    frontier = response.frontier;
    request.resolve(response.chunk);
  };

  worker.onerror = (event) => {
    settleAllPending(new Error(`layoutClient: worker error — ${event.message}`));
  };

  return {
    submit(input: LayoutInput): Promise<LayoutChunk> {
      if (disposed) {
        return Promise.reject(new Error("layoutClient: submit() called after dispose()"));
      }
      const sequence = nextSequence++;
      const request: LayoutRequest = { sequence, input, frontier };
      return new Promise((resolve, reject) => {
        pending.set(sequence, { resolve, reject });
        worker.postMessage(request); // no transfer list — see this file's own doc comment
      });
    },
    reset(): void {
      staleBelow = nextSequence;
      frontier = undefined;
    },
    dispose(): void {
      disposed = true;
      worker.onmessage = null;
      worker.onerror = null;
      settleAllPending(new Error("layoutClient: disposed with a submit() still pending"));
      worker.terminate();
    },
  };
}
