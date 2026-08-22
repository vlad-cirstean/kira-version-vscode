import { authFailure } from "./authFailure.ts";
import { clean } from "./clean.ts";
import { conflicted } from "./conflicted.ts";
import { dirty } from "./dirty.ts";
import { hugeRepo } from "./hugeRepo.ts";
import type { Scenario } from "./types.ts";

const SCENARIOS: Readonly<Record<string, Scenario>> = {
  clean,
  dirty,
  conflicted,
  hugeRepo,
  authFailure,
};

export function loadScenario(name: string): Scenario {
  const scenario = SCENARIOS[name];
  if (!scenario) {
    throw new Error(`unknown scenario '${name}'; known: ${Object.keys(SCENARIOS).join(", ")}`);
  }
  return scenario;
}

export type { Scenario } from "./types.ts";
