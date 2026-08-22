import type { Transport } from "@kira-version/ipc";
import { shallowRef } from "vue";

export type ConnectionState = "connecting" | "connected" | "error";

/**
 * Thin wrapper the UI reads connection state from. P0 keeps this minimal — a real health
 * check (e.g. an initial `repo.open` round-trip) is P1+ behaviour; here it exists so the
 * placeholder shell has something real to display and W8's Playwright suite something real
 * to assert on.
 */
export class BridgeClient {
  readonly connectionState = shallowRef<ConnectionState>("connecting");

  readonly #transport: Transport;

  constructor(transport: Transport) {
    this.#transport = transport;
    this.connectionState.value = "connected";
  }

  get transport(): Transport {
    return this.#transport;
  }

  dispose(): void {
    this.connectionState.value = "connecting";
    this.#transport.dispose();
  }
}
