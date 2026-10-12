import { cacheAsideAttempt } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { loadAttempt, saveAttempt } from "./persistence";

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => data.delete(key),
    setItem: (key, value) => data.set(key, value),
  };
}

describe("persistence", () => {
  it("round-trips an attempt", () => {
    const storage = memoryStorage();

    saveAttempt(cacheAsideAttempt(), storage);

    expect(loadAttempt("url-shortener", storage)).toEqual(cacheAsideAttempt());
  });

  it("ignores corrupt or foreign data instead of crashing", () => {
    const storage = memoryStorage();
    storage.setItem("archdrill:attempt:url-shortener", "{not json");

    expect(loadAttempt("url-shortener", storage)).toBeNull();
    expect(loadAttempt("other-problem", storage)).toBeNull();
  });

  it("works without storage", () => {
    expect(saveAttempt(cacheAsideAttempt(), undefined)).toBe(false);
    expect(loadAttempt("url-shortener", undefined)).toBeNull();
  });
});
