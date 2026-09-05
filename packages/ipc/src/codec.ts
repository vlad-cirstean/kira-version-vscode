/**
 * Encode/decode for messages crossing the transport boundary (D34/D35, `docs/plans/P15.md`).
 * A transport declares what its channel can carry (`"native"`: real `ArrayBuffer`s, structured
 * clone or an equivalent — every buffer collected into a transfer list); `"base64"`: nothing
 * binary survives, so every buffer is replaced with a tagged base64 string before the message
 * ever reaches the channel. `packages/host-vscode`'s `WebviewView` is the concrete reason the
 * second encoding exists (P15's W1 finding: a bare `ArrayBuffer` arrives as `{}`), but this file
 * has no opinion about which host wants which — that is `rpc.ts`'s `MessageChannelLike.
 * bufferEncoding` field, set once per transport.
 */
export type BufferEncoding = "native" | "base64";

/** The VS Code webview transport's declared encoding, shared by both bundles that must agree on
 *  it — `host-vscode/src/transport.ts` (extension host) and `src/webview/main.ts` (webview) are
 *  built into two separate bundles, so a mismatch here is not a type error, it is a webview that
 *  silently renders an empty graph (P15's W5). The value follows from W1's probe (Findings,
 *  `docs/plans/P15.md`): a real VS Code 1.136.1 `WebviewView` still does not carry a bare
 *  `ArrayBuffer` intact (P4c's finding, unchanged), so this is `"base64"`, not `"native"`. */
export const VSCODE_WEBVIEW_BUFFER_ENCODING: BufferEncoding = "base64";

/** A buffer that has been encoded for a transport that cannot carry bytes. `$buf` is what lets
 *  `decodeBuffers` find these again without a schema, walking the same shape `collectTransferables`
 *  already walks. `v`, when present, is the typed-array constructor name (`ArrayBuffer.isView`'s
 *  case) needed to reconstruct the exact view rather than a plain `ArrayBuffer` — absent for a
 *  bare `ArrayBuffer`, which is the only shape anything on today's contract actually sends. */
interface EncodedBuffer {
  readonly $buf: "b64";
  readonly d: string;
  readonly v?: string;
}

export interface EncodedMessage<T> {
  readonly payload: T;
  readonly transfer: readonly ArrayBuffer[];
}

// ---------------------------------------------------------------------------------------
// base64 — a platform builtin where present (measured at 0.49 ms for a 420 KB page), with a
// small feature-detected fallback. Detected once at module scope, not per call (W2).
// ---------------------------------------------------------------------------------------

// The lib this monorepo targets already declares `Uint8Array.prototype.toBase64` /
// `Uint8Array.fromBase64` (non-optional — TS assumes a runtime new enough to have them), but the
// actual runtime a bundle ships to might not: `hasNative*` is a real `typeof` probe, not a
// type-level assumption, so an older engine (or a webview's own JS runtime, which need not match
// the extension host's Bun/Node version) still gets the fallback.
const hasNativeToBase64 = typeof Uint8Array.prototype.toBase64 === "function";
const hasNativeFromBase64 = typeof Uint8Array.fromBase64 === "function";

/** `String.fromCharCode(...chunk)` in bounded chunks — spreading the whole array risks blowing
 *  the engine's call-stack/argument-count limit on a multi-hundred-KB buffer; 0x8000 is the
 *  conventional safe chunk size for this. */
const FALLBACK_CHUNK_SIZE = 0x8000;

function toBase64Fallback(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += FALLBACK_CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + FALLBACK_CHUNK_SIZE));
  }
  return btoa(binary);
}

function fromBase64Fallback(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  return hasNativeToBase64 ? bytes.toBase64() : toBase64Fallback(bytes);
}

function bytesFromBase64(data: string): Uint8Array {
  return hasNativeFromBase64 ? Uint8Array.fromBase64(data) : fromBase64Fallback(data);
}

// ---------------------------------------------------------------------------------------
// The traversal. Three walks of the same shape rule (ArrayBuffer -> ArrayBuffer.isView ->
// Array -> plain object) — collect (native), encode and decode (base64) — kept beside each
// other because they must agree (W2).
// ---------------------------------------------------------------------------------------

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

