import { z } from "zod";

/** Local decisions a handler makes without calling another component. */
export interface LogicDef {
  readonly label: string;
  readonly outcomes: readonly string[];
  readonly description: string;
}

export const LOGIC = {
  checkExpiry: {
    label: "check expiry",
    outcomes: ["valid", "expired"],
    description: "Compare the entity's expiry time with the current time.",
  },
  validateUrl: {
    label: "validate URL",
    outcomes: ["valid", "invalid"],
    description: "Reject malformed or unsupported URLs before doing any work.",
  },
  checkStatus: {
    label: "check status",
    outcomes: ["active", "disabled"],
    description: "Check whether the entity has been disabled.",
  },
} as const satisfies Record<string, LogicDef>;

export type LogicId = keyof typeof LOGIC;
export const LOGIC_IDS = Object.keys(LOGIC) as LogicId[];
export const LogicIdSchema = z.enum(LOGIC_IDS as [LogicId, ...LogicId[]]);

export function getLogic(id: LogicId): LogicDef {
  return LOGIC[id];
}
