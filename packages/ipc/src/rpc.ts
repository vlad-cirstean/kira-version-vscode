/**
 * The one generic RPC endpoint (`docs/plans/P3.md`, W2). Everything above the literal
 * `postMessage` call lives here — request correlation, event dispatch, stream credits and
 * cancellation — so the two hosts (`webview.postMessage`, `ipcRenderer` + `MessagePort`) and
 * the harness's mock cannot diverge on semantics; each contributes only a ~ten-line
 * `MessageChannelLike` adapter.
 */
import type { BufferEncoding } from "./codec.ts";
import { decode, dedupeTransferList, encode } from "./codec.ts";
import type {
  EventKey,
  EventPayload,
  ParamsOf,
  RequestKey,
  ResultOf,
  StreamChunkOf,
  StreamKey,
  StreamParamsOf,
} from "./contract.ts";
import { type Transport, TransportError } from "./transport.ts";
import {
  assertContractShape,
  unwrapVersioned,
  type VersionedEnvelope,
  wrapVersioned,
} from "./validate.ts";

/** The one thing every transport (real or mock) implements: post a message, optionally with a
 *  transfer list, and be told about incoming ones. Everything above this — correlation,
 *  credits, cancellation — is `rpc.ts`'s job, not the channel's. `bufferEncoding` (D34,
 *  `docs/plans/P15.md`) is what this channel's `post`/`onMessage` can actually carry: `"native"`
 *  keeps every buffer as a real `ArrayBuffer`, transferred rather than cloned; `"base64"` is for
 *  a channel where nothing binary survives (VS Code's `WebviewView`, P15's W1 finding) — declared
 *  by the transport, never inferred, so getting it wrong is a config bug in one file rather than
 *  a webview that silently renders `{}`. */
export interface MessageChannelLike {
  readonly bufferEncoding: BufferEncoding;
  post(message: unknown, transfer?: readonly ArrayBuffer[]): void;
  onMessage(handler: (message: unknown) => void): () => void;
  close(): void;
}

/** An error that crossed the wire as data (§3.5): `code` and `message` always; `kind` is P1's
 *  `GitErrorKind` when the failure was a `GitError`, carried structurally since `ipc` cannot
 *  import `@kira-version/git`'s type. Raw stderr never crosses — see `toWireError` below. */
export interface WireError {
  readonly code: string;
  readonly message: string;
  readonly kind?: string;
}

export class RpcError extends Error {
  readonly code: string;
  readonly kind: string | undefined;

  constructor(wire: WireError) {
    super(wire.message);
    this.name = "RpcError";
    this.code = wire.code;
    this.kind = wire.kind;
  }
}

// ---------------------------------------------------------------------------------------
// The frame union. Every member crosses the wire wrapped by `wrapVersioned`.
// ---------------------------------------------------------------------------------------

type Frame =
  | {
      readonly t: "req";
      readonly id: number;
      readonly method: RequestKey;
      readonly params: unknown;
    }
  | { readonly t: "res"; readonly id: number; readonly ok: true; readonly result: unknown }
  | { readonly t: "res"; readonly id: number; readonly ok: false; readonly error: WireError }
  | { readonly t: "evt"; readonly method: EventKey; readonly payload: unknown }
  | {
      readonly t: "open";
      readonly id: number;
      readonly method: StreamKey;
      readonly params: unknown;
    }
  | { readonly t: "chunk"; readonly id: number; readonly seq: number; readonly chunk: unknown }
  | { readonly t: "end"; readonly id: number; readonly error?: WireError }
  | { readonly t: "credit"; readonly id: number; readonly n: number }
  | { readonly t: "cancel"; readonly id: number };

/** Streams open with this much credit already granted — enough that the server can keep one
 *  chunk moving while the previous one is still being processed, never so much that a slow
 *  consumer lets a 100k walk queue unbounded buffers into it (W2). */
const INITIAL_STREAM_CREDIT = 2;

