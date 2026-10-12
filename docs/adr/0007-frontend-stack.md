# ADR 0007 — Frontend stack

**Status:** accepted · 2026-10-12

## Decision
- Vite SPA, React 19, React Flow 12, Tailwind v4.
- Headless accessible primitives.
- Zustand for UI state.
- An immutable `Attempt` edited through commands, with Immer patches for undo/redo.
- pnpm workspaces, Biome, Vitest, Playwright.
- Pinned to stable majors: TypeScript 6.0 and Vitest 4. TypeScript 7 (the native port) and Vitest 5 are adopted later.

## Rejected
- **Next.js:** no SSR or SEO need, and it adds hydration complexity.
- **tldraw:** not MIT-licensed, and its free-form canvas does not fit evaluable structure.
- **Excalidraw:** free-form only.
- **Using React Flow's node array as the domain model:** this was the root cause of the original project's limits.
