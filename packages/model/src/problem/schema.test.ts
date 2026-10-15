import { describe, expect, it } from "vitest";
import { testProblem } from "../testing/fixtures";
import { ProblemSchema } from "./schema";

const withOperations = (operations: unknown[], events = testProblem.events) =>
  ProblemSchema.safeParse({ ...testProblem, operations, events });

describe("ProblemSchema operations", () => {
  it("defaults an operation's trigger to a client request", () => {
    expect(testProblem.operations.find((o) => o.id === "redirect")?.trigger).toEqual({
      type: "request",
    });
  });

  it("requires a method and a path for requested operations", () => {
    const { method: _method, ...noMethod } = testProblem.operations[0] ?? {};

    expect(withOperations([noMethod]).success).toBe(false);
  });

  it("requires request and response sizes for requested operations", () => {
    const { bytes: _bytes, ...noBytes } = testProblem.operations[0] ?? {};

    expect(withOperations([noBytes]).error?.issues.map((i) => i.message)).toContain(
      'operation "redirect" is requested by clients, so it needs request and response sizes',
    );
  });

  it("rejects sizes on work that clients do not request", () => {
    const job = testProblem.operations.find((o) => o.trigger.type === "schedule");
    const sized = { ...job, bytes: { request: 100, response: 100 } };

    expect(withOperations([sized]).error?.issues.map((i) => i.message)).toContain(
      `operation "${job?.id}" is not requested by clients, so nothing carries its sizes`,
    );
  });

  it("lets consumers and jobs go without a method and a path", () => {
    expect(withOperations(testProblem.operations).success).toBe(true);
  });

  it("rejects a consumer of an event the problem does not define", () => {
    const consumer = { ...testProblem.operations[0], trigger: { type: "event", event: "nope" } };

    const result = withOperations([consumer]);

    expect(result.error?.issues.map((i) => i.message)).toContain(
      'operation "redirect" consumes unknown event "nope"',
    );
  });

  it("rejects an event about an unknown entity", () => {
    const result = withOperations(testProblem.operations, [
      { id: "link-created", label: "Link created", entity: "Nope" },
    ]);

    expect(result.error?.issues.map((i) => i.message)).toContain(
      'event "link-created" is about unknown entity "Nope"',
    );
  });
});

describe("ProblemSchema client", () => {
  it("defaults to visitors who open a connection per request, held for a minute", () => {
    const { client: _client, ...noClient } = testProblem;

    expect(ProblemSchema.parse(noClient).client).toEqual({
      flavor: "browser",
      label: "Visitors",
      requestsPerConnection: 1,
      connectionSec: 60,
    });
  });
});
