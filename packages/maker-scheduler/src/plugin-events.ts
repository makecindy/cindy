/**
 * 插件事件来源：插件经 `routine-request` 发布的事件叫醒用户选定的自动化。
 * 事件只是门铃：只保存有界的元数据，要不要处理由自动化自己的条件、前置检查和提示词决定，
 * 宿主不替用户丢弃任何事件（包括自动化自己发出的消息）。规则见
 * docs/product-rules/plugin-event-triggers.md。不依赖 Node，Renderer 也会引用。
 */
import type { ScheduleWebhookEvent } from './types.js';

export const PLUGIN_EVENT_LIMITS = {
  /** 一个自动化最多选多少个插件来源。 */
  sources: 16,
  /** 每个来源最多选多少种事件。 */
  eventsPerSource: 32,
  /** 每个来源最多多少条字段条件。 */
  filtersPerSource: 16,
  filterValueChars: 500,
  /** 进入队列与提示词的字段总预算（按字符计），超出部分丢弃并标记。 */
  persistedFieldChars: 4_000,
  persistedFieldValueChars: 1_000,
  subjectChars: 200,
} as const;

export const PLUGIN_EVENT_FILTER_OPERATORS = ['equals', 'contains', 'not-equals'] as const;
export type PluginEventFilterOperator = (typeof PLUGIN_EVENT_FILTER_OPERATORS)[number];

/** 同一来源内的条件全部满足才算命中（AND）。字段缺失时 equals / contains 不命中，not-equals 命中。 */
export interface SchedulePluginEventFilter {
  field: string;
  operator: PluginEventFilterOperator;
  value: string;
}

export interface SchedulePluginEventSource {
  /** 插件安装身份（与前置检查的 pluginId 相同），不是显示名。 */
  plugin: string;
  /** 插件声明的事件类型；缺省或空列表响应该插件的全部事件。 */
  events?: string[];
  filters?: SchedulePluginEventFilter[];
}

/** 插件发布的单个事件，经宿主校验后交给 toPluginWebhookEvent。 */
export interface PluginPublishedEvent {
  id: string;
  type: string;
  occurredAt: number;
  subject?: string;
  data: Record<string, string | number | boolean>;
}

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));

/** 事件里记录的来源，由宿主根据真实插件身份生成，插件不能自报。 */
export function pluginEventSourceId(plugin: string): string {
  return `plugin:${plugin}`;
}

function normalizeFilter(value: unknown): SchedulePluginEventFilter {
  if (!isObject(value) || !hasOnlyKeys(value, ['field', 'operator', 'value'])) throw new Error('invalid plugin event filter');
  const { field, operator, value: expected } = value;
  if (typeof field !== 'string' || !NAME.test(field)) throw new Error('invalid plugin event filter field');
  if (!(PLUGIN_EVENT_FILTER_OPERATORS as readonly unknown[]).includes(operator)) throw new Error('invalid plugin event filter operator');
  if (typeof expected !== 'string' || expected.length > PLUGIN_EVENT_LIMITS.filterValueChars) {
    throw new Error('invalid plugin event filter value');
  }
  return { field, operator: operator as PluginEventFilterOperator, value: expected };
}

/** 校验调用方提交的插件来源列表；同一插件只保留一项。 */
export function normalizePluginEventSources(value: unknown): SchedulePluginEventSource[] {
  if (!Array.isArray(value) || !value.length || value.length > PLUGIN_EVENT_LIMITS.sources) {
    throw new Error(`Plugin events require 1–${PLUGIN_EVENT_LIMITS.sources} plugin sources`);
  }
  const seen = new Set<string>();
  return value.map((item) => {
    if (!isObject(item) || !hasOnlyKeys(item, ['plugin', 'events', 'filters'])) throw new Error('invalid plugin event source');
    const { plugin, events, filters } = item;
    if (typeof plugin !== 'string' || !plugin.trim() || plugin.length > 512) throw new Error('invalid plugin event source plugin');
    const id = plugin.trim();
    if (seen.has(id)) throw new Error('duplicate plugin event source');
    seen.add(id);
    if (events !== undefined && (!Array.isArray(events) || events.length > PLUGIN_EVENT_LIMITS.eventsPerSource
      || events.some((name) => typeof name !== 'string' || !NAME.test(name)))) {
      throw new Error('invalid plugin event types');
    }
    if (filters !== undefined && (!Array.isArray(filters) || filters.length > PLUGIN_EVENT_LIMITS.filtersPerSource)) {
      throw new Error('invalid plugin event filters');
    }
    const types = [...new Set((events as string[] | undefined) ?? [])];
    const conditions = ((filters as unknown[] | undefined) ?? []).map(normalizeFilter);
    return { plugin: id, ...(types.length ? { events: types } : {}), ...(conditions.length ? { filters: conditions } : {}) };
  });
}

function filterMatches(filter: SchedulePluginEventFilter, fields: ScheduleWebhookEvent['fields']): boolean {
  const actual = fields && Object.hasOwn(fields, filter.field) ? fields[filter.field] : undefined;
  if (filter.operator === 'not-equals') return actual === undefined || String(actual) !== filter.value;
  if (actual === undefined) return false;
  const text = String(actual);
  return filter.operator === 'equals' ? text === filter.value : text.toLowerCase().includes(filter.value.toLowerCase());
}

