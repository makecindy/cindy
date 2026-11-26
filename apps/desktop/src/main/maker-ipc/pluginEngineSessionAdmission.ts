/**
 * Model admission for tasks that run on a plugin-provided engine (`agent_kind = 'acp'`,
 * docs/plans/acp-plugin-bridge.md).
 *
 * The ordinary admission (`resolveSessionExecutionSelection`) checks a task against the built-in
 * Harness catalog and provider routing; a plugin engine is neither, so it would always be refused
 * there. Instead the engine must be one this computer offers right now (enabled, approved and
 * declared, see pluginHarnesses.ts) and not reported unavailable by its plugin. The model stays the
 * engine's own value (`default` lets the engine choose). A reasoning level is kept only when the
 * engine lists it for that model (otherwise the engine keeps its own); Fast does not apply. Built-in
 * tasks never reach this function.
 */
import { isSharedTaskPeer, parseProviderSharePeer } from '@cindy/device-link';
import type { PluginHarness } from '../cindy-brain/pluginHarnesses.js';
import type { SessionOpenBody } from '../localDb/sessionOpening.js';
import {
  PLUGIN_ENGINE_DEFAULT_MODEL,
  isPluginEngineModelDisabled,
  isPluginEngineEffort,
  pluginEngineKeyFromProviderId,
  type PluginEngineEffort,
  type PluginEngineModel,
  type PluginEnginePermissionModeId,
  type PluginEngineView,
} from '../../shared/pluginEngines.js';

/** The user turned the engine off in Settings → Model providers; the plugin itself is still on. */
function pluginEngineSuspendedMessage(name: string): string {
  return `${name} 已在「设置 → 模型供应商」中停用。启用后才能用它运行任务。`;
}

/** The user turned this model of the engine off in Settings → Model providers. */
function pluginEngineModelOffMessage(name: string): string {
  return `${name} 的这个模型已在「设置 → 模型供应商」中关闭。请重新选择模型。`;
}

/**
 * Callers branch on `isPluginEngineKind(body.agentKind)` first. The storage body type only names
 * the built-in kinds (the renderer's `'acp'` reaches it through createUserSession's cast), so the
 * engine kind is kept as the caller passed it rather than rewritten here.
 */
export function admitPluginEngineSession(
  body: SessionOpenBody,
  harnesses: readonly PluginHarness[],
  /** The models the picker offered for an engine (pluginEnginesIpc.pluginEngineModelsOf). */
  modelsOf: (harness: PluginHarness) => readonly PluginEngineModel[],
  /**
   * What the user set for an engine in Settings → Model providers
   * (pluginEnginesIpc.pluginEngineSettingsOf); absent = nothing is turned off.
   */
  settingsOf?: (provider: Pick<PluginHarness, 'key'>) => {
    suspended?: boolean;
    disabledModels?: readonly string[];
    modelEfforts?: PluginEngineView['modelEfforts'];
  },
): SessionOpenBody {
  const key = pluginEngineKeyFromProviderId(body.providerId);
  if (!key) throw new Error('插件引擎任务缺少引擎标识。请在新建任务时重新选择插件引擎。');
  if (body.remoteHostId) {
    throw new Error('插件引擎不能在 SSH 工作区里运行。请在新建任务时选择本机或你的另一台电脑。');
  }
  if (typeof body.agentDeviceId === 'string' && body.agentDeviceId.trim()) return admitPluginEngineSessionElsewhere(body);
  // A provider taken out of an engine (`<engine>~<suffix>`) runs that engine with its own settings
  // (turning off, model switches); its own accounts are checked when the runtime starts
  // (plugin-engine-accounts).
  const harness = harnesses.find((item) => item.key === key.replace(/~[a-z0-9]{8}$/, ''));
  if (!harness) {
    throw new Error('提供这个引擎的插件已停用或卸载。请在新建任务时重新选择模型。');
  }
  const settings = settingsOf?.({ key });
  if (settings?.suspended) throw new Error(pluginEngineSuspendedMessage(harness.name));
  if (harness.availability.state === 'unavailable') {
    const hint = harness.availability.message?.trim();
    throw new Error(hint ? `${harness.name} 当前不可用：${hint}` : `${harness.name} 当前不可用。`);
  }
  const model = typeof body.model === 'string' && body.model.trim() ? body.model : PLUGIN_ENGINE_DEFAULT_MODEL;
  if (isPluginEngineModelDisabled(model, settings?.disabledModels)) throw new Error(pluginEngineModelOffMessage(harness.name));
  const requested = body.effort;
  const offered = modelsOf(harness).find((item) => item.id === model)?.efforts ?? [];
  const saved = settings?.modelEfforts?.[model];
  const effort = isPluginEngineEffort(requested) && offered.includes(requested) ? requested
    : saved && offered.includes(saved) ? saved : '';
  return { ...body, model, effort, fastMode: false };
}

