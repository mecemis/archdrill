import { describe, expect, it } from "vitest";
import { applicableParams, batchable, paramsUpdate } from "./StepParams";

describe("step parameters", () => {
  it("lets a request batch a publish only when it does not wait for it", () => {
    expect(batchable("queue.publish", {}, false)).toBe(false);
    expect(batchable("queue.publish", { fireAndForget: true }, false)).toBe(true);
    expect(batchable("store.insert", {}, true)).toBe(true);
    expect(batchable("ids.allocate", {}, false)).toBe(true);
  });

  it("keeps only what applies to the action and the kind of flow", () => {
    const values = {
      ttlSec: 60,
      aggregateSec: 10,
      batchSize: 100,
      bufferSize: 1000,
      counterShards: 1,
    };

    // A request cannot aggregate, and a buffer needs fire-and-forget.
    expect(applicableParams("counter.increment", values, false)).toEqual({});
    expect(applicableParams("counter.increment", values, true)).toEqual({
      aggregateSec: 10,
      batchSize: 100,
    });
    expect(applicableParams("queue.publish", { ...values, fireAndForget: true }, false)).toEqual({
      fireAndForget: true,
      bufferSize: 1000,
      batchSize: 100,
    });
  });

  it("removes parameters that no longer apply", () => {
    const update = paramsUpdate("queue.publish", { batchSize: 100, bufferSize: 10 }, false);

    expect(update).toEqual({
      each: null,
      outbox: null,
      fireAndForget: null,
      bufferSize: null,
      batchSize: null,
    });
  });
});
