import { describe, expect, it } from 'vitest';
import { CHAT_INVITATION_PATH, parseChatInvitationToken } from '../chatInvitation.js';

const token = 'Ab0_-'.repeat(8) + 'xyz';
const page = `https://relay.example.test${CHAT_INVITATION_PATH}#${token}`;

describe('chat invitation links', () => {
  it('keeps accepting bare tokens and the existing custom-scheme link', () => {
    expect(token).toHaveLength(43);
    expect(parseChatInvitationToken(token)).toBe(token);
    expect(parseChatInvitationToken(`  cindy://chat-invite/${token}\n`)).toBe(token);
  });

  it('reads the token from the public page link, with or without a build hint, and from shared text', () => {
    for (const input of [
      page,
      `${page}?app=cindy`, `${page}?app=cindycn`, `${page}?app=cindydev`,
      `https://relay.example.test/prefix${CHAT_INVITATION_PATH}#${token}`,
      `http://localhost:3000${CHAT_INVITATION_PATH}#${token}`,
      `http://127.0.0.1:3000${CHAT_INVITATION_PATH}#${token}`,
      `http://[::1]:3000${CHAT_INVITATION_PATH}#${token}`,
      `http://[::1]${CHAT_INVITATION_PATH}#${token}?app=cindydev`,
      `本机预览：http://[::1]:3000${CHAT_INVITATION_PATH}#${token}。`,
      `Local preview: http://[::1]:3000${CHAT_INVITATION_PATH}#${token}.`,
      `[本机](http://[::1]:3000${CHAT_INVITATION_PATH}#${token})`,
      `邀请你加入群聊：${page}`, `Join us: ${page}.`, `「${page}」`, `[群聊](${page})`,
    ]) expect(parseChatInvitationToken(input)).toBe(token);
    // The secret lives only in the fragment, never in the HTTP request.
    const url = new URL(page);
    expect(url.pathname + url.search).not.toContain(token);
  });

  it.each([
    ['a query string', `https://relay.example.test${CHAT_INVITATION_PATH}?token=${token}#${token}`],
    ['the token in the query', `https://relay.example.test${CHAT_INVITATION_PATH}?${token}`],
    ['the token in the path', `https://relay.example.test${CHAT_INVITATION_PATH}/${token}`],
    ['user info', `https://user:pass@relay.example.test${CHAT_INVITATION_PATH}#${token}`],
    ['plain http to a public host', `http://relay.example.test${CHAT_INVITATION_PATH}#${token}`],
    ['plain http to a public IPv6 host', `http://[2001:db8::1]${CHAT_INVITATION_PATH}#${token}`],
    ['two loopback IPv6 invitation links', `http://[::1]:3000${CHAT_INVITATION_PATH}#${token} https://[::1]${CHAT_INVITATION_PATH}#${token}`],
    ['IPv6 user info', `https://user@[::1]${CHAT_INVITATION_PATH}#${token}`],
    ['an IPv6 link with a query', `http://[::1]:3000${CHAT_INVITATION_PATH}?t=1#${token}`],
    ['an unknown app hint', `${page}?app=other`],
    ['a redirect hint', `${page}?redirect=https://evil.example.test`],
    ['two fragment parameters', `${page}?app=cindy?app=cindycn`],
    ['an extra fragment segment', `${page}#again`],
    ['a short token', page.slice(0, -1)],
    ['a long token', `${page}a`],
    ['a non-base64url token', page.slice(0, -1) + '='],
    ['a different page', `https://relay.example.test/shared-task/join#${token}`],
    ['another custom scheme', `cindycn://chat-invite/${token}`],
    ['a legacy custom scheme', `xdt-maker://chat-invite/${token}`],
    ['javascript', `javascript:alert(1)//${CHAT_INVITATION_PATH}#${token}`],
    ['an uppercase scheme', page.replace('https', 'HTTPS')],
    ['two invitation links', `${page} ${page.replace('relay', 'other')}`],
    ['a truncated custom link', `cindy://chat-invite/${token.slice(0, 20)}`],
    ['empty text', '   '],
  ])('rejects %s', (_label, input) => {
    expect(parseChatInvitationToken(input)).toBeNull();
  });

  it('rejects non-string and oversized input', () => {
    expect(parseChatInvitationToken(undefined as unknown as string)).toBeNull();
    expect(parseChatInvitationToken(`${page} ${'x'.repeat(8192)}`)).toBeNull();
  });
});
