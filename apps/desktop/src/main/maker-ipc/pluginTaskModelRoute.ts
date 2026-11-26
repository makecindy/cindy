import type { Effort } from '@cindy/maker-core';
import type { ProviderView } from '@cindy/model-providers';
import { isPluginEngineKind } from '../../shared/agentKindConversion.js';
import type { GhostErrandPermissionMode } from '../../shared/ghost.js';
import type { PluginEngineView } from '../../shared/pluginEngines.js';
import type { PluginTaskRoute } from '../../shared/pluginTasks.js';
import {
  isPluginEngineModelRouteAvailable,
  isPluginModelPickerRouteAvailable,
} from '../cindy-brain/ghostModelPicker.js';
import { GHOST_REMOTE_AGENT_MODELS } from '../cindy-brain/ghostAgentModels.js';
import { PluginTaskError } from './pluginTaskService.js';
import type { PendingAgentSwitchIntent } from './sessionAgentSwitchHandler.js';
import type { SessionRuntimeProfile } from './sessionRuntimeControl.js';

/** The caller supplies the ordinary authenticated remote catalog reader, never picker caches.
 * Revalidate on create, setModel and send/accept; a revoked source cannot borrow local namesakes. */
export async function resolveRemotePluginTaskRoute(route: PluginTaskRoute, deps: {
  readProviders(deviceId: string): Promise<ProviderView[]>;
  readPluginEngines?: (deviceId: string) => Promise<readonly PluginEngineView[]>;
  assertCurrent(): void;
}): Promise<PluginTaskRoute> {
  const selection = { ...route };
  deps.assertCurrent();
  if (selection.agentKind === 'acp') {
    if (!deps.readPluginEngines) {
      throw new PluginTaskError('ROUTE_UNAVAILABLE', '远程插件引擎不可用，请恢复连接或重新选择模型');
    }
    let engines: readonly PluginEngineView[];
    try {
      engines = await deps.readPluginEngines(selection.agentDeviceId!);
    } catch {
      deps.assertCurrent();
      throw new PluginTaskError('ROUTE_UNAVAILABLE', '远程插件引擎不可用，请恢复连接或重新选择模型');
    }
    deps.assertCurrent();
    if (!isPluginEngineModelRouteAvailable(selection, engines)) {
      throw new PluginTaskError('ROUTE_UNAVAILABLE', '所选来源的模型、引擎或配置已不可用，请重新选择');
    }
    return selection;
  }
  let providers: ProviderView[];
  try {
    providers = await deps.readProviders(selection.agentDeviceId!);
  } catch {
    deps.assertCurrent();
    throw new PluginTaskError('ROUTE_UNAVAILABLE', '远程模型来源不可用，请恢复连接或重新选择模型');
  }
  deps.assertCurrent();
  if (!isPluginModelPickerRouteAvailable(selection, providers, GHOST_REMOTE_AGENT_MODELS)) {
    throw new PluginTaskError('ROUTE_UNAVAILABLE', '所选来源的模型、引擎或配置已不可用，请重新选择');
  }
  return selection;
}

/**
 * The plugin's saved "Model & tasks" choice with a run location, as the same complete
 * route an explicit request carries. null = no saved location (the local resolver applies).
 * Empty effort leaves the remote catalog default, exactly like an explicit route with ''.
 */
export function savedPluginTaskRemoteRoute(config: {
  agentKind?: PluginTaskRoute['agentKind'] | 'claude-code';
  providerId?: string | null;
  model?: string;
  effort?: string | null;
  fastMode?: PluginTaskRoute['fastMode'];
  agentDeviceId?: string | null;
}): PluginTaskRoute | null {
  const { agentDeviceId, providerId, model } = config;
  const agentKind = config.agentKind === 'claude-code' ? 'cc' : config.agentKind;
  if (!agentDeviceId || !agentKind || !providerId || !model) return null;
  return { agentDeviceId, agentKind, providerId, model, effort: config.effort ?? '', fastMode: config.fastMode ?? false };
}

export interface PluginTaskSessionRouteRow {
  agentKind: string;
  providerId: string | null;
  model: string;
  effort: string;
  fastMode: boolean | 'ultrafast';
  agentDeviceId: string | null;
}

