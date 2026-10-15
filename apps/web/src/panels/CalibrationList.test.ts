import { describe, expect, it } from "vitest";
import { benchmarkLatency, figures, runLabel } from "./CalibrationList";

describe("calibration runs as a reader sees them", () => {
  it("names the load: clients waiting on replies, or a rate sent", () => {
    expect(runLabel({ clients: 1, latencyMs: 1.6 })).toBe("1 client");
    expect(runLabel({ clients: 5200, throughput: 349239 })).toBe("5,200 clients");
    expect(runLabel({ rate: 142000, p50Ms: 0.44 })).toBe("142K/s sent");
  });

  it("keeps two decimals below a millisecond, where benchmark latencies live", () => {
    expect(benchmarkLatency(0.73)).toBe("0.73 ms");
    expect(benchmarkLatency(1.74)).toBe("1.7 ms");
    expect(benchmarkLatency(22.66)).toBe("23 ms");
  });

  it("shows only the figures a run measured, one per line", () => {
    expect(figures({ throughput: 5447, latencyMs: 0.73 })).toEqual(["5.4K/s", "0.73 ms"]);
    expect(figures({ throughput: 395819 })).toEqual(["396K/s"]);
    expect(figures({ p50Ms: 0.4175 })).toEqual(["p50 0.42 ms"]);
  });
});
