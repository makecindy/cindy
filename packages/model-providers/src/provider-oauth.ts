import type { OAuthProviderDescriptor } from './types.js';

const RESERVED_AUTHORIZATION_CODE_PARAMS = new Set([
  'response_type',
  'client_id',
  'redirect_uri',
  'scope',
  'code_challenge',
  'code_challenge_method',
  'state',
]);
const RESERVED_DEVICE_CODE_PARAMS = new Set(['client_id', 'scope']);

/** 返回 OAuth 扩展参数里首个会覆盖标准字段的 key；没有冲突时返回 null。 */
export function findReservedOAuthExtraParam(
  params: Record<string, unknown>,
  flow: NonNullable<OAuthProviderDescriptor['flow']>,
): string | null {
  const reserved = flow === 'device-code'
    ? RESERVED_DEVICE_CODE_PARAMS
    : RESERVED_AUTHORIZATION_CODE_PARAMS;
  return Object.keys(params).find((key) => reserved.has(key.toLowerCase())) ?? null;
}