export interface PluginTaskRuntimeProfileSnapshot {
  effective: SessionRuntimeProfile;
  pendingMutation: { profile: SessionRuntimeProfile } | null;
}

/**
 * Projects a plugin task's effective next-send route for `readSession`.
 *
 * Built-in runtime projections intentionally omit plugin-engine (`acp`) sessions and
 * pending switches targeting `acp`. When a plugin task has an agent-staged switch
 * crossing an `acp` boundary, project that pending intent directly so `tasks.setModel`
 * and `tasks.send` agree on the route before and after the switch lands on send.
 */
export function resolvePluginTaskReadRoute(input: {
  row: PluginTaskSessionRouteRow;
  runtime: PluginTaskRuntimeProfileSnapshot | null;
  pendingSwitch: PendingAgentSwitchIntent | undefined;
}): { resolvedConfig: PluginTaskRoute; hasPendingRoute: boolean } {
  const { row, runtime, pendingSwitch } = input;
  const pendingAcpIntent =
    pendingSwitch && !pendingSwitch.resumeFallbackRecovery && pendingSwitch.runtimeSource === 'agent'
      ? pendingSwitch
      : undefined;

  if (runtime?.pendingMutation?.profile) {
    const selected = runtime.pendingMutation.profile;
    return {
      hasPendingRoute: true,
      resolvedConfig: {
        agentKind: selected.agentKind === 'claude-code' ? 'cc' : selected.agentKind,
        ...(selected.agentDeviceId ? { agentDeviceId: selected.agentDeviceId } : {}),
        providerId: selected.providerId ?? '',
        model: selected.model,
        effort: selected.effort ?? '',
        fastMode: selected.fastMode,
      },
    };
  }

  if (pendingAcpIntent && (isPluginEngineKind(row.agentKind) || pendingAcpIntent.targetAgentKind === 'acp')) {
    const agentDeviceId = pendingAcpIntent.targetAgentDeviceId === undefined
      ? (row.agentDeviceId ?? null)
      : pendingAcpIntent.targetAgentDeviceId;
    const isTargetAcp = pendingAcpIntent.targetAgentKind === 'acp';
    return {
      hasPendingRoute: true,
      resolvedConfig: {
        agentKind: pendingAcpIntent.targetAgentKind === 'claude-code' ? 'cc' : pendingAcpIntent.targetAgentKind,
        ...(agentDeviceId ? { agentDeviceId } : {}),
        providerId: pendingAcpIntent.providerId ?? '',
        model: pendingAcpIntent.model,
        effort: pendingAcpIntent.effort ?? '',
        fastMode: isTargetAcp
          ? false
          : (pendingAcpIntent.fastMode === 'ultrafast' ? 'ultrafast' : pendingAcpIntent.fastMode === true),
      },
    };
  }

  const selected = runtime?.effective;
  if (selected) {
    return {
      hasPendingRoute: false,
      resolvedConfig: {
        agentKind: selected.agentKind === 'claude-code' ? 'cc' : selected.agentKind,
        ...(selected.agentDeviceId ? { agentDeviceId: selected.agentDeviceId } : {}),
        providerId: selected.providerId ?? '',
        model: selected.model,
        effort: selected.effort ?? '',
        fastMode: selected.fastMode,
      },
    };
  }

  return {
    hasPendingRoute: false,
    resolvedConfig: {
      agentKind: row.agentKind as PluginTaskRoute['agentKind'],
      providerId: row.providerId ?? '',
      model: row.model,
      effort: row.effort,
      fastMode: row.fastMode,
      ...(row.agentDeviceId ? { agentDeviceId: row.agentDeviceId } : {}),
    },
  };
}

