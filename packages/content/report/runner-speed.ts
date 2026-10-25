/**
 * How fast this machine runs JavaScript of the kind the engine runs, against
 * the machine the evaluation budgets were set on (an Apple M4 Mac mini).
 * Shared CI runners differ by half from one run to the next, and a laptop by
 * more when it is busy, so the budgets compare times divided by this factor:
 * a slower machine is not a slower engine.
 *
 * The workload is fixed and independent of the engine, so that making the
 * engine slower can never make the machine look slower too. It is timed
 * between the evaluations it corrects, so both meet the same machine.
 */

/** Median milliseconds of the reference workload on the machine the budgets were set on. */
export const BASELINE_REFERENCE_MS = 17.3;
const ROUNDS = 160;
const KEYS = Array.from({ length: 512 }, (_, i) => `component-${i}|entity`);

/**
 * What the fixed point does on every pass: loads added up per component in
 * fresh maps of fresh objects, then utilisations and queueing waits worked
 * out from them. Returns a checksum so none of it is optimised away.
 */
export function referenceWork(): number {
  let checksum = 0;
  for (let round = 0; round < ROUNDS; round++) {
    const loads = new Map<string, { readonly read: number; readonly write: number }>();
    for (let i = 0; i < KEYS.length * 8; i++) {
      const key = KEYS[(i * 7919 + round) % KEYS.length] as string;
      const before = loads.get(key) ?? { read: 0, write: 0 };
      const rate = Math.exp(-((i % 97) / 40)) * 1000;
      loads.set(
        key,
        i % 3 === 0
          ? { read: before.read, write: before.write + rate }
          : { read: before.read + rate, write: before.write },
      );
    }
    for (const [key, load] of loads) {
      const rho = (load.read + load.write) / 50_000;
      checksum += rho > 1 ? 1 - 1 / rho : rho ** 3 / (1 - Math.min(rho, 0.99));
      checksum += key.length * 1e-9;
    }
  }
  return checksum;
}

/** Milliseconds one run of the reference workload takes now. */
export function timeReference(): number {
  const started = performance.now();
  const checksum = referenceWork();
  const elapsed = performance.now() - started;
  if (!Number.isFinite(checksum)) throw new Error("the reference workload went wrong");
  return elapsed;
}
