/**
 * xdt-helper/list_available_models.ts —— 列出每个 agent 当前 host 支持的 model。
 * 用于 create_worker 前确认 model 名拼写, Codex 和 Claude Code 模型不可跨用。
 */

import { BRAND_NAME } from '@cindy/maker-shared/branding';
import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult } from '../lizi_xdtHelperMcpServer.js';
import { okPayload, errorPayload } from './_payload.js';

export interface ModelDescriptor {
  id: string;
  label: string;
  /** 当前已连接且可为该 agent 路由此模型的来源。 */
  providers?: Array<{ id: string; name: string }>;
  /** 未显式指定来源时,host 当前会采用的 provider id。 */
  defaultProviderId?: string | null;
}

/** tier: 'budget' = codex/ 前缀的 gateway 折扣路由, 'standard' = 官方原版。仅出现在返回值, 供 agent 精准选型。 */
type ModelTier = 'budget' | 'standard';

interface TaggedModel {
  id: string;
  label: string;
  tier: ModelTier;
  providers?: Array<{ provider_id: string; provider_name: string }>;
  default_provider_id?: string | null;
}

/**
 * 给每个 model 打 tier 标记。
 *
 * tier='budget'(gateway 折扣 codex 路由) 的唯一判定依据是 model id 的 `codex/` 前缀 ——
 * 与 renderer ModelSelector.categorize() 的归类规则保持一致 (codex/* → 折扣分组),
 * 也与 host CODEX_BUDGET_MODELS 的 id 命名约定一致。据此打 tier 后, agent 不必再从
 * label / description 里语义推断, 直接按 tier 精准匹配用户指定的档位。
 * label (= host displayName, 同时是 UI 下拉展示名) 不受影响, 保持干净。
 */
function tagTier(models: ModelDescriptor[] | undefined): TaggedModel[] | undefined {
  if (!models) return undefined;
  return models.map((m) => ({
    id: m.id,
    label: m.label,
    tier: m.id.startsWith('codex/') ? 'budget' : 'standard',
    ...(m.providers
      ? {
          providers: m.providers.map((provider) => ({
            provider_id: provider.id,
            provider_name: provider.name,
          })),
        }
      : {}),
    ...(m.defaultProviderId !== undefined
      ? { default_provider_id: m.defaultProviderId }
      : {}),
  }));
}

export interface ListAvailableModelsDeps {
  listAvailableModels: (params: {
    agent?: 'claude-code' | 'codex' | 'pi';
  }) => Promise<ControlResult<{
    codex?: ModelDescriptor[];
    claude_code?: ModelDescriptor[];
    pi?: ModelDescriptor[];
  }>>;
}

const DESCRIPTION = [
  '列出每个 agent 当前 host 支持的 model id 清单, 用于 create_worker 前确认 model 名拼写。',
  'Codex 和 Claude Code 支持的 model 完全不同, 不可跨用。',
  '',
  '参数:',
  '- agent: 可选, codex / claude-code / pi; 不传返三者',
  '',
  '返回值:',
  '- codex: Codex agent 的可用 model 列表 [{id, label, tier, providers, default_provider_id}]',
  '- claude_code: Claude Code agent 的可用 model 列表 [{id, label, tier, providers, default_provider_id}]',
  '- pi: Pi agent 的可用 model 列表 [{id, label, tier, providers, default_provider_id}]',
  '- providers: 当前已连接且实际提供该模型的来源 [{provider_id, provider_name}]。创建 Worker 时把选定的 provider_id 原样传给 create_worker/create_workers。',
  '- default_provider_id: 未显式选择来源时 host 当前解析出的默认来源；providers 只有一项时直接使用该项。',
  '',
  'tier 字段 (用于精准选型, 不要靠 label 推断):',
  "- tier='budget': codex/ 前缀的 gateway 折扣路由 (如 codex/gpt-5.5)",
  "- tier='standard': 官方原版 (如 gpt-5.5)",
  '选型规则: 用户明确要求折扣路由 → 选 tier=budget 的模型; 说「官方 / 原版 / 普通版」→ 选 tier=standard。',
  '默认规则: 用户只报模型名 (如 "gpt-5.5") 时, 一律默认 tier=standard (官方原版); 只有用户明确要求折扣路由才允许选 tier=budget。',
  '注意 budget 与 standard 可能 label 同名 (都叫 GPT-5.5), 必须用 tier 区分, 不能只看 label。',
  'tier=budget 仅在 Codex「API key 模式」下可用; OAuth 模式下 create_worker 会返 BUDGET_MODEL_REQUIRES_API_MODE。用户要 budget 档时, 若被拒就如实告知需切到 API key 模式。',
].join('\n');

export function registerListAvailableModelsTool(
  registry: XdtHelperToolRegistry,
  deps: ListAvailableModelsDeps,
): void {
  registry.register({
    name: 'list_available_models',
    category: 'control',
    description: DESCRIPTION,
    inputShape: {
      agent: z
        .enum(['codex', 'claude-code', 'pi'])
        .optional()
        .describe('可选, 只查某一 agent 的 model 列表; 不传返三者'),
    },
    handler: async ({ agent }) => {
      const result = await deps.listAvailableModels({ agent });
      if (!result.ok) {
        if (result.errorCode === 'HOST_NOT_READY') {
          return errorPayload('HOST_NOT_READY', `${BRAND_NAME} 主进程协同服务尚未就绪。`);
        }
        return errorPayload('INTERNAL', result.message);
      }
      return okPayload({
        codex: tagTier(result.codex),
        claude_code: tagTier(result.claude_code),
        pi: tagTier(result.pi),
      });
    },
  });
}
