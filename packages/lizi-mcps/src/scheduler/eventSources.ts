import type { SchedulerMcpDeps } from '../types.js';
import type { SchedulerToolRegistry } from '../cindy_schedulerToolRegistry.js';
import { withScheduler } from './_shared.js';

/**
 * schedule_list_event_sources: the plugin events an automation on this computer can choose.
 * Rules: docs/product-rules/plugin-event-triggers.md.
 */
export function registerScheduleListEventSourcesTool(registry: SchedulerToolRegistry, deps: SchedulerMcpDeps): void {
  const list = deps.pluginEventSources;
  if (!list) return;
  registry.register({
    name: 'schedule_list_event_sources',
    category: 'scheduler',
    description:
      '列出本机可用作自动化触发来源的插件事件：插件 id、名称、监听状态（listening / disconnected / error / stopped / unknown）、'
      + '声明的事件类型和可用于 filters 的字段。只含本机已启用的插件。用于 schedule_create / schedule_update 的 '
      + 'webhookTrigger.source={preset:"plugin",sources:[{plugin,events,filters}]}，不要猜事件名。',
    inputShape: {},
    handler: () => withScheduler(deps, async () => ({ sources: await list() })),
  });
}
