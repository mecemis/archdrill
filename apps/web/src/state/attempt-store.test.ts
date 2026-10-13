import { emptyAttempt } from "@archdrill/model";
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

  it("applies a batch as one undoable step", () => {
    const store = createAttemptStore(cacheAsideAttempt());
    const original = store.getState().attempt;

    const ok = store.getState().dispatchAll([
      { name: "moveComponent", args: { id: "api", position: { x: 1, y: 1 } } },
      { name: "moveComponent", args: { id: "db", position: { x: 2, y: 2 } } },
    ]);
    store.getState().undo();

    expect(ok).toBe(true);
    expect(store.getState().attempt).toEqual(original);
    expect(store.getState().past).toEqual([]);
  });

  it("rejects a whole batch when one command fails", () => {
    const store = createAttemptStore(cacheAsideAttempt());
    const before = store.getState().attempt;

    const ok = store.getState().dispatchAll([
      { name: "removeConnection", args: { id: "api--redis" } },
      { name: "removeConnection", args: { id: "does-not-exist" } },
    ]);

    expect(ok).toBe(false);
    expect(store.getState().attempt).toBe(before);
  });

  it("clears history when the attempt is replaced", () => {
    const store = createAttemptStore(cacheAsideAttempt());
    store.getState().dispatch("updateComponent", { id: "api", replicas: 5 });

    store.getState().replace(cacheAsideAttempt());

    expect(store.getState().past).toEqual([]);
  });

  it("can make a wholesale replacement one more undoable step", () => {
    const store = createAttemptStore(cacheAsideAttempt());
    const before = store.getState().attempt;

    store.getState().replace(emptyAttempt("url-shortener", 1), { undoable: true });
    expect(store.getState().attempt.architecture.components).toHaveLength(0);
    store.getState().undo();

    expect(store.getState().attempt).toEqual(before);
    expect(store.getState().lastChange).toBe("history");
  });
});
