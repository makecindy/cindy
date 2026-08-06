import type {
  AgentKind,
  CreateScheduleInput,
  Schedule,
  UpdateScheduleInput,
} from '@cindy/maker-scheduler';
import {
  isModelSelectableForNewRoute,
  resolveDefaultModel,
  type Catalog,
} from '@cindy/model-providers';

import { getActiveCatalog } from '../maker-host/active-catalog.js';

const FALLBACK_SCHEDULE_MODELS: Record<AgentKind, string> = {
  'claude-code': 'claude-sonnet-4-6',
  codex: 'gpt-5.5',
  pi: '',
};

function isRoutableScheduleDefault(
  catalog: Pick<Catalog, 'providers' | 'defaults'>,
  agentKind: Exclude<AgentKind, 'pi'>,
  modelId: string,
): boolean {
  return catalog.providers.some((provider) => {
    const route = provider.routing[agentKind];
    if (!provider.agents.includes(agentKind) || !route || route.disabled === true) return false;
    return (provider.models[agentKind] ?? []).some(
      (model) =>
        model.id === modelId
        && isModelSelectableForNewRoute(model, { userProvider: provider.source === 'user' }),
    );
  });
}

/** Scheduler defaults follow the active catalog and retain historical fallbacks offline. */
export function defaultModelFor(
  agentKind: AgentKind,
  catalog: Pick<Catalog, 'providers' | 'defaults'> = getActiveCatalog(),
): string {
  // Pi 没有跨来源合法的静态默认,目录默认同样不适用:runner 会用实时连接目录解析
  // {model,providerId}。空字符串可阻止其它调用方制造“看似可用”的 Claude 假路由,
  // 因此 pi 不进 resolver —— 目录里若真给了 pi 默认,也不能在这里落成静态 id。
  if (agentKind === 'pi') return '';
  const catalogDefault = resolveDefaultModel(
    catalog,
    agentKind,
    'session',
    '',
  );
  return catalogDefault && isRoutableScheduleDefault(catalog, agentKind, catalogDefault)
    ? catalogDefault
    : FALLBACK_SCHEDULE_MODELS[agentKind];
}

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function isAgentKind(value: unknown): value is AgentKind {
  return value === 'claude-code' || value === 'codex' || value === 'pi';
}

function materializedDefault(
  agentKind: unknown,
  catalog: Pick<Catalog, 'providers' | 'defaults'>,
): string {
  if (!isAgentKind(agentKind) || agentKind === 'pi') return '';
  return defaultModelFor(agentKind, catalog);
}

/**
 * Freeze a fresh, non-heartbeat agent schedule to the Main process' current catalog default.
 * Script, Pi, bound-session, and explicitly selected model semantics remain byte-for-byte intact.
 */
export function materializeScheduleDefaultForCreate(
  input: CreateScheduleInput,
  catalog: Pick<Catalog, 'providers' | 'defaults'> = getActiveCatalog(),
): CreateScheduleInput {
  if (
    input.executionMode === 'script' ||
    hasText(input.targetSessionId) ||
    hasText(input.model)
  ) {
    return input;
  }
  const model = materializedDefault(input.agentKind, catalog);
  return model ? { ...input, model } : input;
}

/**
 * Apply the same materialization while holding Scheduler's per-task update lock. Effective
 * values combine the current row with the patch so heartbeat transitions and agent changes
 * cannot accidentally freeze the wrong runtime's default.
 */
export function materializeScheduleDefaultForUpdate(
  existing: Schedule,
  patch: UpdateScheduleInput,
  catalog: Pick<Catalog, 'providers' | 'defaults'> = getActiveCatalog(),
): UpdateScheduleInput {
  const hasOwn = (key: keyof UpdateScheduleInput): boolean =>
    Object.prototype.hasOwnProperty.call(patch, key);
  const executionMode = hasOwn('executionMode')
    ? patch.executionMode
    : existing.executionMode;
  const targetSessionId = hasOwn('targetSessionId')
    ? patch.targetSessionId
    : existing.targetSessionId;
  const agentKind = hasOwn('agentKind') ? patch.agentKind : existing.agentKind;
  const agentChanged =
    isAgentKind(patch.agentKind) && patch.agentKind !== existing.agentKind;
  const patchHasModel = hasOwn('model');
  // AgentTabs 无目标记忆时会把 model 清空；Update wire 对非 heartbeat 空值会省略 key。
  // 此时绝不能继承旧 agent 的显式 model，否则会落成「Codex + Claude model」。
  const model = patchHasModel ? patch.model : agentChanged ? undefined : existing.model;

  if (executionMode === 'script' || hasText(model)) return patch;
  if (hasText(targetSessionId)) {
    // Heartbeat 切 agent 时空 model 继续表示跟随绑定会话，但要显式清掉旧 agent override。
    return agentChanged && !patchHasModel ? { ...patch, model: undefined } : patch;
  }
  const nextModel = materializedDefault(agentKind, catalog);
  if (nextModel) return { ...patch, model: nextModel };
  // Pi 没有跨来源静态默认；切入 Pi 时必须清列，让 runner 按实时 Provider 路由解析。
  return agentChanged && !patchHasModel ? { ...patch, model: undefined } : patch;
}
