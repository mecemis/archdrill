import { CALIBRATION_TOLERANCE, type ReplayedRun, replayCalibration } from "@archdrill/engine";
import { describe, expect, it } from "vitest";
import { catalog, catalogIndex } from "../src/index";

/** A run as a reader would check it: what was measured, and what the engine gives. */
function shown({ run, engine, error }: ReplayedRun): string {
  const at = "clients" in run ? `${run.clients} clients` : `${run.rate}/s`;
  return `${at}: measured ${JSON.stringify({ ...run, beyondModel: undefined })}, engine ${JSON.stringify(engine)} (${Math.round(error * 100)}% off)`;
}

describe.each(catalog.calibrations.map((c) => [c.id, c] as const))(
  "calibration %s",
  (_id, calibration) => {
    const replayed = replayCalibration(calibration, catalogIndex);

    it(`reproduces every run within ${CALIBRATION_TOLERANCE * 100}%`, () => {
      const missed = replayed.filter((r) => !r.run.beyondModel && !r.within).map(shown);

      expect(missed).toEqual([]);
    });

    it("misses only the runs it says it misses", () => {
      const fit = replayed.filter((r) => r.run.beyondModel && r.within).map(shown);

      expect(fit).toEqual([]);
    });

    it("is cited by the calibrated size's throughput and latency", () => {
      const { kind, flavor, size } = calibration.component;
      const f = catalogIndex.flavor(kind, flavor);
      const uncited = (["capacityPerSec", "latencyMs"] as const).filter((field) => {
        const provenance = f?.sizes[size]?.provenance[field] ?? f?.provenance[field];
        const sources = !provenance
          ? []
          : "published" in provenance
            ? [provenance.published]
            : provenance.basis;
        return !sources.includes(calibration.source);
      });

      expect(uncited).toEqual([]);
    });
  },
);
