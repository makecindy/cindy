import { z } from 'zod';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

const id = z.string().min(1).max(256);
const agent = z.enum(['claude-code', 'codex', 'pi']);
const endpoint = z.string().url().max(2048).refine(value => {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && url.origin.length <= 512 && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}, 'Use a public endpoint without credentials, query or fragment');
const interruptCodex = z.boolean().optional().describe('Only after the owner agrees to interrupt running local Codex work; call from Claude Code or Pi.');
const connectionModel = z.strictObject({ id, name: z.string().min(1).max(256).optional() });
const connectionRuntime = z.strictObject({
  baseUrl: endpoint, modelsUrl: endpoint.optional(),
  wireProtocol: z.enum(['anthropic-messages', 'openai-responses', 'openai-chat', 'google-generative-ai']),
  supportsImageGeneration: z.boolean().optional(),
  models: z.array(connectionModel).max(2000),
});
export const providerConnectionChange = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('presets') }),
  z.strictObject({ action: z.literal('read'), providerId: id }),
  z.strictObject({ action: z.literal('create'), name: z.string().trim().min(1).max(60),
    presetId: id.optional(), authMethod: z.enum(['apiKey', 'none']).optional(),
    runtimes: z.strictObject({ 'claude-code': connectionRuntime.optional(), codex: connectionRuntime.optional(), pi: connectionRuntime.optional() }).optional(),
    interruptCodex,
  }),
  z.strictObject({ action: z.literal('setRuntime'), providerId: id, agent, runtime: connectionRuntime, interruptCodex }),
  z.strictObject({ action: z.literal('remove'), providerId: id, interruptCodex }),
  z.strictObject({ action: z.literal('setKey'), providerId: id, agent, interruptCodex }),
  z.strictObject({ action: z.literal('refreshModels'), providerId: id, agent, interruptCodex }),
  z.strictObject({ action: z.literal('setModels'), providerId: id, agent, models: z.array(connectionModel).max(2000), interruptCodex }),
  z.strictObject({ action: z.literal('test'), providerId: id, agent }),
]);
const target = z.strictObject({ providerId: id, agent: z.enum(['claude-code', 'codex', 'pi']), modelId: id });
const quote = z.strictObject({ currency: z.enum(['USD', 'CNY']), inputPerMtok: z.number().nonnegative(),
  outputPerMtok: z.number().nonnegative(), cacheReadPerMtok: z.number().nonnegative().nullable().optional(),
  cacheCreatePerMtok: z.number().nonnegative().nullable().optional() });
export const appModelConfiguration = z.discriminatedUnion('setting', [
  z.strictObject({ setting: z.literal('visible'), value: z.boolean().nullable() }),
  z.strictObject({ setting: z.literal('contextLimit'), value: z.number().int().min(1000).max(100_000_000).nullable() }),
  z.strictObject({ setting: z.literal('compactionPercent'), value: z.number().int().min(50).max(90).nullable() }),
  z.strictObject({ setting: z.literal('imageInput'), value: z.boolean().nullable() }),
  z.strictObject({ setting: z.literal('price'), value: quote.nullable() }),
]);
export const appProviderChange = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('rename'), providerId: id, name: z.string().trim().min(1).max(128) }),
  z.strictObject({ action: z.literal('order'), providerIds: z.array(id).min(1).max(512) }),
  z.strictObject({ action: z.literal('visibility'), providerId: id, disabled: z.boolean(), modelIds: z.array(id).min(1).max(512).optional() }),
  z.strictObject({ action: z.literal('resetVisibility'), providerId: id }),
  z.strictObject({ action: z.literal('rediscover'), providerId: id }),
  z.strictObject({ action: z.literal('remove'), providerId: id }),
  z.strictObject({ action: z.literal('restore'), providerId: id }),
  // 2026-11-13: any provider that holds subscription accounts (built-in, created by Cindy, or a
  // legacy Codex connection); the host resolves it and rejects others with the settings page's checks.
  z.strictObject({ action: z.literal('subscriptionAccounts'), providerId: z.string().regex(/^[a-z0-9_-]{1,40}$/),
    command: z.strictObject({
      action: z.enum(['read', 'add', 'create', 'login', 'cancel', 'remove', 'configure', 'place', 'merge', 'remove-provider']),
      accountId: id.optional(), loginKey: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional(),
      target: z.string().regex(/^[a-z0-9_-]{1,40}$/).nullable().optional(),
      strategy: z.enum(['least', 'round', 'order', 'weight', 'usage']).optional(),
      paused: z.boolean().optional(), limit: z.number().int().min(1).max(16).nullable().optional(), weight: z.number().int().min(1).max(100).optional(),
    }) }),
]);
export type AppModelsRequest =
  | { operation: 'connection'; change: z.infer<typeof providerConnectionChange> }
  | { operation: 'list'; providerId?: string }
  | { operation: 'get'; target: z.infer<typeof target> }
  | { operation: 'set'; target: z.infer<typeof target>; change: z.infer<typeof appModelConfiguration> }
  | { operation: 'provider'; change: z.infer<typeof appProviderChange> };
export interface AppModelsCallbacks {
  call(input: AppModelsRequest & { callerSessionId: string }, signal?: AbortSignal): Promise<Record<string, unknown>>;
}

