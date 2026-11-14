import type { LiziMcpSessionContext, XdtHelperMcpDeps } from '@cindy/mcps';
import type { DataOwnerPushStamp } from '../../shared/dataOwnerPush.js';
import { ghostInstallApprovalToken, type InstalledGhost } from '../../shared/ghost.js';
import type { PluginHostToolCaller } from '../mcp-integrations/hostToolCaller.js';
import { hasPluginHostToolGroupApproval } from '../cindy-brain/taskCapability.js';
import { pluginNodeEnvironment } from '../cindy-brain/nodeRuntimeProcessAdapter.js';
import { HostTerminalService, type HostTerminalScope, type HostTerminalStart } from './hostTerminalService.js';

interface LiveSession {
  instanceId: string;
  workDir: string;
  remoteHostId?: string | null;
  onStatusChange(listener: (status: string) => void): () => void;
}
interface Ports {
  service: HostTerminalService;
  owner(): DataOwnerPushStamp;
  pending(): boolean;
  pluginCall(): PluginHostToolCaller | undefined;
  getGhost(id: string): InstalledGhost | null;
  getSession(id: string): LiveSession | undefined;
  pluginDirectory(id: string): string;
  defaultShell?(): HostTerminalStart['shellPref'];
}

/** Shared Desktop/Node Host adapter. Identity comes from the existing Host gateway or live Session. */
export function createTerminalToolExecutor(ports: Ports): NonNullable<XdtHelperMcpDeps['terminal']> {
  function capture(context: LiziMcpSessionContext): HostTerminalScope {
    const owner = ports.owner();
    const sameOwner = () => !ports.pending() && ports.owner().dataOwnerId === owner.dataOwnerId && ports.owner().ownerGeneration === owner.ownerGeneration;
    const plugin = ports.pluginCall();
    if (context.hostCaller || plugin) {
      const caller = context.hostCaller;
      if (!caller || !plugin || context.sessionId !== undefined || caller.pluginId !== plugin.caller.pluginId ||
          caller.dataOwnerId !== owner.dataOwnerId || caller.ownerGeneration !== owner.ownerGeneration ||
          plugin.caller.dataOwnerId !== owner.dataOwnerId || plugin.caller.ownerGeneration !== owner.ownerGeneration) throw new Error('PERMISSION_DENIED');
      const id = caller.pluginId, ghost = ports.getGhost(id);
      const revision = ghostInstallApprovalToken(ghost?.approval);
      plugin.assertCurrent();
      const assertCurrent = () => {
        const latest = ports.getGhost(id);
        if (!sameOwner() || !ghost || !latest || latest.dir !== ghost.dir || ghostInstallApprovalToken(latest.approval) !== revision ||
            !hasPluginHostToolGroupApproval(latest, 'terminal')) throw new Error('TERMINAL_SCOPE_CHANGED');
      };
      assertCurrent();
      return { key: JSON.stringify([owner.dataOwnerId, owner.ownerGeneration, 'plugin', id]), revision: JSON.stringify([ghost!.dir, revision]),
        pluginId: id, defaultCwd: ports.pluginDirectory(id), createDefaultCwd: true,
        environment: pluginNodeEnvironment(id), assertCurrent };
    }
    if (context.remoteHostId) throw new Error('REMOTE_TERMINAL_UNSUPPORTED');
    const id = context.sessionId, session = id ? ports.getSession(id) : undefined;
    if (!id || !session || (context.sessionInstanceId && context.sessionInstanceId !== session.instanceId)) throw new Error('SESSION_REQUIRED');
    if (session.remoteHostId) throw new Error('REMOTE_TERMINAL_UNSUPPORTED');
    const assertCurrent = () => {
      if (!sameOwner() || ports.getSession(id) !== session || session.remoteHostId) throw new Error('TERMINAL_SCOPE_CHANGED');
    };
    assertCurrent();
    const environment = pluginNodeEnvironment(''); delete environment.CINDY_GHOST_ID;
    return { key: JSON.stringify([owner.dataOwnerId, owner.ownerGeneration, 'task', id]), revision: session.instanceId,
      defaultCwd: session.workDir, environment, assertCurrent,
      onClosed: dispose => session.onStatusChange(status => { if (status === 'closed') dispose(); }) };
  }

  return { async call(context, method, args, signal) {
    const scope = capture(context);
    signal?.throwIfAborted();
    const id = args.id as string;
    switch (method) {
      case 'terminal_start': return { scope: 'local', job: await ports.service.start(scope, {
        cwd: args.cwd as string | undefined, program: args.program as HostTerminalStart['program'],
        cols: args.cols as number | undefined, rows: args.rows as number | undefined, shellPref: args.shell as HostTerminalStart['shellPref'] ?? ports.defaultShell?.(),
      }, signal) };
      case 'terminal_list': return { scope: 'local', jobs: ports.service.list(scope) };
      case 'terminal_read': return { scope: 'local', ...ports.service.read(scope, id, args.cursor as number | undefined, args.generation as string | undefined) };
      case 'terminal_write': ports.service.write(scope, id, args.data as string); break;
      case 'terminal_resize': ports.service.resize(scope, id, args.cols as number, args.rows as number); break;
      case 'terminal_stop': ports.service.stop(scope, id); break;
      case 'terminal_forget': ports.service.forget(scope, id); break;
      default: throw new Error('INVALID_TERMINAL_OPERATION');
    }
    scope.assertCurrent();
    return { scope: 'local', requested: true };
  } };
}
