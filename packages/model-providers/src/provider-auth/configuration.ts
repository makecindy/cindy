import { findReservedOAuthExtraParam } from '../provider-oauth.js';
export type ValidationResult =
  { ok: true } | { ok: false; code: 'INVALID_PARAMS'; message: string };
function invalid(message: string): ValidationResult {
  return { ok: false, code: 'INVALID_PARAMS', message };
}

export function validateAuthSection(auth: unknown): ValidationResult {
  if (!auth || typeof auth !== 'object')
    return invalid('auth must be an object');
  const a = auth as Record<string, unknown>;
  if (a.native !== undefined) {
    return a.method === 'oauth' &&
      ['codex', 'claude', 'xai'].includes(String(a.native)) &&
      a.oauth === undefined
      ? { ok: true }
      : invalid(
          'native subscription auth requires oauth method without a generic descriptor',
        );
  }
  if (a.method !== 'apiKey' && a.method !== 'oauth' && a.method !== 'none') {
    return invalid("auth.method must be 'apiKey' | 'oauth' | 'none'");
  }
  if (a.method === 'apiKey' || a.method === 'none') {
    if (a.oauth !== undefined)
      return invalid(`auth.oauth not allowed for ${a.method} method`);
    return { ok: true };
  }
  const d = a.oauth;
  if (!d || typeof d !== 'object')
    return invalid('auth.oauth required for oauth method');
  const o = d as Record<string, unknown>;
  const flow = o.flow ?? 'authorization-code';
  if (flow !== 'authorization-code' && flow !== 'device-code') {
    return invalid(
      "auth.oauth.flow must be 'authorization-code' | 'device-code'",
    );
  }
  const allowedFields = new Set(
    flow === 'device-code'
      ? [
          'flow',
          'tokenUrl',
          'clientId',
          'scopes',
          'modelsDiscoveryUrl',
          'deviceAuthorizationUrl',
          'extraDeviceParams',
        ]
      : [
          'flow',
          'tokenUrl',
          'clientId',
          'scopes',
          'modelsDiscoveryUrl',
          'authorizeUrl',
          'redirectPort',
          'extraAuthParams',
        ],
  );
  const unknownField = Object.keys(o).find(
    (field) => !allowedFields.has(field),
  );
  if (unknownField) return invalid(`auth.oauth.${unknownField} is not allowed`);
  if (
    flow === 'authorization-code' &&
    (o.deviceAuthorizationUrl !== undefined ||
      o.extraDeviceParams !== undefined)
  ) {
    return invalid(
      'auth.oauth device-code fields not allowed for authorization-code',
    );
  }
  if (
    flow === 'device-code' &&
    (o.authorizeUrl !== undefined ||
      o.extraAuthParams !== undefined ||
      o.redirectPort !== undefined)
  ) {
    return invalid(
      'auth.oauth authorization-code fields not allowed for device-code',
    );
  }
  for (const field of ['tokenUrl', 'clientId', 'scopes'] as const) {
    if (
      typeof o[field] !== 'string' ||
      (field !== 'scopes' && (o[field] as string).trim().length === 0)
    ) {
      return invalid(`auth.oauth.${field} required`);
    }
  }
  const endpointFields =
    flow === 'device-code'
      ? (['deviceAuthorizationUrl', 'tokenUrl'] as const)
      : (['authorizeUrl', 'tokenUrl'] as const);
  for (const field of endpointFields) {
    if (
      typeof o[field] !== 'string' ||
      (o[field] as string).trim().length === 0
    ) {
      return invalid(`auth.oauth.${field} required`);
    }
    try {
      const u = new URL(o[field] as string);
      // OAuth 端点强制 https:回调虽在回环,但授权码/token 交换绝不能明文出网。
      if (u.protocol !== 'https:' || u.username || u.password) {
        return invalid(`auth.oauth.${field} must be https`);
      }
    } catch {
      return invalid(`auth.oauth.${field} is not a valid URL`);
    }
  }
  if (o.redirectPort !== undefined) {
    if (
      flow !== 'authorization-code' ||
      typeof o.redirectPort !== 'number' ||
      !Number.isInteger(o.redirectPort) ||
      o.redirectPort <= 0 ||
      o.redirectPort >= 65536
    ) {
      return invalid('auth.oauth.redirectPort invalid');
    }
  }
  for (const field of ['extraAuthParams', 'extraDeviceParams'] as const) {
    if (o[field] === undefined) continue;
    if (!o[field] || typeof o[field] !== 'object' || Array.isArray(o[field])) {
      return invalid(`auth.oauth.${field} invalid`);
    }
    if (
      Object.values(o[field] as Record<string, unknown>).some(
        (value) => typeof value !== 'string',
      )
    ) {
      return invalid(`auth.oauth.${field} invalid`);
    }
    const collision = findReservedOAuthExtraParam(
      o[field] as Record<string, unknown>,
      flow,
    );
    if (collision) {
      return invalid(`auth.oauth.${field} cannot override '${collision}'`);
    }
  }
  if (o.modelsDiscoveryUrl !== undefined) {
    try {
      const url = new URL(String(o.modelsDiscoveryUrl));
      if (
        typeof o.modelsDiscoveryUrl !== 'string' ||
        url.protocol !== 'https:' ||
        url.username ||
        url.password
      ) {
        return invalid('auth.oauth.modelsDiscoveryUrl must be https');
      }
    } catch {
      return invalid('auth.oauth.modelsDiscoveryUrl is not a valid URL');
    }
  }
  return { ok: true };
}
