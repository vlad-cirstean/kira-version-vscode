import type { Scenario } from "./types.ts";

/** Stub — see dirty.ts. Fills in once fetch/push auth-failure handling exists. */
export const authFailure: Scenario = new Proxy({} as Scenario, {
  get(): never {
    throw new Error("scenario 'authFailure' is not implemented yet — it is a P0 stub.");
  },
});
