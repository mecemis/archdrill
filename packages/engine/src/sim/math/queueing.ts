/** Utilisation above which the steady-state formulas are evaluated at this cap; overload is modelled separately. */
export const MAX_STEADY_UTILIZATION = 0.98;

/**
 * Mean waiting time in queue for an M/M/c system, Sakasegawa's approximation:
 *   Wq ≈ ρ^(√(2(c+1)) − 1) / (c (1 − ρ)) · S
 * Exact for c = 1. `serviceTime` is the mean service time of one server.
 */
export function sakasegawaWait(utilization: number, servers: number, serviceTime: number): number {
  if (utilization <= 0 || servers <= 0 || serviceTime <= 0) return 0;
  const rho = Math.min(utilization, MAX_STEADY_UTILIZATION);
  return (rho ** (Math.sqrt(2 * (servers + 1)) - 1) / (servers * (1 - rho))) * serviceTime;
}

/** Above this many servers the exact formula's O(c) cost is not worth it; the approximation is used. */
export const EXACT_SERVER_LIMIT = 5000;

/**
 * Exact M/M/c mean waiting time (Erlang C), computed through the Erlang B
 * recursion B(k) = a·B(k−1) / (k + a·B(k−1)), which stays numerically stable
 * for thousands of servers, then C = c·B / (c − a·(1 − B)).
 */
export function erlangCWait(utilization: number, servers: number, serviceTime: number): number {
  if (utilization <= 0 || servers <= 0 || serviceTime <= 0) return 0;
  const rho = Math.min(utilization, MAX_STEADY_UTILIZATION);
  const a = servers * rho;
  let blocking = 1;
  for (let k = 1; k <= servers; k++) blocking = (a * blocking) / (k + a * blocking);
  const waitProbability = (servers * blocking) / (servers - a * (1 - blocking));
  return (waitProbability * serviceTime) / (servers * (1 - rho));
}

/** Mean queueing delay: exact Erlang C up to EXACT_SERVER_LIMIT servers, Sakasegawa beyond. */
export function queueWait(utilization: number, servers: number, serviceTime: number): number {
  const c = Math.max(1, Math.round(servers));
  return c <= EXACT_SERVER_LIMIT
    ? erlangCWait(utilization, c, serviceTime)
    : sakasegawaWait(utilization, c, serviceTime);
}