/**
 * The engine belongs to another computer or a shared provider (`body.agentDeviceId`): the plugin
 * need not be installed here, so this computer cannot check the engine itself. Whether that host
 * offers it (plugin supports remote/guest workspace, engine available, opened for remote use, and
 * active share grant) is decided there when the task starts; a refusal surfaces as the start error
 * and never falls back to an engine of this computer.
 */
/** Raw device-link wire peers (shared-task / provider-share channels) cannot host a plugin engine. */
export function isDisallowedPluginEngineDeviceId(deviceId: string | null | undefined): boolean {
  return Boolean(deviceId && (isSharedTaskPeer(deviceId) || parseProviderSharePeer(deviceId)));
}

function admitPluginEngineSessionElsewhere(body: SessionOpenBody): SessionOpenBody {
  if (typeof body.agentDeviceId === 'string' && isDisallowedPluginEngineDeviceId(body.agentDeviceId)) {
    throw new Error('无效的插件引擎运行位置。请重新选择插件引擎。');
  }
  const model = typeof body.model === 'string' && body.model.trim() ? body.model : PLUGIN_ENGINE_DEFAULT_MODEL;
  return { ...body, model, effort: isPluginEngineEffort(body.effort) ? body.effort : '', fastMode: false };
}

/** What a task switching onto a plugin engine starts with (the engine's own values, see below). */
export interface PluginEngineSwitchTarget {
  model: string;
  /** '' = the engine keeps its own level. */
  effort: PluginEngineEffort | '';
  permissionMode: PluginEnginePermissionModeId;
  /** The engine's name, for the handoff and the switch divider. */
  engineName: string;
}

/**
 * Admission for an existing task switching onto a plugin engine (sessionAgentSwitchHandler).
 * Same rules as opening a task on it: the engine must be offered on this computer right now; the
 * model is the engine's own value; a reasoning level only when the engine lists it for that model.
 * The task keeps its permission mode when the engine offers it, else it takes the mode a new task on
 * that engine starts in. Full access is offered by every engine, so it is kept only when the task
 * already had it.
 */
export function admitPluginEngineSwitchTarget(
  target: { providerId: string | null | undefined; model: string; effort?: unknown; permissionMode?: string | null },
  engines: readonly PluginEngineView[],
): PluginEngineSwitchTarget {
  const key = pluginEngineKeyFromProviderId(target.providerId);
  if (!key) throw new Error('缺少插件引擎标识。请重新选择插件引擎。');
  const engine = engines.find((item) => item.key === key);
  if (!engine) throw new Error('提供这个引擎的插件已停用或卸载。请重新选择模型。');
  if (engine.suspended) throw new Error(pluginEngineSuspendedMessage(engine.name));
  if (engine.availability.state === 'unavailable') {
    const hint = engine.availability.message?.trim();
    throw new Error(hint ? `${engine.name} 当前不可用：${hint}` : `${engine.name} 当前不可用。`);
  }
  const model = target.model.trim() ? target.model : PLUGIN_ENGINE_DEFAULT_MODEL;
  if (engine.disabledModels?.some((item) => item.id === model)) throw new Error(pluginEngineModelOffMessage(engine.name));
  if (engine.defaultModelAllowed === false
    && (model === PLUGIN_ENGINE_DEFAULT_MODEL || !engine.models.some((item) => item.id === model))) {
    throw new Error(`${engine.name} 当前没有开放这个模型。请重新选择模型。`);
  }
  const offered = engine.models.find((item) => item.id === model)?.efforts ?? [];
  const saved = engine.modelEfforts?.[model];
  const effort = isPluginEngineEffort(target.effort) && offered.includes(target.effort) ? target.effort
    : saved && offered.includes(saved) ? saved : '';
  const permissionMode = engine.permissionModes.find((mode) => mode.id === target.permissionMode)?.id
    ?? engine.defaultPermissionMode;
  return { model, effort, permissionMode, engineName: engine.name };
}
