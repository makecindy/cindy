import { describe, expect, it } from 'vitest';
import { buildSharedTaskInvitationLink, parseSharedTaskInvitation, parseSharedTaskInvitationIntent, sharedTaskAccountName } from '../sharedTaskInvitation.js';

const token = 'A'.repeat(43);
const server = 'https://relay.example.test';
const link = `${server}/shared-task/join#${token}`;

describe('shared task invitation handoff', () => {
  it('keeps the secret out of the HTTP request while retaining old codes', () => {
    expect(buildSharedTaskInvitationLink(token, server + '/')).toBe(link);
    const url = new URL(link);
    expect(url.pathname + url.search).not.toContain(token);
    for (const input of [token, link, `Join this task: ${link}.`, `[Join](${link})`, `「${link}」`]) {
      expect(parseSharedTaskInvitation(input, server)).toEqual({ ok: true, invitation: token });
    }
  });
  it('accepts only the originating build hint in the fragment', () => {
    for (const app of ['cindycn', 'cindydev'] as const) {
      const value = buildSharedTaskInvitationLink(token, server, app);
      expect(value).toBe(link + '?app=' + app);
      expect(new URL(value).search).toBe('');
      expect(parseSharedTaskInvitation(value, server)).toEqual({ ok: true, invitation: token });
    }
    for (const hint of ['?app=other', '?app=cindy&app=cindycn', '?app=cindy?extra=1', '?redirect=https://other.example.test']) {
      expect(parseSharedTaskInvitation(link + hint, server)).toEqual({ ok: false, reason: 'invalid' });
    }
  });
  it('extracts the unique invitation when the task title contains ordinary URLs', () => {
    const message = `邀请你加入「检查 https://docs.example.test/ 和 http://example.test/page」\n${link}?app=cindycn\n复制后打开 Cindy`;
    expect(parseSharedTaskInvitation(message, server)).toEqual({ ok: true, invitation: token });
    expect(parseSharedTaskInvitation(message, 'https://other.example.test')).toEqual({ ok: false, reason: 'different-server' });
    expect(parseSharedTaskInvitation('https://docs.example.test/#' + token, server)).toEqual({ ok: false, reason: 'invalid' });
  });
  it('still rejects multiple invitations, including invalid and foreign-server candidates', () => {
    for (const other of [link.replace(token, 'B'.repeat(43)), link.replace(server, 'https://other.example.test'), link + '?app=unknown', link.replace(token, 'invalid')]) {
      expect(parseSharedTaskInvitation(`https://docs.example.test/\n${other}\n${link}`, server)).toEqual({ ok: false, reason: 'invalid' });
    }
  });
  it('does not extract credentials from arbitrary URLs or ambiguous invitations', () => {
    for (const input of [link + 'B', link + '/more', link.replace('/join#', '/join?token='), link.replace('https:', 'javascript:'),
      link.replace('https://', 'https://user:password@'), `${link} ${link}`, 'a'.repeat(8193)]) {
      expect(parseSharedTaskInvitation(input, server)).toEqual({ ok: false, reason: 'invalid' });
    }
    expect(parseSharedTaskInvitation(link, 'https://other.example.test')).toEqual({ ok: false, reason: 'different-server' });
    expect(parseSharedTaskInvitation(link, server + '/prefix')).toEqual({ ok: false, reason: 'different-server' });
  });
  it('handles prefixed endpoints and local development without accepting arbitrary HTTP servers', () => {
    for (const base of [server + '/prefix', 'http://127.0.0.1:1234', 'http://localhost:1234']) {
      expect(parseSharedTaskInvitation(buildSharedTaskInvitationLink(token, base), base)).toEqual({ ok: true, invitation: token });
    }
    expect(() => buildSharedTaskInvitationLink(token, 'http://public.example.test')).toThrow();
  });
  it('accepts only bounded invitation handoffs with one token and service', () => {
    const query = `?invitation=${token}&server=${encodeURIComponent(server)}`;
    for (const path of ['cindy://shared-task/join', 'cindy://shared-session', 'cindycn://shared-session', 'cindydev://shared-session']) {
      expect(parseSharedTaskInvitationIntent(path + query)).toEqual({ invitation: token, server });
    }
    for (const value of ['https://shared-task/join', 'other://shared-session', 'cindy://shared-session/extra', 'cindy://user@shared-session']) {
      expect(parseSharedTaskInvitationIntent(value + query)).toBeNull();
    }
    for (const suffix of ['&invitation=' + token, '&server=' + server, '&redirect=https://evil.test', '#extra']) {
      expect(parseSharedTaskInvitationIntent('cindy://shared-session' + query + suffix)).toBeNull();
    }
  });
  it('uses the account name within the existing label limit without splitting Unicode', () => {
    expect(sharedTaskAccountName('  Account Name  ')).toBe('Account Name');
    expect(sharedTaskAccountName('a'.repeat(31) + '\u{1f600}')).toBe('a'.repeat(31));
    expect(sharedTaskAccountName('A\nB')).toBe('AB');
    expect(sharedTaskAccountName('')).toBe('Cindy');
  });
});
