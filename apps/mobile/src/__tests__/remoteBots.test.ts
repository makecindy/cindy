import { describe, expect, it } from 'vitest';

import {
  isRemoteBotsUnsupported,
  normalizeRemoteBotProfiles,
  remoteBotCanOpen,
  resolveRemoteBotAvatarColor,
} from '@/bots/remoteBots';

describe('remote Bots projection', () => {
  it('keeps only the read-only fields used by Mobile', () => {
    expect(normalizeRemoteBotProfiles([{
      id: 'bot-1',
      name: 'Release',
      description: 'ships builds',
      avatar: '🚀',
      avatarColor: '#fff',
      status: 'active',
      currentVersion: 3,
      canonicalSessionId: 'session-1',
      permissions: 'trusted',
      capabilities: { secret: true },
      channels: [{ kind: 'local', enabled: true, config: { token: 'secret' } }],
    }])).toEqual([{
      id: 'bot-1',
      name: 'Release',
      description: 'ships builds',
      avatar: '🚀',
      avatarColor: '#fff',
      status: 'active',
      currentVersion: 3,
      canonicalSessionId: 'session-1',
      channels: [{ kind: 'local', enabled: true }],
    }]);
  });

  it('drops malformed rows and never makes archived or missing-canonical Bots openable', () => {
    const [archived, missing] = normalizeRemoteBotProfiles([
      { id: 'a', name: 'Archived', status: 'archived', canonicalSessionId: 's-a' },
      { id: 'm', name: 'Missing', status: 'active' },
      { id: '', name: 'invalid' },
    ]);
    expect(remoteBotCanOpen(archived)).toBe(false);
    expect(remoteBotCanOpen(missing)).toBe(false);
  });

  it('fails closed for unhealthy, deleting, and unknown lifecycle states', () => {
    const rows = normalizeRemoteBotProfiles([
      { id: 'e', name: 'Error', status: 'error', canonicalSessionId: 's-e' },
      { id: 'd', name: 'Deleting', status: 'deleting', canonicalSessionId: 's-d' },
      { id: 'u', name: 'Unknown', status: 'future-state', canonicalSessionId: 's-u' },
    ]);
    expect(rows.map((row) => row.status)).toEqual(['error', 'deleting', 'error']);
    expect(rows.every((row) => !remoteBotCanOpen(row))).toBe(true);
  });

  it('degrades Desktop avatar sentinels to the generic Bot emoji', () => {
    // Mobile's Bot list renders `avatar` as text, so a `cindy://avatar/…` value
    // (bundled artwork on Desktop) must not reach the screen as a raw scheme.
    const rows = normalizeRemoteBotProfiles([
      { id: 'a', name: 'Cindy', avatar: 'cindy://avatar/official' },
      { id: 'b', name: 'Future', avatar: '  CINDY://AVATAR/next  ' },
      { id: 'c', name: 'Missing', avatar: '' },
      { id: 'd', name: 'Wrong type', avatar: 42 },
      { id: 'e', name: 'Emoji', avatar: '🚀' },
      { id: 'f', name: 'Not the namespace', avatar: 'cindy://media/official' },
    ]);
    expect(rows.map((row) => row.avatar)).toEqual([
      '🤖',
      '🤖',
      '🤖',
      '🤖',
      '🚀',
      'cindy://media/official',
    ]);
  });

  it('recognizes old Desktop capability rejection without swallowing other failures', () => {
    expect(isRemoteBotsUnsupported(Object.assign(new Error('old'), { code: 'CHANNEL_NOT_ALLOWED' }))).toBe(true);
    expect(isRemoteBotsUnsupported('DEVICE_LINK_CHANNEL_NOT_ALLOWED')).toBe(true);
    expect(isRemoteBotsUnsupported(new Error('DEVICE_OFFLINE'))).toBe(false);
  });

  it('maps Desktop semantic avatar colors onto valid Mobile theme colors', () => {
    const colors = {
      cta: '#111111',
      inputCaret: '#222222',
      textSecondary: '#333333',
      textPrimary: '#444444',
      surfaceElevated: '#555555',
    };
    expect(resolveRemoteBotAvatarColor('violet', colors)).toBe(colors.cta);
    expect(resolveRemoteBotAvatarColor('graphite', colors)).toBe(colors.textPrimary);
    expect(resolveRemoteBotAvatarColor('#abcdef', colors)).toBe('#abcdef');
    expect(resolveRemoteBotAvatarColor('not-a-native-color', colors)).toBe(colors.surfaceElevated);
  });
});