/** 事件是否命中任一来源（OR）；来源内事件类型与条件同时满足（AND）。 */
export function pluginEventMatches(sources: readonly SchedulePluginEventSource[], event: ScheduleWebhookEvent): boolean {
  return sources.some((source) => event.source === pluginEventSourceId(source.plugin)
    && (!source.events?.length || source.events.includes(event.event))
    && (source.filters ?? []).every((filter) => filterMatches(filter, event.fields)));
}

/** 范围是否相同：仅重排、重复项不算变化，避免无谓地清空已接收事件。 */
export function samePluginEventScope(
  a: readonly SchedulePluginEventSource[],
  b: readonly SchedulePluginEventSource[],
): boolean {
  const canonical = (sources: readonly SchedulePluginEventSource[]) => JSON.stringify(
    [...sources].map((source) => [
      source.plugin,
      [...new Set(source.events ?? [])].sort(),
      (source.filters ?? []).map((filter) => [filter.field, filter.operator, filter.value]).sort((x, y) =>
        JSON.stringify(x).localeCompare(JSON.stringify(y))),
    ]).sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
  );
  return canonical(a) === canonical(b);
}

/**
 * 把插件事件转成队列里的门铃记录。字段按预算截断：队列落盘、提示词注入都基于这份有界副本，
 * 插件需要传更多内容时应让任务自己用插件工具去读。
 */
export function toPluginWebhookEvent(plugin: string, event: PluginPublishedEvent, receivedAt: number): ScheduleWebhookEvent {
  let budget: number = PLUGIN_EVENT_LIMITS.persistedFieldChars;
  let truncated = false;
  const fields: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(event.data)) {
    const cost = key.length + (typeof value === 'string' ? Math.min(value.length, PLUGIN_EVENT_LIMITS.persistedFieldValueChars) : String(value).length);
    if (cost > budget) {
      truncated = true;
      continue;
    }
    budget -= cost;
    if (typeof value === 'string' && value.length > PLUGIN_EVENT_LIMITS.persistedFieldValueChars) {
      truncated = true;
      Object.defineProperty(fields, key, { value: value.slice(0, PLUGIN_EVENT_LIMITS.persistedFieldValueChars), enumerable: true, configurable: true, writable: true });
    } else {
      Object.defineProperty(fields, key, { value, enumerable: true, configurable: true, writable: true });
    }
  }
  const subject = event.subject?.trim().slice(0, PLUGIN_EVENT_LIMITS.subjectChars);
  return {
    // 不同插件可能使用相同的上游 ID；加上来源避免互相判为重复。
    deliveryId: `${pluginEventSourceId(plugin)}:${event.id}`,
    event: event.type,
    receivedAt,
    source: pluginEventSourceId(plugin),
    occurredAt: event.occurredAt,
    ...(subject ? { subject } : {}),
    ...(Object.keys(fields).length ? { fields } : {}),
    ...(truncated ? { fieldsTruncated: true as const } : {}),
  };
}

type SubscribingSchedule = {
  status: string;
  expireAt?: number;
  webhookTrigger?: { source?: { preset: string; sources?: readonly SchedulePluginEventSource[] } };
};

/** 插件看到的一条订阅：只有事件类型与条件，不含自动化身份、名称或提示词。 */
export interface PluginEventSubscription {
  events?: string[];
  filters?: SchedulePluginEventFilter[];
}

/** 每个插件最多返回多少条去重后的订阅。 */
export const PLUGIN_EVENT_SUBSCRIPTIONS_PER_PLUGIN = 200;

/**
 * 启用中的自动化按插件汇总的订阅（相同的事件与条件只保留一条）。插件可据此只去盯被订阅的对象，
 * 例如 GitLab 插件只轮询自动化选中的项目或 MR；要不要处理仍由自动化决定。
 */
export function pluginEventSubscriptions(schedules: readonly SubscribingSchedule[], now = Date.now()): Map<string, PluginEventSubscription[]> {
  const result = new Map<string, PluginEventSubscription[]>();
  const seen = new Map<string, Set<string>>();
  for (const schedule of schedules) {
    const source = schedule.webhookTrigger?.source;
    if (schedule.status !== 'active' || (schedule.expireAt !== undefined && schedule.expireAt <= now)) continue;
    if (source?.preset !== 'plugin') continue;
    for (const item of source.sources ?? []) {
      const list = result.get(item.plugin) ?? [];
      const keys = seen.get(item.plugin) ?? new Set<string>();
      result.set(item.plugin, list);
      seen.set(item.plugin, keys);
      const events = [...new Set(item.events ?? [])].sort();
      const filters = (item.filters ?? []).map((filter) => ({ field: filter.field, operator: filter.operator, value: filter.value }))
        .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
      const key = JSON.stringify([events, filters]);
      if (keys.has(key) || list.length >= PLUGIN_EVENT_SUBSCRIPTIONS_PER_PLUGIN) continue;
      keys.add(key);
      list.push({ ...(events.length ? { events } : {}), ...(filters.length ? { filters } : {}) });
    }
  }
  return result;
}

/** 至少有一个启用中的自动化订阅了哪些插件：宿主据此决定保持哪些插件在监听。 */
export function subscribedEventPlugins(schedules: readonly SubscribingSchedule[], now = Date.now()): Set<string> {
  return new Set(pluginEventSubscriptions(schedules, now).keys());
}
