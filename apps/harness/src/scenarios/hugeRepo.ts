import type { Scenario } from "./types.ts";

/** The ceiling test W9's perf harness measures against (§5.1). */
export const hugeRepo: Scenario = {
  name: "hugeRepo",
  repoOpen: {
    repoId: "huge",
    toplevel: "/repos/huge",
    gitDir: "/repos/huge/.git",
    isBare: false,
  },
  commitCount: 100_000,
};
