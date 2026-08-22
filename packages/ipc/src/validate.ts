/**
 * Boundary validation. Per §3.5, a contract mismatch must fail loudly rather than
 * half-work — so this throws, it does not degrade.
 */
export const CONTRACT_VERSION = 1;

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
