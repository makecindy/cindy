import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  enabled: true,
  createContact: vi.fn(),
  emitLocalContactsChanged: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock('../../../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../maker-host/maker-contacts-host.js', () => ({
  getDesktopContactsManager: () => ({
    getStore: () => ({
      createContact: harness.createContact,
      resolve: harness.resolve,
    }),
  }),
}));

vi.mock('../../../maker-host/contacts-settings-store.js', () => ({
  readContactsSettingsState: () => ({ value: { enabled: harness.enabled } }),
}));

vi.mock('../../../maker-host/contacts-change-events.js', () => ({
  emitLocalContactsChanged: harness.emitLocalContactsChanged,
}));

import {
  autoRegisterTelegramSpeaker,
  resetTelegramSpeakerRegistrationCache,
} from '../contactsAutoRegister.js';

describe('Telegram contacts auto-register', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.enabled = true;
    harness.resolve.mockReturnValue([]);
    resetTelegramSpeakerRegistrationCache();
  });

  it('registers a non-owner once and emits the shared local change event', () => {
    const speaker = { id: '12345', name: 'Alice', username: 'alice', isOwner: false };
    autoRegisterTelegramSpeaker(speaker, { chatName: 'Ops' });
    autoRegisterTelegramSpeaker(speaker, { chatName: 'Ops' });

    expect(harness.resolve).toHaveBeenCalledOnce();
    expect(harness.createContact).toHaveBeenCalledOnce();
    expect(harness.createContact).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: 'Alice',
        summary: 'Telegram 群「Ops」成员(bot 自动登记)',
        identities: [
          { platform: 'telegram', value: '12345' },
          { platform: 'telegram', value: '@alice' },
        ],
      }),
    );
    expect(harness.emitLocalContactsChanged).toHaveBeenCalledOnce();
  });

  it('does not emit a change event when contact creation fails', () => {
    harness.createContact.mockImplementationOnce(() => {
      throw new Error('database busy');
    });

    autoRegisterTelegramSpeaker(
      { id: 'telegram-event-2', name: 'Bob', isOwner: false },
      { chatName: '项目群' },
    );

    expect(harness.emitLocalContactsChanged).not.toHaveBeenCalled();
  });

  it('does not create contacts for the owner, when disabled, or for known identities', () => {
    autoRegisterTelegramSpeaker({ id: '1', name: 'Owner', isOwner: true }, { chatName: 'Ops' });
    harness.enabled = false;
    autoRegisterTelegramSpeaker({ id: '2', name: 'Disabled', isOwner: false }, { chatName: 'Ops' });
    harness.enabled = true;
    harness.resolve.mockReturnValue([{ matchType: 'identity' }]);
    autoRegisterTelegramSpeaker({ id: '3', name: 'Known', isOwner: false }, { chatName: 'Ops' });

    expect(harness.createContact).not.toHaveBeenCalled();
    expect(harness.emitLocalContactsChanged).not.toHaveBeenCalled();
    expect(harness.resolve).toHaveBeenCalledOnce();
  });
});
