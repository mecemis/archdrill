import type { Plugin } from "vite";
import { parse } from "yaml";

/**
 * Compiles YAML content to JSON modules at build time, so the app bundle ships
 * data but no YAML parser. Schema validation happens where the data is loaded.
 */
export function yamlContent(): Plugin {
  return {
    name: "archdrill-yaml-content",
    transform(source, id) {
      if (!/\.ya?ml$/.test(id)) return null;
      return { code: `export default ${JSON.stringify(parse(source))};`, map: null };
    },
  };
}
