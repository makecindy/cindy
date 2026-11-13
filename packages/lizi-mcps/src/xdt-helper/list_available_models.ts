/**
 * xdt-helper/list_available_models.ts —— 列出每个 agent 当前 host 支持的 model。
 * 用于 send_to_session 新建普通任务或 create_worker 前确认 model 名拼写, Codex 和 Claude Code 模型不可跨用。
 */

import { BRAND_NAME } from '@cindy/maker-shared/branding';
import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult } from '../lizi_xdtHelperMcpServer.js';
import { okPayload, errorPayload } from './_payload.js';
import { LOCAL_AGENT_DEVICE, toHostAgentDeviceId } from './create_worker.js';

export interface ModelDescriptor {
  id: string;
  label: string;
  /** 当前已连接且可为该 agent 路由此模型的来源。 */
  providers?: Array<{ id: string; name: string }>;
  /** 未显式指定来源时,host 当前会采用的 provider id。 */
  defaultProviderId?: string | null;
}

/** tier: 'budget' = openai-codex/ 或 codex/ 前缀的 gateway 折扣路由, 'standard' = 官方原版。仅出现在返回值, 供 agent 精准选型。 */
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
 * tier='budget'(gateway 折扣路由) 的判定依据是 model id 的 `openai-codex/` 或 `codex/` 前缀 ——
 * 与 `@cindy/model-providers` 的 `CODEX_GATEWAY_WIRE_PREFIXES` 保持一致,
 * 也与 host CODEX_BUDGET_MODELS 的 id 命名约定一致。据此打 tier 后, agent 不必再从
 * label / description 里语义推断, 直接按 tier 精准匹配用户指定的档位。
 * label (= host displayName, 同时是 UI 下拉展示名) 不受影响, 保持干净。
 */
function isBudgetWireModel(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  return (
    (id.startsWith('openai-codex/') && id.length > 'openai-codex/'.length) ||
    (id.startsWith('codex/') && id.length > 'codex/'.length)
  );
}

