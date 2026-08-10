import { isLoopbackProviderUrl } from '@cindy/model-providers';

export type CustomProviderAuthMode = 'apiKey' | 'oauth' | 'none';

export interface ProviderModelFetchSignatureFields {
  baseUrl: string;
  requestPath: string;
  modelsUrl: string;
  apiKey: string;
  headers: ReadonlyArray<{ name: string; value: string }>;
}

export interface ProviderConnectionTestSignatureFields extends ProviderModelFetchSignatureFields {
  wireProtocol: string;
  models: ReadonlyArray<{ id: string }>;
}

export function stripCredentialHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => {
      const normalized = name.toLowerCase();
      return normalized !== 'authorization' && normalized !== 'x-api-key';
    }),
  );
}

/**
 * 无鉴权请求在任何「落盘前」动作里也必须保持 loopback-only。测试连接和模型发现会直接
 * 使用尚未保存的表单值，不能只依赖保存时与 main store 的最终校验。
 */
export function areProviderRequestUrlsAllowed(
  authMode: CustomProviderAuthMode,
  baseUrl: string,
  modelsUrl?: string,
): boolean {
  if (authMode !== 'none') return true;
  return (
    isLoopbackProviderUrl(baseUrl.trim()) &&
    (!modelsUrl?.trim() || isLoopbackProviderUrl(modelsUrl.trim()))
  );
}

/**
 * 模型发现请求的完整有效输入签名。只在当前对话框闭包内短暂比较，不持久化、不记录。
 * 鉴权模式变化会改变实际请求，即使表单里的 key/header 文本没有变化也必须作废旧响应。
 */
export function providerModelFetchRequestSignature(
  fields: ProviderModelFetchSignatureFields,
  authMode: CustomProviderAuthMode,
): string {
  const headers: Record<string, string> = {};
  for (const header of fields.headers) {
    const name = header.name.trim();
    if (name) headers[name] = header.value.trim();
  }
  const effectiveHeaders = authMode === 'apiKey' ? headers : stripCredentialHeaders(headers);
  return JSON.stringify({
    authMode,
    baseUrl: fields.baseUrl.trim(),
    requestPath: fields.requestPath.trim(),
    modelsUrl: fields.modelsUrl.trim(),
    apiKey: authMode === 'apiKey' ? fields.apiKey.trim() : null,
    headers: Object.entries(effectiveHeaders).sort(([a], [b]) => a.localeCompare(b)),
  });
}

/**
 * 已存供应商在编辑态的基线快照：端点/协议/鉴权模式来自已存配置,apiKey 是编辑态回填的
 * 已存明文 key(自定义鉴权请求头是 main-only 密文,不回读进 renderer,故 headers 只含
 * 已存的非密文头)。用于判定「是否可复用 main-only 密文头」而无需把密钥回读到 renderer。
 */
export interface SavedProviderProbeBaseline {
  baseUrl: string;
  requestPath: string;
  modelsUrl: string;
  wireProtocol: string;
  authMode: CustomProviderAuthMode;
  apiKey: string;
  headers: ReadonlyArray<{ name: string; value: string }>;
}

function normalizeHeaderRows(
  rows: ReadonlyArray<{ name: string; value: string }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (name) out[name] = row.value.trim();
  }
  return out;
}

function headerRowsEqual(
  a: ReadonlyArray<{ name: string; value: string }>,
  b: ReadonlyArray<{ name: string; value: string }>,
): boolean {
  const na = normalizeHeaderRows(a);
  const nb = normalizeHeaderRows(b);
  const ka = Object.keys(na).sort();
  const kb = Object.keys(nb).sort();
  if (ka.length !== kb.length) return false;
  return ka.every((key, i) => key === kb[i] && na[key] === nb[kb[i]]);
}

/**
 * 模型发现是否可安全复用已存供应商的 main-only 密文头(经 savedProviderId 让 main 并入)。
 * 仅当**请求实际目标端点**(baseUrl / modelsUrl)与鉴权模式相对已存配置未改动时才允许——
 * 否则把已存密钥并到用户新填的任意主机上,会把凭证外泄给新端点。表单显式填的头/key 仍
 * 由 main 侧以 renderer 值优先覆盖,这里只决定「是否附带 savedProviderId」。
 */
