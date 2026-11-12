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
const connectionModel = z.strictObject({ id, name: z.string().min(1).max(256).optional(),
  mode: z.enum(['chat', 'image_generation', 'video_generation']).optional().describe('媒体型号按用户资料显式声明；不根据品牌或型号名称猜测。Guide 可随后通过 manage_media_guide 补齐。'),
  modalities: z.strictObject({ input: z.array(z.enum(['text', 'image', 'video', 'audio'])).min(1).max(4),
    output: z.array(z.enum(['text', 'image', 'video', 'audio'])).min(1).max(4) }).optional().describe('实际输入/输出能力；图片编辑或图生视频须声明 image 输入。媒体能力独立于聊天图片输入和 supportsImageGeneration。'),
});
const connectionRuntime = z.strictObject({
  baseUrl: endpoint, modelsUrl: endpoint.optional(),
  wireProtocol: z.enum(['anthropic-messages', 'openai-responses', 'openai-chat', 'google-generative-ai']),
  supportsImageGeneration: z.boolean().optional(),
  imageApi: z.literal('openai-images').optional(),
  videoApi: z.enum(['xai-videos', 'minimax-videos', 'openai-videos']).optional(),
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
const guideEvidence = z.strictObject({ kind: z.enum(['documentation', 'curl', 'prompt']), reference: z.string().min(1).max(2048) });
export const mediaGuideChange = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('get'), source: z.enum(['auto', 'official']).optional() }),
  z.strictObject({ action: z.literal('validate'), guide: z.record(z.string(), z.unknown()) }),
  z.strictObject({ action: z.literal('save'), guide: z.record(z.string(), z.unknown()), expectedRevision: z.string().min(1).max(128).nullable(), evidence: guideEvidence.optional() }),
]);
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
  z.strictObject({ action: z.literal('subscriptionAccounts'), providerId: z.enum(['anthropic', 'openai']),
    command: z.strictObject({ action: z.enum(['read', 'add', 'login', 'cancel', 'remove', 'configure']),
      accountId: id.optional(), loginKey: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional(),
      strategy: z.enum(['least', 'round', 'order', 'weight', 'usage']).optional(),
      paused: z.boolean().optional(), limit: z.number().int().min(1).max(16).nullable().optional(), weight: z.number().int().min(1).max(100).optional(),
    }) }),
]);
export type AppModelsRequest =
  | { operation: 'mediaGuide'; target: z.infer<typeof target>; change: z.infer<typeof mediaGuideChange> }
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
  registry.register({ name: 'manage_media_guide', category: 'settings',
    description: '按需获取或补齐指定 provider/引擎/model 的媒体调用 Guide。每次需要时 get：自定义优先，没有则官方；source=official 明确尝试官方说明，执行连接、账号与计费不变。缺失时根据用户给的文档链接、cURL、示例或提示生成声明式 HTTP Guide，缺关键资料再请用户协助；不要让用户编写 JSON。validate 只检查不调用；save 按现有任务权限保存，expectedRevision 使用 get 的 customRevision（首次为 null），资料来源如实填 evidence，不能伪造 officialDocs。保存后再次 get 自然生效；prepare 固定快照，换 Guide 重新 prepare。实际生成只能通过 cindy.media 并经过当前 Ask/Auto/完全访问权限及附件交接，不得用 shell/raw HTTP 绕过。只有真实媒体交付才算验证成功；pending、提交结果未知或已经生成但交付失败时恢复原 invocation，不能重复生成。Guide 不得含 host、凭证或执行脚本。',
    inputShape: { target, change: mediaGuideChange }, handler: (input, signal) => invoke({ operation: 'mediaGuide', ...input }, signal) });
  registry.register({ name: 'set_model_configuration', category: 'settings',
    description: '修改用户指定模型的一项高级配置；visible 控制是否在选择器显示，不等于停用；value=null 删除该项覆盖并跟随默认，不影响其它配置。价格只影响本地用量估算，不改供应商实际账单。复用设置页校验与生效逻辑。',
    inputShape: { target, change: appModelConfiguration }, handler: input => invoke({ operation: 'set', ...input }) });
  registry.register({ name: 'configure_model_provider', category: 'settings',
    description: '管理这台电脑的供应商名称、顺序、开关与模型发现。subscriptionAccounts 管 Anthropic/OpenAI 订阅账号：command.action=read 查看账号状态；add/login 使用官方 CLI 浏览器登录（需唯一 loginKey），cancel 用同一 loginKey；configure 设置策略或账号暂停、并发上限（limit=null 为不限制，未设置过即不限制；达到上限不再分配新任务）、权重；remove 移出非默认账号，保留 CLI 文件。账号 id 来自 read，不收凭证或自定义路径。供应商 remove/restore 只管理已断开内置来源的显示。',
    inputShape: { change: appProviderChange }, handler: input => invoke({ operation: 'provider', ...input }) });
  registry.register({ name: 'configure_model_connection', category: 'settings',
    description: '直接配置这台电脑的 API 模型连接，无需 Computer Use。presets 查看模板；create 使用 presetId 或显式 runtimes（模型可先为空），返回新连接 ID；read 查看连接。API key 只由主人通过 Cindy 安全输入卡交给宿主，禁止在参数、对话或文件中传密钥；不同端点分别填写。none 仅用于免密本机服务。setKey 更换指定引擎密钥；setRuntime 设置一个引擎的端点、协议与型号，变更端点时重新安全输入密钥，保留其它引擎；remove 删除该连接及专属凭证，不删历史。refreshModels 获取并合并型号、保留用户覆盖；setModels 设置型号名单；test 经保存路线发最小推理请求，可能计费。保存、目录发现、推理验证分别报告。需要重载且 Codex 正忙时返回 confirmationRequired，不写入；主人同意中断后可从 Claude Code/Pi 使用 interruptCodex=true，不能中断调用工具的 Codex 自己。不支持 SSH；手机可经原有加密代输入卡填写密钥。',
    inputShape: { change: providerConnectionChange }, handler: (input, signal) => invoke({ operation: 'connection', ...input }, signal) });
}
