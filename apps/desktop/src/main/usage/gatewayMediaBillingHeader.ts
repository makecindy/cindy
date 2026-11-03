/** Nova passthrough billing is Base64URL JSON, independent of the response body. */
export interface GatewayMediaBilling {
  cost: number;
  model?: string;
}

export function parseGatewayMediaBillingHeader(value: string | null): GatewayMediaBilling | null {
  if (!value || value.length > 64 * 1024 || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return null;
  try {
    const payload: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const { cost, model } = payload as Record<string, unknown>;
    if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) return null;
    return {
      cost,
      ...(typeof model === 'string' && model.trim() ? { model: model.trim() } : {}),
    };
  } catch {
    return null;
  }
}
