import type { PreRunHookConfig } from "./types.js";
import { nextRun } from "./engine/cron.js";

/** Sources describe events, independently of the connector transporting them. */
export interface RoutineSource {
  id: string;
  name: string;
  events: Array<{ type: string; name: string; fields: string[] }>;
  status: "listening" | "disconnected" | "error";
  lastEventAt?: number;
}

/** The host supplies source identity; publishers cannot choose a target Bot or prompt. */
export interface RoutineEvent {
  id: string;
  type: string;
  occurredAt: number;
  subject?: string;
  data: Record<string, string | number | boolean>;
  originRoutineId?: string;
}

export type RoutineTrigger =
  | { id: string; kind: "cron"; expression: string; timezone: string }
  | { id: string; kind: "interval"; intervalMs: number; anchorMs?: number }
  | { id: string; kind: "once"; at: number }
  | {
      id: string;
      kind: "event";
      sourceId: string;
      eventType: string;
      filters: Array<{
        field: string;
        operator: "equals" | "contains" | "not-equals";
        value: string;
      }>;
    };

/** Host-owned rules: per-teammate follow-up, the owner-enabled daily todo check, and nightly learning. */
export type RoutineBuiltin = "follow-up" | "todo-check" | "nightly-learning";

/** Stable error prefix for attempts to delete or rewrite a host-owned routine. */
export const BUILTIN_ROUTINE_ERROR = "BUILTIN_ROUTINE";

/** A single standing instruction, with OR-combined time and event triggers. */
export interface Routine {
  /** Derived by the engine, never accepted as configuration. */
  activity?: "queued" | "running";
  id: string;
  botId: string;
  name: string;
  prompt: string;
  enabled: boolean;
  triggers: RoutineTrigger[];
  /** Omitted on legacy rules: preserve their existing silent behavior; new omissions persist false. */
  silentWhenIdle?: boolean;
  /** null explicitly removes the check; omission preserves it on older clients. */
  preRunHook?: PreRunHookConfig | null;
  /**
   * 宿主内置规则（每个伙伴一条的「跟进」与「夜间学习」，以及主人在近况里打开的「每天查待办」）。由宿主模板生成，不接受用户/模型
   * 改写指令与触发条件、不能删除，只能暂停（enabled）。可选字段：旧数据与旧客户端缺省即普通规则，
   * state 版本不变。
   */
  builtin?: RoutineBuiltin;
  /**
   * 内置规则的宿主模板版本（可选，只由 ensureBuiltin 写）。版本变化时 ensure 一定重写规则；
   * 旧数据缺省视为与任何显式版本不同，下次 ensure 补写。
   */
  builtinVersion?: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export type RoutineInput = Pick<
  Routine,
  "name" | "prompt" | "enabled" | "triggers" | "silentWhenIdle" | "preRunHook"
>;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object");
  return value as Record<string, unknown>;
}

function string(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`Expected nonempty text of at most ${max} characters`);
  }
  return value;
}

/** Validate on the host boundary as well as when restoring persisted definitions. */
export function parseRoutineInput(value: unknown): RoutineInput {
  const input = record(value);
  if (typeof input.enabled !== "boolean")
    throw new Error("enabled must be boolean");
  if (
    !Array.isArray(input.triggers) ||
    (input.enabled && input.triggers.length < 1) ||
    input.triggers.length > 32
  ) {
    throw new Error("An enabled routine requires between 1 and 32 triggers; disabled drafts allow none");
  }
  const triggers = input.triggers.map((raw): RoutineTrigger => {
    const trigger = record(raw);
    const id = string(trigger.id, 128);
    if (trigger.kind === "cron") {
      const expression = string(trigger.expression, 128);
      const timezone = string(trigger.timezone, 128);
      nextRun(expression, Date.now(), timezone);
      return { id, kind: "cron", expression, timezone };
    }
    if (trigger.kind === "interval") {
      if (
        !Number.isSafeInteger(trigger.intervalMs) ||
        Number(trigger.intervalMs) < 60_000
      ) {
        throw new Error("Interval must be an integer of at least one minute");
      }
      if (trigger.anchorMs !== undefined && (!Number.isSafeInteger(trigger.anchorMs) || Number(trigger.anchorMs) < 0))
        throw new Error("Invalid interval anchor");
      return { id, kind: "interval", intervalMs: Number(trigger.intervalMs),
        ...(trigger.anchorMs === undefined ? {} : { anchorMs: Number(trigger.anchorMs) }) };
    }
    if (trigger.kind === "once") {
      if (!Number.isSafeInteger(trigger.at) || Number(trigger.at) < 0)
        throw new Error("Invalid one-time trigger");
      return { id, kind: "once", at: Number(trigger.at) };
    }
    if (
      trigger.kind !== "event" ||
      !Array.isArray(trigger.filters) ||
      trigger.filters.length > 16
    ) {
      throw new Error("Invalid event trigger");
    }
    return {
      id,
      kind: "event",
      sourceId: string(trigger.sourceId, 200),
      eventType: string(trigger.eventType, 200),
      filters: trigger.filters.map((rawFilter) => {
        const filter = record(rawFilter);
        if (
          !["equals", "contains", "not-equals"].includes(
            String(filter.operator),
          )
        ) {
          throw new Error("Invalid filter operator");
        }
        return {
          field: string(filter.field, 128),
          operator: filter.operator as "equals" | "contains" | "not-equals",
          value: string(filter.value, 2000),
        };
      }),
    };
  });
  if (new Set(triggers.map((trigger) => trigger.id)).size !== triggers.length) {
    throw new Error("Trigger IDs must be unique");
  }
  if (input.silentWhenIdle !== undefined && typeof input.silentWhenIdle !== "boolean")
    throw new Error("silentWhenIdle must be boolean");
  let preRunHook: PreRunHookConfig | null | undefined;
  if (input.preRunHook === null) preRunHook = null;
  else if (input.preRunHook !== undefined) {
    const hook = record(input.preRunHook);
    if (hook.timeoutMs !== undefined && (!Number.isSafeInteger(hook.timeoutMs) || Number(hook.timeoutMs) <= 0))
      throw new Error("Invalid pre-run check timeout");
    preRunHook = { command: string(hook.command, 32_000),
      ...(hook.timeoutMs === undefined ? {} : { timeoutMs: Number(hook.timeoutMs) }) };
  }
  return {
    ...(input.silentWhenIdle === undefined ? {} : { silentWhenIdle: input.silentWhenIdle as boolean }),
    ...(preRunHook === undefined ? {} : { preRunHook }),
    name: string(input.name, 200),
    prompt: string(input.prompt, 100_000),
    enabled: input.enabled,
    triggers,
  };
}

