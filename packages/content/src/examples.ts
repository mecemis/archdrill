import { AttemptSchema } from "@archdrill/model";
import { z } from "zod";
import fixedGateways from "../problems/chat/corpus/golden/fixed-gateways.yaml";
import gatewaysAndSequences from "../problems/chat/corpus/golden/gateways-and-sequences.yaml";
import hybridFanOut from "../problems/news-feed/corpus/golden/hybrid-fan-out.yaml";
import pushPostgres from "../problems/news-feed/corpus/golden/push-postgres.yaml";
import outboxSaga from "../problems/payments/corpus/golden/outbox-saga.yaml";
import publishAfterCommit from "../problems/payments/corpus/golden/publish-after-commit.yaml";
import redisSlidingCounter from "../problems/rate-limiter/corpus/golden/redis-sliding-counter.yaml";
import redisTokenBucket from "../problems/rate-limiter/corpus/golden/redis-token-bucket.yaml";
import dynamodbDirect from "../problems/url-shortener/corpus/golden/dynamodb-direct.yaml";
import dynamodbActiveActive from "../problems/url-shortener/corpus/golden/dynamodb-redis-active-active.yaml";
import dynamodbRedis from "../problems/url-shortener/corpus/golden/dynamodb-redis-cache-aside.yaml";
import dynamodbTwoRegions from "../problems/url-shortener/corpus/golden/dynamodb-redis-two-regions.yaml";
import mysqlMemcached from "../problems/url-shortener/corpus/golden/mysql-memcached-cache-aside.yaml";
import postgresHash from "../problems/url-shortener/corpus/golden/postgres-hash-based.yaml";
import postgresRedisCacheAside from "../problems/url-shortener/corpus/golden/postgres-redis-cache-aside.yaml";
import postgresFixedFleet from "../problems/url-shortener/corpus/golden/postgres-redis-fixed-fleet.yaml";
import postgresTwoRegions from "../problems/url-shortener/corpus/golden/postgres-redis-two-regions.yaml";
import postgresSized from "../problems/url-shortener/corpus/golden/postgres-sized-for-cache-loss.yaml";

/**
 * A reference design: CI holds it to its expected scores, and the app offers
 * it as an example to study.
 */
export const GoldenSchema = z.object({
  id: z.string().min(1),
  /** A short name, shown when the design is offered as an example. */
  title: z.string().min(1),
  description: z.string().min(1),
  /** Scenario id → minimum score the design must reach without failing a gate. */
  expect: z.record(z.string(), z.object({ minScore: z.number().min(0).max(100) })),
  /** Scenarios this design is expected not to pass: valid elsewhere, but not an answer here. */
  notPassing: z.array(z.string()).default([]),
  attempt: AttemptSchema,
});
export type Golden = z.infer<typeof GoldenSchema>;

/** Reference designs per problem, best known first. */
export const goldenDesigns: Readonly<Record<string, readonly Golden[]>> = {
  "url-shortener": [
    postgresRedisCacheAside,
    dynamodbDirect,
    dynamodbRedis,
    mysqlMemcached,
    postgresHash,
    postgresSized,
    postgresFixedFleet,
    postgresTwoRegions,
    dynamodbTwoRegions,
    dynamodbActiveActive,
  ].map((g) => GoldenSchema.parse(g)),
  "rate-limiter": [redisSlidingCounter, redisTokenBucket].map((g) => GoldenSchema.parse(g)),
  "news-feed": [hybridFanOut, pushPostgres].map((g) => GoldenSchema.parse(g)),
  chat: [gatewaysAndSequences, fixedGateways].map((g) => GoldenSchema.parse(g)),
  payments: [outboxSaga, publishAfterCommit].map((g) => GoldenSchema.parse(g)),
};

/** Reference designs for a problem, to open as examples. */
export function examplesFor(problemId: string): readonly Golden[] {
  return goldenDesigns[problemId] ?? [];
}
