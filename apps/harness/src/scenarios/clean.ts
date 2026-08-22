import type { Scenario } from "./types.ts";

export const clean: Scenario = {
  name: "clean",
  repoOpen: {
    repoId: "clean",
    toplevel: "/repos/clean",
    gitDir: "/repos/clean/.git",
    isBare: false,
  },
  commitCount: 42,
};