function toWireError(error: unknown): WireError {
  if (error instanceof Error) {
    const kind = (error as { readonly kind?: unknown }).kind;
    return typeof kind === "string"
      ? { code: error.name, message: error.message, kind }
      : { code: error.name, message: error.message };
  }
  return { code: "Unknown", message: String(error) };
}

function post(channel: MessageChannelLike, frame: Frame): void {
  const envelope = wrapVersioned(frame);
  const { payload, transfer } = encode(envelope, channel.bufferEncoding);
  channel.post(payload, dedupeTransferList(transfer));
}

function receive(channel: MessageChannelLike, handleFrame: (frame: Frame) => void): () => void {
  return channel.onMessage((raw) => {
    const envelope = decode<VersionedEnvelope<Frame>>(raw, channel.bufferEncoding);
    handleFrame(unwrapVersioned(envelope));
  });
}

// ---------------------------------------------------------------------------------------
// A small counting semaphore — the credit gate a stream's `emit` waits on.
// ---------------------------------------------------------------------------------------

class CreditGate {
  #available = 0;
  #waiters: Array<() => void> = [];

  grant(n: number): void {
    this.#available += n;
    while (this.#available > 0 && this.#waiters.length > 0) {
      this.#available--;
      this.#waiters.shift()?.();
    }
  }

  acquire(): Promise<void> {
    if (this.#available > 0) {
      this.#available--;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.#waiters.push(resolve));
  }
}

// ---------------------------------------------------------------------------------------
// createRpcClient — the UI side of the endpoint. Implements P0's `Transport`.
// ---------------------------------------------------------------------------------------

interface PendingRequest {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: unknown) => void;
}

interface PendingStream {
  readonly method: StreamKey;
  readonly onChunk: (chunk: unknown) => void | Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  /** Chains chunk processing so out-of-order concurrent deliveries of `onMessage` (the
   *  transport may invoke it again before an `await onChunk(...)` above resolves) cannot call
   *  `onChunk` for two chunks concurrently — ordering is a contract callers rely on (W9). */
  queue: Promise<void>;
  done: boolean;
}

