import { describe, expect, it } from "vitest";
import { type Capability, canHandle, onlyServesObjects, type TriggerType } from "./capabilities";

const caps = (...list: Capability[]) => new Set(list);
const TRIGGERS: readonly TriggerType[] = ["request", "event", "schedule"];

describe("canHandle", () => {
  it("lets services run any flow, stream processors consume, and object storage answer requests", () => {
    const service = caps("stateless-compute");
    const processor = caps("stream-processing");
    const storage = caps("durable-store", "serves-objects");

    expect(TRIGGERS.map((t) => canHandle(service, t))).toEqual([true, true, true]);
    expect(TRIGGERS.map((t) => canHandle(processor, t))).toEqual([false, true, false]);
    expect(TRIGGERS.map((t) => canHandle(storage, t))).toEqual([true, false, false]);
    expect(canHandle(caps("durable-store"), "request")).toBe(false);
  });

  it("tells handlers that only serve objects from services", () => {
    expect(onlyServesObjects(caps("durable-store", "serves-objects"))).toBe(true);
    expect(onlyServesObjects(caps("stateless-compute", "serves-objects"))).toBe(false);
    expect(onlyServesObjects(caps("stateless-compute"))).toBe(false);
  });
});