export function modelFetchCanReuseSavedCredentials(
  form: Pick<ProviderModelFetchSignatureFields, 'baseUrl' | 'modelsUrl'> &
    Partial<Pick<ProviderModelFetchSignatureFields, 'requestPath'>>,
  baseline: Pick<SavedProviderProbeBaseline, 'baseUrl' | 'modelsUrl' | 'authMode'>,
  authMode: CustomProviderAuthMode,
): boolean {
  return (
    authMode === baseline.authMode &&
    form.baseUrl.trim() === baseline.baseUrl.trim() &&
    form.modelsUrl.trim() === baseline.modelsUrl.trim()
  );
}

/**
 * Restore an untouched hydrated key after an endpoint edit is reverted to the
 * saved base/models target. Explicit key edits always win, including clearing
 * the field, so this helper only fills an actually empty, revision-zero draft.
 */
export function restoreHydratedApiKey<
  T extends Pick<ProviderModelFetchSignatureFields, 'baseUrl' | 'modelsUrl' | 'apiKey'>,
>(
  form: T,
  baseline: Pick<SavedProviderProbeBaseline, 'baseUrl' | 'modelsUrl' | 'authMode' | 'apiKey'>,
  authMode: CustomProviderAuthMode,
  keyEditRevision: number,
): T {
  if (
    authMode !== 'apiKey' ||
    keyEditRevision !== 0 ||
    form.apiKey.trim() ||
    !baseline.apiKey.trim() ||
    !modelFetchCanReuseSavedCredentials(form, baseline, authMode)
  ) {
    return form;
  }
  return { ...form, apiKey: baseline.apiKey };
}

/**
 * Decide whether a hydrated API key may be sent to the saved provider's endpoint.
 * requestPath is a routing detail within the same base/models URL and does not
 * change the credential target; baseUrl/modelsUrl changes still require an edit.
 */
export function canSendHydratedApiKey(
  form: Pick<ProviderModelFetchSignatureFields, 'baseUrl' | 'modelsUrl'> &
    Partial<Pick<ProviderModelFetchSignatureFields, 'requestPath'>>,
  baseline: Pick<SavedProviderProbeBaseline, 'baseUrl' | 'modelsUrl' | 'authMode'> &
    Partial<Pick<SavedProviderProbeBaseline, 'requestPath'>>,
  authMode: CustomProviderAuthMode,
  keyEditRevision: number,
): boolean {
  if (keyEditRevision > 0) return true;
  return (
    authMode === baseline.authMode &&
    form.baseUrl.trim() === baseline.baseUrl.trim() &&
    form.modelsUrl.trim() === baseline.modelsUrl.trim()
  );
}

/**
 * 测试连接是否走「已存供应商」受控探测(kind:'saved')。saved 探测整体按已存 spec 发起,
 * 能带上不回读进表单的 main-only 密文头;但它用的是已存端点/模型/凭证,所以只有当编辑态
 * 表单里端点、协议、鉴权模式与凭证材料相对已存配置**都未改动**时才可用——否则用 adhoc
 * 探测用户新填的值(此时若供应商依赖不回读的密文头会失败,但用户正在改端点/凭证,由其
 * 自行补齐,与本 finding 的「未改动端点」边界一致)。
 */
export function connectionTestCanUseSaved(
  form: ProviderConnectionTestSignatureFields,
  baseline: SavedProviderProbeBaseline,
  authMode: CustomProviderAuthMode,
): boolean {
  if (authMode !== baseline.authMode) return false;
  if (form.baseUrl.trim() !== baseline.baseUrl.trim()) return false;
  if (form.requestPath.trim() !== baseline.requestPath.trim()) return false;
  if (form.wireProtocol !== baseline.wireProtocol) return false;
  if (authMode === 'apiKey' && form.apiKey.trim() !== baseline.apiKey.trim()) return false;
  return headerRowsEqual(form.headers, baseline.headers);
}

/** 测试连接还取决于实际推理协议与首个有效模型；任一变化都必须让旧探测响应失效。 */
export function providerConnectionTestRequestSignature(
  fields: ProviderConnectionTestSignatureFields,
  authMode: CustomProviderAuthMode,
): string {
  return JSON.stringify({
    request: providerModelFetchRequestSignature(fields, authMode),
    wireProtocol: fields.wireProtocol,
    modelId: fields.models.map((model) => model.id.trim()).find(Boolean) ?? null,
  });
}
