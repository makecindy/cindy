/**
 * builtinApiKeyBridge.ts — 内置 API-key 供应商专用 IPC 的业务体(可注入、零 electron 依赖)。
 * ---------------------------------------------------------------------------
 * 这些键在 MAIN_ONLY_PROVIDER_SECRET_STORAGE_KEYS 里,通用 safeStorage IPC 已拦截,
 * 本模块是 renderer 触达它们的唯一合法通道的业务内核:白名单 / 类型 / 长度等
 * 边界校验与统一 IPC 错误协议都在这里,单测直测拒绝路径(bootstrap-electron 只做
 * sender 守卫 + 依赖装配)。
 *
 * - store / remove 是 mutation:失败走 throwIpcError(INVALID_PARAMS / INTERNAL),
 *   renderer 经 extractIpcError 解码,永不回读明文;
 * - has 是查询:失败回 false 供 UI 按未配置渲染,只回存在性布尔。
 */

import type { ProviderSecretId } from '../../shared/providerSecrets.js';
import { throwIpcError } from '../utils/ipcValidate.js';

/**
 * 允许经本桥访问的内置 API-key 供应商(新增供应商时在此扩展)。
 * 模块私有:这是权限白名单,不导出可变引用(ReadonlySet 只是编译期约束,
 * 挡不住运行时 .add());外部只能经 isBuiltinApiKeyProviderId 查询。
 */
const BUILTIN_API_KEY_PROVIDER_IDS: ReadonlySet<ProviderSecretId> = new Set<ProviderSecretId>([
  'gemini',
  'openai-images',
]);

/** 白名单查询(只读语义,供测试与未来调用方使用,不暴露集合本体)。 */
export function isBuiltinApiKeyProviderId(providerId: unknown): providerId is ProviderSecretId {
  return (
    typeof providerId === 'string' && BUILTIN_API_KEY_PROVIDER_IDS.has(providerId as ProviderSecretId)
  );
}

/**
 * 真实 API key 远短于此(gemini ~39 / OpenAI 平台 ~200 字符);上限挡的是被攻陷
 * renderer 塞超大字符串让 main 同步加密落盘耗资源(副作用前验证 payload 长度)。
 */
export const BUILTIN_API_KEY_MAX_LENGTH = 1024;

/** 依赖注入面:providerSecretStore 的读写切片 + key 变更广播 + 统一日志。 */
export interface BuiltinApiKeyBridgeDeps {
  store: {
    set(id: ProviderSecretId, value: string): boolean;
    remove(id: ProviderSecretId): { success: boolean; error?: string };
    has(id: ProviderSecretId): boolean;
  };
  onKeyChanged: (providerId: ProviderSecretId) => void;
  /**
   * 查询路径吞掉的异常经此进 main 统一 logger(级别/轮转/持久化,规约 §1);
   * 本模块保持零 electron 依赖,logger 由装配方注入。
   */
  logError: (message: string, err: unknown) => void;
}

function requireBuiltinApiKeyProviderId(providerId: unknown): ProviderSecretId {
  if (!isBuiltinApiKeyProviderId(providerId)) {
    throwIpcError('INVALID_PARAMS', `unsupported builtin api-key provider: ${String(providerId)}`);
  }
  return providerId;
}

/** 写入 key。校验顺序:白名单 → 类型/长度 → 非空;存储失败抛 INTERNAL。 */
export function builtinApiKeyStore(
  deps: BuiltinApiKeyBridgeDeps,
  providerId: unknown,
  value: unknown,
): void {
  const id = requireBuiltinApiKeyProviderId(providerId);
  if (typeof value !== 'string' || value.length > BUILTIN_API_KEY_MAX_LENGTH) {
    throwIpcError('INVALID_PARAMS', 'api key must be a string within the length limit');
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throwIpcError('INVALID_PARAMS', 'api key must not be empty');
  }
  if (!deps.store.set(id, trimmed)) {
    throwIpcError('INTERNAL', 'failed to store the api key');
  }
  deps.onKeyChanged(id);
}

/** 删除 key。存储层报失败时抛 INTERNAL,不广播变更。 */
export function builtinApiKeyRemove(deps: BuiltinApiKeyBridgeDeps, providerId: unknown): void {
  const id = requireBuiltinApiKeyProviderId(providerId);
  const result = deps.store.remove(id);
  if (!result.success) {
    throwIpcError('INTERNAL', 'failed to remove the api key');
  }
  deps.onKeyChanged(id);
}

/** 查询 key 是否已存。非白名单 / 存储层异常一律回 false(UI 按未配置渲染)。 */
export function builtinApiKeyHas(deps: BuiltinApiKeyBridgeDeps, providerId: unknown): boolean {
  if (!isBuiltinApiKeyProviderId(providerId)) return false;
  try {
    return deps.store.has(providerId);
  } catch (err) {
    deps.logError('[builtin-api-key-has] secret store query failed', err);
    return false;
  }
}
