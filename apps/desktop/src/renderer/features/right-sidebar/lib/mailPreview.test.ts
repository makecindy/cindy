// @vitest-environment jsdom
// Transport regression: explicit provider choices must survive device-link,
// and a legacy host ignoring the choice must never display a different mailbox.
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@/features/device-link/remoteProjectsStore', () => ({ getSessionDeviceId: () => null }));
vi.mock('../store', () => ({
  addOrFocusSingletonTab: vi.fn(),
  ensureHydrated: vi.fn(),
  patchTabState: vi.fn(),
}));
vi.mock('./detachedSidebarRouting', () => ({ routeSidebarCommand: vi.fn() }));
vi.mock('./sidebarCommands', () => ({ requestRightSidebarVisibility: vi.fn() }));
import { readMailPreview, openMailPreview, openMailCard } from './mailPreview';
import { trackGhostCardFormDelivery, releaseGhostCardFormDelivery } from '@cindy/maker-shared/ghost-card-form';
import { addOrFocusSingletonTab, ensureHydrated, patchTabState } from '../store';
import { routeSidebarCommand } from './detachedSidebarRouting';
import { requestRightSidebarVisibility } from './sidebarCommands';
const mail = {
  accountId: 'account',
  messageId: 'mail',
  from: 'a@example.test',
  to: '',
  cc: '',
  bcc: '',
  subject: 'Subject',
  date: '',
  bodyText: 'Body',
  bodyHtml: '',
  attachments: [],
};
afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  vi.clearAllMocks();
});
function remote(data: object) {
  const invoke = vi.fn(async (_device: string, _channel: string, _args: unknown[]) => ({
    blocks: [{ data }],
  }));
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { deviceLink: { invoke } },
  });
  return invoke;
}
it('preserves legacy resource IDs and conveys an explicit provider in the optional query', async () => {
  const invoke = remote({ supported: true, message: mail, providerId: 'chosen' });
  const result = await readMailPreview(
    'session',
    'https://mail.example.test/a',
    true,
    'device',
    true,
    'chosen',
  );
  expect(result.message?.bodyText).toBe('Body');
  expect(invoke.mock.calls[0]?.[2]?.[0]).toMatchObject({
    ref: { id: JSON.stringify(['session', 'https://mail.example.test/a', true]) },
    query: JSON.stringify({ opened: true, providerId: 'chosen' }),
  });
});
it('rejects an unacknowledged provider while keeping ordinary legacy reads working', async () => {
  remote({ supported: true, message: mail });
  const selected = await readMailPreview(
    'session',
    'https://mail.example.test/a',
    true,
    'device',
    true,
    'chosen',
  );
  expect(selected.message).toBeNull();
  expect(selected.error).toBe('MAIL_PROVIDER_UNAVAILABLE');
  expect(
    (await readMailPreview('session', 'https://mail.example.test/a', true, 'device')).message
      ?.bodyText,
  ).toBe('Body');
});

// Link opening previously raced card keystrokes in transit. The real delivery
// barrier must finish before either sidebar entry or an explicit provider read.
it.each(['link', 'card'] as const)('keeps the %s entry in the same sidebar and waits for the last edit', async kind => {
  const sessionId = 'pending-' + kind;
  let finish!: (ok: boolean) => void;
  trackGhostCardFormDelivery(sessionId, 'editor', new Promise(resolve => { finish = resolve; }));
  vi.mocked(routeSidebarCommand).mockResolvedValue('attached');
  vi.mocked(addOrFocusSingletonTab).mockResolvedValue({ id: 'same-mail-tab' } as never);
  const open = kind === 'link' ? openMailPreview(sessionId, 'https://mail.example.test/draft') : openMailCard(sessionId, 'saved-card');
  await Promise.resolve();
  expect(routeSidebarCommand).not.toHaveBeenCalled();
  finish(true);
  await open;
  expect(ensureHydrated).toHaveBeenCalledWith(sessionId);
  const state = kind === 'link' ? { url: 'https://mail.example.test/draft' } : { url: '', callId: 'saved-card' };
  expect(addOrFocusSingletonTab).toHaveBeenCalledWith(sessionId, 'mail-preview', state);
  expect(vi.mocked(patchTabState).mock.calls[0][1]).toBe('same-mail-tab');
  expect(requestRightSidebarVisibility).toHaveBeenCalledWith('open', { sessionId });
});
it('waits before a visible draft read, keeps background reads inert and retains failed edits', async () => {
  const sessionId = 'pending-read', invoke = remote({ supported: true, message: mail, draftCallId: 'saved-card' });
  let finish!: (ok: boolean) => void;
  trackGhostCardFormDelivery(sessionId, 'editor', new Promise(resolve => { finish = resolve; }));
  const opened = readMailPreview(sessionId, 'https://mail.example.test/draft', true, 'device', true);
  await Promise.resolve();
  expect(invoke).not.toHaveBeenCalled();
  expect((await readMailPreview(sessionId, 'https://mail.example.test/draft', true, 'device')).draftCallId).toBeUndefined();
  finish(true);
  expect((await opened).draftCallId).toBe('saved-card');

  trackGhostCardFormDelivery(sessionId, 'editor', Promise.resolve(false));
  invoke.mockClear();
  try {
    await expect(openMailPreview(sessionId, 'https://mail.example.test/draft')).rejects.toThrow('Draft sync failed');
    await expect(openMailCard(sessionId, 'saved-card')).rejects.toThrow('Draft sync failed');
    await expect(readMailPreview(sessionId, 'https://mail.example.test/draft', true, 'device', true)).rejects.toThrow('Draft sync failed');
    expect(routeSidebarCommand).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  } finally {
    releaseGhostCardFormDelivery(sessionId, 'editor');
  }
});
