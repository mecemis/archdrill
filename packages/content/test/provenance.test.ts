import { FLAVOR_NUMBERS, type Provenance, SIZE_NUMBERS } from "@archdrill/model";
import { describe, expect, it } from "vitest";
import { catalog } from "../src/index";

/** Every number a flavor or a size carries, with where it sits. */
function numbers() {
  const found: {
    readonly where: string;
    readonly field: string;
    readonly provenance: Provenance | undefined;
  }[] = [];
  for (const kind of catalog.kinds) {
    for (const flavor of kind.flavors) {
      const at = `${kind.id}/${flavor.id}`;
      for (const field of FLAVOR_NUMBERS) {
        if (flavor[field] === undefined) continue;
        found.push({ where: at, field, provenance: flavor.provenance[field] });
      }
      for (const [sizeId, size] of Object.entries(flavor.sizes)) {
        for (const field of SIZE_NUMBERS) {
          const value = size[field];
          if (value === undefined) continue;
          if (typeof value === "object" && Object.keys(value).length === 0) continue;
          found.push({
            where: `${at}/${sizeId}`,
            field,
            provenance: size.provenance[field] ?? flavor.provenance[field],
          });
        }
      }
    }
  }
  return found;
}

describe("catalog provenance", () => {
  it("says where every number comes from: a published source or a stated model", () => {
    const missing = numbers()
      .filter((n) => n.provenance === undefined)
      .map((n) => `${n.where}.${n.field}`);

    expect(missing).toEqual([]);
  });

  it("names the real offering every size stands for", () => {
    const unnamed = catalog.kinds.flatMap((kind) =>
      kind.flavors.flatMap((flavor) =>
        Object.entries(flavor.sizes)
          .filter(([, size]) => (size.standsFor ?? flavor.standsFor) === undefined)
          .map(([sizeId]) => `${kind.id}/${flavor.id}/${sizeId}`),
      ),
    );

    expect(unnamed).toEqual([]);
  });

  it("lists only sources that some number cites", () => {
    const cited = new Set(
      numbers().flatMap((n) =>
        !n.provenance
          ? []
          : "published" in n.provenance
            ? [n.provenance.published]
            : n.provenance.basis,
      ),
    );

    expect(catalog.sources.map((s) => s.id).filter((id) => !cited.has(id))).toEqual([]);
  });

  it("dates every source", () => {
    expect(catalog.sources.every((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.retrieved))).toBe(true);
  });
});
