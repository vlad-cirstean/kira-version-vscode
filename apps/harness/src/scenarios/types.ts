import type { ResultOf } from "@kira-version/ipc";

/** A named, deep-linkable state the harness can render (`?scenario=<name>`). */
export interface Scenario {
  readonly name: string;
  readonly repoOpen: ResultOf<"repo.open">;
  readonly commitCount: number;
}
