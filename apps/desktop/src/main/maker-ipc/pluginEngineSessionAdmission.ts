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
import type { PluginHarness } from '../cindy-brain/pluginHarnesses.js';
import type { SessionOpenBody } from '../localDb/sessionOpening.js';
import {
  PLUGIN_ENGINE_DEFAULT_MODEL,
  isPluginEngineEffort,
  pluginEngineKeyFromProviderId,
  type PluginEngineModel,
} from '../../shared/pluginEngines.js';

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
): SessionOpenBody {
  const key = pluginEngineKeyFromProviderId(body.providerId);
  if (!key) throw new Error('插件引擎任务缺少引擎标识。请在新建任务时重新选择插件引擎。');
  if (body.remoteHostId || body.agentDeviceId) {
    throw new Error('插件引擎只能在本机运行。请在新建任务时选择本机。');
  }
  const harness = harnesses.find((item) => item.key === key);
  if (!harness) {
    throw new Error('提供这个引擎的插件已停用或卸载。请在新建任务时重新选择模型。');
  }
  if (harness.availability.state === 'unavailable') {
    const hint = harness.availability.message?.trim();
    throw new Error(hint ? `${harness.name} 当前不可用：${hint}` : `${harness.name} 当前不可用。`);
  }
  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : PLUGIN_ENGINE_DEFAULT_MODEL;
  const requested = body.effort;
  const offered = modelsOf(harness).find((item) => item.id === model)?.efforts ?? [];
  const effort = isPluginEngineEffort(requested) && offered.includes(requested) ? requested : '';
  return { ...body, model, effort, fastMode: false };
}
