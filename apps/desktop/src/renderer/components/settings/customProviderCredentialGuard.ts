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
  modelsUrl?: string;
  /**
   * 用户在本次编辑中动过 Key 字段(`keyEditRevisionRef` > 0)。
   * 未动过时已存的 Key 仍然有效,不能当成缺凭据。
   */
  keyEdited: boolean;
  /**
   * 该 runtime 在保存前已经存有 Key,**且这次保存后仍会留着**。
   *
   * 已存的 Key 绑定在原端点上:端点一变,`patch()` 会清空表单里未改动的
   * hydrated key,`planProviderKeyMutations` 也会清除落库的旧密文
   * (两处都以 `endpointChangedForAgent` 为条件)。所以调用方必须在端点变过时
   * 把它置 false —— 否则「未碰 Key + 存过 Key」会放行一个保存后无凭据的
   * runtime(PR #9034 review P1)。
   */
  hasStoredKey: boolean;
  /**
   * 编辑既有 Provider 时,main 侧会保留该 runtime 既存的密文鉴权头
   * (`planProviderHeaderMutations` 的 'update' 分支 + `endpointChangedForAgent`)。
   *
   * 头凭证是 main-only 密文,`provider:list` 经 `withoutProviderHeaderCredentials`
   * 把 `headerOverride` 整个剔除,renderer **从不回读其值**。所以这里只接受一个
   * 「保留条件是否成立」的布尔,不含任何凭据内容。
   *
   * 调用方必须由 main 给的**存在信号**推出它,而不是只看端点有没有变:
   * `headersState === 'configured'`(不含值的 transient 标记)说明确实存着头凭证,
   * 且上次保存就得是 apiKey 鉴权 —— none / oauth 模式下头凭证一律被清除,
   * 此时无凭证可留,只看「端点未变 + 未带 headers」会放行出无凭据的配置
   * (PR #9034 review P1)。口径与 `activeHeadersCanRemainSaved` 一致。
   */
  preservesStoredHeaderCredential?: boolean;
}

/**
 * 保存时同名请求头由后出现的那一行覆盖(`for (const h of rf.headers) headers[n] = ...`),
 * 所以判据必须看**合并后**的结果:先填一行有效 Authorization、再填一行同名空值,
 * 最终落库的凭据是空的。按原始表单行用 `some` 判断会放行这种配置。
 */
export function mergedHeaderNames(
  headers: { name: string; value: string }[],
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const header of headers) {
    const name = header.name.trim();
    if (name) merged[name] = header.value.trim();
  }
  return merged;
}

const mergedHeaders = mergedHeaderNames;

function hasCredentialHeader(headers: { name: string; value: string }[]): boolean {
  return Object.entries(mergedHeaders(headers)).some(
    ([name, value]) =>
      CREDENTIAL_HEADERS.includes(name.toLowerCase()) && value.length > 0,
  );
}

function runtimeHasCredential(runtime: CredentialRuntimeDraft): boolean {
  if (runtime.apiKey.trim().length > 0) return true;
  if (hasCredentialHeader(runtime.headers)) return true;
  // 编辑既有 Provider 且没碰 Key 字段:沿用已存的 Key。
  if (!runtime.keyEdited && runtime.hasStoredKey) return true;
  // main 侧会保留既存的密文鉴权头(仅用头鉴权的 Provider 据此仍可改名称/模型)。
  return runtime.preservesStoredHeaderCredential === true;
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
 *
 * 鉴权方式对**整个 Provider** 生效,而 `user-provider.ts:408-412` 对每个 route
 * 同时检查 `baseUrl` 与 `modelsUrl`。因此只有当待保存配置里**每一个** runtime 的
 * 两个地址都是 loopback 时,「改选无鉴权」才真的能存下去;否则照做仍会被挡。
 */
export function credentialGuidanceKind(
  runtimes: { baseUrl: string; modelsUrl?: string }[],
): 'loopback' | 'remote' {
  if (runtimes.length === 0) return 'remote';
  const allLoopback = runtimes.every((runtime) => {
    if (!isLoopbackProviderUrl(runtime.baseUrl.trim())) return false;
    const modelsUrl = runtime.modelsUrl?.trim();
    return !modelsUrl || isLoopbackProviderUrl(modelsUrl);
  });
  return allLoopback ? 'loopback' : 'remote';
}
