import { describe, expect, test } from "bun:test";
import { coerceSettings, defaultSettings, SETTINGS, toVsCodeConfiguration } from "./schema.ts";

describe("defaultSettings", () => {
  test("returns every SETTINGS key at its declared default", () => {
    const settings = defaultSettings();
    for (const key of Object.keys(SETTINGS) as (keyof typeof SETTINGS)[]) {
      expect(settings[key]).toEqual(SETTINGS[key].default);
    }
  });
});

describe("coerceSettings", () => {
  test("an empty object coerces to the defaults with no problems", () => {
    const result = coerceSettings({});
    expect(result.settings).toEqual(defaultSettings());
    expect(result.problems).toEqual([]);
  });

  test("accepts a valid value for every type: string, ranged number, enum, and stringArray", () => {
    const result = coerceSettings({
      "kiraVersion.git.path": "/usr/bin/git",
      "kiraVersion.graph.pageSize": 1000,
      "kiraVersion.graph.scope": "head",
      "kiraVersion.review.baseCandidates": ["trunk", "develop"],
    });
    expect(result.problems).toEqual([]);
    expect(result.settings["kiraVersion.git.path"]).toBe("/usr/bin/git");
    expect(result.settings["kiraVersion.graph.pageSize"]).toBe(1000);
    expect(result.settings["kiraVersion.graph.scope"]).toBe("head");
    expect(result.settings["kiraVersion.review.baseCandidates"]).toEqual(["trunk", "develop"]);
  });

  test("stringArray: a non-array value falls back to the default and is reported", () => {
    const result = coerceSettings({ "kiraVersion.review.baseCandidates": "main" });
    expect(result.settings["kiraVersion.review.baseCandidates"]).toEqual(
      SETTINGS["kiraVersion.review.baseCandidates"].default,
    );
    expect(result.problems).toEqual([
      { key: "kiraVersion.review.baseCandidates", reason: "wrong type" },
    ]);
  });

  test("stringArray: one non-string member rejects the WHOLE array, never partly", () => {
    const result = coerceSettings({
      "kiraVersion.review.baseCandidates": ["main", 42, "master"],
    });
    expect(result.settings["kiraVersion.review.baseCandidates"]).toEqual(
      SETTINGS["kiraVersion.review.baseCandidates"].default,
    );
    expect(result.problems).toEqual([
      { key: "kiraVersion.review.baseCandidates", reason: "wrong type" },
    ]);
  });

  test("stringArray: an empty array is a valid value, not an error", () => {
    const result = coerceSettings({ "kiraVersion.review.baseCandidates": [] });
    expect(result.settings["kiraVersion.review.baseCandidates"]).toEqual([]);
    expect(result.problems).toEqual([]);
  });

  test("a wrong type falls back to the default and is reported", () => {
    const result = coerceSettings({ "kiraVersion.graph.pageSize": "lots" });
    expect(result.settings["kiraVersion.graph.pageSize"]).toBe(
      SETTINGS["kiraVersion.graph.pageSize"].default,
    );
    expect(result.problems).toEqual([{ key: "kiraVersion.graph.pageSize", reason: "wrong type" }]);
  });

  test("an out-of-range number falls back to the default and is reported", () => {
    const tooLow = coerceSettings({ "kiraVersion.graph.pageSize": 1 });
    expect(tooLow.settings["kiraVersion.graph.pageSize"]).toBe(
      SETTINGS["kiraVersion.graph.pageSize"].default,
    );
    expect(tooLow.problems).toEqual([
      { key: "kiraVersion.graph.pageSize", reason: "out of range" },
    ]);

    const tooHigh = coerceSettings({ "kiraVersion.graph.pageSize": 1_000_000 });
    expect(tooHigh.problems).toEqual([
      { key: "kiraVersion.graph.pageSize", reason: "out of range" },
    ]);
  });

  test("an unknown enum member falls back to the default and is reported", () => {
    const result = coerceSettings({ "kiraVersion.graph.scope": "everything" });
    expect(result.settings["kiraVersion.graph.scope"]).toBe(
      SETTINGS["kiraVersion.graph.scope"].default,
    );
    expect(result.problems).toEqual([
      { key: "kiraVersion.graph.scope", reason: "unknown enum member" },
    ]);
  });

  test("an unknown key falls back to defaults for everything and is reported, without touching known keys", () => {
    const result = coerceSettings({
      "kiraVersion.nonsense": true,
      "kiraVersion.log.level": "debug",
    });
    expect(result.settings).toEqual({ ...defaultSettings(), "kiraVersion.log.level": "debug" });
    expect(result.problems).toEqual([{ key: "kiraVersion.nonsense", reason: "unknown key" }]);
  });

  test("never throws on a hostile input shape", () => {
    expect(() =>
      coerceSettings({
        "kiraVersion.git.path": 42,
        "kiraVersion.graph.pageSize": null,
        "kiraVersion.log.level": {},
      }),
    ).not.toThrow();
  });
});

describe("toVsCodeConfiguration", () => {
  test("has one property per setting, with description, default and enum intact", () => {
    const { properties } = toVsCodeConfiguration();

    const pageSize = properties["kiraVersion.graph.pageSize"] as Record<string, unknown>;
    expect(pageSize).toEqual({
      type: "number",
      default: 5000,
      description: SETTINGS["kiraVersion.graph.pageSize"].description,
      minimum: 100,
      maximum: 50000,
    });

    const scope = properties["kiraVersion.graph.scope"] as Record<string, unknown>;
    expect(scope).toEqual({
      type: "string",
      default: "all",
      description: SETTINGS["kiraVersion.graph.scope"].description,
      enum: ["all", "head"],
    });

    const gitPath = properties["kiraVersion.git.path"] as Record<string, unknown>;
    expect(gitPath).toEqual({
      type: "string",
      default: "",
      description: SETTINGS["kiraVersion.git.path"].description,
    });

    const baseCandidates = properties["kiraVersion.review.baseCandidates"] as Record<
      string,
      unknown
    >;
    expect(baseCandidates).toEqual({
      type: "array",
      items: { type: "string" },
      default: ["main", "master"],
      description: SETTINGS["kiraVersion.review.baseCandidates"].description,
    });
  });
});