function tagTier(models: ModelDescriptor[] | undefined): TaggedModel[] | undefined {
  if (!models) return undefined;
  return models.map((m) => ({
    id: m.id,
    label: m.label,
    tier: isBudgetWireModel(m.id) ? 'budget' : 'standard',
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
  /** 调用方任务(可选)：它的 Agent 在另一台电脑运行时，按那台的模型目录列出。 */
  getSessionContext?: () => { sessionId?: string };
  listAvailableModels: (params: {
    agent?: 'claude-code' | 'codex' | 'pi';
    callerSessionId?: string;
    executionDeviceId?: string;
    /** 列哪里的模型：省略 = Lead 所在位置；null = 任务所在电脑；string = 那台电脑或分享。 */
    agentDeviceId?: string | null;
  }) => Promise<ControlResult<{
    /** 本次列出的位置(null = 任务所在电脑)；旧 host 不带。 */
    agentDeviceId?: string | null;
    /** 还能放 Worker Agent 的其他位置；旧 host 不带。 */
    locations?: Array<{ agentDeviceId: string; name: string }>;
    codex?: ModelDescriptor[];
    claude_code?: ModelDescriptor[];
    pi?: ModelDescriptor[];
  }, string>>;
}

/** host 的位置(null = 任务所在电脑) → MCP 的 agent_device_id(`local`)。 */
function toToolAgentDeviceId(value: string | null): string {
  return value ?? LOCAL_AGENT_DEVICE;
}

const DESCRIPTION = [
  '列出每个 agent 当前 host 支持的 model id 清单, 用于 send_to_session 新建普通任务或 create_worker 前确认 model 名拼写。',
  'Codex 和 Claude Code 支持的 model 完全不同, 不可跨用。',
  '',
  '普通任务使用 device 选择任务电脑、provider_device_id 选择供应商位置；execution_device_id / agent_device_id 是兼容旧名。位置参数同时给新旧名时必须一致。',
  '参数:',
  '- agent: 可选, codex / claude-code / pi; 不传返三者',
  '- device: 可选，任务和文件所在电脑，取 list_machines 的 machines.computers[].deviceId；local 为本机。旧名 execution_device_id 继续支持。',
  '- provider_device_id: 可选，模型供应商位置，取 locations[].provider_device_id；local 相对 device 指定的任务电脑。不传 device 时保留当前任务的模型位置。旧名 agent_device_id 继续支持。',
  '',
  '返回值:',
  '- device: 显式查询的任务电脑；provider_device_id: 实际模型位置；locations: 其他可选供应商位置。agent_device_id 保留为旧名。send_to_session 使用同一 device、provider_device_id 和 model；Worker 仍用 execution_device_id、agent_device_id。',
  '- codex: Codex agent 的可用 model 列表 [{id, label, tier, providers, default_provider_id}]',
  '- claude_code: Claude Code agent 的可用 model 列表 [{id, label, tier, providers, default_provider_id}]',
  '- pi: Pi agent 的可用 model 列表 [{id, label, tier, providers, default_provider_id}]',
  '- providers: 当前已连接且实际提供该模型的来源 [{provider_id, provider_name}]。普通任务按精确 model 使用宿主默认来源，不传 provider_id；显式创建 Worker 时可把选定的 provider_id 传给 create_worker/create_workers。',
  '- default_provider_id: 未显式选择来源时 host 当前解析出的默认来源；providers 只有一项时直接使用该项。',
  '',
  'tier 字段 (用于精准选型, 不要靠 label 推断):',
  "- tier='budget': openai-codex/ 或 codex/ 前缀的 gateway 折扣路由 (如 openai-codex/gpt-5.5、codex/gpt-5.5)",
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
      device: z.string().trim().min(1).max(128).optional().describe('任务所在电脑，取 list_machines 的 machines.computers[].deviceId；查询在这台电脑创建任务可用的模型。省略保持当前任务的位置。'),
      provider_device_id: z.string().trim().min(1).max(128).optional().describe('模型供应商所在电脑；local 相对 device 指定的任务电脑。agent_device_id 为兼容旧名。'),
      agent: z
        .enum(['codex', 'claude-code', 'pi'])
        .optional()
        .describe('可选, 只查某一 agent 的 model 列表; 不传返三者'),
      agent_device_id: z
        .string()
        .trim()
        .min(1)
        .max(128)
        .optional()
        .describe('可选, 模型位置: locations[].agent_device_id 或 "local"；指定工作电脑时相对它，否则不传跟 Lead'),
      execution_device_id: z.string().trim().min(1).max(128).optional()
        .describe('兼容旧名；优先用 device 指定任务电脑，查询它可用的模型与远程供应商'),
    },
    handler: async ({ agent, agent_device_id, execution_device_id, device, provider_device_id }) => {
      if ((device !== undefined && execution_device_id !== undefined && device !== execution_device_id)
        || (provider_device_id !== undefined && agent_device_id !== undefined && provider_device_id !== agent_device_id))
        return errorPayload('INVALID_ARGS', '设备参数与兼容旧名不一致，请只指定一个任务位置和一个供应商位置。');
      execution_device_id = device ?? execution_device_id;
      agent_device_id = provider_device_id ?? agent_device_id;
      const callerSessionId = deps.getSessionContext?.().sessionId;
      const result = await deps.listAvailableModels({
        agent,
        ...(callerSessionId ? { callerSessionId } : {}),
        ...(execution_device_id !== undefined ? { executionDeviceId: execution_device_id } : {}),
        ...toHostAgentDeviceId(agent_device_id),
      });
      if (!result.ok) {
        if (result.errorCode === 'HOST_NOT_READY') {
          return errorPayload('HOST_NOT_READY', `${BRAND_NAME} 主进程协同服务尚未就绪。`);
        }
        // 那台电脑 / 分享不可用时保留原因，Lead 才能如实告诉用户。
        return errorPayload(
          result.errorCode.startsWith('REMOTE_AGENT_') || result.errorCode === 'UNSUPPORTED_CAPABILITY' ? result.errorCode : 'INTERNAL',
          result.message,
        );
      }
      return okPayload({
        ...(execution_device_id !== undefined ? { device: execution_device_id } : {}),
        ...(result.agentDeviceId !== undefined
          ? { provider_device_id: toToolAgentDeviceId(result.agentDeviceId), agent_device_id: toToolAgentDeviceId(result.agentDeviceId) }
          : {}),
        ...(result.locations
          ? {
              locations: result.locations.map((location) => ({
                provider_device_id: location.agentDeviceId,
                agent_device_id: location.agentDeviceId,
                name: location.name,
              })),
            }
          : {}),
        codex: tagTier(result.codex),
        claude_code: tagTier(result.claude_code),
        pi: tagTier(result.pi),
      });
    },
  });
}
