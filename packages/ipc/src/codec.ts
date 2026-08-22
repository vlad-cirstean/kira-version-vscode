/**
 * Encode/decode for messages crossing the transport boundary. `encode` walks the message
 * and collects every `ArrayBuffer` it finds into a transfer list, so a transport can hand
 * that list to `postMessage`'s second argument and have layout buffers (§5.3, §5.5)
 * transferred rather than structured-cloned. Retrofitting this after the UI assumed
 * structured clone would be a rewrite of the stream layer — so it exists from W4 even
 * though nothing produces real layout buffers yet.
 */
export interface EncodedMessage<T> {
  readonly payload: T;
  readonly transfer: readonly ArrayBuffer[];
}

export function encode<T>(message: T): EncodedMessage<T> {
  const transfer: ArrayBuffer[] = [];
  collectTransferables(message, transfer);
  return { payload: message, transfer };
}

export function decode<T>(payload: T): T {
  return payload;
}

function collectTransferables(value: unknown, out: ArrayBuffer[]): void {
  if (value instanceof ArrayBuffer) {
    out.push(value);
    return;
  }
  if (ArrayBuffer.isView(value)) {
    out.push(value.buffer as ArrayBuffer);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTransferables(item, out);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectTransferables(item, out);
  }
}
