/**
 * 受邀者请分享者电脑让一个 Device Link（V1）供应商分享改走 Agent-Net
 * （docs/dev-rules/protocol-compatibility/agent-net-linked-provider-shares.md）。
 * 只在已经通过 Device Link 认证的分享连接上发：受邀者在这里报上自己的 Agent-Net 公钥，
 * 分享者电脑记下后，只给这把钥匙签放行证。成员关系仍然只看原来的 V1 分享。
 */
export const PROVIDER_SHARE_AGENT_NET_LINK_CHANNEL = 'provider-share:agent-net-link:v1';

const KEY = /^[A-Za-z0-9_-]{43}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

export interface ProviderShareAgentNetLinkRequest {
  version: 1;
  signingKey: string;
  transportKey: string;
}

/** 分享者所在的 Agent-Net 网络；受邀者只接受与自己同一个官方服务、同一个区域的线路。 */
export interface ProviderShareAgentNetLinkRoute {
  server: string;
  networkId: string;
  rootPublicKey: string;
  hostDeviceId: string;
  region: 'cn' | 'global';
}

/** 不可用的原因只用于本机日志与冷却时长，不展示给用户。 */
export type ProviderShareAgentNetLinkUnavailable = 'agent-net-off' | 'relay-unsupported' | 'link-failed';

export type ProviderShareAgentNetLinkResponse =
  | { route: ProviderShareAgentNetLinkRoute }
  | { unavailable: ProviderShareAgentNetLinkUnavailable };

/** 32 字节的 base64url 公钥：43 个字符，最后一个字符的低两位为 0（与 agent-net-protocol 的校验一致）。 */
function isKey(value: unknown): value is string {
  return typeof value === 'string' && KEY.test(value) && /[AEIMQUYcgkosw048]$/.test(value);
}

export function parseProviderShareAgentNetLinkRequest(value: unknown): ProviderShareAgentNetLinkRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 3 || row.version !== 1 || !isKey(row.signingKey) || !isKey(row.transportKey)
    || row.signingKey === row.transportKey) return null;
  return { version: 1, signingKey: row.signingKey, transportKey: row.transportKey };
}

export function parseProviderShareAgentNetLinkResponse(value: unknown): ProviderShareAgentNetLinkResponse | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.unavailable === 'string') {
    // 新版本可能报新的原因：按最保守的「暂时不可用」处理。
    return { unavailable: ['agent-net-off', 'relay-unsupported'].includes(row.unavailable)
      ? row.unavailable as ProviderShareAgentNetLinkUnavailable : 'link-failed' };
  }
  const route = row.route as Record<string, unknown> | undefined;
  if (!route || typeof route !== 'object' || Array.isArray(route)) return null;
  const { server, networkId, rootPublicKey, hostDeviceId, region } = route;
  if (typeof server !== 'string' || server.length > 512 || typeof networkId !== 'string' || !ID.test(networkId)
    || !isKey(rootPublicKey) || typeof hostDeviceId !== 'string' || !ID.test(hostDeviceId)
    || (region !== 'cn' && region !== 'global')) return null;
  return { route: { server, networkId, rootPublicKey, hostDeviceId, region } };
}
