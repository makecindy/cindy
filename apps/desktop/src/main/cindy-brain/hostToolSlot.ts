import { GHOST_HOST_TOOL_GROUPS, type GhostHostToolGroup } from '@cindy/plugin-protocol';
import type { HostToolCaller, HostToolRuntime } from '@cindy/mcps';
import type { GhostPipeHostToolRequest, InstalledGhost } from '../../shared/ghost.js';
import { ghostInstallApprovalToken } from '../../shared/ghost.js';
import type { DataOwnerPushStamp } from '../../shared/dataOwnerPush.js';
import { hasPluginHostToolGroupApproval } from './taskCapability.js';
import { runPluginHostToolCall } from '../mcp-integrations/hostToolCaller.js';

export interface PluginHostToolPorts {
  getGhost(id: string): InstalledGhost | null;
  owner(): DataOwnerPushStamp;
  createRuntime(server: string, caller: Extract<HostToolCaller, { kind: 'plugin' }>): HostToolRuntime | null;
  approveGroup(id: string, group: GhostHostToolGroup, current: () => boolean): Promise<boolean>;
  policy(server: string, tool: string, args: Record<string, unknown>): string;
  confirm(input: { pluginId: string; pluginName: string; server: string; tool: string; args: Record<string, unknown> }): Promise<boolean>;
  recordCall?(pluginId: string, server: string, tool: string): void;
}

const fail = (errorCode: string) => ({ isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, errorCode }) }] });

/** Both logic pages and Node workers enter here with a Host-verified installation identity. */
export async function handlePluginHostToolRequest(id: string, payload: unknown, pageCurrent: () => boolean, ports: PluginHostToolPorts) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return fail('INVALID_PARAMS');
  const raw = payload as Partial<GhostPipeHostToolRequest>;
  if (raw.type !== 'host-tool-request' || typeof raw.tool !== 'string' || !/^[a-z][a-z0-9_:-]{0,127}$/.test(raw.tool) ||
    !raw.args || typeof raw.args !== 'object' || Array.isArray(raw.args)) return fail('INVALID_PARAMS');
  // Plugin management, owner input, app updates and feedback are outside this entry.
  if (raw.server !== 'cindy_helper' && raw.server !== 'cindy_scheduler') return fail('PERMISSION_DENIED');
  const server = raw.server, tool = raw.tool;
  let args: Record<string, unknown>;
  try { args = JSON.parse(JSON.stringify(raw.args)); } catch { return fail('INVALID_PARAMS'); }
  const argsJson = JSON.stringify(args);
  const owner = ports.owner();
  const ghost = ports.getGhost(id);
  const revision = ghostInstallApprovalToken(ghost?.approval);
  const current = () => {
    const latest = ports.getGhost(id), activeOwner = ports.owner();
    return pageCurrent() && latest?.enabled === true && latest.approval.state === 'approved' &&
      latest.dir === ghost?.dir && ghostInstallApprovalToken(latest.approval) === revision &&
      activeOwner.dataOwnerId === owner.dataOwnerId && activeOwner.ownerGeneration === owner.ownerGeneration;
  };
  if (!ghost || !current()) return fail('PERMISSION_DENIED');
  const caller = { kind: 'plugin' as const, pluginId: id, ...owner };
  const runtime = ports.createRuntime(server, caller);
  if (!runtime) return fail('HOST_NOT_READY');
  try {
    const definition = runtime.describe(tool);
    const group = GHOST_HOST_TOOL_GROUPS.find(item => item === definition?.category);
    if (!definition || !group) return fail('PERMISSION_DENIED');
    if (!await ports.approveGroup(id, group, current)) return fail('PERMISSION_DENIED');
    const authorized = () => current() && hasPluginHostToolGroupApproval(ports.getGhost(id), group);
    if (!authorized()) return fail('PERMISSION_DENIED');
    const perCall = ports.policy(server, definition.name, args) !== 'auto-approve';
    if (perCall && !await ports.confirm({ pluginId: id, pluginName: ghost.manifest.name, server, tool: definition.name, args: JSON.parse(argsJson) }))
      return fail('PERMISSION_DENIED');
    if (!authorized()) return fail('PERMISSION_DENIED');
    const assertCurrent = () => { if (!authorized()) throw new Error('PERMISSION_DENIED'); };
    const result = await runPluginHostToolCall({ caller, server, tool: definition.name, argsJson, assertCurrent }, () => runtime.call(definition.name, args));
    assertCurrent();
    ports.recordCall?.(id, server, definition.name);
    return result;
  } catch {
    return fail(current() ? 'HOST_TOOL_FAILED' : 'PERMISSION_DENIED');
  } finally {
    await runtime.close();
  }
}
