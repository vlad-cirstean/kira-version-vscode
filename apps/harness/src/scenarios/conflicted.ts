import type { Scenario } from "./types.ts";

/** Stub — see dirty.ts. Fills in once conflict prediction/resolution UI exists. */
export const conflicted: Scenario = new Proxy({} as Scenario, {
  get(): never {
    throw new Error("scenario 'conflicted' is not implemented yet — it is a P0 stub.");
  },
});
