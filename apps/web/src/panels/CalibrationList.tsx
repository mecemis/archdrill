import { CALIBRATION_TOLERANCE, type ReplayedRun, replayCalibration } from "@archdrill/engine";
import type { BenchmarkRun, Calibration } from "@archdrill/model";
import { catalogIndex } from "../state/content";
import { compact } from "../ui/format";
import { SourceLink } from "./SourceLink";

/** Benchmark latencies are often under a millisecond: keep two decimals there. */
export function benchmarkLatency(ms: number): string {
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
}

/** How a run loaded the servers: clients waiting on replies, or a fixed rate. */
export function runLabel(run: BenchmarkRun): string {
  if ("rate" in run) return `${compact(run.rate)}/s sent`;
  return `${run.clients.toLocaleString("en-US")} ${run.clients === 1 ? "client" : "clients"}`;
}

type Figures = {
  readonly throughput?: number;
  readonly latencyMs?: number;
  readonly p50Ms?: number;
};

/** The measurements a run recorded, or the engine's figures for the same ones, one per line. */
export function figures({ throughput, latencyMs, p50Ms }: Figures): readonly string[] {
  return [
    throughput !== undefined ? `${compact(throughput)}/s` : null,
    latencyMs !== undefined ? benchmarkLatency(latencyMs) : null,
    p50Ms !== undefined ? `p50 ${benchmarkLatency(p50Ms)}` : null,
  ].filter((line): line is string => line !== null);
}

function Lines({ lines }: { readonly lines: readonly string[] }) {
  return lines.map((line) => (
    <span key={line} className="block whitespace-nowrap">
      {line}
    </span>
  ));
}

// Replays are cheap but run once: the catalog does not change at runtime.
const replays = new Map<string, readonly ReplayedRun[]>();
function replayed(calibration: Calibration): readonly ReplayedRun[] {
  const known = replays.get(calibration.id);
  if (known) return known;
  const runs = replayCalibration(calibration, catalogIndex);
  replays.set(calibration.id, runs);
  return runs;
}

function Verdict({ replay }: { readonly replay: ReplayedRun }) {
  const off = `${Math.round(replay.error * 100)}% off`;
  if (replay.run.beyondModel) {
    return (
      <span
        className="whitespace-nowrap rounded bg-warn-soft px-1 text-[10px] font-semibold text-warn-fg"
        title="The engine does not model what happens here; see below."
      >
        not modelled
      </span>
    );
  }
  return (
    <span
      className={`whitespace-nowrap rounded px-1 text-[10px] font-semibold ${
        replay.within ? "bg-ok-soft text-ok-fg" : "bg-bad-soft text-bad-fg"
      }`}
    >
      {off}
    </span>
  );
}

function CalibrationCard({ calibration }: { readonly calibration: Calibration }) {
  const source = catalogIndex.catalog.sources.find((s) => s.id === calibration.source);
  const { kind, flavor, size, replicas } = calibration.component;
  const sizeLabel = catalogIndex.flavor(kind, flavor)?.sizes[size]?.label ?? size;
  return (
    <div className="flex flex-col gap-1 rounded-md border border-line px-2 py-1.5">
      <span className="flex flex-wrap items-center gap-x-1.5">
        <span className="font-medium text-fg">{calibration.title}</span>
        {source && <SourceLink source={source} />}
      </span>
      <span className="text-fg-subtle">
        On the {sizeLabel} size{replicas > 1 ? `, ${replicas} replicas` : ""}. {calibration.setup}
      </span>
      {calibration.work && (
        <span className="text-fg-subtle">
          Replayed at 1/{calibration.work.ratio} of the work: {calibration.work.why}
        </span>
      )}
      <table className="w-full text-left tabular-nums">
        <thead className="text-fg-subtle">
          <tr>
            <th className="py-0.5 font-normal">Run</th>
            <th className="py-0.5 font-normal">Measured</th>
            <th className="py-0.5 font-normal">Engine</th>
            <th className="py-0.5" aria-label="Verdict" />
          </tr>
        </thead>
        <tbody>
          {replayed(calibration).map((replay) => (
            <tr key={runLabel(replay.run)} className="border-t border-line align-top">
              <td className="whitespace-nowrap py-0.5 pr-2 text-fg-muted">
                {runLabel(replay.run)}
              </td>
              <td className="py-0.5 pr-2 text-fg">
                <Lines lines={figures(replay.run)} />
              </td>
              <td className="py-0.5 pr-2 text-fg">
                <Lines lines={figures(replay.engine)} />
              </td>
              <td className="py-0.5 text-right">
                <Verdict replay={replay} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {calibration.beyondModel && (
        <span className="text-fg-subtle">Not modelled: {calibration.beyondModel}</span>
      )}
    </div>
  );
}

/**
 * Published benchmarks the engine replays with this flavor's numbers, run by
 * run, so a reader can see how close the model lands.
 */
export function CalibrationList({
  kind,
  flavor,
}: {
  readonly kind: string;
  readonly flavor: string;
}) {
  const calibrations = catalogIndex.catalog.calibrations.filter(
    (c) => c.component.kind === kind && c.component.flavor === flavor,
  );
  if (calibrations.length === 0) return null;
  return (
    <section className="flex flex-col gap-1.5" aria-label="Checked against benchmarks">
      <span className="font-medium text-fg">Checked against benchmarks</span>
      <span className="text-fg-subtle">
        The engine replays these measurements with the catalog's numbers for the size they ran on,
        and must land within {Math.round(CALIBRATION_TOLERANCE * 100)}% of each.
      </span>
      {calibrations.map((calibration) => (
        <CalibrationCard key={calibration.id} calibration={calibration} />
      ))}
    </section>
  );
}
