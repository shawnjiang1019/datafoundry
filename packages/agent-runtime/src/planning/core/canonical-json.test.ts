import { describe, expect, it } from "vitest";

import { canonicalHash, canonicalJson, sha256Hex } from "./canonical-json.js";

describe("canonicalJson", () => {
  it("sorts keys at every depth, keeps array order, and drops undefined fields", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: "x" }, skip: undefined }))
      .toBe('{"a":{"c":"x","d":[3,1]},"b":1}');
  });

  it("sorts keys by code unit, not locale", () => {
    expect(canonicalJson({ b: 1, B: 2, a: 3, _: 4 })).toBe('{"B":2,"_":4,"a":3,"b":1}');
  });

  it("keeps non-ASCII text unescaped", () => {
    expect(canonicalJson({ 名称: "销售额" })).toBe('{"名称":"销售额"}');
  });

  it("rejects values JSON cannot represent faithfully", () => {
    expect(() => canonicalJson({ x: Number.NaN })).toThrow("CANONICAL_JSON_NON_FINITE_NUMBER:$.x");
    expect(() => canonicalJson([Infinity])).toThrow("CANONICAL_JSON_NON_FINITE_NUMBER:$[0]");
    expect(() => canonicalJson({ at: new Date(0) })).toThrow("CANONICAL_JSON_UNSUPPORTED_VALUE:$.at:Date");
    expect(() => canonicalJson({ n: 1n })).toThrow("CANONICAL_JSON_UNSUPPORTED_VALUE:$.n:bigint");
  });

  it("hashes equal payloads identically regardless of key order (golden)", () => {
    const payload = { sql: "SELECT 1", dialect: "duckdb", limit: 100 };
    const reordered = { limit: 100, dialect: "duckdb", sql: "SELECT 1" };
    expect(canonicalHash(payload)).toBe(canonicalHash(reordered));
    expect(canonicalHash(payload)).toBe(sha256Hex('{"dialect":"duckdb","limit":100,"sql":"SELECT 1"}'));
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});
