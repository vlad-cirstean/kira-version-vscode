import type { Scenario } from "./types.ts";

/**
 * Stub: this scenario has no behaviour to show until the phase that models a dirty
 * working tree lands. Fails loudly if selected rather than rendering something misleading
 * (§3.5's "fail loudly rather than half-work", applied to dev scaffolding too).
 */
export const dirty: Scenario = new Proxy({} as Scenario, {
  get(): never {
    throw new Error("scenario 'dirty' is not implemented yet — it is a P0 stub.");
  },
});
