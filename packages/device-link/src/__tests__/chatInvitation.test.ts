import { describe, expect, it } from 'vitest';
import { parseChatInvitationShareId, parseChatInvitationToken } from '../chatInvitation.js';

const token = 'Ab0_-'.repeat(8) + 'xyz';
const id = 'A_0-'.repeat(8);
const page = `https://share.example.test/chat-invite/${id}`;

// D1/D5/D9 wire boundary: IDs are references, never bearer tokens or request origins.
// Existing tests covered the retired fragment page; these inputs exercise the real parsers.
// unit tier; no network, accounts, persistence or module resets.
describe('chat invitation links', () => {
  it('keeps accepting bare tokens and all three native app schemes', () => {
    expect(parseChatInvitationToken(token)).toBe(token);
    for (const scheme of ['cindy', 'cindycn', 'cindydev']) expect(parseChatInvitationToken(`  ${scheme}://chat-invite/${token}\n`)).toBe(token);
    expect(parseChatInvitationToken(page)).toBeNull();
    expect(parseChatInvitationToken(`https://relay.example.test/chat-invite/join#${token}`)).toBeNull();
  });
  it('reads one opaque share ID from a complete link or shared text without trusting its host', () => {
    for (const input of [page, `邀请你加入群聊：${page}`, `Join us: ${page}.`, `「${page}」`, `[群聊](${page})`,
      page.replace('share.example.test', 'untrusted.example.test'),
      page.replace('https://share.example.test', 'http://localhost:3000'),
      page.replace('https://share.example.test', 'http://127.0.0.1:3000'),
      page.replace('https://share.example.test', 'http://[::1]:3000'),
    ]) expect(parseChatInvitationShareId(input)).toBe(id);
    expect(parseChatInvitationShareId(id)).toBeNull();
  });
  it.each([
    `${page}?token=${token}`, `${page}#${token}`, `${page}/`, page.slice(0,-1), `${page}a`,
    page.replace('https:', 'http:'), page.replace('https:', 'ftp:'), page.replace('https:', 'HTTPS:'),
    page.replace('share.example.test', 'user:pass@share.example.test'), `${page} ${page}`, `${page} https://another.test/chat-invite/${id}`,
    `https://share.example.test/chat-invite/join#${token}`, `https://share.example.test/s/${id}`,
    `https://share.example.test/prefix/chat-invite/${id}`, `javascript:alert(1)//chat-invite/${id}`,
    `cindy://chat-invite/${token.slice(1)}`, `xdt-maker://chat-invite/${token}`, '', '   ',
  ])('rejects malformed or ambiguous references: %s', input => {
    expect(parseChatInvitationShareId(input)).toBeNull();
    expect(parseChatInvitationToken(input)).toBeNull();
  });
  it('rejects non-string and oversized input', () => {
    for (const input of [undefined as unknown as string, `${page} ${'x'.repeat(8192)}`]) {
      expect(parseChatInvitationShareId(input)).toBeNull(); expect(parseChatInvitationToken(input)).toBeNull();
    }
  });
});
