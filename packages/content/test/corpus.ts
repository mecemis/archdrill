/// <reference path="../src/yaml.d.ts" />
import { isCommandName } from "@archdrill/model";
import { z } from "zod";
import chatMutants from "../problems/chat/corpus/mutants.yaml";
import newsFeedMutants from "../problems/news-feed/corpus/mutants.yaml";
import paymentsMutants from "../problems/payments/corpus/mutants.yaml";
import rateLimiterMutants from "../problems/rate-limiter/corpus/mutants.yaml";
import urlShortenerMutants from "../problems/url-shortener/corpus/mutants.yaml";
import { type Golden, GoldenSchema, goldenDesigns } from "../src/examples";

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

export { type Golden, GoldenSchema };

export const corpora: readonly ProblemCorpus[] = [
  {
    problemId: "url-shortener",
    golden: goldenDesigns["url-shortener"] ?? [],
    mutants: z.object({ mutants: z.array(MutantSchema) }).parse(urlShortenerMutants).mutants,
  },
  {
    problemId: "rate-limiter",
    golden: goldenDesigns["rate-limiter"] ?? [],
    mutants: z.object({ mutants: z.array(MutantSchema) }).parse(rateLimiterMutants).mutants,
  },
  {
    problemId: "news-feed",
    golden: goldenDesigns["news-feed"] ?? [],
    mutants: z.object({ mutants: z.array(MutantSchema) }).parse(newsFeedMutants).mutants,
  },
  {
    problemId: "chat",
    golden: goldenDesigns.chat ?? [],
    mutants: z.object({ mutants: z.array(MutantSchema) }).parse(chatMutants).mutants,
  },
  {
    problemId: "payments",
    golden: goldenDesigns.payments ?? [],
    mutants: z.object({ mutants: z.array(MutantSchema) }).parse(paymentsMutants).mutants,
  },
];
