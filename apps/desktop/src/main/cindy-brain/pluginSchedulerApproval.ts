import type { HostToolCaller } from '@cindy/mcps';
import type { ScheduleMutationGuard } from '@cindy/maker-scheduler';
import type { PluginHostToolPorts } from './hostToolSlot.js';
import { hasPluginHostToolGroupApproval } from './taskCapability.js';
import { getPluginHostToolCaller, runPluginHostToolCall } from '../mcp-integrations/hostToolCaller.js';

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const command = (value: unknown): string | undefined => {
  const text = record(value)?.command;
  return typeof text === 'string' && text.trim() ? text : undefined;
};
const hasShell = (args: Record<string, unknown>) =>
  args.executionMode === 'script' || !!(command(args.scriptConfig) || command(args.preRunHook));

/** Adds a plugin caller condition around the frozen gateway. All schedule reads
 * and writes still use the Agent's registered handlers and original policy. */
export function withPluginSchedulerApproval(id: string, ports: PluginHostToolPorts): PluginHostToolPorts {
  let caller: Extract<HostToolCaller, { kind: 'plugin' }>;
  let active = () => false;
  const noNode = () => {
    const ghost = ports.getGhost(id);
    return ghost?.approval.state !== 'approved' || !ghost.manifest.node;
  };
  const assertCurrent = () => {
    if (!active() || !hasPluginHostToolGroupApproval(ports.getGhost(id), 'scheduler')) throw new Error('PERMISSION_DENIED');
  };
  const readSchedule = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    assertCurrent();
    const runtime = ports.createRuntime('cindy_scheduler', caller);
    if (!runtime) throw new Error('HOST_NOT_READY');
    const input = { id: args.id, ...(args.device !== undefined ? { device: args.device } : {}) };
    try {
      const result = await runPluginHostToolCall({ caller, server: 'cindy_scheduler', tool: 'schedule_get',
        argsJson: JSON.stringify(input), assertCurrent }, () => runtime.call('schedule_get', input));
      assertCurrent();
      const text = result.content.find(item => item.type === 'text');
      if (!text || text.type !== 'text') throw new Error('UNSUPPORTED_CAPABILITY');
      const payload = JSON.parse(text.text) as Record<string, unknown>;
      if (payload.ok !== true) throw new Error('UNSUPPORTED_CAPABILITY');
      const remote = args.device !== undefined && args.device !== 'local';
      const group = remote && Array.isArray(payload.groups)
        ? payload.groups.map(record).find(item => item !== undefined && item.deviceId === args.device && item.ok === true) : undefined;
      if (remote && !group) throw new Error('UNSUPPORTED_CAPABILITY');
      const data = record(remote ? group!.data : payload.data);
      if (!data || data.id !== args.id) throw new Error('UNSUPPORTED_CAPABILITY');
      // schedule_get adds display-only metadata and qualifies remote task IDs;
      // the existing engine precondition compares the persisted definition.
      const { webhookStatus: _status, ...schedule } = data;
      if (remote) for (const key of ['targetSessionId', 'sessionId']) {
        const value = schedule[key], prefix = `${args.device}::`;
        if (typeof value === 'string' && value.startsWith(prefix)) schedule[key] = value.slice(prefix.length);
      }
      return schedule;
    } finally { await runtime.close(); }
  };
  const check = async (server: string, tool: string, args: Record<string, unknown>): Promise<ScheduleMutationGuard | undefined> => {
    if (server !== 'cindy_scheduler' || !noNode()) return;
    assertCurrent();
    if (tool === 'schedule_set_pre_run_hook'
      || ((tool === 'schedule_create' || tool === 'schedule_update') && hasShell(args)))
      throw new Error('UNSUPPORTED_CAPABILITY');
    // Any update can reactivate an expired schedule (e.g. recurring: true).
    // Inspect the stored definition through the existing shared read handler.
    if (tool === 'schedule_update' || tool === 'schedule_run_now' || tool === 'schedule_resume') {
      const schedule = await readSchedule(args);
      assertCurrent();
      if (hasShell(schedule)) throw new Error('UNSUPPORTED_CAPABILITY');
      return schedule as unknown as ScheduleMutationGuard;
    }
  };
  return {
    ...ports,
    approveGroup: async (pluginId, group, current) => {
      const approved = await ports.approveGroup(pluginId, group, current);
      active = current;
      return approved;
    },
    createRuntime: (server, identity) => {
      caller = identity;
      const runtime = ports.createRuntime(server, identity);
      if (!runtime) return null;
      return { ...runtime, call: async (tool, args, signal) => {
        const scheduleGuard = await check(server, tool, args ?? {});
        if (!scheduleGuard) return runtime.call(tool, args, signal);
        const current = getPluginHostToolCaller();
        if (!current) throw new Error('PERMISSION_DENIED');
        return runPluginHostToolCall({ ...current, scheduleGuard }, () => runtime.call(tool, args, signal));
      } };
    },
    confirm: async input => {
      await check(input.server, input.tool, input.args);
      return ports.confirm(input);
    },
  };
}
