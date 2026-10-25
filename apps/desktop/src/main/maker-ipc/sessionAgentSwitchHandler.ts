import { getDeviceLinkInvokeContext, isDeviceLinkInvoke } from '../device-link/invoke-context.js';
import { createSharedTaskSettingGuard } from './sharedTaskSetting.js';
import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { shouldApplyExclusiveProviderRerouteLive } from '../maker-host/model-route-guard-live.js';
import {
  performSessionAgentSwitch as performSharedSwitch,
  applyPendingAgentSwitchIfIdle as applySharedPendingSwitch,
  projectPendingAgentSwitchIntent,
  type MakerSessionAgentSwitchHandlerDeps,
} from '@cindy/im-runtime/sessionAgentSwitch';
export * from '@cindy/im-runtime/sessionAgentSwitch';

// Retain the dependency object's identity and live properties for the host's
// mutation lane, while keeping the shared implementation independent of Electron.
const desktopDeps = new WeakMap<MakerSessionAgentSwitchHandlerDeps, MakerSessionAgentSwitchHandlerDeps>();
function withDesktopCatalog(deps: MakerSessionAgentSwitchHandlerDeps): MakerSessionAgentSwitchHandlerDeps {
  let wrapped = desktopDeps.get(deps);
  if (!wrapped) {
    wrapped = Object.assign(Object.create(deps) as MakerSessionAgentSwitchHandlerDeps, { shouldApplyExclusiveProviderReroute: shouldApplyExclusiveProviderRerouteLive });
    desktopDeps.set(deps, wrapped);
  }
  return wrapped;
}
export function performSessionAgentSwitch(deps: MakerSessionAgentSwitchHandlerDeps, params: Parameters<typeof performSharedSwitch>[1]) {
  return performSharedSwitch(withDesktopCatalog(deps), params);
}
export function applyPendingAgentSwitchIfIdle(deps: MakerSessionAgentSwitchHandlerDeps, sessionId: string, options?: Parameters<typeof applySharedPendingSwitch>[2]) {
  return applySharedPendingSwitch(withDesktopCatalog(deps), sessionId, options);
}

export function registerMakerSessionAgentSwitchHandler(
  registry: IpcHandlerRegistry,
  deps: MakerSessionAgentSwitchHandlerDeps,
): void {
  registry.handle(
    MAKER_INVOKE.SWITCH_SESSION_AGENT,
    async (
      _e,
      sessionId: unknown,
      targetAgentKind: unknown,
      model: unknown,
      providerId: unknown,
      effort: unknown,
      fastMode: unknown,
      // 第 7 参(可选):{ agentDeviceId } —— 同时换 Agent 所在电脑。旧被控端忽略多余参数,
      // 位置保持不变(与今天一致)。
      options?: unknown,
      thinking?: unknown,
    ) => {
      const context = getDeviceLinkInvokeContext();
      const confirmedContextWindow = options && typeof options === 'object' && !Array.isArray(options)
        ? (options as { confirmedContextWindow?: unknown }).confirmedContextWindow : undefined;
      // Same trust boundary as SET_MODEL: remote controllers cannot authorize a
      // destructive local-context rebuild by supplying a confirmation number.
      if (isDeviceLinkInvoke() && confirmedContextWindow !== undefined) {
        throwIpcError('PRECONDITION_FAILED', 'remote model-window confirmation is unsupported');
      }
      const agentDeviceId =
        options && typeof options === 'object' && !Array.isArray(options) && 'agentDeviceId' in options
          ? (options as { agentDeviceId?: unknown }).agentDeviceId
          : undefined;
      // 共享任务的访客只能在主人给的范围内改设置，不能把 Agent 挪到主人的其他电脑上。
      if (agentDeviceId !== undefined && context?.sharedTask) {
        throwIpcError('UNSUPPORTED_CAPABILITY', 'shared task guests cannot move the agent to another computer');
      }
      const guard = createSharedTaskSettingGuard(context?.sharedTask, String(sessionId), context?.sharedTaskSetting ?? { admitted: false });
      const run = () => performSessionAgentSwitch(deps, {
        sessionId,
        targetAgentKind,
        model,
        providerId,
        effort,
        fastMode,
        ...(confirmedContextWindow !== undefined ? { confirmedContextWindow } : {}),
        ...(agentDeviceId !== undefined ? { agentDeviceId } : {}),
        thinking,
        assertSelectionCurrent: guard.admit,
      });
      return typeof sessionId === 'string' && sessionId && deps.withSessionLock
        ? deps.withSessionLock(sessionId, run)
        : run();
    },
  );
  registry.handle(
    MAKER_INVOKE.GET_SESSION_AGENT_SWITCH_INTENT,
    (_e, sessionId: unknown) => {
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throwIpcError('INVALID_PARAMS', 'sessionId required');
      }
      return projectPendingAgentSwitchIntent(deps.pendingSwitches?.get(sessionId));
    },
  );
}
