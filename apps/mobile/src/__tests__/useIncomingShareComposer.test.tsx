// @vitest-environment jsdom
// Unit: a shared URL used to disappear, and existing tasks had no receiving path.
// Exercise the real mailbox/hook: wrong destination, draft hydration, full tray,
// persistence failure and account changes must not consume or redirect content.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { useIncomingShareComposer } from '@/session/useIncomingShareComposer';
import { __resetIncomingShareForTest, discardIncomingShareBatch, receiveIncomingShare, stageIncomingShareBatch, selectIncomingShareDestination, incomingShareBatchId, incomingShareDestination } from '@/session/incomingShare';
import { setMobileAuthOwner, __testing as ownerTesting } from '@/auth/authOwnerGeneration';
import type { ResolvedSharePayload } from 'expo-sharing';
const h = vi.hoisted(() => ({ focused: true, auth: { isAuthenticated: true, user: { id: 'a' }, getAccessToken: async () => 'token' } }));
vi.mock('expo-router', () => ({ useIsFocused: () => h.focused }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => h.auth }));
vi.mock('react-i18next', async importOriginal => ({ ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/session/pastedImageAttachment', () => ({ resolvePastedImageAsset: vi.fn() }));
vi.mock('expo-file-system/legacy', () => ({ deleteAsync: vi.fn() }));
let root: Root;
const appendText = vi.fn(), enqueueUploads = vi.fn(), onError = vi.fn();
const link: ResolvedSharePayload = { value: 'https://example.com', shareType: 'url', contentUri: 'https://example.com', contentType: 'website', contentMimeType: 'text/uri-list', originalName: 'example.com', contentSize: null };
const file: ResolvedSharePayload = { value: 'file:///share/report.pdf', shareType: 'file', contentUri: 'file:///share/report.pdf', contentType: 'file', contentMimeType: 'application/pdf', originalName: 'report.pdf', contentSize: 20 };
function Composer({ destination = 'chosen', ready = true, count = 0 }: { destination?: string | readonly string[]; ready?: boolean; count?: number }) {
  useIncomingShareComposer({ destination, ready, attachmentCount: count, appendText, enqueueUploads, onError, getPendingUploadCount: () => 0 });
  return null;
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  ownerTesting.reset(); setMobileAuthOwner('a'); __resetIncomingShareForTest();
  h.focused = true; vi.clearAllMocks(); root = createRoot(document.createElement('div'));
});
afterEach(() => { act(() => root.unmount()); __resetIncomingShareForTest(); });
function share(ack = vi.fn()) {
  const batch = stageIncomingShareBatch([link, file], ack)!;
  selectIncomingShareDestination(batch.id, 'chosen');
  return ack;
}
it('waits for the chosen focused composer to hydrate, then appends text and uploads once', () => {
  const ack = share();
  act(() => root.render(<Composer destination="other" />));
  act(() => root.render(<Composer ready={false} />));
  expect(ack).not.toHaveBeenCalled();
  act(() => root.render(<Composer />));
  expect(appendText).toHaveBeenCalledExactlyOnceWith(link.value);
  expect(enqueueUploads).toHaveBeenCalledWith([expect.objectContaining({ name: 'report.pdf', uri: file.value, incomingShareOrder: { batchId: expect.any(String), index: 0 }, cleanupLocalUris: expect.any(Function) })], expect.anything());
  act(() => root.render(<Composer />));
  expect(ack).toHaveBeenCalledOnce();
});
it('keeps every file pending when the destination tray is full', () => {
  const ack = share();
  act(() => root.render(<Composer count={20} />));
  expect(ack).not.toHaveBeenCalled(); expect(appendText).not.toHaveBeenCalled();
  expect(onError).toHaveBeenCalledWith('composer.upload.maxAttachments');
  act(() => root.render(<Composer count={19} />));
  expect(ack).toHaveBeenCalledOnce(); expect(enqueueUploads).toHaveBeenCalledOnce();
});
it('does not expose unacknowledged content, and retries when the composer refocuses', () => {
  const ack = share(vi.fn().mockImplementationOnce(() => { throw new Error('disk'); }));
  act(() => root.render(<Composer />));
  expect(appendText).not.toHaveBeenCalled();
  expect(onError).toHaveBeenCalledWith('composer.upload.shareReceiveFailed');
  h.focused = false; act(() => root.render(<Composer />));
  h.focused = true; act(() => root.render(<Composer />));
  expect(appendText).toHaveBeenCalledOnce(); expect(ack).toHaveBeenCalledTimes(2);
});
it('never hands a previous account share to the current composer', () => {
  share(); setMobileAuthOwner('b');
  act(() => root.render(<Composer />));
  expect(appendText).not.toHaveBeenCalled(); expect(enqueueUploads).not.toHaveBeenCalled();
});
it('receives a native text-only share as text instead of a fictitious file', () => {
  const ack = vi.fn();
  receiveIncomingShare({ getSharedPayloads: () => [{ shareType: 'text', value: 'A passage' }], clearSharedPayloads: ack });
  const expected: ResolvedSharePayload = { value: 'A passage', shareType: 'text', contentUri: null, contentType: 'text', contentMimeType: null, originalName: 'A passage', contentSize: null };
  expect(selectIncomingShareDestination(incomingShareBatchId([expected]), 'chosen')).toBe(true);
  act(() => root.render(<Composer />));
  expect(appendText).toHaveBeenCalledExactlyOnceWith('A passage');
  expect(enqueueUploads).not.toHaveBeenCalled(); expect(ack).toHaveBeenCalledOnce();
});

it('cancels an unclaimed share so sharing the same text again can open a fresh chooser', () => {
  const ack = share();
  expect(discardIncomingShareBatch(incomingShareBatchId([link, file]))).toBe(true);
  act(() => root.render(<Composer />));
  expect(ack).toHaveBeenCalledOnce(); expect(appendText).not.toHaveBeenCalled();
  let nextAck!: ReturnType<typeof share>;
  act(() => { nextAck = share(); });
  act(() => root.render(<Composer />));
  expect(nextAck).toHaveBeenCalledOnce(); expect(appendText).toHaveBeenCalledOnce();
});

it('retains a companion share until the live canonical task is ready', () => {
  const resource = { collectionId: 'companions', kind: 'bot', id: 'alice' };
  const batch = stageIncomingShareBatch([link, file], vi.fn())!;
  selectIncomingShareDestination(batch.id, incomingShareDestination('host', 'old-task', resource));
  act(() => root.render(<Composer destination={incomingShareDestination('host', 'old-task', resource)} ready={false} />));
  expect(batch.acknowledge).not.toHaveBeenCalled();
  act(() => root.render(<Composer destination={incomingShareDestination('host', 'new-task', resource)} ready={false} />));
  expect(appendText).not.toHaveBeenCalled();
  act(() => root.render(<Composer destination={incomingShareDestination('host', 'new-task', resource)} />));
  expect(batch.acknowledge).toHaveBeenCalledOnce();
  expect(appendText).toHaveBeenCalledExactlyOnceWith(link.value);
  expect(enqueueUploads).toHaveBeenCalledOnce();
});

it('also accepts a task-row selection when the mounted route retains companion identity', () => {
  const ack = share();
  act(() => root.render(<Composer destination={['chosen', 'resource-alias']} />));
  expect(ack).toHaveBeenCalledOnce();
  expect(appendText).toHaveBeenCalledOnce();
});
