import { InMemoryStore } from "@mastra/core/storage";
import { describe, expect, it } from "vitest";

import { sharedHelperMastra, sharedMastraFor } from "./shared-mastra.js";

describe("shared Mastra", () => {
  it("hands every helper agent the same instance, so runs do not leave Mastra instances behind", () => {
    expect(sharedHelperMastra()).toBe(sharedHelperMastra());
  });

  it("keeps one instance per storage", () => {
    const storageA = new InMemoryStore();
    const storageB = new InMemoryStore();
    expect(sharedMastraFor(storageA)).toBe(sharedMastraFor(storageA));
    expect(sharedMastraFor(storageA)).not.toBe(sharedMastraFor(storageB));
  });
});
