/**
 * 自动化「事件」触发里插件来源的勾选逻辑（纯函数）。
 * 勾选插件本身 = 该插件的全部事件（不写 events，以后插件新增的事件也会触发）；
 * 只勾部分事件时写明列表；取消最后一个事件即移除该插件。字段条件（filters）界面不编辑，原样保留。
 */
import type { SchedulePluginEventSource } from '@cindy/maker-scheduler/plugin-events';

export interface PluginEventChoice {
  plugin: string;
  events: ReadonlyArray<{ type: string }>;
}

export type PluginEventCheckState = 'all' | 'some' | 'none';

export function pluginCheckState(sources: readonly SchedulePluginEventSource[], plugin: string): PluginEventCheckState {
  const source = sources.find((item) => item.plugin === plugin);
  if (!source) return 'none';
  return source.events?.length ? 'some' : 'all';
}

export function pluginEventChecked(sources: readonly SchedulePluginEventSource[], plugin: string, type: string): boolean {
  const source = sources.find((item) => item.plugin === plugin);
  return Boolean(source && (!source.events?.length || source.events.includes(type)));
}

/** 勾选或取消整个插件。 */
export function setPluginSelected(
  sources: readonly SchedulePluginEventSource[],
  plugin: string,
  selected: boolean,
): SchedulePluginEventSource[] {
  const existing = sources.find((item) => item.plugin === plugin);
  if (!selected) return sources.filter((item) => item.plugin !== plugin);
  const next: SchedulePluginEventSource = { plugin, ...(existing?.filters ? { filters: existing.filters } : {}) };
  return existing ? sources.map((item) => (item.plugin === plugin ? next : item)) : [...sources, next];
}

/** 勾选或取消插件里的一种事件。全部勾上时收成“全部事件”。 */
export function setPluginEventSelected(
  sources: readonly SchedulePluginEventSource[],
  choice: PluginEventChoice,
  type: string,
  selected: boolean,
): SchedulePluginEventSource[] {
  const declared = choice.events.map((event) => event.type);
  const existing = sources.find((item) => item.plugin === choice.plugin);
  const current = new Set(existing ? (existing.events?.length ? existing.events : declared) : []);
  if (selected) current.add(type);
  else current.delete(type);
  if (!current.size) return sources.filter((item) => item.plugin !== choice.plugin);
  const all = declared.length > 0 && declared.every((name) => current.has(name)) && current.size === declared.length;
  const next: SchedulePluginEventSource = {
    plugin: choice.plugin,
    ...(all ? {} : { events: declared.filter((name) => current.has(name)).concat([...current].filter((name) => !declared.includes(name))) }),
    ...(existing?.filters ? { filters: existing.filters } : {}),
  };
  return existing ? sources.map((item) => (item.plugin === choice.plugin ? next : item)) : [...sources, next];
}
