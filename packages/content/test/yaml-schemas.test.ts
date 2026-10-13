import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

function yamlFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return yamlFiles(path);
    return name.endsWith(".yaml") ? [path] : [];
  });
}

describe("content files", () => {
  it.each(
    [...yamlFiles(join(root, "catalog")), ...yamlFiles(join(root, "problems"))].map((f) => [
      relative(root, f),
    ]),
  )("%s points editors at its schema", (file) => {
    const first = readFileSync(join(root, file), "utf8").split("\n")[0] ?? "";
    expect(first).toMatch(/^# yaml-language-server: \$schema=(\.\.\/)+schema\/\w+\.schema\.json$/);
  });
});
