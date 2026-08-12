/**
 * Discord adapter characterization test — pins the host-side contract used by
 * the shared IM orchestrator.
 */
import { describe, expect, it, vi } from 'vitest';

import os from 'node:os';
import path from 'node:path';

const scopeMocks = vi.hoisted(() => ({
  owner: 'local-v1',
  root: '',
  join: null as unknown as (...parts: string[]) => string,
  claimLegacy: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => path.join(os.tmpdir(), 'xdt-discord-adapter-test')),
  },
}));

vi.mock('../../ownerScopedStorage', () => ({
  ownerScopedImUserDataPath: (...parts: string[]) =>
    scopeMocks.join(scopeMocks.root, 'owners', scopeMocks.owner, ...parts),
  claimLegacyImPath: scopeMocks.claimLegacy,
}));

import type { DiscordIM } from '@cindy/im';
import { buildDiscordAdapter } from '../adapter';

const fakeIm = {} as unknown as DiscordIM;
const CONFIG = {
  agentKind: 'claude-code' as const,
  defaultModel: 'claude-opus-4-7',
  defaultPermissionMode: 'auto' as const,
  effortOverrides: { 'claude-opus-4-7': 'xhigh' as const },
};

describe('discord ImChannelAdapter characterization', () => {
  const adapter = buildDiscordAdapter(fakeIm, CONFIG);
  scopeMocks.root = path.join(os.tmpdir(), 'xdt-discord-adapter-test');
  scopeMocks.join = path.join;

  it('channel / source are discord and the adapter is not thread scoped', () => {
    expect(adapter.channel).toBe('discord');
    expect(adapter.sessions.source).toBe('discord');
    expect(adapter.sessions.workspaceKind).toBe('dialogue');
    expect(adapter.threadScoped).toBeUndefined();
  });

  it('session id is discord_{appId}_{userId}', () => {
    expect(adapter.sessions.sessionIdFor('app_123', '9876543210')).toBe(
      'discord_app_123_9876543210',
    );
  });

  it('uses shared IM insert columns', () => {
    expect(adapter.sessions.extraInsertColumns('app_123', '9876543210')).toEqual({
      imBotContextId: 'app_123',
      imUserId: '9876543210',
    });
  });

  it('vendorOptions inject discordChatId + source=discord', () => {
    expect(adapter.buildVendorOptions('9876543210')).toEqual({
      discordChatId: '9876543210',
      source: 'discord',
    });
  });

  it('title, generated title prefix, and processing emoji match Discord contract', () => {
    expect(adapter.sessions.defaultTitle('9876543210')).toBe('Discord · 543210');
    expect(adapter.sessions.generatedTitlePrefix).toBe('Discord · ');
    expect(adapter.processingEmoji).toBe('👀');
  });

  it('workingDir = userData/im-working-dir/discord-{appId}', () => {
    const dir = adapter.sessions.ensureWorkingDir('app_123');
    expect(dir).toBe(
      path.join(
        os.tmpdir(),
        'xdt-discord-adapter-test',
        'owners',
        'local-v1',
        'im-working-dir',
        'discord-app_123',
      ),
    );
    expect(scopeMocks.claimLegacy).toHaveBeenCalledWith(
      path.join(os.tmpdir(), 'xdt-discord-adapter-test', 'im-working-dir', 'discord-app_123'),
      dir,
    );
  });
});