/** Event payloads are bounded data, never an alternate instruction or tool call. */
export function parseRoutineEvent(value: unknown): RoutineEvent {
  const event = record(value);
  const rawData = record(event.data);
  if (Object.keys(rawData).length > 64)
    throw new Error("Too many event fields");
  const data: RoutineEvent["data"] = {};
  for (const [key, field] of Object.entries(rawData)) {
    string(key, 128);
    if (
      typeof field !== "string" &&
      typeof field !== "number" &&
      typeof field !== "boolean"
    ) {
      throw new Error(
        "Event fields must be strings, finite numbers or booleans",
      );
    }
    if (
      (typeof field === "number" && !Number.isFinite(field)) ||
      (typeof field === "string" && field.length > 8000)
    ) {
      throw new Error("Invalid event field");
    }
    Object.defineProperty(data, key, {
      value: field,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  if (JSON.stringify(data).length > 32_000)
    throw new Error("Event payload is too large");
  if (
    typeof event.occurredAt !== "number" ||
    !Number.isSafeInteger(event.occurredAt) ||
    event.occurredAt < 0
  ) {
    throw new Error("Invalid event timestamp");
  }
  return {
    id: string(event.id, 256),
    type: string(event.type, 200),
    occurredAt: event.occurredAt,
    data,
    ...(event.subject === undefined
      ? {}
      : { subject: string(event.subject, 1000) }),
    ...(event.originRoutineId === undefined
      ? {}
      : { originRoutineId: string(event.originRoutineId, 128) }),
  };
}

/** Exact source/type/scope filtering happens before any model execution. */
export function matchesRoutineEvent(
  routine: Routine,
  sourceId: string,
  event: RoutineEvent,
): string[] {
  if (!routine.enabled || event.originRoutineId === routine.id) return [];
  return routine.triggers
    .filter((trigger) => {
      if (
        trigger.kind !== "event" ||
        trigger.sourceId !== sourceId ||
        trigger.eventType !== event.type
      )
        return false;
      return trigger.filters.every((filter) => {
        const actual =
          filter.field === "subject"
            ? event.subject
            : Object.hasOwn(event.data, filter.field)
              ? event.data[filter.field]
              : undefined;
        if (actual === undefined) return false;
        switch (filter.operator) {
          case "equals":
            return String(actual) === filter.value;
          case "not-equals":
            return String(actual) !== filter.value;
          case "contains":
            return String(actual).includes(filter.value);
        }
      });
    })
    .map((trigger) => trigger.id);
}

export function nextRoutineTriggerAt(
  trigger: RoutineTrigger,
  from: number,
): number | undefined {
  if (trigger.kind === "event") return undefined;
  if (trigger.kind === "once") return trigger.at > from ? trigger.at : undefined;
  return trigger.kind === "interval"
    ? trigger.anchorMs === undefined ? from + trigger.intervalMs
      : trigger.anchorMs > from ? trigger.anchorMs
        : trigger.anchorMs + (Math.floor((from - trigger.anchorMs) / trigger.intervalMs) + 1) * trigger.intervalMs
    : nextRun(trigger.expression, from, trigger.timezone);
}
