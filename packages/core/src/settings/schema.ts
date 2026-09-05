/**
 * D25 — "One schema in `core`, generating `contributes.configuration` for VS Code at build time.
 * Defined at P3, before ~15 settings accrete in two places; a future host's own settings surface
 * would generate from the same schema rather than inventing a second one." `SETTINGS` below is
 * that one place; `scripts/gen-settings.ts` reads `toVsCodeConfiguration()` to keep
 * `packages/host-vscode/package.json` in step with it.
 *
 * The keys this file defines are exactly the keys P3 consumes — each later phase adds its own
 * with its own consumer; the schema's value is being the one place, not being complete on day
 * one.
 */
import { assert } from "../util/assert.ts";

/** Which shell mounted the UI bundle — a structural copy of `@kira-version/ipc`'s `HostKind`
 *  (ipc may not import core and core may not import ipc, per §3.1's B3; kept honest by
 *  `tests/unit/ipc/wireConformance.test.ts`, same as `SettingsSnapshot`/`HeadState`/
 *  `DecorationRef`). */
export type HostKind = "vscode" | "harness";

/** `docs/plans/P7.md` W7/D43: `"stringArray"` is the first array-valued setting type — added for
 *  `kiraVersion.review.baseCandidates` (§6.8) exclusively; nothing else in the schema needs it
 *  yet. */
export type SettingType = "string" | "number" | "boolean" | "enum" | "stringArray";

export interface SettingDef<T> {
  readonly key: string;
  readonly type: SettingType;
  readonly default: T;
  /** Becomes the VS Code setting description verbatim. */
  readonly description: string;
  readonly enum?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly scope?: "window" | "resource";
}

export const SETTINGS = {
  "kiraVersion.git.path": {
    key: "kiraVersion.git.path",
    type: "string",
    default: "",
    description:
      "Path to the git executable. Empty uses the host's own discovery (VS Code's " +
      "git.path setting, then PATH) — see §4.2.",
  },
  "kiraVersion.graph.pageSize": {
    key: "kiraVersion.graph.pageSize",
    type: "number",
    default: 5000,
    description: "How many commits a single Load more page fetches.",
    minimum: 100,
    maximum: 50000,
  },
  "kiraVersion.graph.scope": {
    key: "kiraVersion.graph.scope",
    type: "enum",
    default: "all",
    description: 'Whether the graph shows every ref ("all") or only the current HEAD\'s ancestry.',
    enum: ["all", "head"],
  },
  "kiraVersion.log.level": {
    key: "kiraVersion.log.level",
    type: "enum",
    default: "info",
    description: "Verbosity of kira-version's own diagnostic log.",
    enum: ["off", "error", "warn", "info", "debug"],
  },
  "kiraVersion.review.baseCandidates": {
    key: "kiraVersion.review.baseCandidates",
    type: "stringArray",
    default: ["main", "master"],
    description:
      "Branch review (§6.8): candidate base branches to compare against, in order, tried " +
      "after the branch's own upstream and the repository's detected default branch " +
      "(origin/HEAD) both fail to resolve.",
  },
} as const satisfies Record<string, SettingDef<unknown>>;

export type SettingKey = keyof typeof SETTINGS;

const SETTING_KEYS = Object.keys(SETTINGS) as readonly SettingKey[];

/** The set of legal values for a def, derived from its `type`/`enum` rather than its `default` —
 *  `default`'s own literal type (e.g. exactly `5000`) is one legal value, not the type. */
type ValueOfDef<D extends SettingDef<unknown>> = D["type"] extends "string"
  ? string
  : D["type"] extends "boolean"
    ? boolean
    : D["type"] extends "number"
      ? number
      : D["type"] extends "stringArray"
        ? readonly string[]
        : D["enum"] extends readonly (infer E)[]
          ? E
          : never;

export type SettingValue<K extends SettingKey> = ValueOfDef<(typeof SETTINGS)[K]>;

export type Settings = { readonly [K in SettingKey]: SettingValue<K> };

function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(SETTINGS, key);
}

/** The canonical default for every key, straight from `SETTINGS` — the single cast below just
 *  restates what `SETTINGS`'s own `satisfies` clause already guarantees element-by-element. */