export interface PluginTaskModelRouteWriterDeps {
  readTaskRow(taskId: string): Promise<{ agentKind: string; providerId: string | null; agentDeviceId: string | null } | null>;
  readPendingSwitch(taskId: string): PendingAgentSwitchIntent | undefined;
  performAgentSwitch(params: {
    sessionId: string;
    targetAgentKind: 'claude-code' | 'codex' | 'pi' | 'acp';
    model: string;
    providerId: string;
    effort: string | null;
    fastMode: boolean | 'ultrafast';
    agentDeviceId: string | null;
    beforeMutation: () => Promise<void>;
  }): Promise<{ deferred?: boolean; sameEngineSuperseded?: boolean }>;
  applySamePluginEngineModel(params: {
    sessionId: string;
    model: string;
    providerId: string;
    effort: Effort | null;
    beforeMutation: () => Promise<void>;
  }): Promise<{ deferred: boolean; superseded: boolean }>;
  commitPermissionMode(
    taskId: string,
    permissionMode: GhostErrandPermissionMode,
    beforeMutation: () => Promise<void>,
  ): Promise<unknown>;
  getBuiltinSessionRuntime(taskId: string): Promise<
    | {
        ok: true;
        runtime: {
          runtimeGeneration: number;
          effectiveProfile: SessionRuntimeProfile;
          pendingMutation: { profile: SessionRuntimeProfile } | null;
        };
      }
    | { ok: false; message: string }
  >;
  setBuiltinSessionRuntime(params: {
    targetSessionId: string;
    expectedGeneration: number;
    beforeMutation: () => Promise<void>;
    patch: {
      harness?: 'claude-code' | 'codex' | 'pi';
      agentDeviceId?: string | null;
      model: string;
      providerId: string;
      effort: Effort | null;
      fastMode: boolean | 'ultrafast';
      permissionMode?: GhostErrandPermissionMode;
    };
  }): Promise<{ ok: true; status: 'applied' | 'deferred' } | { ok: false; errorCode: string; message: string }>;
  setBuiltinPermissionMode(params: {
    targetSessionId: string;
    expectedGeneration: number;
    beforeMutation: () => Promise<void>;
    permissionMode: GhostErrandPermissionMode;
  }): Promise<{ ok: true; status: 'applied' | 'deferred' } | { ok: false; errorCode: string; message: string }>;
  applyPendingSwitchIfIdle(taskId: string): Promise<void>;
}

/**
 * Applies a plugin task `setModel` update across built-in and plugin-engine (`acp`) routes:
 * - Same `acp` engine on the same computer: clears any pending cross-engine switch, then
 *   applies the new model/effort directly through the `acp` SET_MODEL path.
 * - Cross-engine or cross-location transition involving `acp`: stages a deferred switch via
 *   `performSessionAgentSwitch`.
 * - Built-in to built-in: reuses `sessionControlService.setSessionRuntime`, forcing
 *   `harness` selection when superseding a staged `acp` switch.
 */
