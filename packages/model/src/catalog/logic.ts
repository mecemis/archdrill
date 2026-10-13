import { z } from "zod";

/**
 * Which outcome a request takes, decided by a fact about it: requests whose
 * class has the fact take `outcome`, the others take the other outcome.
 */
export interface FactRule {
  readonly fact: string;
  readonly outcome: string;
}

/** Local decisions a handler makes without calling another component. */
export interface LogicDef {
  readonly label: string;
  readonly outcomes: readonly string[];
  readonly description: string;
  /** For two-way decisions: the fact about the request that decides them. */
  readonly decidedBy?: FactRule;
}

export const LOGIC = {
  checkExpiry: {
    label: "check expiry",
    outcomes: ["valid", "expired"],
    description: "Compare the entity's expiry time with the current time.",
    decidedBy: { fact: "expired", outcome: "expired" },
  },
  validateUrl: {
    label: "validate URL",
    outcomes: ["valid", "invalid"],
    description: "Reject malformed or unsupported URLs before doing any work.",
    decidedBy: { fact: "invalidInput", outcome: "invalid" },
  },
  checkStatus: {
    label: "check status",
    outcomes: ["active", "disabled"],
    description: "Check whether the entity has been disabled.",
    decidedBy: { fact: "disabled", outcome: "disabled" },
  },
  hasCustomAlias: {
    label: "custom alias?",
    outcomes: ["custom", "generated"],
    description:
      "Branch on whether the request asks for a specific alias or wants a generated code.",
    decidedBy: { fact: "customAlias", outcome: "custom" },
  },
  generateRandomCode: {
    label: "generate random code",
    outcomes: ["ok"],
    description: "Draw a random code from the keyspace. Codes can collide with existing ones.",
  },
  hashUrl: {
    label: "hash URL",
    outcomes: ["ok"],
    description:
      "Derive a code from a hash of the long URL. The same URL maps to the same code; different URLs can collide.",
  },
  rehashWithSalt: {
    label: "rehash with salt",
    outcomes: ["ok"],
    description:
      "Hash the long URL again with a salt (for example an attempt counter) to get a different code after a collision. Hashing the same URL again without a salt gives the same code.",
  },
  encodeBase62: {
    label: "encode base62",
    outcomes: ["ok"],
    description: "Turn a number into a short base62 string.",
  },
  checkLimit: {
    label: "check limit",
    outcomes: ["under", "over"],
    description:
      "Compare the client's count in the current window with its limit. Exact only if the count covers every server.",
    decidedBy: { fact: "overLimit", outcome: "over" },
  },
  checkLocalLimit: {
    label: "check local limit",
    outcomes: ["under", "over"],
    description:
      "Compare this server's own count with the client's limit divided by the number of servers. It only catches clients far over their limit, and only if their traffic spreads evenly.",
    decidedBy: { fact: "farOverLimit", outcome: "over" },
  },
  isCelebrity: {
    label: "celebrity author?",
    outcomes: ["regular", "celebrity"],
    description:
      "Branch on whether the post's author has millions of followers, too many to copy the post to each of them.",
    decidedBy: { fact: "celebrity", outcome: "celebrity" },
  },
  obfuscateId: {
    label: "obfuscate id",
    outcomes: ["ok"],
    description:
      "Permute sequential ids with a reversible scramble (for example a Feistel network) so codes are not enumerable.",
  },
} as const satisfies Record<string, LogicDef>;

export type LogicId = keyof typeof LOGIC;
export const LOGIC_IDS = Object.keys(LOGIC) as LogicId[];
export const LogicIdSchema = z.enum(LOGIC_IDS as [LogicId, ...LogicId[]]);

export function getLogic(id: LogicId): LogicDef {
  return LOGIC[id];
}

/** Logic a problem offers: the ones it lists, or every one when it lists nothing. */
export function offeredLogic(listed: readonly LogicId[] | undefined): readonly LogicId[] {
  return listed ?? LOGIC_IDS;
}
