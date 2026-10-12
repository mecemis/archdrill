import { z } from "zod";
import { ATTEMPT_SCHEMA_VERSION, type Attempt, AttemptSchema } from "./schema";

/** Why an attempt could not be read. */
export class AttemptImportError extends Error {}

type Raw = Record<string, unknown>;

/**
 * Upgrades from one schema version to the next, keyed by the version they
 * upgrade from. Changes that only add optional fields with defaults (call
 * policies, autoscaling) need no entry: parsing fills the defaults.
 */
const MIGRATIONS: Readonly<Record<number, (attempt: Raw) => Raw>> = {};

const isRecord = (value: unknown): value is Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Upgrades an attempt saved by an earlier version and validates it. */
export function migrateAttempt(raw: unknown): Attempt {
  if (!isRecord(raw)) throw new AttemptImportError("This is not an ArchDrill design.");
  let version = typeof raw.schemaVersion === "number" ? raw.schemaVersion : 0;
  if (version > ATTEMPT_SCHEMA_VERSION) {
    throw new AttemptImportError("This design was saved by a newer version of ArchDrill.");
  }
  let attempt = raw;
  while (version < ATTEMPT_SCHEMA_VERSION) {
    const migrate = MIGRATIONS[version];
    if (!migrate) throw new AttemptImportError(`Designs from version ${version} cannot be read.`);
    attempt = { ...migrate(attempt), schemaVersion: version + 1 };
    version++;
  }
  const parsed = AttemptSchema.safeParse(attempt);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AttemptImportError(
      `The design is not valid${issue ? ` (${issue.path.join(".") || "root"}: ${issue.message})` : ""}.`,
    );
  }
  return parsed.data;
}

const EXPORT_FORMAT = "archdrill-attempt";

const ExportSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  exportedAt: z.string(),
  attempt: z.unknown(),
});

/** A design as a self-describing JSON document. */
export function exportAttempt(attempt: Attempt, now: Date = new Date()): string {
  return JSON.stringify({ format: EXPORT_FORMAT, exportedAt: now.toISOString(), attempt }, null, 2);
}

/** Reads an exported document, or a bare attempt, upgrading it if it is older. */
export function importAttempt(text: string): Attempt {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AttemptImportError("The file is not JSON.");
  }
  const wrapped = ExportSchema.safeParse(json);
  return migrateAttempt(wrapped.success ? wrapped.data.attempt : json);
}
