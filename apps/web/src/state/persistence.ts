import { type Attempt, AttemptSchema } from "@archdrill/model";

const KEY_PREFIX = "archdrill:attempt:";

/**
 * Local autosave for the current attempt. Storage can be unavailable (private
 * windows, blocked site data), so every access is guarded and the app works
 * without it. IndexedDB with versioned migrations replaces this in M5.
 */
export function loadAttempt(
  problemId: string,
  storage: Storage | undefined = safeStorage(),
): Attempt | null {
  try {
    const raw = storage?.getItem(KEY_PREFIX + problemId);
    if (!raw) return null;
    const parsed = AttemptSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.problemId === problemId ? parsed.data : null;
  } catch {
    return null;
  }
}

export function saveAttempt(
  attempt: Attempt,
  storage: Storage | undefined = safeStorage(),
): boolean {
  try {
    storage?.setItem(KEY_PREFIX + attempt.problemId, JSON.stringify(attempt));
    return storage !== undefined;
  } catch {
    return false;
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
