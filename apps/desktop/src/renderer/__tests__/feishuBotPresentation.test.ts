import { describe, expect, it } from 'vitest';

import {
  savedCredentialsNoteKey,
  shouldShowSavedCredentialsCard,
} from '@/components/settings/feishuBotPresentation';

describe('Feishu bot saved-credential presentation', () => {
  it('keeps the bound card visible for every transport state when credentials exist', () => {
    expect(shouldShowSavedCredentialsCard(true)).toBe(true);
    expect(shouldShowSavedCredentialsCard(false)).toBe(false);
  });

  it.each([
    ['idle', 'settings.feishuBot.saved.idleNote'],
    ['testing', 'settings.feishuBot.saved.connectingNote'],
    ['connected', 'settings.feishuBot.connected.note'],
    ['reconnecting', 'settings.feishuBot.saved.reconnectingNote'],
    ['conflict', 'settings.feishuBot.saved.conflictNote'],
    ['error', 'settings.feishuBot.saved.errorNote'],
  ] as const)('maps %s to an explicit saved-credential explanation', (status, key) => {
    expect(savedCredentialsNoteKey(status, false)).toBe(key);
  });

  it('swaps the connected note once strangers are allowed', () => {
    expect(savedCredentialsNoteKey('connected', true)).toBe(
      'settings.feishuBot.connected.noteStrangersAllowed',
    );
    // 只有已连接那句会被开关改写, 其它档位与访客开关无关。
    expect(savedCredentialsNoteKey('error', true)).toBe('settings.feishuBot.saved.errorNote');
  });
});
