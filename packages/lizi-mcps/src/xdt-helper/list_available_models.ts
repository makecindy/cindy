import { BRAND_NAME } from '@cindy/maker-shared/branding';
import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult } from '../lizi_xdtHelperMcpServer.js';
import { okPayload, errorPayload } from './_payload.js';

export interface ModelDescriptor {
  id: string;
  label: string;
  category?: string;
  group?: string;
}

/** tier: catalog budget group/category first; legacy codex/ prefix is the fallback. */
type ModelTier = 'budget' | 'standard';

interface TaggedModel extends ModelDescriptor {
  tier: ModelTier;
}

/**
 * Keep this adapter dependency-free: lizi-mcps consumes the already projected catalog fields.
 * Missing/unknown fields intentionally retain the legacy codex/ heuristic for old hosts.
 */
function isBudgetModel(model: Pick<ModelDescriptor, 'id' | 'category' | 'group'>): boolean {
  const declared = model.category ?? model.group;
  if (declared === 'gpt-budget') return true;
  if (declared !== undefined) return false;
  return model.id.startsWith('codex/');
}

/** Add the tier marker without asking agents to infer it from labels. */
export function tagTier(models: ModelDescriptor[] | undefined): TaggedModel[] | undefined {
  if (!models) return undefined;
  return models.map((m) => ({
    ...m,
    tier: isBudgetModel(m) ? 'budget' : 'standard',
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
  '- agent: 可选, codex 或 claude-code; 不传返两者',
  '',
  '返回值:',
  '- codex: Codex agent 的可用 model 列表 [{id, label, tier}]',
  '- claude_code: Claude Code agent 的可用 model 列表 [{id, label, tier}]',
  '',
  'tier 字段 (用于精准选型, 不要靠 label 推断):',
  "- tier='budget': catalog 的 group/category=gpt-budget;旧 host 缺字段时 codex/ 前缀兜底",
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
