import { ACTIONS, type ActionId, actionTakesParam, type CallStep } from "@archdrill/model";
import { activePack } from "../../state/content";
import { Field, INPUT_CLASS, Select } from "../../ui/primitives";

/** Call parameters a candidate tunes, as they are stored on a step. */
export type TunableValues = Partial<
  Pick<
    CallStep,
    | "ttlSec"
    | "batchSize"
    | "coalesce"
    | "consistent"
    | "aggregateSec"
    | "counterShards"
    | "fireAndForget"
    | "bufferSize"
    | "each"
    | "idempotencyKey"
    | "outbox"
  >
>;

const MAX_BATCH = 1_000_000;
const MAX_WINDOW_SEC = 3600;
const MAX_COUNTER_SHARDS = 1024;
const MAX_BUFFER = 100_000_000;

/** Batched allocation fetches keys ahead; other batches collect items, which wait for the batch. */
export const prefetches = (action: ActionId) => ACTIONS[action].effect === "allocate";

/**
 * Whether a step can batch: background work can wait for a batch to fill;
 * a request cannot, unless it prefetches keys or hands messages off.
 */
export function batchable(action: ActionId, values: TunableValues, background: boolean): boolean {
  return (
    actionTakesParam(action, "batchSize") &&
    (background || prefetches(action) || values.fireAndForget === true || values.each !== undefined)
  );
}

/**
 * The parameters a step's action takes, filtered to what a step in this kind
 * of flow can use, without the ones that do not apply.
 */
export function applicableParams(
  action: ActionId,
  values: TunableValues,
  background: boolean,
): TunableValues {
  const takes = (param: keyof TunableValues) => actionTakesParam(action, param);
  return {
    ...(takes("ttlSec") && values.ttlSec !== undefined ? { ttlSec: values.ttlSec } : {}),
    ...(takes("coalesce") && values.coalesce ? { coalesce: true } : {}),
    ...(takes("consistent") && values.consistent ? { consistent: true } : {}),
    ...(takes("fireAndForget") && values.fireAndForget ? { fireAndForget: true } : {}),
    ...(takes("bufferSize") && values.fireAndForget && values.bufferSize !== undefined
      ? { bufferSize: values.bufferSize }
      : {}),
    ...(takes("aggregateSec") && background && values.aggregateSec !== undefined
      ? { aggregateSec: values.aggregateSec }
      : {}),
    ...(takes("each") && values.each !== undefined ? { each: values.each } : {}),
    ...(takes("idempotencyKey") && values.idempotencyKey ? { idempotencyKey: true } : {}),
    ...(takes("outbox") && values.outbox && !values.fireAndForget ? { outbox: true } : {}),
    ...(takes("counterShards") && (values.counterShards ?? 1) > 1
      ? { counterShards: values.counterShards }
      : {}),
    ...(batchable(action, values, background) && (values.batchSize ?? 1) > 1
      ? { batchSize: values.batchSize }
      : {}),
  };
}

