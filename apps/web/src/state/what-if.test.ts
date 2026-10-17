import { applyCommand } from "@archdrill/model";
import { afterEach, describe, expect, it } from "vitest";
import { useAttemptStore } from "./store";
import {
  findBreakingPoint,
  MAX_FACTOR,
  MIN_FACTOR,
  requestWhatIf,
  samePlace,
  useWhatIf,
} from "./what-if";
import { factorLabel } from "./what-if-compute";

afterEach(() => {
  useWhatIf.setState({ factor: 1, result: null, failed: false, breaking: null, searching: false });
});

describe("what-if traffic", () => {
  it("keeps the multiple within what a search can reach", () => {
    useWhatIf.getState().setFactor(1000);
    expect(useWhatIf.getState().factor).toBe(MAX_FACTOR);
    useWhatIf.getState().setFactor(0.01);
    expect(useWhatIf.getState().factor).toBe(MIN_FACTOR);
  });

  it("says when a what-if could not be simulated, instead of simulating forever", () => {
    const attempt = useAttemptStore.getState().attempt;

    requestWhatIf({
      kind: "simulate",
      attempt,
      scenarioId: "none",
      environmentId: "none",
      factor: 2,
    });

    expect(useWhatIf.getState()).toMatchObject({ failed: true, result: null });
  });

  it("always finishes a search for the breaking point", () => {
    findBreakingPoint();

    expect(useWhatIf.getState().searching).toBe(false);
    expect(useWhatIf.getState().breaking).not.toBeNull();
  });

  it("takes a layout-only edit for the same place, and any other edit for a new one", () => {
    const attempt = useAttemptStore.getState().attempt;
    const place = { attempt, scenarioId: "s", environmentId: "e" };
    const moved = { ...attempt, layout: { ...attempt.layout, visitors: { x: 999, y: 999 } } };
    const renamed = applyCommand(attempt, "updateComponent", {
      id: attempt.architecture.components[0]?.id ?? "",
      label: "Renamed",
    }).attempt;

    expect(samePlace(place, { ...place, attempt: moved })).toBe(true);
    expect(samePlace(place, { ...place, attempt: renamed })).toBe(false);
  });

  it("writes a multiple with as few digits as say it", () => {
    expect([0.25, 0.5, 1, 2.4, 3, 12.6].map(factorLabel)).toEqual([
      "×0.25",
      "×0.5",
      "×1",
      "×2.4",
      "×3",
      "×13",
    ]);
  });
});
