import { cacheAsideAttempt } from "@archdrill/model/testing";
import { describe, expect, it } from "vitest";
import { createAttemptStore, starterAttempt } from "./attempt-store";
import { useToasts } from "./toasts";

describe("attempt store", () => {
  it("starts new attempts with a client", () => {
    expect(starterAttempt("url-shortener", 1).architecture.components.map((c) => c.id)).toEqual([
      "visitors",
    ]);
  });

  it("applies commands and undoes and redoes them", () => {
    const store = createAttemptStore(cacheAsideAttempt());

    store.getState().dispatch("updateComponent", { id: "api", replicas: 5 });
    store.getState().undo();
    const afterUndo = store
      .getState()
      .attempt.architecture.components.find((c) => c.id === "api")?.replicas;
    store.getState().redo();
    const afterRedo = store
      .getState()
      .attempt.architecture.components.find((c) => c.id === "api")?.replicas;

    expect(afterUndo).toBe(3);
    expect(afterRedo).toBe(5);
  });

  it("reports a rejected command and leaves the attempt untouched", () => {
    const store = createAttemptStore(cacheAsideAttempt());
    const before = store.getState().attempt;

    const result = store.getState().dispatch("addConnection", { from: "lb", to: "api" });

    expect(result).toBeUndefined();
    expect(store.getState().attempt).toBe(before);
    expect(useToasts.getState().toasts.at(-1)).toMatchObject({
      tone: "error",
      message: expect.stringContaining("already connected"),
    });
  });

  it("clears history when the attempt is replaced", () => {
    const store = createAttemptStore(cacheAsideAttempt());
    store.getState().dispatch("updateComponent", { id: "api", replicas: 5 });

    store.getState().replace(cacheAsideAttempt());

    expect(store.getState().past).toEqual([]);
  });
});