export function registerAppModelsTools(registry: XdtHelperToolRegistry, callbacks: AppModelsCallbacks,
  context: () => LiziMcpSessionContext): void {
  const invoke = async (input: AppModelsRequest, signal?: AbortSignal) => {
    const ctx = context();
    if (!ctx.sessionId || ctx.remoteHostId) return errorPayload('CAPABILITY_NOT_AVAILABLE', '请在目标电脑的本机任务中管理模型设置。');
    if (input.operation === 'connection' && 'interruptCodex' in input.change && input.change.interruptCodex && ctx.agentKind === 'codex')
      return errorPayload('CODEX_CALLER_WOULD_STOP', '此操作会中断当前 Codex 执行。请用 Claude Code 或 Pi 执行这次连接修改。');
    try {
      signal?.throwIfAborted();
      const request = { ...input, callerSessionId: ctx.sessionId };
      const result = await (signal ? callbacks.call(request, signal) : callbacks.call(request));
      return result.ok === false ? errorPayload(String(result.errorCode ?? 'MODEL_SETTINGS_FAILED'),
        '操作未完成，请读取当前配置后处理返回的原因。', result) : okPayload(result);
    } catch { return errorPayload('MODEL_SETTINGS_FAILED', '模型设置操作未确认完成。请重新查询；账号变化、组织管理策略或型号已不可用时不能保存。'); }
  };
  registry.register({ name: 'list_model_providers', category: 'settings',
    description: '读取这台电脑的完整模型供应商目录、供应商顺序及模型开关，包括未启用的型号。返回安全投影，不返回密钥或鉴权请求头。当前任务选模用任务控制工具，全局默认模型用 get_app_default_model。',
    inputShape: { providerId: id.optional() }, handler: input => invoke({ operation: 'list', ...input }) });
  registry.register({ name: 'get_model_configuration', category: 'settings',
    description: '读取某个供应商、引擎与模型的选择器显示开关、上下文窗口覆盖、压缩阈值、图片输入与价格覆盖。先从 list_model_providers 取准确身份。',
    inputShape: { target }, handler: input => invoke({ operation: 'get', ...input }) });
  registry.register({ name: 'set_model_configuration', category: 'settings',
    description: '修改用户指定模型的一项高级配置；visible 控制是否在选择器显示，不等于停用；value=null 删除该项覆盖并跟随默认，不影响其它配置。价格只影响本地用量估算，不改供应商实际账单。复用设置页校验与生效逻辑。',
    inputShape: { target, change: appModelConfiguration }, handler: input => invoke({ operation: 'set', ...input }) });
  registry.register({ name: 'configure_model_provider', category: 'settings',
    description: '管理这台电脑的供应商名称、顺序、开关与模型发现。subscriptionAccounts 管 Anthropic/OpenAI 订阅账号，providerId 可以是 anthropic/openai 或 list_model_providers 里带 subscriptionAccountPool 的同类供应商（每个供应商只分配自己的账号）：command.action=read 查看该供应商的账号；create（providerId 只能是 anthropic/openai）登录另一个账号并作为单独的新供应商，add 登录另一个账号并加入 providerId 指定的供应商，login 重新登录已有账号，这三者都用官方 CLI 浏览器登录（需唯一 loginKey），cancel 用同一 loginKey；place 把 accountId 移到 target 指定的同类供应商，target=null 为拿出来作为单独供应商；merge 把该供应商的全部账号并入 target；remove-provider 删除 Cindy 新建的订阅供应商，不再使用其账号、保留 CLI 文件。官方默认登录（账号 default）固定在内置供应商，不能移走。移动、并入与拿出不改任务与账号的绑定：已有任务继续用原账号；拿出生成的新供应商默认不开远程调用、分享和供应商组。configure 设置策略或账号暂停、并发上限（limit=null 为不限制，未设置过即不限制；达到上限不再分配新任务）、权重；remove 移出非默认账号，保留 CLI 文件。账号 id 来自 read，不收凭证或自定义路径。供应商 remove/restore 只管理已断开内置来源的显示。',
    inputShape: { change: appProviderChange }, handler: input => invoke({ operation: 'provider', ...input }) });
  registry.register({ name: 'configure_model_connection', category: 'settings',
    description: '直接配置这台电脑的 API 模型连接，无需 Computer Use。presets 查看模板；create 使用 presetId 或显式 runtimes（模型可先为空），返回新连接 ID；read 查看连接。API key 只由主人通过 Cindy 安全输入卡交给宿主，禁止在参数、对话或文件中传密钥；不同端点分别填写。none 仅用于免密本机服务。setKey 更换指定引擎密钥；setRuntime 设置一个引擎的端点、协议与型号，变更端点时重新安全输入密钥，保留其它引擎；remove 删除该连接及专属凭证，不删历史。refreshModels 获取并合并型号、保留用户覆盖；setModels 设置型号名单；test 经保存路线发最小推理请求，可能计费。保存、目录发现、推理验证分别报告。需要重载且 Codex 正忙时返回 confirmationRequired，不写入；主人同意中断后可从 Claude Code/Pi 使用 interruptCodex=true，不能中断调用工具的 Codex 自己。不支持 SSH；手机可经原有加密代输入卡填写密钥。',
    inputShape: { change: providerConnectionChange }, handler: (input, signal) => invoke({ operation: 'connection', ...input }, signal) });
}
