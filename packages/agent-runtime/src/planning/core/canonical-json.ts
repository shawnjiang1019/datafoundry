import { createHash } from "node:crypto";

/**
 * Canonical JSON for plan artifacts and executable-unit hashes: object keys sorted by
 * code unit, compact separators, no whitespace, and non-JSON values rejected instead of
 * silently coerced. Mirrors D-Trail's `json.dumps(sort_keys=True, separators=(",", ":"),
 * allow_nan=False)` so a hash names exactly one payload.
 */
export const canonicalJson = (value: unknown): string => serialize(value, "$");

export const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** SHA-256 of the canonical JSON encoding. */
export const canonicalHash = (value: unknown): string => sha256Hex(canonicalJson(value));

const serialize = (value: unknown, path: string): string => {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(`CANONICAL_JSON_NON_FINITE_NUMBER:${path}`);
      }
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new Error(`CANONICAL_JSON_UNSUPPORTED_VALUE:${path}:${typeof value}`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => serialize(item, `${path}[${index}]`)).join(",")}]`;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`CANONICAL_JSON_UNSUPPORTED_VALUE:${path}:${prototype?.constructor?.name ?? "object"}`);
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${serialize(entry, `${path}.${key}`)}`).join(",")}}`;
};
