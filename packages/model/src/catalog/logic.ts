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
  hasCustomAlias: {
    label: "custom alias?",
    outcomes: ["custom", "generated"],
    description:
      "Branch on whether the request asks for a specific alias or wants a generated code.",
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
