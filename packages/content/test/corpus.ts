/// <reference path="../src/yaml.d.ts" />
import { AttemptSchema, isCommandName } from "@archdrill/model";
import { z } from "zod";
import dynamodbDirect from "../problems/url-shortener/corpus/golden/dynamodb-direct.yaml";
import dynamodbRedis from "../problems/url-shortener/corpus/golden/dynamodb-redis-cache-aside.yaml";
import mysqlMemcached from "../problems/url-shortener/corpus/golden/mysql-memcached-cache-aside.yaml";
import postgresHash from "../problems/url-shortener/corpus/golden/postgres-hash-based.yaml";
import postgresRedisCacheAside from "../problems/url-shortener/corpus/golden/postgres-redis-cache-aside.yaml";
import urlShortenerMutants from "../problems/url-shortener/corpus/mutants.yaml";

export const GoldenSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  /** Scenario id → minimum score the design must reach without failing a gate. */
  expect: z.record(z.string(), z.object({ minScore: z.number().min(0).max(100) })),
  /** Scenarios this design is expected not to pass: valid elsewhere, but not an answer here. */
  notPassing: z.array(z.string()).default([]),
  attempt: AttemptSchema,
});
export type Golden = z.infer<typeof GoldenSchema>;

const CommandStepSchema = z
  .record(z.string(), z.record(z.string(), z.unknown()))
  .refine((step) => Object.keys(step).length === 1, "each apply entry names exactly one command")
  .refine((step) => Object.keys(step).every(isCommandName), "unknown command")
  .transform((step) => {
    const [name, args] = Object.entries(step)[0] as [string, Record<string, unknown>];
    return { name, args };
  });

export const MutantSchema = z.object({
  id: z.string().min(1),
  base: z.string().min(1),
  description: z.string().min(1),
  apply: z.array(CommandStepSchema).min(1),
  expect: z
    .object({
      scenario: z.string().min(1),
      /** Validation must block the scenario with these issue codes. */
      invalid: z.array(z.string()).min(1).optional(),
      /** These check instances must fail or be only partially satisfied. */
      fails: z.array(z.string()).min(1).optional(),
      band: z.enum(["not-passing", "passing", "strong", "excellent"]).optional(),
    })
    .refine((e) => (e.invalid === undefined) !== (e.fails === undefined), {
      message: "a mutant expects either invalid issue codes or failing checks",
    }),
});
export type Mutant = z.infer<typeof MutantSchema>;

export interface ProblemCorpus {
  readonly problemId: string;
  readonly golden: readonly Golden[];
  readonly mutants: readonly Mutant[];
}

export const corpora: readonly ProblemCorpus[] = [
  {
    problemId: "url-shortener",
    golden: [
      postgresRedisCacheAside,
      dynamodbDirect,
      dynamodbRedis,
      mysqlMemcached,
      postgresHash,
    ].map((g) => GoldenSchema.parse(g)),
    mutants: z.object({ mutants: z.array(MutantSchema) }).parse(urlShortenerMutants).mutants,
  },
];