function encodeBuffers(value: unknown): unknown {
  if (value instanceof ArrayBuffer) {
    const encoded: EncodedBuffer = { $buf: "b64", d: bytesToBase64(new Uint8Array(value)) };
    return encoded;
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    const bytes = new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength);
    const encoded: EncodedBuffer = {
      $buf: "b64",
      d: bytesToBase64(bytes),
      v: (view as { constructor: { name: string } }).constructor.name,
    };
    return encoded;
  }
  if (Array.isArray(value)) return value.map(encodeBuffers);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, encodeBuffers(item)]),
    );
  }
  return value;
}

function isEncodedBuffer(value: unknown): value is EncodedBuffer {
  return (
    value !== null && typeof value === "object" && (value as { $buf?: unknown }).$buf === "b64"
  );
}

/** Typed-array views this contract could plausibly ever send (`PackedCommitChunk`'s own fields
 *  are `Uint32Array`s in memory before being packed into `ArrayBuffer`s — see
 *  `packages/core/src/store/commitStore.ts`) plus the couple of others a future field might
 *  reasonably use. Not every typed-array constructor JS has — an intentionally closed list, so
 *  an unrecognised tag is a loud error rather than a silent `eval`-shaped lookup. */
const VIEW_CONSTRUCTORS: Readonly<Record<string, new (buffer: ArrayBuffer) => ArrayBufferView>> = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  DataView,
};

function decodeBuffers(value: unknown): unknown {
  if (isEncodedBuffer(value)) {
    const bytes = bytesFromBase64(value.d);
    // A fresh, exactly-sized ArrayBuffer: `bytes` may be a view over a larger buffer (fallback
    // or native `fromBase64`'s own return shape are both undefined here), and `.buffer` handed
    // straight to a typed-array constructor would silently carry that extra length forward.
    const buffer = (bytes.buffer as ArrayBuffer).slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    );
    if (value.v === undefined) return buffer;
    const Ctor = VIEW_CONSTRUCTORS[value.v];
    if (!Ctor) {
      throw new Error(`codec: unknown typed-array kind '${value.v}' in an encoded buffer`);
    }
    return new Ctor(buffer);
  }
  if (Array.isArray(value)) return value.map(decodeBuffers);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, decodeBuffers(item)]),
    );
  }
  return value;
}

// ---------------------------------------------------------------------------------------
// The public codec. Defaulting `encoding` to `"native"` keeps every pre-P15 call
// (`encode(message)`, `decode(payload)`) byte-for-byte what it returned before this file grew
// a second encoding — W2's own "done when" condition.
// ---------------------------------------------------------------------------------------

export function encode<T>(
  message: T,
  encoding: BufferEncoding = "native",
): EncodedMessage<unknown> {
  if (encoding === "native") {
    const transfer: ArrayBuffer[] = [];
    collectTransferables(message, transfer);
    return { payload: message, transfer };
  }
  return { payload: encodeBuffers(message), transfer: [] };
}

export function decode<T>(payload: unknown, encoding: BufferEncoding = "native"): T {
  return (encoding === "native" ? payload : decodeBuffers(payload)) as T;
}

/**
 * Asserts every buffer in `transfer` appears exactly once. `postMessage` itself throws a
 * `DataCloneError` on a duplicate, but only after doing whatever other work preceded the call
 * (§5.5's "transfers, not clones" rule, W3) — this is the same assertion made loud and early
 * enough to name the offending code path in a stack trace. It never filters or dedupes; a
 * caller that produces the same buffer twice has a bug the packer should not paper over. Called
 * unconditionally by `rpc.ts`'s `post()` regardless of encoding — under `"base64"` `transfer` is
 * always empty by construction, so this is a no-op there, not a second branch to remember.
 */
export function dedupeTransferList(transfer: readonly ArrayBuffer[]): readonly ArrayBuffer[] {
  const seen = new Set<ArrayBuffer>();
  for (const buffer of transfer) {
    if (seen.has(buffer)) {
      throw new Error(
        "dedupeTransferList: the same ArrayBuffer appears twice in one transfer list",
      );
    }
    seen.add(buffer);
  }
  return transfer;
}
