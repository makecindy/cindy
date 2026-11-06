import { z } from 'zod';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

const id = z.string().min(1).max(256);
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
]);
export type AppModelsRequest =
  | { operation: 'list'; providerId?: string }
  | { operation: 'get'; target: z.infer<typeof target> }
  | { operation: 'set'; target: z.infer<typeof target>; change: z.infer<typeof appModelConfiguration> }
  | { operation: 'provider'; change: z.infer<typeof appProviderChange> };
export interface AppModelsCallbacks {
  call(input: AppModelsRequest & { callerSessionId: string }): Promise<Record<string, unknown>>;
}

export function registerAppModelsTools(registry: XdtHelperToolRegistry, callbacks: AppModelsCallbacks,
  context: () => LiziMcpSessionContext): void {
  const invoke = async (input: AppModelsRequest) => {
    const ctx = context();
    if (!ctx.sessionId || ctx.remoteHostId) return errorPayload('CAPABILITY_NOT_AVAILABLE', '请在目标电脑的本机任务中管理模型设置。');
    try {
      const result = await callbacks.call({ ...input, callerSessionId: ctx.sessionId });
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
    description: '管理供应商名称、显示顺序、供应商或指定型号开关、恢复默认开关、重新发现模型。remove/restore 只管理已断开内置来源的显示；不会删除自定义连接或凭证。身份与参数来自 list_model_providers。',
    inputShape: { change: appProviderChange }, handler: input => invoke({ operation: 'provider', ...input }) });
}
