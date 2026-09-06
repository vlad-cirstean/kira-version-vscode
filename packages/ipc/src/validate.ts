import type { EventKey, RequestKey, StreamKey } from "./contract.ts";

/**
 * Boundary validation. Per §3.5, a contract mismatch must fail loudly rather than
 * half-work — so this throws, it does not degrade.
 */
export const CONTRACT_VERSION = 12;

export class ContractVersionMismatchError extends Error {
  readonly received: number;

  constructor(received: number) {
    super(
      `ipc contract version mismatch: this build expects ${CONTRACT_VERSION}, received ${received}`,
    );
    this.name = "ContractVersionMismatchError";
    this.received = received;
  }
}

export function validateVersion(received: number): void {
  if (received !== CONTRACT_VERSION) {
    throw new ContractVersionMismatchError(received);
  }
}

export interface VersionedEnvelope<T> {
  readonly version: number;
  readonly body: T;
}

export function wrapVersioned<T>(body: T): VersionedEnvelope<T> {
  return { version: CONTRACT_VERSION, body };
}

export function unwrapVersioned<T>(envelope: VersionedEnvelope<T>): T {
  validateVersion(envelope.version);
  return envelope.body;
}

// ---------------------------------------------------------------------------------------
// assertContractShape — a per-key structural check on arrival.
// ---------------------------------------------------------------------------------------

/**
 * The complete method-name lists, mirroring `Contract`'s keys. TypeScript's own exhaustiveness
 * checking cannot reach across a wire, so these are the runtime half of the same guarantee — but
 * a plain `Set<RequestKey>` literal is only checked for *extra* keys, not missing ones (adding a
 * key to `Contract["requests"]` and forgetting it here compiles cleanly, and previously did:
 * `docs/plans/P8.md` W21 found all four `remote.*` requests and `remote.progress` missing from
 * these three sets, silently failing every `assertContractShape` call for them since W17 added
 * them to `Contract` (`RpcError: ipc contract shape error … unknown request method`) with nothing
 * short of an E2E test through the real codec ever exercising this path to catch it — `mockBridge`
 * calls its handlers directly, `repoService`'s own integration tests never round-trip through
 * `assertContractShape`). Built through a `Record<Key, true>` rather than an array literal so a
 * *missing* key is a compile error too — TypeScript's mapped-type checker requires every key of
 * `RequestKey`/`EventKey`/`StreamKey` to be present, which a bare array can never enforce.
 */
const REQUEST_KEY_MAP: Record<RequestKey, true> = {
  "app.init": true,
  "repo.list": true,
  "repo.pick": true,
  "repo.open": true,
  "repo.close": true,
  "graph.status": true,
  "graph.loadMore": true,
  "graph.refresh": true,
  "commit.detail": true,
  "commit.fileDiff": true,
  "editor.openDiff": true,
  "editor.goToFile": true,
  "clipboard.write": true,
  "refs.list": true,
  "status.get": true,
  "preflight.checkout": true,
  "preflight.revert": true,
  "op.run": true,
  "undo.peek": true,
  "undo.run": true,
  "editor.resolveConflict": true,
  "review.resolveBase": true,
  "review.open": true,
  "remote.pullPreflight": true,
  "remote.pushPreflight": true,
  "remote.run": true,
  "remote.cancel": true,
  "stash.list": true,
  "stash.show": true,
  "preflight.stashPop": true,
  "preflight.stashBranch": true,
  "preflight.reset": true,
  "preflight.cherryPick": true,
  "search.run": true,
};
const EVENT_KEY_MAP: Record<EventKey, true> = {
  "repo.changed": true,
  "settings.changed": true,
  "review.target": true,
  "remote.progress": true,
};
const STREAM_KEY_MAP: Record<StreamKey, true> = {
  "graph.stream": true,
};
const REQUEST_KEYS: ReadonlySet<RequestKey> = new Set(Object.keys(REQUEST_KEY_MAP) as RequestKey[]);
const EVENT_KEYS: ReadonlySet<EventKey> = new Set(Object.keys(EVENT_KEY_MAP) as EventKey[]);
const STREAM_KEYS: ReadonlySet<StreamKey> = new Set(Object.keys(STREAM_KEY_MAP) as StreamKey[]);

export type ContractChannel = "request" | "event" | "stream";

export class ContractShapeError extends Error {
  readonly channel: ContractChannel;
  readonly method: string;

  constructor(channel: ContractChannel, method: string, reason: string) {
    super(`ipc contract shape error on ${channel} '${method}': ${reason}`);
    this.name = "ContractShapeError";
    this.channel = channel;
    this.method = method;
  }
}

function keysForChannel(channel: ContractChannel): ReadonlySet<string> {
  switch (channel) {
    case "request":
      return REQUEST_KEYS;
    case "event":
      return EVENT_KEYS;
    case "stream":
      return STREAM_KEYS;
  }
}

/**
 * A per-key structural check on arrival, not a schema library: the wire is trusted-but-
 * versioned between two halves of one build (§3.5). `validateVersion` rules out a stale build
 * talking to a fresh one; this rules out the one thing a version number alone cannot catch — a
 * method name or a `kind` discriminant that could not have come from this contract at all.
 * It does not re-validate every field, since a single build's own type-checker already
 * guarantees that; it exists for the boundary between two different builds.
 */
export function assertContractShape(
  channel: ContractChannel,
  method: string,
  payload: unknown,
): void {
  if (!keysForChannel(channel).has(method)) {
    throw new ContractShapeError(channel, method, `unknown ${channel} method`);
  }
  if (payload === null || typeof payload !== "object") {
    throw new ContractShapeError(channel, method, "payload is not an object");
  }
  const record = payload as Record<string, unknown>;
  if ("kind" in record && typeof record.kind !== "string") {
    throw new ContractShapeError(channel, method, "'kind' discriminant is not a string");
  }
}
