# 06 — Software architecture

## Stack

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript (strict) everywhere | One language for model, engine, evaluator, and UI. Evaluation runs in the browser with no round-trips. |
| App | **Vite** SPA + **React 19** | This is an editor: there is no SSR or SEO need. A plain SPA avoids hydration complexity. |
| Canvas | **@xyflow/react** (React Flow 12) | MIT; purpose-built for structured node/edge graphs; custom nodes and edges; mature |
| UI primitives | Tailwind CSS v4 + accessible headless primitives (Radix/Base UI via shadcn-style components) | Speed of building a dense editor UI without hand-rolling popovers, dialogs, and menus |
| UI state | **Zustand** | Small and predictable. Only for UI state (selection, panels, mode). |
| Domain state | Immutable `Attempt` document edited through **commands**. **Immer** patches give undo/redo and change summaries. | The domain model is not React Flow's node array. React Flow renders a *projection* of it. |
| Schemas | **Zod 4** | Runtime validation of content and imports; types inferred from schemas |
| Content | YAML problem packs → compiled and validated at build time → JSON | Authoring is not coding. The bundle ships no YAML parser. |
| Engine execution | Web Worker with a typed message protocol (Comlink if it stays thin) | Keeps the UI responsive; evaluation is debounced and cancellable |
| Persistence | IndexedDB (`idb`) + versioned JSON export/import | Local-first; no backend in v0.1 |
| Unit and property tests | **Vitest** + **fast-check** | Fast; same toolchain as Vite |
| E2E | Playwright | Critical flows: build, record, evaluate, fix |
| Lint and format | **Biome** | One fast tool instead of ESLint + Prettier |
| Package manager | **pnpm** workspaces | Strict, fast, good monorepo ergonomics |
| CI and hosting | GitHub Actions; the static production build published to GitHub Pages, carrying in the page the security policy the local preview sends as headers | Simple and free; one content security policy everywhere |

Version policy: use current stable majors that have had at least a few months of adoption. At the time of writing that means TypeScript 6.0, Vite 8, Vitest 4, React 19, Zod 4, React Flow 12, and Zustand 5. TypeScript 7 (the native port) and Vitest 5 are tracked and adopted once the ecosystem settles.

## Repository layout

```
archdrill/
├── apps/
│   └── web/                  Vite + React app (canvas, panels, worker client)
├── packages/
│   ├── model/                Zod schemas, types, validators, commands, migrations
│   ├── engine/               analysis (paths, facts) + analytic simulation; later des/
│   ├── evaluator/            check library, strategy registry, scoring, feedback
│   └── content/              catalog + problem packs (YAML), build-time compiler,
│                             golden designs, mutant expectations
├── docs/                     design docs, ADRs, problem design notes
└── .github/workflows/        CI
```

### Dependency rules

```
model  ←  engine  ←  evaluator  ←  apps/web
  ↑                      ↑
  └──────  content  ─────┘   (content depends on model schemas; evaluator tests use content)
```

- `model`, `engine`, and `evaluator` are **framework-free**: no React and no DOM. They run in Node (tests, CI tooling) and in a Web Worker.
- `apps/web` is the only package that knows about React and React Flow.
- No package imports from `apps/*`.
- Packages are consumed as TypeScript source through workspace `exports`. There is no separate build step for internal packages, and Vite and Vitest compile them.

## Data flow at runtime

```
user action
  → command (pure: Attempt → Attempt, plus Immer patches)      [main thread]
  → attempt store updates → React Flow projection re-renders
  → debounced evaluate(attempt, problem) posted to worker
        worker: validate → analyse → simulate (per scenario environment) → check → score
  → results store (per scenario) → results dock, canvas heat, rail badges, regression toasts
```

- Evaluation results are memoised per `(attemptHash, scenarioId, engineVersion)`.
- A new edit cancels any in-flight evaluation.

**As built (M7).**

- **The worker.** Evaluation runs in a module worker (`apps/web/src/state/evaluation.worker.ts`).
  - The first evaluation runs once on the main thread at startup, so the first screen has results.
  - While the worker runs, the previous results stay on screen, marked *Updating…*.
  - The worker cannot be interrupted mid-evaluation. Edits made while it runs are coalesced: only the latest design is evaluated next.
- **Fallback.** Without workers (tests, a policy that forbids them) or after a worker error, evaluation runs synchronously on the main thread.
- **Memoisation.** Results are memoised by reference on the evaluated parts of the attempt (architecture, flows, decisions), so moving nodes never re-evaluates.

## Persistence and versioning

- **Schema versions.** `Attempt.schemaVersion` is an integer. `packages/model/migrations/` holds `vN → vN+1` pure functions, each with fixture tests.
- **Content versions.** Problem packs carry their own version. Attempts store the problem version they were made against, and the UI warns if content has changed since.
- **Export envelope.** `{ format: "archdrill-attempt", schemaVersion, problemId, problemVersion, attempt }`. Import is validated with Zod and migrated.

## Testing strategy

| Layer | Tests |
|---|---|
| `model` | schema fixtures (valid and invalid), validators, commands (including undo via patches), migrations |
| `engine` | path enumeration on fixture flows, facts, queueing math vs closed form, cache model vs reference values, fixed-point convergence and divergence, determinism, property tests |
| `evaluator` | every check: pass, fail, and n/a fixtures; strategy recognition; scoring arithmetic; property tests (bounds, monotonicity) |
| `content` | every problem pack validates; **golden corpus** meets expected bands; **mutant corpus** fails expected checks (mutation report) |
| `web` | component tests for recorder and inspector logic; Playwright E2E for the core loop |

Coverage target: 80%+ for `model`, `engine`, and `evaluator`, where correctness lives. The UI relies on E2E tests for the critical paths.

## CI

Every pull request runs:

1. install;
2. Biome check;
3. `tsc` (all packages);
4. unit and property tests;
5. content compile;
6. golden and mutant suites;
7. web build;
8. Playwright smoke tests (once E2E exists).

The mutation report and the engine golden-numbers diff are uploaded as artefacts.

## Performance budgets

| Operation | Budget |
|---|---|
| Static analysis + analytic evaluation of all scenarios, 30 components, about 10 flows | p95 < 100 ms in the worker |
| DES scenario run | < 2 s |
| Canvas interaction with 100 nodes | 60 fps; no evaluation on the main thread |
| Initial load | < 300 KB gzipped JS before the canvas route chunk |

**Verified (M7).**

- `pnpm report` measures the first budget on every golden design padded to 30 components, after JIT warm-up.
  - Locally: p95 54–64 ms for the two designs that pass every scenario.
  - CI enforced 250 ms, because shared runners are slower and noisier. Since M25 the times are corrected for the machine instead: a fixed reference workload, independent of the engine, is timed between the evaluations, and each p95 is divided by how much longer it took than on the machine the budgets were set on. Raw times on shared runners vary by half from run to run; corrected ones vary by about 10%. CI checks the corrected p95 against 130 ms (2,600 ms with timelines), 30% over the target.
- The canvas no longer evaluates on the main thread.
- Initial load: 244 KB gzipped JS. Libraries are in separate cached chunks: React 68 KB, React Flow 57 KB, others 36 KB.
- The evaluation worker (about 90 KB gzipped) loads alongside the page.

## Error handling

- Validation errors are data: located, displayed, and never thrown to the UI.
- Engine invariants that should be impossible throw `EngineInvariantError` carrying context. The worker reports them as an "internal error" with a copyable diagnostic bundle (attempt plus scenario plus engine version), never as a silent zero score.
- Imports that fail validation show the Zod issue paths in plain language.