export function createRpcClient(channel: MessageChannelLike): Transport {
  let nextId = 1;
  const pendingRequests = new Map<number, PendingRequest>();
  const pendingStreams = new Map<number, PendingStream>();
  const openStreamIdByMethod = new Map<StreamKey, number>();
  const eventHandlers = new Map<EventKey, Set<(payload: unknown) => void>>();

  function finishStream(id: number): void {
    const entry = pendingStreams.get(id);
    if (!entry) return;
    entry.done = true;
    pendingStreams.delete(id);
    if (openStreamIdByMethod.get(entry.method) === id) openStreamIdByMethod.delete(entry.method);
  }

  function handleFrame(frame: Frame): void {
    switch (frame.t) {
      case "res": {
        const pending = pendingRequests.get(frame.id);
        if (!pending) return;
        pendingRequests.delete(frame.id);
        if (frame.ok) pending.resolve(frame.result);
        else pending.reject(new RpcError(frame.error));
        return;
      }
      case "evt": {
        assertContractShape("event", frame.method, frame.payload);
        for (const handler of eventHandlers.get(frame.method) ?? []) handler(frame.payload);
        return;
      }
      case "chunk": {
        const entry = pendingStreams.get(frame.id);
        if (!entry || entry.done) return;
        entry.queue = entry.queue.then(async () => {
          if (entry.done) return;
          await entry.onChunk(frame.chunk);
          if (entry.done) return;
          post(channel, { t: "credit", id: frame.id, n: 1 });
        });
        return;
      }
      case "end": {
        const entry = pendingStreams.get(frame.id);
        if (!entry || entry.done) return;
        entry.queue = entry.queue.then(() => {
          if (entry.done) return;
          finishStream(frame.id);
          if (frame.error) entry.reject(new RpcError(frame.error));
          else entry.resolve();
        });
        return;
      }
      // "req", "open", "credit" and "cancel" are client -> server only; a client never
      // receives them, and a stray one is a protocol bug worth failing loudly on.
      default:
        throw new TransportError(
          "contract-mismatch",
          `client received an unexpected frame '${frame.t}'`,
        );
    }
  }

  const unsubscribe = receive(channel, handleFrame);

  return {
    request<K extends RequestKey>(
      method: K,
      params: ParamsOf<K>,
      signal?: AbortSignal,
    ): Promise<ResultOf<K>> {
      if (signal?.aborted) {
        return Promise.reject(
          new TransportError("cancelled", `request '${method}' was already cancelled`),
        );
      }
      const id = nextId++;
      return new Promise<ResultOf<K>>((resolve, reject) => {
        pendingRequests.set(id, { resolve: resolve as (result: unknown) => void, reject });
        if (signal) {
          signal.addEventListener(
            "abort",
            () => {
              if (!pendingRequests.has(id)) return;
              pendingRequests.delete(id);
              post(channel, { t: "cancel", id });
              reject(new TransportError("cancelled", `request '${method}' was cancelled`));
            },
            { once: true },
          );
        }
        post(channel, { t: "req", id, method, params });
      });
    },

    on<K extends EventKey>(method: K, handler: (payload: EventPayload<K>) => void): () => void {
      let set = eventHandlers.get(method);
      if (!set) {
        set = new Set();
        eventHandlers.set(method, set);
      }
      const wrapped = handler as (payload: unknown) => void;
      set.add(wrapped);
      return () => set.delete(wrapped);
    },

    stream<K extends StreamKey>(
      method: K,
      params: StreamParamsOf<K>,
      onChunk: (chunk: StreamChunkOf<K>) => void,
      signal?: AbortSignal,
    ): Promise<void> {
      // Opening a second stream for the same method supersedes the first (W2) — the same
      // "superseded query is killed" rule §4.3 states for reads.
      const priorId = openStreamIdByMethod.get(method);
      if (priorId !== undefined) {
        const prior = pendingStreams.get(priorId);
        if (prior && !prior.done) {
          finishStream(priorId);
          post(channel, { t: "cancel", id: priorId });
          prior.resolve();
        }
      }

      if (signal?.aborted) {
        return Promise.reject(
          new TransportError("cancelled", `stream '${method}' was already cancelled`),
        );
      }

      const id = nextId++;
      return new Promise<void>((resolve, reject) => {
        const entry: PendingStream = {
          method,
          onChunk: onChunk as (chunk: unknown) => void | Promise<void>,
          resolve,
          reject,
          queue: Promise.resolve(),
          done: false,
        };
        pendingStreams.set(id, entry);
        openStreamIdByMethod.set(method, id);

        if (signal) {
          signal.addEventListener(
            "abort",
            () => {
              if (entry.done) return;
              finishStream(id);
              post(channel, { t: "cancel", id });
              resolve();
            },
            { once: true },
          );
        }

        post(channel, { t: "open", id, method, params });
        post(channel, { t: "credit", id, n: INITIAL_STREAM_CREDIT });
      });
    },

    dispose(): void {
      unsubscribe();
      for (const pending of pendingRequests.values()) {
        pending.reject(new TransportError("transport-closed", "the transport was disposed"));
      }
      pendingRequests.clear();
      for (const [id, entry] of pendingStreams) {
        if (!entry.done) {
          entry.done = true;
          entry.resolve();
        }
        pendingStreams.delete(id);
      }
      openStreamIdByMethod.clear();
      eventHandlers.clear();
      channel.close();
    },
  };
}

// ---------------------------------------------------------------------------------------
// createRpcServer — the host side of the endpoint.
// ---------------------------------------------------------------------------------------

export type RequestHandler<K extends RequestKey> = (
  params: ParamsOf<K>,
  ctx: { readonly signal: AbortSignal },
) => Promise<ResultOf<K>>;