export async function applyPluginTaskModelRoute(
  deps: PluginTaskModelRouteWriterDeps,
  taskId: string,
  route: PluginTaskRoute,
  assertUnchanged: () => Promise<void>,
  permissionMode?: GhostErrandPermissionMode,
): Promise<{ status: 'applied' | 'deferred' }> {
  const targetAgent = route.agentKind === 'cc' ? 'claude-code' : route.agentKind;
  const targetLocation = route.agentDeviceId ?? null;
  const taskRow = await deps.readTaskRow(taskId);
  if (!taskRow) {
    throw new PluginTaskError('TASK_NOT_FOUND', `Task ${taskId} not found`);
  }
  const currentIsAcp = isPluginEngineKind(taskRow.agentKind);
  const currentLocation = taskRow.agentDeviceId ?? null;
  const samePluginEngine =
    targetAgent === 'acp'
    && currentIsAcp
    && (taskRow.providerId ?? null) === (route.providerId || null)
    && currentLocation === targetLocation;

  const commitPermissionIfNeeded = async () => {
    if (permissionMode === undefined) return;
    await assertUnchanged();
    await deps.commitPermissionMode(taskId, permissionMode, assertUnchanged);
  };

  if (samePluginEngine) {
    await assertUnchanged();
    try {
      if (deps.readPendingSwitch(taskId)) {
        const cleared = await deps.performAgentSwitch({
          sessionId: taskId,
          targetAgentKind: 'acp',
          model: route.model,
          providerId: route.providerId,
          effort: route.effort || null,
          fastMode: false,
          agentDeviceId: targetLocation,
          beforeMutation: assertUnchanged,
        });
        if (cleared.sameEngineSuperseded) {
          throw new PluginTaskError('TASK_BUSY', '任务模型切换已被更新的选择覆盖，请重试');
        }
      }
      const applied = await deps.applySamePluginEngineModel({
        sessionId: taskId,
        model: route.model,
        providerId: route.providerId,
        effort: (route.effort || null) as Effort | null,
        beforeMutation: assertUnchanged,
      });
      if (applied.superseded) {
        throw new PluginTaskError('TASK_BUSY', '任务模型切换已被更新的选择覆盖，请重试');
      }
      await commitPermissionIfNeeded();
      return { status: applied.deferred ? 'deferred' : 'applied' };
    } catch (error) {
      if (error instanceof PluginTaskError) throw error;
      throw new PluginTaskError('ROUTE_UNAVAILABLE', error instanceof Error ? error.message : '任务模型不可用，请重新选择');
    }
  }

  if (targetAgent === 'acp' || currentIsAcp) {
    await assertUnchanged();
    try {
      const switched = await deps.performAgentSwitch({
        sessionId: taskId,
        targetAgentKind: targetAgent,
        model: route.model,
        providerId: route.providerId,
        effort: route.effort || null,
        fastMode: targetAgent === 'acp' ? false : route.fastMode,
        agentDeviceId: targetLocation,
        beforeMutation: assertUnchanged,
      });
      await commitPermissionIfNeeded();
      return { status: switched.deferred ? 'deferred' : 'applied' };
    } catch (error) {
      if (error instanceof PluginTaskError) throw error;
      throw new PluginTaskError('ROUTE_UNAVAILABLE', error instanceof Error ? error.message : '任务模型不可用，请重新选择');
    }
  }

  const current = await deps.getBuiltinSessionRuntime(taskId);
  if (!current.ok) throw new PluginTaskError('TASK_NOT_FOUND', current.message);
  await assertUnchanged();
  const pendingAgent = current.runtime.pendingMutation?.profile.agentKind ?? deps.readPendingSwitch(taskId)?.targetAgentKind;
  const selectedLocation = (current.runtime.pendingMutation?.profile ?? current.runtime.effectiveProfile).agentDeviceId ?? null;
  const selectLocation = targetLocation !== selectedLocation || targetLocation !== (current.runtime.effectiveProfile.agentDeviceId ?? null);
  const selectHarness = current.runtime.effectiveProfile.agentKind !== targetAgent
    || (pendingAgent !== undefined && pendingAgent !== targetAgent) || selectLocation || !!targetLocation;
  const permissionHandoff = permissionMode !== undefined && current.runtime.effectiveProfile.agentKind !== targetAgent;
  const result = await deps.setBuiltinSessionRuntime({
    targetSessionId: taskId,
    expectedGeneration: current.runtime.runtimeGeneration,
    beforeMutation: assertUnchanged,
    patch: {
      ...(selectHarness ? { harness: targetAgent } : {}),
      ...(selectLocation || targetLocation ? { agentDeviceId: targetLocation } : {}),
      model: route.model,
      providerId: route.providerId,
      effort: (route.effort || null) as Effort | null,
      fastMode: route.fastMode,
      ...(permissionMode && !permissionHandoff ? { permissionMode } : {}),
    },
  });
  if (!result.ok) throw new PluginTaskError(result.errorCode, result.message);
  if (permissionHandoff) {
    await assertUnchanged();
    await deps.applyPendingSwitchIfIdle(taskId);
    await assertUnchanged();
    const changed = await deps.getBuiltinSessionRuntime(taskId);
    if (!changed.ok) throw new PluginTaskError('TASK_NOT_FOUND', changed.message);
    if (changed.runtime.effectiveProfile.agentKind !== targetAgent) {
      throw new PluginTaskError('TASK_BUSY', 'Wait for the selected Agent to become available');
    }
    const permission = await deps.setBuiltinPermissionMode({
      targetSessionId: taskId,
      expectedGeneration: changed.runtime.runtimeGeneration,
      beforeMutation: assertUnchanged,
      permissionMode,
    });
    if (!permission.ok) throw new PluginTaskError(permission.errorCode, permission.message);
    return { status: permission.status };
  }
  return { status: result.status };
}
