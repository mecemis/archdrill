import { type KeyboardEvent, type MouseEvent, useId } from "react";

export interface LineSeries {
  readonly label: string;
  /** One value per time; null where there is nothing to show. */
  readonly values: readonly (number | null)[];
}

/** A window to shade, such as a fault from its start to its end. */
export interface TimeBand {
  readonly from: number;
  readonly to: number;
  readonly label: string;
}

/** Colour and dash pattern per series, so lines differ by more than colour. */
const STYLES = [
  { color: "#0369a1", dash: "" },
  { color: "#be123c", dash: "6 3" },
  { color: "#b45309", dash: "2 3" },
  { color: "#047857", dash: "8 3 2 3" },
  { color: "#6d28d9", dash: "1 2" },
  { color: "#3f3f46", dash: "10 4" },
] as const;

const WIDTH = 640;
const HEIGHT = 150;
const LEFT = 48;
const RIGHT = 8;
const TOP = 10;
const BOTTOM = 22;

function niceTimeStep(duration: number): number {
  for (const step of [5, 10, 15, 30, 60, 120]) if (duration / step <= 8) return step;
  return 300;
}

/** A small line chart over time, with shaded windows and an optional limit line. */
export function LineChart({
  title,
  times,
  series,
  domain,
  format,
  limit,
  bands = [],
  cursor,
  onPick,
}: {
  readonly title: string;
  readonly times: readonly number[];
  readonly series: readonly LineSeries[];
  readonly domain: readonly [number, number];
  readonly format: (value: number) => string;
  readonly limit?: { readonly value: number; readonly label: string };
  readonly bands?: readonly TimeBand[];
  /** A moment to mark, in seconds; the legend shows each series' value there. */
  readonly cursor?: number | undefined;
  /** Picks the moment under a click, in seconds. */
  readonly onPick?: ((t: number) => void) | undefined;
}) {
  const id = useId();
  const end = times.at(-1) ?? 1;
  const [low, high] = domain[1] > domain[0] ? domain : [domain[0], domain[0] + 1];
  const x = (t: number) => LEFT + ((WIDTH - LEFT - RIGHT) * t) / Math.max(end, 1e-9);
  const y = (v: number) =>
    TOP + (HEIGHT - TOP - BOTTOM) * (1 - (Math.min(high, Math.max(low, v)) - low) / (high - low));
  const step = niceTimeStep(end);
  const ticks = Array.from({ length: Math.floor(end / step) + 1 }, (_, i) => i * step);
  const levels = [low, (low + high) / 2, high];
  const cursorIndex =
    cursor === undefined
      ? -1
      : times.reduce(
          (best, t, i) => (Math.abs(t - cursor) < Math.abs((times[best] ?? 0) - cursor) ? i : best),
          0,
        );
  const pick = (event: MouseEvent<SVGSVGElement>) => {
    if (!onPick) return;
    const box = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - box.left) / box.width) * WIDTH;
    const fraction = (x - LEFT) / (WIDTH - LEFT - RIGHT);
    onPick(Math.min(end, Math.max(0, fraction * end)));
  };
  // Arrow keys move the picked moment one step, for keyboard users.
  const nudge = (event: KeyboardEvent<SVGSVGElement>) => {
    if (!onPick || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    event.preventDefault();
    const from = Math.max(0, cursorIndex);
    const next = event.key === "ArrowRight" ? from + 1 : from - 1;
    onPick(times[Math.min(times.length - 1, Math.max(0, next))] ?? 0);
  };
  const valueText = `${times[cursorIndex] ?? 0} s: ${series
    .map((s) => `${s.label} ${formatAt(s.values[cursorIndex], format)}`)
    .join(", ")}`;
  const pathOf = (values: readonly (number | null)[]) => {
    let d = "";
    let drawing = false;
    values.forEach((value, i) => {
      const t = times[i] ?? 0;
      if (value === null || !Number.isFinite(value)) {
        drawing = false;
        return;
      }
      d += `${drawing ? "L" : "M"}${x(t).toFixed(1)},${y(value).toFixed(1)} `;
      drawing = true;
    });
    return d.trim();
  };

  return (
    <figure className="flex flex-col gap-1">
      <figcaption id={id} className="text-xs font-semibold text-zinc-600">
        {title}
      </figcaption>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        aria-labelledby={id}
        className={`h-auto w-full ${onPick ? "cursor-crosshair" : ""}`}
        {...(onPick
          ? {
              // Picking a moment on a chart works like a slider over time.
              role: "slider",
              tabIndex: 0,
              "aria-valuemin": 0,
              "aria-valuemax": end,
              "aria-valuenow": times[Math.max(0, cursorIndex)] ?? 0,
              "aria-valuetext": cursorIndex < 0 ? "no moment picked" : valueText,
              onClick: pick,
              onKeyDown: nudge,
            }
          : { role: "img" })}
      >
        <title>{title}</title>
        {bands.map((band) => (
          <g key={`${band.label}-${band.from}`}>
            <rect
              x={x(band.from)}
              y={TOP}
              width={Math.max(1, x(Math.min(band.to, end)) - x(band.from))}
              height={HEIGHT - TOP - BOTTOM}
              fill="#ffe4e6"
            />
            <text x={x(band.from) + 3} y={TOP + 10} fontSize="9" fill="#9f1239">
              {band.label}
            </text>
          </g>
        ))}
        {levels.map((level) => (
          <g key={level}>
            <line
              x1={LEFT}
              x2={WIDTH - RIGHT}
              y1={y(level)}
              y2={y(level)}
              stroke="#e4e4e7"
              strokeWidth="1"
            />
            <text x={LEFT - 4} y={y(level) + 3} fontSize="9" textAnchor="end" fill="#71717a">
              {format(level)}
            </text>
          </g>
        ))}
        {ticks.map((t) => (
          <text key={t} x={x(t)} y={HEIGHT - 6} fontSize="9" textAnchor="middle" fill="#71717a">
            {t} s
          </text>
        ))}
        {limit && (
          <g>
            <line
              x1={LEFT}
              x2={WIDTH - RIGHT}
              y1={y(limit.value)}
              y2={y(limit.value)}
              stroke="#e11d48"
              strokeWidth="1"
              strokeDasharray="4 3"
            />
            <text
              x={WIDTH - RIGHT - 2}
              y={y(limit.value) - 3}
              fontSize="9"
              textAnchor="end"
              fill="#be123c"
            >
              {limit.label}
            </text>
          </g>
        )}
        {cursorIndex >= 0 && (
          <line
            x1={x(times[cursorIndex] ?? 0)}
            x2={x(times[cursorIndex] ?? 0)}
            y1={TOP}
            y2={HEIGHT - BOTTOM}
            stroke="#0c4a6e"
            strokeWidth="1"
          />
        )}
        {series.map((s, i) => {
          const style = STYLES[i % STYLES.length] ?? STYLES[0];
          return (
            <path
              key={s.label}
              d={pathOf(s.values)}
              fill="none"
              stroke={style.color}
              strokeWidth="1.75"
              strokeDasharray={style.dash}
            />
          );
        })}
      </svg>
      <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-zinc-700">
        {series.map((s, i) => {
          const style = STYLES[i % STYLES.length] ?? STYLES[0];
          return (
            <li key={s.label} className="flex items-center gap-1">
              <svg width="18" height="6" aria-hidden="true">
                <line
                  x1="0"
                  x2="18"
                  y1="3"
                  y2="3"
                  stroke={style.color}
                  strokeWidth="2"
                  strokeDasharray={style.dash}
                />
              </svg>
              <span>
                {s.label}
                {cursorIndex >= 0 && (
                  <span className="text-zinc-500 tabular-nums">
                    : {formatAt(s.values[cursorIndex], format)}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </figure>
  );
}

function formatAt(value: number | null | undefined, format: (v: number) => string): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : format(value);
}
