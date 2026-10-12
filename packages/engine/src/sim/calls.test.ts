import { type ConnectionPolicy, DEFAULT_POLICY } from "@archdrill/model";
import { describe, expect, it } from "vitest";
import { type AttemptRisks, callModel, NETWORK_RTT_MS, NO_TIMEOUT_WAIT_MS } from "./calls";

const NO_RISK: AttemptRisks = { shed: 0, fault: 0, faultHangs: false, overload: 0, timeout: 0 };
const policy = (overrides: Partial<ConnectionPolicy>): ConnectionPolicy => ({
  ...DEFAULT_POLICY,
  ...overrides,
});

describe("callModel", () => {
  it("leaves healthy calls alone", () => {
    const call = callModel(NO_RISK, policy({ retries: 3 }));

    expect(call).toMatchObject({ failure: 0, attemptsOnSuccess: 1, reach: 1 });
  });

  it("retries failed attempts and counts the extra attempts", () => {
    const call = callModel({ ...NO_RISK, overload: 0.5 }, policy({ retries: 2 }));
    const attemptsPerCall =
      (1 - call.failure) * call.attemptsOnSuccess + call.failure * call.attemptsOnFailure;

    expect(call.failure).toBeCloseTo(0.125, 12);
    expect(call.attemptsOnFailure).toBe(3);
    expect(attemptsPerCall).toBeCloseTo(1 + 0.5 + 0.25, 12);
  });

  it("makes a hanging dependency cost the timeout on every attempt, plus backoff", () => {
    const hung = { ...NO_RISK, fault: 1, faultHangs: true };

    const bounded = callModel(hung, policy({ timeoutMs: 50, retries: 2 }));
    const unbounded = callModel(hung, policy({}));

    // Three attempts of 50 ms, plus full-jitter backoff of 5 ms and 10 ms on average.
    expect(bounded.failureLatency.mean).toBeCloseTo(3 * 50 + 15, 9);
    expect(unbounded.failureLatency.mean).toBe(NO_TIMEOUT_WAIT_MS);
  });

  it("fails refused connections in a round trip", () => {
    const call = callModel({ ...NO_RISK, fault: 1 }, policy({ timeoutMs: 50 }));

    expect(call.failureLatency.mean).toBe(NETWORK_RTT_MS);
  });

  it("stops calling a dependency that fails most attempts once the breaker opens", () => {
    const failing = { ...NO_RISK, fault: 1, faultHangs: true };

    const call = callModel(failing, policy({ timeoutMs: 50, retries: 2, circuitBreaker: true }));

    expect(call).toMatchObject({ failure: 1, shortCircuit: 1, attemptsOnFailure: 0 });
    expect(call.failureLatency.mean).toBe(0);
  });

  it("keeps the breaker closed below its threshold", () => {
    const call = callModel({ ...NO_RISK, overload: 0.2 }, policy({ circuitBreaker: true }));

    expect(call.shortCircuit).toBe(0);
    expect(call.failure).toBeCloseTo(0.2, 12);
  });

  it("does not send shed or faulted attempts to the target", () => {
    const call = callModel({ ...NO_RISK, shed: 0.5, fault: 0.2 }, policy({}));

    expect(call.reach).toBeCloseTo(0.4, 12);
    expect(call.failure).toBeCloseTo(1 - 0.5 * 0.8, 12);
  });
});
