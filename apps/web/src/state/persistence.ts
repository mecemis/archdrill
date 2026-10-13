import { type Attempt, migrateAttempt } from "@archdrill/model";

const KEY_PREFIX = "archdrill:attempt:";

const BASELINE_PREFIX = "archdrill:baseline:";

/**
 * Local autosave for the current attempt. Storage can be unavailable (private
 * windows, blocked site data), so every access is guarded and the app works
 * without it. Designs are a few kilobytes, so localStorage is enough; saved
 * designs go through the same migrations as imported ones.
 */
export function loadAttempt(
  problemId: string,
  storage: Storage | null = safeStorage(),
): Attempt | null {
  return load(KEY_PREFIX + problemId, problemId, storage);
}

export function saveAttempt(attempt: Attempt, storage: Storage | null = safeStorage()): boolean {
  return save(KEY_PREFIX + attempt.problemId, attempt, storage);
}

/** The design pinned for comparison, if any. */
export function loadBaseline(
  problemId: string,
  storage: Storage | null = safeStorage(),
): Attempt | null {
  return load(BASELINE_PREFIX + problemId, problemId, storage);
}

export function saveBaseline(
  problemId: string,
  attempt: Attempt | null,
  storage: Storage | null = safeStorage(),
): boolean {
  if (attempt) return save(BASELINE_PREFIX + problemId, attempt, storage);
  try {
    storage?.removeItem(BASELINE_PREFIX + problemId);
    return storage !== null;
  } catch {
    return false;
  }
}

function load(key: string, problemId: string, storage: Storage | null): Attempt | null {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return null;
    const attempt = migrateAttempt(JSON.parse(raw));
    return attempt.problemId === problemId ? attempt : null;
  } catch {
    return null;
  }
}

function save(key: string, attempt: Attempt, storage: Storage | null): boolean {
  try {
    storage?.setItem(key, JSON.stringify(attempt));
    return storage !== null;
  } catch {
    return false;
  }
}

/** The browser's storage, or null when it is missing or blocked. Pass null explicitly to disable storage. */
export function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
