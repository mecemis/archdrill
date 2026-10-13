import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { predictionKey, usePredictions } from "./predictions";

const key = predictionKey("s4", "cache-restart");

describe("usePredictions", () => {
  const stored = new Map<string, string>();
  beforeEach(() => {
    stored.clear();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => stored.set(k, v),
    });
    usePredictions.setState({ byTimeline: {} });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps answers until the timeline is revealed, and after", () => {
    const { answer, reveal } = usePredictions.getState();

    answer(key, "recovery", "minute");
    answer(key, "store-load", "busy");
    answer(key, "recovery", "seconds");
    expect(usePredictions.getState().byTimeline[key]).toEqual({
      answers: { recovery: "seconds", "store-load": "busy" },
      revealed: false,
    });

    reveal(key);
    expect(usePredictions.getState().byTimeline[key]?.revealed).toBe(true);
    expect(JSON.parse(stored.get("archdrill:predictions:url-shortener") ?? "{}")).toEqual(
      usePredictions.getState().byTimeline,
    );
  });

  it("starts over when the candidate predicts again", () => {
    const { answer, reveal, reset } = usePredictions.getState();
    answer(key, "recovery", "minute");
    reveal(key);

    reset(key);

    expect(usePredictions.getState().byTimeline[key]).toBeUndefined();
  });
});
