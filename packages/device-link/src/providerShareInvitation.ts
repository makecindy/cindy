/**
 * 供应商分享链接。口令放在 fragment，不进入网页 HTTP 请求；链接里的服务地址只用来在
 * 两个官方区域之间选择，从不直接当作请求目标。
 */
import { isProviderShareInvitation } from './providerShareApi.js';
import { sharedTaskInvitationServer, type SharedTaskInvitationApp } from './sharedTaskInvitation.js';

export const PROVIDER_SHARE_INVITATION_PATH = '/provider-share/join';
export const PROVIDER_SHARE_LINK_TTL_MS = 5 * 60_000;
const APPS = new Set(['cindy', 'cindycn', 'cindydev']);

export function buildProviderShareLink(invitation: string, server: string, app: SharedTaskInvitationApp = 'cindy'): string {
  const base = sharedTaskInvitationServer(server);
  if (!isProviderShareInvitation(invitation) || !base || !APPS.has(app)) throw new Error('Invalid provider share invitation');
  return `${base}${PROVIDER_SHARE_INVITATION_PATH}#${invitation}${app === 'cindy' ? '' : '?app=' + app}`;
}

export interface ProviderShareInvitationIntent {
  invitation: string;
  /** Normalized origin + path prefix of the device-link service that issued the link. */
  server: string;
}

/** Strict custom-scheme handoff: `cindy://provider-share/join?invitation=…&server=…`. */
export function parseProviderShareInvitationIntent(value: string): ProviderShareInvitationIntent | null {
  if (value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (!['cindy:', 'cindycn:', 'cindydev:'].includes(url.protocol) || url.username || url.password || url.port || url.hash) return null;
    if (url.host !== 'provider-share' || url.pathname !== '/join') return null;
    if ([...url.searchParams.keys()].some((key) => key !== 'invitation' && key !== 'server')) return null;
    if (url.searchParams.getAll('invitation').length !== 1 || url.searchParams.getAll('server').length !== 1) return null;
    const invitation = url.searchParams.get('invitation');
    const server = sharedTaskInvitationServer(url.searchParams.get('server') ?? '');
    return isProviderShareInvitation(invitation) && server ? { invitation, server } : null;
  } catch {
    return null;
  }
}

/** A pasted provider-share link (`https://…/provider-share/join#<token>[?app=…]`). */
export function parseProviderShareLink(input: string): ProviderShareInvitationIntent | null {
  if (input.length > 8192) return null;
  const links = input.trim().match(/https?:\/\/[^\s<>"'，。！？、（）「」“”‘’[\])]+/g)?.filter((link) => {
    try { return new URL(link.replace(/[.,;!?]+$/, '')).pathname.endsWith(PROVIDER_SHARE_INVITATION_PATH); } catch { return false; }
  });
  if (links?.length !== 1) return null;
  try {
    const url = new URL(links[0].replace(/[.,;!?]+$/, ''));
    if (url.search || url.username || url.password) return null;
    const [invitation, hint, extra] = url.hash.slice(1).split('?');
    if (extra !== undefined || (hint !== undefined && !/^app=(cindy|cindycn|cindydev)$/.test(hint))) return null;
    if (!isProviderShareInvitation(invitation)) return null;
    const server = sharedTaskInvitationServer(url.origin + url.pathname.slice(0, -PROVIDER_SHARE_INVITATION_PATH.length));
    return server ? { invitation, server } : null;
  } catch {
    return null;
  }
}

/**
 * Which official region issued this link. `servers` maps each official region to its
 * device-link base URL (from the built-in endpoint manifests); anything else is rejected.
 */
export function providerShareLinkRegion<R extends string>(
  intent: ProviderShareInvitationIntent,
  servers: Readonly<Record<R, string | null | undefined>>,
): R | null {
  for (const [region, base] of Object.entries(servers) as Array<[R, string | null | undefined]>) {
    if (base && sharedTaskInvitationServer(base) === intent.server) return region;
  }
  return null;
}
