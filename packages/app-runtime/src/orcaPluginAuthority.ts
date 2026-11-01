import type { CurrentDbClientSnapshot } from '@cindy/runtime-db/client/current';
import type { OrcaWorkerCreationPlanValidator } from '@cindy/orca-workflow/host/orcaWorkerCreationService';
import { PluginTaskError, type PluginTaskService, type PluginTaskStore, type readPluginTaskPlanReceipt } from '@cindy/plugin-runtime/pluginTaskService';
import { assertPluginWorkerDirectoryScope, type resolvePluginWorkerDirectory } from '@cindy/plugin-runtime/pluginWorkerDirectory';
import { captureTaskActionGuard } from './taskActionAuthorization.js';
import { hasAcceptedUserTaskInput, type AcceptedTaskInput } from './pluginTaskInput.js';

/** Host-owned Orca admission, retained across creation waits and queued delivery. */
export function createOrcaPluginAuthority(host: {
  getCurrentDbClientSnapshot(): CurrentDbClientSnapshot | null;
  getAcceptedInputProvenance(sessionId: string): AcceptedTaskInput | null;
  getSession(sessionId: string): { isTurnRunning(): boolean } | null | undefined;
  createPluginTaskStore(client: NonNullable<CurrentDbClientSnapshot>['client']): Pick<PluginTaskStore, 'get'>;
  pluginTaskServiceForCurrentOwner(): Pick<PluginTaskService, 'get'>;
  readPluginTaskConfig(pluginId: string): { permissionMode?: string; workingDir?: string };
  isPluginTaskAuthorized(pluginId: string): boolean;
  resolvePluginWorkerDirectory: typeof resolvePluginWorkerDirectory;
  readPluginTaskPlanReceipt: typeof readPluginTaskPlanReceipt;
  isGhostPickedDir(pluginId: string, directory: string): boolean;
  getSelfDeviceId(): string | null;
  readSessionAgentDeviceId(sessionId: string): Promise<string | null>;
}) {
  const { getCurrentDbClientSnapshot, getAcceptedInputProvenance, getSession,
    createPluginTaskStore, pluginTaskServiceForCurrentOwner, readPluginTaskConfig,
    isPluginTaskAuthorized, resolvePluginWorkerDirectory, readPluginTaskPlanReceipt,
    isGhostPickedDir, getSelfDeviceId, readSessionAgentDeviceId } = host;

  const assertPluginWorkerAutoAuthorized = (pluginId: string, task: { status: string; permissionMode?: string; planModeEnabled?: boolean }) => {
    if (task.status !== 'active') {
      throw new PluginTaskError('TASK_BUSY', 'Archived tasks cannot create Workers');
    }
    if (!isPluginTaskAuthorized(pluginId) || task.planModeEnabled || task.permissionMode !== 'auto' || readPluginTaskConfig(pluginId).permissionMode !== 'auto') {
      throw new PluginTaskError('PERMISSION_DENIED', 'Authorize Auto for the plugin coordinator before creating Workers');
    }
  };

  // Uninstall keeps the historical receipt, but ordinary Orca belongs to the user.
  // Malformed receipts still go through the service's fail-closed ownership check.
  const hasRevokedPluginTaskOwnership = (receipt: { payload: string }): boolean => {
    try { return JSON.parse(receipt.payload)?.ownershipRevoked === true; }
    catch { return false; }
  };

  const captureOrcaPluginAuthority = async (leadSessionId: string) => {
    // All Orca lifecycle/control paths already retain this guard through lookup,
    // preparation and acceptance. Bind the originating call even outside its ALS.
    const assertActionCurrent = captureTaskActionGuard();
    const epoch = getCurrentDbClientSnapshot();
    if (!epoch) throw new PluginTaskError('HOST_NOT_READY', 'Task storage unavailable', true);
    const input = getAcceptedInputProvenance(leadSessionId);
    const executing = !!input || !!getSession(leadSessionId)?.isTurnRunning();
    const store = createPluginTaskStore(epoch.client);
    const receipt = await store.get(leadSessionId);
    // Retry continues the original input; only a new accepted user message
    // replaces that source. The stable lineage already survives automatic retries.
    const inputId = input?.retrySourceClientId ?? input?.clientId;
    if (receipt?.operation === 'create' && hasRevokedPluginTaskOwnership(receipt) && executing
      && !await hasAcceptedUserTaskInput(epoch.client, leadSessionId, input)) {
      throw new PluginTaskError('PERMISSION_DENIED', 'Orca input provenance unavailable');
    }
    const run = inputId?.startsWith('plugin-task:') ? await store.get(inputId.slice('plugin-task:'.length)) : undefined;
    let inputPluginId: string | null = null;
    if (inputId?.startsWith('plugin-task:')) {
      if (!run || run.operation !== 'send' || run.targetId !== leadSessionId || JSON.parse(run.payload).inputMessageId !== inputId) {
        throw new PluginTaskError('PERMISSION_DENIED', 'Plugin input provenance unavailable');
      }
      inputPluginId = run.pluginId;
    }
    if (epoch !== getCurrentDbClientSnapshot()) throw new PluginTaskError('PERMISSION_DENIED', 'Account changed');
    const pluginId = inputPluginId ?? (receipt?.operation === 'create' && !hasRevokedPluginTaskOwnership(receipt) ? receipt.pluginId : null);
    const assertCurrent = async () => {
      if (epoch !== getCurrentDbClientSnapshot()) throw new PluginTaskError('PERMISSION_DENIED', 'Account changed');
      const current = await store.get(leadSessionId);
      const currentPluginId = current?.operation === 'create' && !hasRevokedPluginTaskOwnership(current) ? current.pluginId : null;
      if (epoch !== getCurrentDbClientSnapshot() || currentPluginId !== pluginId) throw new PluginTaskError('PERMISSION_DENIED', 'Orca task ownership changed');
      if (assertActionCurrent) await assertActionCurrent();
      if (pluginId === null) return;
      const task = await pluginTaskServiceForCurrentOwner!().get(pluginId, leadSessionId);
      if (epoch !== getCurrentDbClientSnapshot()) throw new PluginTaskError('PERMISSION_DENIED', 'Account changed');
      assertPluginWorkerAutoAuthorized(pluginId, task);
      if (assertActionCurrent) await assertActionCurrent();
    };
    await assertCurrent();
    return { permissionMode: pluginId === null ? undefined : 'auto' as const, assertCurrent };
  };

  const validateCreationPlan: OrcaWorkerCreationPlanValidator = async (params, resolvedWorkingDir, resolvedRoute, assertCurrent) => {
      const epoch = getCurrentDbClientSnapshot();
      if (!epoch) throw new PluginTaskError('HOST_NOT_READY','Task storage unavailable');
      const receipt = await createPluginTaskStore(epoch.client).get(params.leadSessionId);
      await assertCurrent?.();
      if (epoch !== getCurrentDbClientSnapshot()) throw new PluginTaskError('PERMISSION_DENIED','Account changed');
      if (!receipt || receipt.operation !== 'create' || hasRevokedPluginTaskOwnership(receipt)) return undefined;
      const task = await pluginTaskServiceForCurrentOwner!().get(receipt.pluginId,params.leadSessionId);
      if (epoch !== getCurrentDbClientSnapshot()) throw new PluginTaskError('PERMISSION_DENIED','Account changed');
      assertPluginWorkerAutoAuthorized(receipt.pluginId, task);
      // Plugin directory grants identify resources on this computer, not same-named
      // paths on another device. Reject before directory lookup or remote creation.
      if (params.executionDeviceId !== undefined) {
        throw new PluginTaskError('PERMISSION_DENIED', 'Plugin-owned tasks cannot create Workers on another device');
      }
      // 插件登记的路由不含 Agent 所在电脑：Worker 只能跟 Lead(或留在本机)，不能指定别的电脑。
      // 指向本机自己按留在本机算(与创建服务同口径)。
      if (
        typeof params.agentDeviceId === 'string'
        && params.agentDeviceId !== getSelfDeviceId()
        && params.agentDeviceId !== await readSessionAgentDeviceId(params.leadSessionId)
      ) {
        throw new PluginTaskError('PERMISSION_DENIED', 'Plugin-owned tasks cannot run a Worker Agent on another computer');
      }
      const cfg = readPluginTaskConfig(receipt.pluginId);
      const resolveAuthorizedDirectory = (requested: string) => resolvePluginWorkerDirectory({
        requested, leadDirectory: task.workingDir,
        configuredDirectory: cfg.workingDir, isPickedDirectory: dir => isGhostPickedDir(receipt.pluginId,dir),
        assertCurrent: () => {
          if (epoch !== getCurrentDbClientSnapshot() || !isPluginTaskAuthorized(receipt.pluginId) || cfg.workingDir !== readPluginTaskConfig(receipt.pluginId).workingDir) throw new PluginTaskError('PERMISSION_DENIED','Plugin directory authorization changed');
        },
      });
      const directory = await resolveAuthorizedDirectory(params.workingDir ?? task.workingDir ?? '');
      if (resolvedWorkingDir !== undefined && directory !== await resolveAuthorizedDirectory(resolvedWorkingDir)) throw new PluginTaskError('PERMISSION_DENIED','Worker directory changed during creation');
      // Drain plan registration before taking the receipt snapshot. Waiting only
      // after this read leaves a stale no-plan payload even when get() sees the
      // newly persisted plan. Keep the final task check after directory awaits.
      await pluginTaskServiceForCurrentOwner!().get(receipt.pluginId,params.leadSessionId);
      if (epoch !== getCurrentDbClientSnapshot()) throw new PluginTaskError('PERMISSION_DENIED','Account changed');
      const currentReceipt = await createPluginTaskStore(epoch.client).get(params.leadSessionId);
      if (!currentReceipt || currentReceipt.operation !== 'create' || currentReceipt.pluginId !== receipt.pluginId || hasRevokedPluginTaskOwnership(currentReceipt) || epoch !== getCurrentDbClientSnapshot()) throw new PluginTaskError('PERMISSION_DENIED', 'Task ownership changed');
      const data = readPluginTaskPlanReceipt(currentReceipt.payload);
      const item = data.teamPlan?.items.find((x: {label:string})=>x.label===params.label);
      const plannedDirectory = item && resolvedRoute
        ? await resolveAuthorizedDirectory(item.workingDir) : undefined;
      const currentTask = await pluginTaskServiceForCurrentOwner!().get(receipt.pluginId,params.leadSessionId);
      await assertCurrent?.();
      if (epoch !== getCurrentDbClientSnapshot() || currentTask.revision !== task.revision) throw new PluginTaskError('STALE_REVISION','Task changed during directory validation');
      // Last admission check also covers no-plan plugin tasks and revocation
      // while directory/receipt reads or the existing reservation were pending.
      assertPluginWorkerAutoAuthorized(receipt.pluginId, currentTask);
      if (cfg.workingDir !== readPluginTaskConfig(receipt.pluginId).workingDir) throw new PluginTaskError('PERMISSION_DENIED','Plugin directory authorization changed');
      assertPluginWorkerDirectoryScope({ requested: directory, leadDirectory: currentTask.workingDir,
        configuredDirectory: cfg.workingDir, isPickedDirectory: dir => isGhostPickedDir(receipt.pluginId, dir) });
      if (!data.teamPlan) return undefined; // Existing plugins retain their original behavior.
      if (!item || data.settledLabels?.includes(params.label)) throw new PluginTaskError('INVALID_REQUEST','Worker is not pending in the registered plan');
      const route = item.route;
      // Defaults and provider capabilities are resolved by the creation service.
      // Compare that exact spawn route at the post-reservation admission check.
      if (resolvedRoute && (directory!==plannedDirectory || resolvedRoute.model!==route.model || resolvedRoute.providerId!==route.providerId || resolvedRoute.effort!==route.effort || resolvedRoute.fastMode!==route.fastMode || params.agent!==(route.agentKind==='cc'?'claude-code':route.agentKind))) throw new PluginTaskError('INVALID_REQUEST','Worker configuration differs from registered plan');
      return data.teamPlan.concurrency;
  };

  return { assertPluginWorkerAutoAuthorized, captureOrcaPluginAuthority, validateCreationPlan };
}
