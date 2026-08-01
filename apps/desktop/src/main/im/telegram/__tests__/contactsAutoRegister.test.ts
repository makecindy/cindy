import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  createContact: vi.fn(),
  emitLocalContactsChanged: vi.fn(),
  resolve: vi.fn(() => []),
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
  readContactsSettingsState: () => ({ value: { enabled: true } }),
}));

vi.mock('../../../maker-host/contacts-change-events.js', () => ({
  emitLocalContactsChanged: harness.emitLocalContactsChanged,
}));

import { autoRegisterTelegramSpeaker } from '../contactsAutoRegister.js';

describe('Telegram contacts auto-register', () => {
  beforeEach(() => {
    harness.createContact.mockReset();
    harness.emitLocalContactsChanged.mockReset();
    harness.resolve.mockReset().mockReturnValue([]);
  });

  it('建档成功后触发共享本地变更事件', () => {
    autoRegisterTelegramSpeaker(
      { id: 'telegram-event-1', name: 'Alice', isOwner: false },
      { chatName: '项目群' },
    );

    expect(harness.createContact).toHaveBeenCalledTimes(1);
    expect(harness.emitLocalContactsChanged).toHaveBeenCalledTimes(1);
  });

  it('建档失败时不触发变更事件', () => {
    harness.createContact.mockImplementationOnce(() => {
      throw new Error('database busy');
    });

    autoRegisterTelegramSpeaker(
      { id: 'telegram-event-2', name: 'Bob', isOwner: false },
      { chatName: '项目群' },
    );

    expect(harness.emitLocalContactsChanged).not.toHaveBeenCalled();
  });
});