export type StreamHandler<K extends StreamKey> = (
  params: StreamParamsOf<K>,
  ctx: {
    readonly signal: AbortSignal;
    /** Awaited by the handler: this is where the credit-based backpressure reaches back into
     *  whatever is producing chunks (W7 — P2's paused `git log`). */
    readonly emit: (chunk: StreamChunkOf<K>) => Promise<void>;
  },
) => Promise<void>;

export type ServerHandlers = {
  readonly requests: { readonly [K in RequestKey]: RequestHandler<K> };
  readonly streams: { readonly [K in StreamKey]: StreamHandler<K> };
};

export interface RpcServer {
  emit<K extends EventKey>(method: K, payload: EventPayload<K>): void;
  dispose(): void;
}

export function createRpcServer(channel: MessageChannelLike, handlers: ServerHandlers): RpcServer {
  const activeWork = new Map<number, AbortController>();
  const creditGates = new Map<number, CreditGate>();

  async function handleRequest(id: number, method: RequestKey, params: unknown): Promise<void> {
    const controller = new AbortController();
    activeWork.set(id, controller);
    try {
      assertContractShape("request", method, params);
      const handler = handlers.requests[method];
      const result = await handler(params as never, { signal: controller.signal });
      if (activeWork.delete(id)) post(channel, { t: "res", id, ok: true, result });
    } catch (error) {
      if (activeWork.delete(id))
        post(channel, { t: "res", id, ok: false, error: toWireError(error) });
    }
  }

  async function handleOpen(id: number, method: StreamKey, params: unknown): Promise<void> {
    const controller = new AbortController();
    activeWork.set(id, controller);
    const gate = new CreditGate();
    creditGates.set(id, gate);
    let seq = 0;

    async function emit(chunk: unknown): Promise<void> {
      if (controller.signal.aborted) return;
      await Promise.race([
        gate.acquire(),
        new Promise<void>((resolve) =>
          controller.signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
      ]);
      if (controller.signal.aborted) return;
      post(channel, { t: "chunk", id, seq, chunk });
      seq++;
    }

    try {
      assertContractShape("stream", method, params);
      const handler = handlers.streams[method];
      await handler(params as never, { signal: controller.signal, emit: emit as never });
      if (activeWork.delete(id)) {
        creditGates.delete(id);
        post(channel, { t: "end", id });
      }
    } catch (error) {
      if (activeWork.delete(id)) {
        creditGates.delete(id);
        if (controller.signal.aborted) post(channel, { t: "end", id });
        else post(channel, { t: "end", id, error: toWireError(error) });
      }
    }
  }

  function handleFrame(frame: Frame): void {
    switch (frame.t) {
      case "req":
        void handleRequest(frame.id, frame.method, frame.params);
        return;
      case "open":
        void handleOpen(frame.id, frame.method, frame.params);
        return;
      case "credit":
        creditGates.get(frame.id)?.grant(frame.n);
        return;
      case "cancel": {
        const controller = activeWork.get(frame.id);
        if (controller) {
          controller.abort();
          activeWork.delete(frame.id);
          creditGates.delete(frame.id);
        }
        return;
      }
      // "res", "evt", "chunk" and "end" are server -> client only.
      default:
        throw new TransportError(
          "contract-mismatch",
          `server received an unexpected frame '${frame.t}'`,
        );
    }
  }

  const unsubscribe = receive(channel, handleFrame);

  return {
    emit<K extends EventKey>(method: K, payload: EventPayload<K>): void {
      post(channel, { t: "evt", method, payload });
    },
    dispose(): void {
      unsubscribe();
      // Not by a timeout: a client that disappears without cancelling (a disposed webview)
      // is handled by aborting every controller this channel is still holding.
      for (const controller of activeWork.values()) controller.abort();
      activeWork.clear();
      creditGates.clear();
      channel.close();
    },
  };
}