/** Fields for a call step's tunable parameters. */
export function StepParams({
  action,
  values,
  onChange,
  background,
}: {
  readonly action: ActionId;
  readonly values: TunableValues;
  readonly onChange: (values: TunableValues) => void;
  /** A consumer or a job, which can wait for windows and batches. */
  readonly background: boolean;
}) {
  const takes = (param: keyof TunableValues) => actionTakesParam(action, param);
  const set = (patch: TunableValues) => onChange({ ...values, ...patch });
  const counts = activePack.problem.counts;
  return (
    <>
      {takes("each") && counts.length > 0 && (
        <Field label="Once for each (in parallel)">
          <Select
            value={values.each ?? ""}
            onChange={(e) => set({ each: e.target.value === "" ? undefined : e.target.value })}
          >
            <option value="">Once per request</option>
            {counts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {takes("idempotencyKey") && (
        <Check
          label="Send an idempotency key, so a repeat is acted on once"
          checked={values.idempotencyKey === true}
          onChange={(idempotencyKey) => set({ idempotencyKey })}
        />
      )}
      {takes("outbox") && (
        <Check
          label="Through a transactional outbox, with the store write before it"
          checked={values.outbox === true}
          onChange={(outbox) => set({ outbox, ...(outbox ? { fireAndForget: false } : {}) })}
        />
      )}
      {takes("fireAndForget") && !values.outbox && (
        <Check
          label="Fire-and-forget: hand the message to a local buffer and continue"
          checked={values.fireAndForget === true}
          onChange={(fireAndForget) => set({ fireAndForget })}
        />
      )}
      {takes("bufferSize") && values.fireAndForget && (
        <NumberField
          label="Buffer (messages kept while the queue is unreachable; empty for no bound)"
          value={values.bufferSize}
          max={MAX_BUFFER}
          onChange={(bufferSize) => set({ bufferSize })}
        />
      )}
      {takes("coalesce") && (
        <Check
          label="Coalesce concurrent reads of a key (single-flight)"
          checked={values.coalesce === true}
          onChange={(coalesce) => set({ coalesce })}
        />
      )}
      {takes("consistent") && (
        <Check
          label="Consistent read (sees every acknowledged write; costs primary capacity or a full read unit)"
          checked={values.consistent === true}
          onChange={(consistent) => set({ consistent })}
        />
      )}
      {takes("aggregateSec") && background && (
        <NumberField
          label="Aggregation window (seconds; sum per key, then write once; empty to write each item)"
          value={values.aggregateSec}
          max={MAX_WINDOW_SEC}
          onChange={(aggregateSec) => set({ aggregateSec })}
        />
      )}
      {takes("counterShards") && (
        <NumberField
          label="Counter shards (rows each key's count is spread over; empty for one)"
          value={values.counterShards}
          min={2}
          max={MAX_COUNTER_SHARDS}
          onChange={(counterShards) => set({ counterShards })}
        />
      )}
      {batchable(action, values, background) && (
        <NumberField
          label={
            prefetches(action)
              ? "Batch size (keys per call; 1 = every request)"
              : values.fireAndForget
                ? "Batch size (messages per call, sent in the background)"
                : values.each !== undefined
                  ? "Batch size (this request's calls per batch)"
                  : "Batch size (items per call; items wait for the batch to fill)"
          }
          value={values.batchSize ?? 1}
          max={MAX_BATCH}
          onChange={(batchSize) => set({ batchSize })}
        />
      )}
      {takes("ttlSec") && (
        <NumberField
          label="TTL (seconds)"
          value={values.ttlSec}
          onChange={(ttlSec) => set({ ttlSec })}
        />
      )}
    </>
  );
}

function Check({
  label,
  checked,
  onChange,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-fg">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/** A whole number, or nothing when the field is left empty. */
function NumberField({
  label,
  value,
  min = 1,
  max,
  onChange,
}: {
  readonly label: string;
  readonly value: number | undefined;
  readonly min?: number;
  readonly max?: number;
  readonly onChange: (value: number | undefined) => void;
}) {
  return (
    <Field label={label}>
      <input
        type="number"
        min={min}
        max={max}
        value={value ?? ""}
        onChange={(e) => {
          if (e.target.value === "") return onChange(undefined);
          const n = Math.round(Number(e.target.value));
          onChange(Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min, n)));
        }}
        className={INPUT_CLASS}
      />
    </Field>
  );
}

const TUNABLE: readonly (keyof TunableValues)[] = [
  "each",
  "idempotencyKey",
  "outbox",
  "ttlSec",
  "batchSize",
  "coalesce",
  "consistent",
  "aggregateSec",
  "counterShards",
  "fireAndForget",
  "bufferSize",
];

/** Whether an action has any parameter worth an editor. */
export function hasTunableParams(action: ActionId): boolean {
  return TUNABLE.some((param) => actionTakesParam(action, param));
}

/**
 * The update that makes a step's parameters `values`: each parameter its
 * action takes is set, or removed (null) when it no longer applies.
 */
export function paramsUpdate(
  action: ActionId,
  values: TunableValues,
  background: boolean,
): { [K in keyof TunableValues]: TunableValues[K] | null } {
  const applicable = applicableParams(action, values, background);
  return Object.fromEntries(
    TUNABLE.filter((param) => actionTakesParam(action, param)).map((param) => [
      param,
      applicable[param] ?? null,
    ]),
  );
}
