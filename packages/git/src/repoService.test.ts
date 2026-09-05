import { describe, expect, test } from "bun:test";
import { ByteCappedLru, CountCappedLru } from "./repoService.ts";

/**
 * The two LRU caches §5.5 calls for (P5 W3) — pure, synchronous, no git involved, so tested
 * directly here rather than only through a real repository in `tests/integration/`. The real
 * `RepoService.diffCache`/`detailCache` are exactly one of these each; `tests/integration/
 * repoService.test.ts` covers their wiring (keys, what gets cached, `refsChanged` clearing)
 * against a real repository.
 */

describe("ByteCappedLru", () => {
  test("evicts the least-recently-inserted entry once the total exceeds the cap", () => {
    const cache = new ByteCappedLru<string>(10);
    cache.set("a", "value-a", 4);
    cache.set("b", "value-b", 4); // 8 bytes total, under the 10-byte cap — no read of "a" yet
    cache.set("c", "value-c", 4); // 12 bytes total — over cap, evicts "a" (the oldest entry)
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("value-b");
    expect(cache.get("c")).toBe("value-c");
  });

  test("get() moves a key to the back, so it survives an eviction a less-recently-read key does not", () => {
    const cache = new ByteCappedLru<string>(10);
    cache.set("a", "value-a", 4);
    cache.set("b", "value-b", 4);
    expect(cache.get("a")).toBe("value-a"); // "a" is now the most-recently-used
    cache.set("c", "value-c", 4); // over cap: evicts "b" (now the least-recently-used), not "a"
    expect(cache.get("a")).toBe("value-a");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe("value-c");
  });

  test("re-setting an existing key updates its size accounting rather than double-counting it", () => {
    const cache = new ByteCappedLru<string>(10);
    cache.set("a", "small", 2);
    cache.set("a", "bigger", 8); // replaces, not adds — total is 8, not 10
    expect(cache.get("a")).toBe("bigger");
    cache.set("b", "value-b", 2); // 8 + 2 = 10: exactly at the cap, no eviction needed
    expect(cache.get("a")).toBe("bigger");
    expect(cache.get("b")).toBe("value-b");
  });

  test("a single entry whose own size exceeds the cap is not held (the cap always wins)", () => {
    const cache = new ByteCappedLru<string>(4);
    cache.set("a", "value-a", 4);
    expect(cache.get("a")).toBe("value-a");
    cache.set("b", "too-big", 10); // bigger than the cap on its own
    expect(cache.get("a")).toBeUndefined(); // evicted to make room, then still over cap
    expect(cache.get("b")).toBeUndefined(); // and "b" itself cannot fit either
  });

  test("a miss returns undefined without throwing", () => {
    const cache = new ByteCappedLru<string>(10);
    expect(cache.get("nope")).toBeUndefined();
  });
});

describe("CountCappedLru", () => {
  test("evicts the least-recently-inserted entry once entry count exceeds the cap", () => {
    const cache = new CountCappedLru<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3); // 3 entries, cap 2 — evicts "a"
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
  });

  test("get() moves a key to the back, so it survives an eviction a less-recently-read key does not", () => {
    const cache = new CountCappedLru<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1); // "a" is now the most-recently-used
    cache.set("c", 3); // evicts "b", not "a"
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe(3);
  });

  test("re-setting an existing key does not count twice against the entry cap", () => {
    const cache = new CountCappedLru<number>(2);
    cache.set("a", 1);
    cache.set("a", 100); // same key — still 1 entry
    cache.set("b", 2); // 2 entries, exactly at the cap
    expect(cache.get("a")).toBe(100);
    expect(cache.get("b")).toBe(2);
  });

  test("clear() empties the cache", () => {
    const cache = new CountCappedLru<number>(5);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.clear();
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeUndefined();
  });

  test("a miss returns undefined without throwing", () => {
    const cache = new CountCappedLru<number>(5);
    expect(cache.get("nope")).toBeUndefined();
  });
});
