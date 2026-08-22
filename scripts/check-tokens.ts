#!/usr/bin/env bun
/**
 * B4 — no hardcoded colour in packages/ui (§6.1). Biome has no rule for this, so this
 * greps for hex literals, rgb()/hsl() calls, and named CSS colours outside theme/*.css,
 * the one place a colour literal is allowed (it's where the --kv-* fallback chains live).
 *
 * Crude and completely effective: the failure mode it prevents — a stray #1e1e1e that
 * looks right in dark and wrong in every other theme — is invisible in review and obvious
 * in a grep.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const UI_ROOT = join(import.meta.dir, "..", "packages", "ui", "src");
const EXEMPT_DIR = join(UI_ROOT, "theme");
const SCANNED_EXTENSIONS = [".css", ".vue", ".ts"];

const HEX_COLOR = /#[0-9a-fA-F]{3,8}\b/g;
const FUNCTIONAL_COLOR = /\b(?:rgb|rgba|hsl|hsla)\s*\(/g;

// A conservative subset of CSS named colours worth catching; deliberately not exhaustive —
// this is a grep, not a CSS parser, and false negatives here are cheaper than false positives
// on words like "background" or "border" that merely contain a colour-ish substring.
const NAMED_COLORS = [
  "red",
  "green",
  "blue",
  "yellow",
  "orange",
  "purple",
  "black",
  "white",
  "gray",
  "grey",
  "pink",
  "brown",
  "cyan",
  "magenta",
  "lime",
  "navy",
  "teal",
];
const NAMED_COLOR_PATTERN = new RegExp(
  `(?:color|background|border|fill|stroke)\\s*:\\s*(${NAMED_COLORS.join("|")})\\b`,
  "gi",
);

interface Violation {
  file: string;
  line: number;
  text: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      walk(full, out);
    } else if (SCANNED_EXTENSIONS.includes(entry.slice(entry.lastIndexOf(".")))) {
      out.push(full);
    }
  }
  return out;
}

function scanFile(path: string): Violation[] {
  const violations: Violation[] = [];
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
    for (const pattern of [HEX_COLOR, FUNCTIONAL_COLOR, NAMED_COLOR_PATTERN]) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) {
        violations.push({ file: path, line: index + 1, text: line.trim() });
        break;
      }
    }
  });
  return violations;
}

function main(): void {
  const files = walk(UI_ROOT).filter((f) => !f.startsWith(`${EXEMPT_DIR}/`) && f !== EXEMPT_DIR);
  const violations = files.flatMap(scanFile);

  if (violations.length === 0) {
    console.log(
      `check-tokens: no hardcoded colours found outside ${relative(process.cwd(), EXEMPT_DIR)}`,
    );
    return;
  }

  console.error(
    `check-tokens: found ${violations.length} hardcoded colour(s) outside theme/*.css:\n`,
  );
  for (const v of violations) {
    console.error(`  ${relative(process.cwd(), v.file)}:${v.line}: ${v.text}`);
  }
  process.exit(1);
}

main();
