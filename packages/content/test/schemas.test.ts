import { readFileSync, writeFileSync } from "node:fs";
import { CatalogSchema, ProblemSchema, ScenarioSchema } from "@archdrill/model";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GoldenSchema, MutantSchema } from "./corpus";

/**
 * JSON Schemas for editors, generated from the same Zod schemas that validate
 * content. YAML files point at them (`# yaml-language-server: $schema=…`), so
 * an editor completes fields and flags mistakes while a pack is written.
 * Run `pnpm schemas` to regenerate them after a schema change.
 */
const SCHEMAS = {
  problem: ProblemSchema,
  scenario: ScenarioSchema,
  catalog: CatalogSchema,
  golden: GoldenSchema,
  mutants: z.object({ mutants: z.array(MutantSchema) }),
} as const;

const UPDATE = process.env.UPDATE_SCHEMAS === "1";

describe("editor schemas", () => {
  it.each(Object.entries(SCHEMAS))("%s.schema.json matches the content schema", (name, schema) => {
    const json = {
      title: `ArchDrill ${name}`,
      ...z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }),
    };
    const file = new URL(`../schema/${name}.schema.json`, import.meta.url);
    if (UPDATE) writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
    // Compared as data: the formatter may lay the file out differently.
    expect(JSON.parse(readFileSync(file, "utf8")), "run `pnpm schemas` to regenerate").toEqual(
      json,
    );
  });
});
