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
