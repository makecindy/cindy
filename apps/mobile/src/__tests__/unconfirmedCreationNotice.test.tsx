// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Alert } from 'react-native';
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { isDurableCreationDraft, type DurableOutboxRecord } from '@/session/durableOutbox';
import { UnconfirmedCreationNotice } from '@/session/UnconfirmedCreationNotice';

const outbox = vi.hoisted(() => ({ records: [] as DurableOutboxRecord[] }));
vi.mock('react-native', () => ({ Alert: { alert: vi.fn() } }));
vi.mock('expo-router', () => ({ useIsFocused: () => true, useRouter: () => ({ push: vi.fn() }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/session/newSessionCreation', () => ({ recoverUnconfirmedCreationDrafts: async () => [] }));
vi.mock('@/session/mobileDurableOutbox', () => ({
  getCurrentMobileOutboxRecords: () => outbox.records,
  mobileDurableOutbox: { subscribe: () => () => undefined },
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;

function draft(sessionId: string, marker: 'editReady' | 'cancelled'): DurableOutboxRecord {
  return {
    version: 1, accountId: 'owner', deviceId: 'pc', state: 'failed', createdAt: 1, uploads: [],
    suspended: true, error: marker === 'cancelled' ? undefined : '[NOT_CONNECTED] reliable link stalled',
    item: {
      sessionId, clientId: sessionId, text: 'keep', attachmentSlots: [], quotesEncoded: false,
      agentReferences: [], pastedTextRanges: [], slashCommandRanges: [], permissionModeAtSend: 'auto',
      slotMeta: [], slotByLocalId: {}, waitingIds: [], failedIds: [], enqueueError: null, phase: 'failed',
    },
    creation: {
      deviceName: 'PC', planModeArm: false, restorePermissionMode: null,
      ...(marker === 'cancelled' ? { cancelled: true as const } : { editReady: true as const }),
      draft: {
        agentKind: 'codex', workspaceKind: 'dialogue', model: 'model', effort: 'medium',
        permissionMode: 'auto', workingDir: '/repo', providerId: null, fastMode: false, firstMessage: 'keep',
      },
    },
  };
}

beforeEach(() => {
  setMobileAuthOwner('owner');
  outbox.records = [];
  vi.mocked(Alert.alert).mockClear();
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

it('does not alert when a cancelled draft is still on the home ledger', async () => {
  const cancelled = draft('cancelled-home', 'cancelled');
  outbox.records = [cancelled];
  await act(async () => { root.render(createElement(UnconfirmedCreationNotice)); });
  expect(isDurableCreationDraft(cancelled)).toBe(true);
  expect(Alert.alert).not.toHaveBeenCalled();
});

it('alerts only for a create the host never confirmed', async () => {
  outbox.records = [draft('dropped-home', 'editReady')];
  await act(async () => { root.render(createElement(UnconfirmedCreationNotice)); });
  expect(Alert.alert).toHaveBeenCalledWith(
    'session.screen.createFailedTitle',
    'session.screen.firstMessageNotSent',
    expect.any(Array),
  );
});
