import { invitationHtml, invitationCss, invitationScript } from './publicTaskPage.js';
import { providerShareInvitationHtml, providerShareInvitationCss, providerShareInvitationScript } from './publicProviderPage.js';
import { invitationBrandMark } from './invitationMark.js';
export { invitationHtml, invitationCss, invitationScript, providerShareInvitationHtml, providerShareInvitationCss,
  providerShareInvitationScript, invitationBrandMark };

/** Same handoff, locales, accessibility and themes as V1. Only the V2 receipt
 * syntax and public service prefix differ. No invitation reaches this server. */
export function agentNetInvitationAsset(kind: 'shared-task' | 'provider-share', asset: string): { type: string; body: string | Buffer } | null {
  if (asset === 'mark.png') return { type: 'image/png', body: invitationBrandMark };
  if (asset === 'join') return { type: 'text/html; charset=utf-8', body: kind === 'shared-task' ? invitationHtml : providerShareInvitationHtml };
  if (asset === 'join.css') return { type: 'text/css; charset=utf-8', body: kind === 'shared-task' ? invitationCss : providerShareInvitationCss };
  if (asset !== 'join.js') return null;
  let script = (kind === 'shared-task' ? invitationScript : providerShareInvitationScript)
    .replace('/^[A-Za-z0-9_-]{43}$/', String.raw`/^an2\.[A-Za-z0-9_-]{1,4096}$/`)
    .replace(`const suffix = '/${kind}/join';`, `const suffix = '/api/agent-net/${kind}/join';`);
  if (kind === 'provider-share') script = script.replace("'cindy://provider-share/join?invitation='", "app + '://provider-share/join?invitation='");
  return { type: 'application/javascript; charset=utf-8', body: script };
}
