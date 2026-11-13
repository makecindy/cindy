import { declaredGhostHostToolGroups, GHOST_HOST_TOOL_GROUPS, type GhostHostToolGroup } from '@cindy/plugin-protocol';
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
  /** A headless host may lack the service entirely rather than be starting it. */
  unavailableRuntimeError?: { errorCode: string; message: string };
  approveGroup(id: string, group: GhostHostToolGroup, current: () => boolean): Promise<boolean>;
  policy(server: string, tool: string, args: Record<string, unknown>): string;
  confirm(input: { pluginId: string; pluginName: string; server: string; tool: string; args: Record<string, unknown> }): Promise<boolean>;
  recordCall?(pluginId: string, server: string, tool: string): void;
}

const fail = (errorCode: string, message?: string) => ({ isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, errorCode, ...(message ? { message } : {}) }) }] });
const SERVICE_GROUPS: Readonly<Record<string, GhostHostToolGroup>> = {
  cindy_browser: 'browser', cindy_computer: 'computer', cindy_ssh: 'ssh', cindy_docs: 'docs',
};

/** Both logic pages and Node workers enter here with a Host-verified installation identity. */
export async function handlePluginHostToolRequest(id: string, payload: unknown, pageCurrent: () => boolean, ports: PluginHostToolPorts) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return fail('INVALID_PARAMS');
  const raw = payload as Partial<GhostPipeHostToolRequest>;
  if (raw.type !== 'host-tool-request' || typeof raw.server !== 'string' || typeof raw.tool !== 'string' || !/^[a-z][a-z0-9_:-]{0,127}$/.test(raw.tool) ||
    !raw.args || typeof raw.args !== 'object' || Array.isArray(raw.args)) return fail('INVALID_PARAMS');
  // Plugin management, owner input, app updates and feedback are outside this entry.
  if (raw.server !== 'cindy_helper' && raw.server !== 'cindy_scheduler' && !Object.hasOwn(SERVICE_GROUPS, raw.server ?? '')) return fail('PERMISSION_DENIED');
  const server = raw.server, tool = raw.tool;
  let args: Record<string, unknown>;
  try { args = JSON.parse(JSON.stringify(raw.args)); } catch { return fail('INVALID_PARAMS'); }
  const argsJson = JSON.stringify(args);
  const owner = ports.owner();
  const ghost = ports.getGhost(id);
  const installDir = ghost?.dir;
  const revision = ghostInstallApprovalToken(ghost?.approval);
  const installationCurrent = () => {
    const latest = ports.getGhost(id), activeOwner = ports.owner();
    return latest?.enabled === true && latest.approval.state === 'approved' &&
      latest.dir === installDir && ghostInstallApprovalToken(latest.approval) === revision &&
      activeOwner.dataOwnerId === owner.dataOwnerId && activeOwner.ownerGeneration === owner.ownerGeneration;
  };
  const current = () => pageCurrent() && installationCurrent();
  if (!ghost || !current()) return fail('PERMISSION_DENIED');
  const serviceGroup = SERVICE_GROUPS[server];
  if (serviceGroup && !declaredGhostHostToolGroups(ghost.manifest).includes(serviceGroup)) return fail('PERMISSION_DENIED');
  const caller = { kind: 'plugin' as const, pluginId: id, ...owner };
  const runtime = ports.createRuntime(server, caller);
  if (!runtime) return fail(ports.unavailableRuntimeError?.errorCode ?? 'HOST_NOT_READY', ports.unavailableRuntimeError?.message);
  let closeStarted = false;
  try {
    const definition = runtime.describe(tool);
    const group = SERVICE_GROUPS[server] ?? GHOST_HOST_TOOL_GROUPS.find(item => item === definition?.category);
    if (!definition || !group) return fail('PERMISSION_DENIED');
    if (!await ports.approveGroup(id, group, current)) return fail('PERMISSION_DENIED');
    const authorized = () => current() && hasPluginHostToolGroupApproval(ports.getGhost(id), group);
    if (!authorized()) return fail('PERMISSION_DENIED');
    const perCall = ports.policy(server, definition.name, args) !== 'auto-approve';
    if (perCall && !await ports.confirm({ pluginId: id, pluginName: ghost.manifest.name, server, tool: definition.name, args: JSON.parse(argsJson) }))
      return fail('PERMISSION_DENIED');
    if (!authorized()) return fail('PERMISSION_DENIED');
    const assertCurrent = () => { if (!authorized()) throw new Error('PERMISSION_DENIED'); };
    const assertDeliveryCurrent = () => {
      if (!installationCurrent() || !hasPluginHostToolGroupApproval(ports.getGhost(id), group))
        throw new Error('PERMISSION_DENIED');
    };
    const result = await runPluginHostToolCall({ caller, server, tool: definition.name, argsJson, assertCurrent, assertDeliveryCurrent }, () => runtime.call(definition.name, args));
    closeStarted = true;
    await runtime.close();
    // Cleanup is an async boundary too; old-owner data must not escape it.
    assertCurrent();
    ports.recordCall?.(id, server, definition.name);
    return result;
  } catch (error) {
    return fail((error instanceof Error && error.message === 'PERMISSION_DENIED') || !current()
      ? 'PERMISSION_DENIED' : error instanceof Error && error.message === 'UNSUPPORTED_CAPABILITY'
        ? 'UNSUPPORTED_CAPABILITY' : 'HOST_TOOL_FAILED');
  } finally {
    if (!closeStarted) await runtime.close();
  }
}
