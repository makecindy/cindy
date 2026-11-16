import { ID_PATTERN, KEY_PATTERN, type GrantKind } from '@cindy/agent-net-protocol';
import { decodeUtf8, fromBase64Url, toBase64Url, utf8 } from './portableBytes.js';

export interface AgentNetSharingInvitation {
  v: 2;
  kind: GrantKind;
  invitation: string;
  networkId: string;
  rootPublicKey: string;
  resourceId: string;
  hostDeviceId: string;
  region: 'cn' | 'global';
}
export interface AgentNetSharingInvitationIntent { server: string; receipt: AgentNetSharingInvitation; }
const prefix = 'an2.';
function server(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:'
      && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) return null;
    return url.origin + url.pathname.replace(/\/+$/, '');
  } catch { return null; }
}
function valid(value: unknown): value is AgentNetSharingInvitation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as AgentNetSharingInvitation;
  const id = (v: unknown): v is string => typeof v === 'string' && ID_PATTERN.test(v);
  return Object.keys(r).length === 8 && r.v === 2 && (r.kind === 'shared-task' || r.kind === 'provider-share')
    && typeof r.invitation === 'string' && /^[A-Za-z0-9_-]{43}$/.test(r.invitation) && id(r.networkId) && id(r.resourceId)
    && id(r.hostDeviceId) && typeof r.rootPublicKey === 'string' && KEY_PATTERN.test(r.rootPublicKey)
    && /[AEIMQUYcgkosw048]$/.test(r.rootPublicKey) && (r.region === 'cn' || r.region === 'global');
}
export function encodeAgentNetSharingInvitation(receipt: AgentNetSharingInvitation): string {
  if (!valid(receipt)) throw new Error('INVALID_AGENT_NET_SHARING_INVITATION');
  return prefix + toBase64Url(utf8(JSON.stringify(receipt)));
}
export function decodeAgentNetSharingInvitation(value: string): AgentNetSharingInvitation | null {
  if (!value.startsWith(prefix) || value.length > 4096) return null;
  try { const r: unknown = JSON.parse(decodeUtf8(fromBase64Url(value.slice(prefix.length)))); return valid(r) ? r : null; }
  catch { return null; }
}
export function buildAgentNetSharingInvitation(receipt: AgentNetSharingInvitation, base: string, app: 'cindy' | 'cindycn' | 'cindydev' = 'cindy'): string {
  const target = server(base);
  if (!target || !['cindy', 'cindycn', 'cindydev'].includes(app)) throw new Error('SECURE_SHARING_INVITATION_REQUIRED');
  return target + '/api/agent-net/' + receipt.kind + '/join#' + encodeAgentNetSharingInvitation(receipt)
    + (app === 'cindy' ? '' : '?app=' + app);
}
/** Explicit invitations choose their own pinned V2 service. Old V1 invitation
 * parsing retains its configured-server restriction and is never widened. */
export function parseAgentNetSharingInvitation(input: string, expectedKind?: GrantKind): AgentNetSharingInvitationIntent | null {
  if (input.length > 8192) return null;
  try {
    let url: URL;
    const trimmed = input.trim();
    if (/^cindy(?:cn|dev)?:\/\//.test(trimmed)) url = new URL(trimmed);
    else {
      const links = trimmed.match(/https?:\/\/[^\s<>"'，。！？、（）「」“”‘’\[\])]+/g)?.filter(value => {
        try { return /\/api\/agent-net\/(shared-task|provider-share)\/join$/.test(new URL(value.replace(/[.,;!?]+$/, '')).pathname); }
        catch { return false; }
      });
      if (links?.length !== 1) return null;
      url = new URL(links[0].replace(/[.,;!?]+$/, ''));
    }
    if (url.username || url.password) return null;
    let encoded: string, base: string | null, kind: GrantKind;
    if (['cindy:', 'cindycn:', 'cindydev:'].includes(url.protocol)) {
      if (url.hash || url.port || [...url.searchParams.keys()].some(key => key !== 'invitation' && key !== 'server')
        || url.searchParams.getAll('invitation').length !== 1 || url.searchParams.getAll('server').length !== 1) return null;
      if ((url.host === 'shared-task' && url.pathname === '/join') || (url.host === 'shared-session' && !url.pathname)) kind = 'shared-task';
      else if (url.host === 'provider-share' && url.pathname === '/join') kind = 'provider-share'; else return null;
      encoded = url.searchParams.get('invitation')!; base = server(url.searchParams.get('server')!);
    } else {
      const match = /\/api\/agent-net\/(shared-task|provider-share)\/join$/.exec(url.pathname);
      if (!match || url.search) return null;
      kind = match[1] as GrantKind;
      const [value, hint, extra] = url.hash.slice(1).split('?');
      if (extra !== undefined || (hint !== undefined && !/^app=(cindy|cindycn|cindydev)$/.test(hint))) return null;
      encoded = value; base = server(url.origin + url.pathname.slice(0, -match[0].length));
    }
    const receipt = decodeAgentNetSharingInvitation(encoded);
    return base && receipt?.kind === kind && (!expectedKind || kind === expectedKind) ? { server: base, receipt } : null;
  } catch { return null; }
}
