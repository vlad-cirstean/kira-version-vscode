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

export type TransportErrorCode =
  | "cancelled"
  | "contract-mismatch"
  | "transport-closed"
  | "handler-error";

export class TransportError extends Error {
  readonly code: TransportErrorCode;

  constructor(code: TransportErrorCode, message: string) {
    super(message);
    this.name = "TransportError";
    this.code = code;
  }
}

/**
 * Both hosts (VS Code postMessage, Electron ipcRenderer+MessagePort) and the harness's
 * mock bridge implement this. The UI's bridge client (`packages/ui/src/bridge/client.ts`,
 * P1+) depends only on this interface, never on a concrete transport.
 */
export interface Transport {
  request<K extends RequestKey>(
    method: K,
    params: ParamsOf<K>,
    signal?: AbortSignal,
  ): Promise<ResultOf<K>>;

  on<K extends EventKey>(method: K, handler: (payload: EventPayload<K>) => void): () => void;

  stream<K extends StreamKey>(
    method: K,
    params: StreamParamsOf<K>,
    onChunk: (chunk: StreamChunkOf<K>) => void,
    signal?: AbortSignal,
  ): Promise<void>;

  dispose(): void;
}
