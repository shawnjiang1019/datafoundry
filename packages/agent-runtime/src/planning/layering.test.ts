import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * planning/core is a pure library: it may import zod, node:crypto, and its own modules
 * (plus type-only imports). Runtime wiring — tools, gateways, models, protocol state —
 * lives outside core, so the planner stays testable offline and extractable later.
 */
const coreDir = fileURLToPath(new URL("./core", import.meta.url));
const ALLOWED_VALUE_IMPORTS = new Set(["zod", "node:crypto"]);

const sourceFiles = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (statSync(path).isDirectory()) return sourceFiles(path);
  return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
});

describe("planning/core layering", () => {
  it("imports only zod, node:crypto, and core-relative modules at runtime", () => {
    const violations: string[] = [];
    for (const file of sourceFiles(coreDir)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)";/gmsu)) {
        const [, typeOnly, specifier] = match as unknown as [string, string | undefined, string];
        if (typeOnly || ALLOWED_VALUE_IMPORTS.has(specifier)) continue;
        const inCore = specifier.startsWith(".") && !relative(coreDir, join(file, "..", specifier)).startsWith("..");
        if (!inCore) violations.push(`${relative(coreDir, file)} → ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
