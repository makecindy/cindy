import { AsyncLocalStorage } from 'node:async_hooks';
import type { ScheduleMutationGuard } from '@cindy/maker-scheduler';
import type { HostToolCaller } from '@cindy/mcps';
import type { PluginHostToolPorts } from './hostToolSlot.js';
import { hasPluginHostToolGroupApproval } from './taskCapability.js';
import { getPluginHostToolCaller, runPluginHostToolCall } from '../mcp-integrations/hostToolCaller.js';

type Confirmation = Parameters<PluginHostToolPorts['confirm']>[0];
type PreparedHook = { command: string; content: string; workingDir?: string };
const approvalScope = new AsyncLocalStorage<{
  schedule?: ScheduleMutationGuard;
  confirmHook?: (hook: PreparedHook) => Promise<void>;
}>();

/** Read by the existing scheduler mutation guard; ordinary Agent calls retain no extra guard. */
export function getApprovedPluginScheduleGuard(): ScheduleMutationGuard | undefined {
  return getPluginHostToolCaller() ? approvalScope.getStore()?.schedule : undefined;
}

export function getPluginPreparedHookApproval(): ((hook: PreparedHook) => Promise<void>) | undefined {
  return getPluginHostToolCaller() ? approvalScope.getStore()?.confirmHook : undefined;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const command = (value: unknown): string | undefined => {
  const text = record(value)?.command;
  return typeof text === 'string' && text.trim() ? text : undefined;
};
const readsSchedule = (tool: string, args: Record<string, unknown>) =>
  tool === 'schedule_run_now' || tool === 'schedule_resume' ||
  (tool === 'schedule_update' && (args.executionMode === 'script' || !!(command(args.scriptConfig) || command(args.preRunHook))));
const submitsShell = (tool: string, args: Record<string, unknown>) =>
  (tool === 'schedule_create' || tool === 'schedule_update') && !!(command(args.scriptConfig) || command(args.preRunHook));

/** Adds a plugin caller condition around the frozen gateway. All schedule reads
 * and writes still use the Agent's registered handlers and original policy. */
export function withPluginSchedulerApproval(id: string, ports: PluginHostToolPorts): PluginHostToolPorts {
  let caller: Extract<HostToolCaller, { kind: 'plugin' }>;
  let active = () => false;
  let expected: ScheduleMutationGuard | undefined;
  const noNode = () => {
    const ghost = ports.getGhost(id);
    return ghost?.approval.state !== 'approved' || !ghost.manifest.node;
  };
  const inspect = (server: string, tool: string, args: Record<string, unknown>) =>
    server === 'cindy_scheduler' && noNode() &&
    (tool === 'schedule_set_pre_run_hook' || readsSchedule(tool, args) || submitsShell(tool, args));
  const assertCurrent = () => {
    if (!active() || !hasPluginHostToolGroupApproval(ports.getGhost(id), 'scheduler')) throw new Error('PERMISSION_DENIED');
  };
  const readSchedule = async (args: Record<string, unknown>): Promise<ScheduleMutationGuard | null> => {
    assertCurrent();
    const runtime = ports.createRuntime('cindy_scheduler', caller);
    if (!runtime) throw new Error('HOST_NOT_READY');
    const input = { id: args.id, ...(args.device !== undefined ? { device: args.device } : {}) };
    try {
      const result = await runPluginHostToolCall({ caller, server: 'cindy_scheduler', tool: 'schedule_get',
        argsJson: JSON.stringify(input), assertCurrent }, () => runtime.call('schedule_get', input));
      assertCurrent();
      const text = result.content.find(item => item.type === 'text');
      if (!text || text.type !== 'text') throw new Error('SCHEDULE_UNAVAILABLE');
      const payload = JSON.parse(text.text) as Record<string, unknown>;
      if (payload.ok !== true) throw new Error('SCHEDULE_UNAVAILABLE');
      const remote = args.device !== undefined && args.device !== 'local';
      const group = remote && Array.isArray(payload.groups)
        ? payload.groups.map(record).find(item => item !== undefined && item.deviceId === args.device && item.ok === true) : undefined;
      if (remote && !group) throw new Error('SCHEDULE_UNAVAILABLE');
      const data = record(remote ? group!.data : payload.data);
      if (!data) return null;
      if (data.id !== args.id) throw new Error('SCHEDULE_UNAVAILABLE');
      const { webhookStatus: _status, ...schedule } = data;
      if (remote) for (const key of ['targetSessionId', 'sessionId']) {
        const value = schedule[key], prefix = `${args.device}::`;
        if (typeof value === 'string' && value.startsWith(prefix)) schedule[key] = value.slice(prefix.length);
      }
      return schedule as unknown as ScheduleMutationGuard;
    } finally { await runtime.close(); }
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
      return { ...runtime, call: (tool, args, signal) => approvalScope.run({ schedule: expected,
        ...(tool === 'schedule_set_pre_run_hook' && noNode() ? { confirmHook: async (hook: PreparedHook) => {
          getPluginHostToolCaller()?.assertCurrent();
          if (!await ports.confirm({ pluginId: id, pluginName: ports.getGhost(id)!.manifest.name, server, tool,
            args: { ...args, hostShell: hook } })) throw Object.assign(new Error('PERMISSION_DENIED'), { code: 'PERMISSION_DENIED' });
          getPluginHostToolCaller()?.assertCurrent();
        } } : {}),
      }, () => runtime.call(tool, args, signal)) };
    },
    policy: (server, tool, args) => inspect(server, tool, args) ? 'prompt-each-time' : ports.policy(server, tool, args),
    confirm: async (input: Confirmation) => {
      if (!inspect(input.server, input.tool, input.args)) return ports.confirm(input);
      // First approve reading/generating the hook; the prepared command and full
      // code get their own native confirmation before overwrite/self-test.
      if (input.tool === 'schedule_set_pre_run_hook') return ports.confirm(input);
      try {
        const schedule = readsSchedule(input.tool, input.args) ? await readSchedule(input.args) : null;
        if (readsSchedule(input.tool, input.args) && !schedule) return false;
        expected = schedule ?? undefined;
        const commands = [command(input.args.scriptConfig), command(input.args.preRunHook),
          ...(schedule ? [schedule.executionMode === 'script' ? schedule.scriptConfig?.command : undefined, schedule.preRunHook?.command] : [])]
          .filter((value): value is string => typeof value === 'string' && value.length > 0);
        if (!commands.length && ports.policy(input.server, input.tool, input.args) === 'auto-approve') return true;
        const allowed = await ports.confirm({ ...input, args: { ...input.args,
          ...(commands.length ? { hostShell: { commands, workingDir: input.args.workingDir ?? schedule?.workingDir } } : {}) } });
        return allowed;
      } catch { return false; }
    },
  };
}
