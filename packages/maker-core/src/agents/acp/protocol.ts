/** ACP v1 uses JSON-RPC 2.0 over newline-delimited UTF-8 JSON. */
export const ACP_PROTOCOL_VERSION = 1;
export type AcpRpcId = string | number;
export class AcpRpcError extends Error {
  constructor(public readonly code: number, message: string, public readonly data?: unknown) {
    super(message);
    this.name = 'AcpRpcError';
  }
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function isRpcId(value: unknown): value is AcpRpcId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}