export function defaultSettings(): Settings {
  // `as unknown as Settings`: once a `stringArray` key's value type is a literal array tuple
  // (`readonly ["main", "master"]`), TypeScript's "sufficient overlap" check on a direct `as
  // Settings` no longer holds against `Object.fromEntries`'s inferred `{[k: string]: ...}`
  // shape, even though every member is in fact assignable — the same guarantee `SETTINGS`'s own
  // `satisfies` clause already establishes element-by-element.
  return Object.fromEntries(
    SETTING_KEYS.map((key) => [key, SETTINGS[key].default]),
  ) as unknown as Settings;
}

export interface CoerceProblem {
  readonly key: string;
  readonly reason: "unknown key" | "wrong type" | "out of range" | "unknown enum member";
}

export interface CoerceResult {
  readonly settings: Settings;
  readonly problems: readonly CoerceProblem[];
}

type CoerceOne =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: CoerceProblem["reason"] };

function coerceOne(def: SettingDef<unknown>, value: unknown): CoerceOne {
  switch (def.type) {
    case "string":
      return typeof value === "string" ? { ok: true, value } : { ok: false, reason: "wrong type" };
    case "boolean":
      return typeof value === "boolean" ? { ok: true, value } : { ok: false, reason: "wrong type" };
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, reason: "wrong type" };
      }
      if (def.minimum !== undefined && value < def.minimum)
        return { ok: false, reason: "out of range" };
      if (def.maximum !== undefined && value > def.maximum)
        return { ok: false, reason: "out of range" };
      return { ok: true, value };
    }
    case "enum": {
      if (typeof value !== "string") return { ok: false, reason: "wrong type" };
      const members: readonly string[] | undefined = def.enum;
      assert(members !== undefined, `SETTINGS[${def.key}]: type "enum" without an enum list`);
      if (!members.includes(value)) return { ok: false, reason: "unknown enum member" };
      return { ok: true, value };
    }
    case "stringArray": {
      // Never-partly-valid, exactly like every other type: one non-string member and the
      // WHOLE array falls back to the default, rather than silently dropping just that member.
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
        return { ok: false, reason: "wrong type" };
      }
      return { ok: true, value };
    }
  }
}

/**
 * Never throws and never returns a partly-valid object: a wrong type, an out-of-range number
 * or an unknown enum member falls back to that key's default and is reported in
 * `problems`, which the host logs. A user with `"pageSize": "lots"` in their settings.json gets
 * a working panel and a log line, not a dead one.
 */
export function coerceSettings(raw: Readonly<Record<string, unknown>>): CoerceResult {
  const settings = defaultSettings() as Record<string, unknown>;
  const problems: CoerceProblem[] = [];

  for (const rawKey of Object.keys(raw)) {
    if (!isSettingKey(rawKey)) {
      problems.push({ key: rawKey, reason: "unknown key" });
      continue;
    }
    const outcome = coerceOne(SETTINGS[rawKey], raw[rawKey]);
    if (outcome.ok) {
      settings[rawKey] = outcome.value;
    } else {
      problems.push({ key: rawKey, reason: outcome.reason });
    }
  }

  return { settings: settings as Settings, problems };
}

export interface VsCodeConfigurationSchema {
  readonly properties: Record<string, unknown>;
}

/** Drives `scripts/gen-settings.ts`: one JSON Schema property per setting. */
export function toVsCodeConfiguration(): VsCodeConfigurationSchema {
  const properties: Record<string, unknown> = {};

  for (const key of SETTING_KEYS) {
    const def: SettingDef<unknown> = SETTINGS[key];

    const property: Record<string, unknown> = {
      type: def.type === "enum" ? "string" : def.type === "stringArray" ? "array" : def.type,
      default: def.default,
      description: def.description,
    };
    if (def.type === "stringArray") property.items = { type: "string" };
    if (def.enum !== undefined) property.enum = def.enum;
    if (def.minimum !== undefined) property.minimum = def.minimum;
    if (def.maximum !== undefined) property.maximum = def.maximum;
    if (def.scope !== undefined) property.scope = def.scope;

    properties[key] = property;
  }

  return { properties };
}
