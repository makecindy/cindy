import { isLoopbackProviderUrl } from '@cindy/model-providers';

/**
 * 自定义 Provider 保存前的凭据完整性判定(#8693 / #7646)。
 *
 * apiKey 模式下把 Key 留空仍能保存时,表单不会写入 `auth` 字段,而下游
 * `pi-host.ts` 的 `cfg.auth?.method ?? 'apiKey'` 把缺失当 apiKey 处理,
 * 因为既没有 Key 也没有凭据头而静默跳过该 Provider(只有一行 WARN),
 * 界面上只剩一个没有任何解释的灰置开关。在保存前挡住这种配置。
 *
 * 判据与 main 侧 `provider-connection-state.ts` 的 `hasCustomProviderCredential`
 * 保持一致:**`authorization` / `x-api-key` 头里的值同样算凭据**。两边不一致
 * 会把本来能连上的配置误挡在保存之外。
 */

/** 与 hasCustomProviderCredential 相同的凭据头口径。 */
const CREDENTIAL_HEADERS = ['authorization', 'x-api-key'];

export type CustomProviderAuthMode = 'apiKey' | 'oauth' | 'none';

export interface CredentialRuntimeDraft<TAgent extends string = string> {
  agent: TAgent;
  /** 表单里当前填的 Key(未 trim)。 */
  apiKey: string;
  headers: { name: string; value: string }[];
  baseUrl: string;
  /**
   * 用户在本次编辑中动过 Key 字段(`keyEditRevisionRef` > 0)。
   * 未动过时已存的 Key 仍然有效,不能当成缺凭据。
   */
  keyEdited: boolean;
  /** 该 runtime 在保存前已经存有 Key。 */
  hasStoredKey: boolean;
}

function hasCredentialHeader(headers: { name: string; value: string }[]): boolean {
  return headers.some(
    (header) =>
      CREDENTIAL_HEADERS.includes(header.name.trim().toLowerCase())
      && header.value.trim().length > 0,
  );
}

function runtimeHasCredential(runtime: CredentialRuntimeDraft): boolean {
  if (runtime.apiKey.trim().length > 0) return true;
  if (hasCredentialHeader(runtime.headers)) return true;
  // 编辑既有 Provider 且没碰 Key 字段:沿用已存的 Key。
  return !runtime.keyEdited && runtime.hasStoredKey;
}

/**
 * 返回第一个缺凭据的 runtime 的 agent(供调用方把错误聚焦到它的字段),
 * 全部就绪时返回 undefined。oauth / none 模式不适用本判定。
 */
export function missingCredentialRuntime<TAgent extends string>(
  authMode: CustomProviderAuthMode,
  runtimes: CredentialRuntimeDraft<TAgent>[],
): TAgent | undefined {
  if (authMode !== 'apiKey') return undefined;
  return runtimes.find((runtime) => !runtimeHasCredential(runtime))?.agent;
}

/**
 * 缺凭据时该给哪一种出路。`user-provider.ts` 对**非 loopback** 地址的 `none`
 * 强制 `disabled: true`,所以只有 loopback 端点能被引导去改选「无鉴权」;
 * 局域网与远端只能填占位 Key(Ollama 等兼容端点不校验 Key 内容)。
 * 引导错方向会把用户推向一条代码不允许的路 —— 这正是 #8693 里提报者
 * 手改 `auth` 为 `{"method":"none"}` 后开关依旧灰置的原因。
 */
export function credentialGuidanceKind(baseUrl: string): 'loopback' | 'remote' {
  return isLoopbackProviderUrl(baseUrl.trim()) ? 'loopback' : 'remote';
}
