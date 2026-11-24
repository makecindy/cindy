/**
 * 插件事件来源与自动化之间的进程内交接：插件管子（cindy-brain/routineSlot.ts）上报监听状态、
 * 发布事件；Webhook 宿主（index.ts）登记哪些插件被启用的自动化订阅，并接收事件入队。
 * 两边不直接依赖，避免插件运行时与调度器互相加载。规则见 docs/product-rules/plugin-event-triggers.md。
 */
import type { PluginEventSubscription, PluginPublishedEvent } from '@cindy/maker-scheduler';

export type PluginEventListenState = 'listening' | 'disconnected' | 'error';

/** 自动化详情里显示的单个插件来源状态。 */
export interface PluginEventSourceStatus {
  plugin: string;
  /** stopped：插件没在运行（未安装、已停用或尚未启动）；其余为插件最近一次上报。 */
  state: PluginEventListenState | 'stopped' | 'unknown';
  reportedAt?: number;
  lastEventAt?: number;
}

export interface PluginEventPublishResult {
  /** 进入了多少个自动化的队列。 */
  accepted: number;
  /** 所有匹配的自动化都已收过这条投递。 */
  duplicate: boolean;
}

type Sink = (plugin: string, event: PluginPublishedEvent) => Promise<PluginEventPublishResult>;

const reports = new Map<string, { state: PluginEventListenState; reportedAt: number }>();
const lastEvents = new Map<string, number>();
let subscribed = new Set<string>();
let subscriptionDetails = new Map<string, PluginEventSubscription[]>();
const subscriptionListeners = new Set<(plugins: ReadonlySet<string>) => void>();
const statusListeners = new Set<() => void>();
let sink: Sink | null = null;
let isRunning: ((plugin: string) => boolean) | null = null;

/** 插件上报监听状态。返回是否有变化：未变化时不广播。 */
export function reportPluginEventStatus(plugin: string, state: PluginEventListenState, now = Date.now()): boolean {
  if (reports.get(plugin)?.state === state) return false;
  reports.set(plugin, { state, reportedAt: now });
  for (const listener of statusListeners) listener();
  return true;
}

/** 插件停止、停用或卸载后，旧的“正在监听”不能继续显示。 */
export function forgetPluginEventStatus(plugin: string): void {
  if (!reports.delete(plugin)) return;
  for (const listener of statusListeners) listener();
}

export function onPluginEventStatusChanged(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

/** 插件运行时提供“这个插件现在是否在运行”，用于区分停止与最近一次上报。 */
export function setPluginRuntimeProbe(probe: ((plugin: string) => boolean) | null): void {
  isRunning = probe;
}

export function pluginEventSourceStatus(plugin: string): PluginEventSourceStatus {
  const report = reports.get(plugin);
  const lastEventAt = lastEvents.get(plugin);
  const running = isRunning?.(plugin);
  return {
    plugin,
    state: running === false ? 'stopped' : report?.state ?? 'unknown',
    ...(report ? { reportedAt: report.reportedAt } : {}),
    ...(lastEventAt ? { lastEventAt } : {}),
  };
}

/**
 * Webhook 宿主登记各插件的订阅（只有事件类型与条件）：插件经 `routine-request` 的 subscriptions
 * 读取，用来决定盯哪些对象；被订阅的插件集合变化时通知插件运行时启动监听。
 */
export function setPluginEventSubscriptions(next: ReadonlyMap<string, PluginEventSubscription[]>): void {
  subscriptionDetails = new Map(next);
  setSubscribedEventPlugins(new Set(next.keys()));
}

/** 某插件当前的订阅副本；没有自动化选择它时为空列表。 */
export function pluginEventSubscriptionsFor(plugin: string): PluginEventSubscription[] {
  return (subscriptionDetails.get(plugin) ?? []).map((item) => ({
    ...(item.events ? { events: [...item.events] } : {}),
    ...(item.filters ? { filters: item.filters.map((filter) => ({ ...filter })) } : {}),
  }));
}

function setSubscribedEventPlugins(plugins: ReadonlySet<string>): void {
  if (plugins.size === subscribed.size && [...plugins].every((plugin) => subscribed.has(plugin))) return;
  subscribed = new Set(plugins);
  for (const listener of subscriptionListeners) listener(subscribed);
}

export function subscribedEventPluginIds(): ReadonlySet<string> {
  return subscribed;
}

export function onSubscribedEventPluginsChanged(listener: (plugins: ReadonlySet<string>) => void): () => void {
  subscriptionListeners.add(listener);
  return () => subscriptionListeners.delete(listener);
}

/** 登记事件接收入口；返回的释放函数只在入口仍是自己时清除，换账号时旧宿主迟到的停止不影响新宿主。 */
export function setPluginEventSink(next: Sink): () => void {
  sink = next;
  return () => {
    if (sink !== next) return;
    sink = null;
    setPluginEventSubscriptions(new Map());
  };
}

/**
 * 把插件事件交给自动化队列。没有宿主（被动实例、尚未启动或已停止）时返回 0 个接收：
 * 事件已经校验，只是没有自动化可以处理，插件不需要重试。
 */
export async function publishPluginEvent(plugin: string, event: PluginPublishedEvent): Promise<PluginEventPublishResult> {
  if (!sink) return { accepted: 0, duplicate: false };
  const result = await sink(plugin, event);
  lastEvents.set(plugin, Date.now());
  return result;
}

/** 仅测试使用。 */
export function resetPluginEventsForTest(): void {
  reports.clear();
  lastEvents.clear();
  subscribed = new Set();
  subscriptionDetails = new Map();
  subscriptionListeners.clear();
  statusListeners.clear();
  sink = null;
  isRunning = null;
}
