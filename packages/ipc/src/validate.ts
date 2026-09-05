import type { EventKey, RequestKey, StreamKey } from "./contract.ts";

/**
 * Boundary validation. Per §3.5, a contract mismatch must fail loudly rather than
 * half-work — so this throws, it does not degrade.
 */
export const CONTRACT_VERSION = 4;

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

/** The complete method-name lists, mirroring `Contract`'s keys. TypeScript's own exhaustiveness
 *  checking cannot reach across a wire, so these are the runtime half of the same guarantee —
 *  `contract.test.ts` fails if a key here and a key in `Contract` ever drift apart. */
const REQUEST_KEYS: ReadonlySet<RequestKey> = new Set([
  "app.init",
  "repo.list",
  "repo.pick",
  "repo.open",
  "repo.close",
  "graph.status",
  "graph.loadMore",
  "graph.refresh",
  "commit.detail",
  "commit.fileDiff",
  "editor.openDiff",
  "editor.goToFile",
  "clipboard.write",
]);
const EVENT_KEYS: ReadonlySet<EventKey> = new Set(["repo.changed", "settings.changed"]);
const STREAM_KEYS: ReadonlySet<StreamKey> = new Set(["graph.stream"]);

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
