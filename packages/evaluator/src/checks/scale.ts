import { z } from "zod";
import type { Evidence } from "../evidence";
import { usd } from "./metrics";
import { defineCheck, failed, notApplicable, passed } from "./types";

/** Utilisation a right-sized fleet would run at; savings are estimated against it. */
const RIGHT_SIZED_UTILIZATION = 0.6;
/** Instances every service keeps for redundancy, however idle. */
const MIN_REDUNDANT_INSTANCES = 2;

/** No component runs many instances that the load does not need. */
export const overprovisioned = defineCheck({
  id: "overprovisioned",
  description: "Components do not run many idle instances.",
  params: z.strictObject({
    environment: z.string().min(1),
    below: z.number().positive().max(1).default(0.1),
    minInstances: z.number().int().min(2).default(3),
  }),
  run(params, ctx) {
    const env = ctx.metrics.get(params.environment);
    if (!env) return notApplicable("This scenario does not simulate load.");
    const label = (id: string) =>
      ctx.attempt.architecture.components.find((c) => c.id === id)?.label ?? id;
    const idle = [...env.components.values()].filter(
      (c) =>
        c.instances >= params.minInstances &&
        c.readLoad + c.writeLoad > 0 &&
        c.utilization < params.below,
    );
    if (idle.length === 0) {
      return passed(`No component runs mostly idle at ${env.environment.label}.`);
    }
    const lines = idle.map((c) => {
      const needed = Math.max(
        MIN_REDUNDANT_INSTANCES,
        Math.ceil((c.utilization * c.instances) / RIGHT_SIZED_UTILIZATION),
      );
      const saving = c.costBreakdown.instances * (1 - needed / c.instances);
      return {
        componentId: c.componentId,
        line: `${label(c.componentId)}: ${Math.round(c.instances)} instances at ${Math.round(c.utilization * 100)}% utilisation; about ${needed} would do, saving ${usd(saving)}/month`,
      };
    });
    return {
      status: "partial",
      fraction: 0.5,
      message: `Some components run mostly idle at ${env.environment.label}; autoscaling or fewer instances would cost less.`,
      details: lines.map((l) => l.line),
      evidence: lines.map((l): Evidence => ({ type: "component", componentId: l.componentId })),
    };
  },
});

/** Services that handle requests scale with load instead of being sized for the peak forever. */
export const autoscalingConfigured = defineCheck({
  id: "autoscaling-configured",
  description: "Services that handle requests autoscale.",
  params: z.strictObject({}),
  run(_params, ctx) {
    const handlers = new Set(ctx.attempt.flows.map((f) => f.handler));
    const services = ctx.attempt.architecture.components.filter(
      (c) =>
        handlers.has(c.id) && ctx.catalog.capabilities(c.kind, c.flavor).has("stateless-compute"),
    );
    if (services.length === 0) return notApplicable("No service handles a flow yet.");
    const fixed = services.filter((c) => !c.autoscale);
    if (fixed.length === 0) {
      return passed(`${services.map((c) => c.label).join(", ")} scale with load.`);
    }
    return failed(
      `${fixed.map((c) => c.label).join(", ")} ${fixed.length === 1 ? "runs" : "run"} a fixed number of instances.`,
      fixed.map((c): Evidence => ({ type: "component", componentId: c.id })),
    );
  },
});
