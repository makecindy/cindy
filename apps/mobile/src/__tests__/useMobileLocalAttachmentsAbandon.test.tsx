// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MobileLocalAttachmentUploadCandidate } from '@/session/mobileLocalAttachmentUpload';
import {
  useMobileLocalAttachments,
  type UseMobileLocalAttachmentsOptions,
  type UseMobileLocalAttachmentsResult,
} from '@/session/useMobileLocalAttachments';

const runtime = vi.hoisted(() => ({
  uploads: [] as Array<{ name: string; resolve: () => void }>,
  discarded: [] as unknown[],
}));

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('react-i18next', async (importOriginal) => {
  const t = (key: string) => key;
  return { ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ t }) };
});
vi.mock('expo-document-picker', () => ({}));
vi.mock('expo-image-picker', () => ({}));
vi.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///docs/',
  deleteAsync: async () => undefined,
}));
vi.mock('@/session/durableOutboxFiles', () => ({
  retainComposerAttachmentFile: async (_owner: string, id: string) => `file:///stage/${id}`,
}));
vi.mock('@/session/sentAttachmentThumbStore', () => ({
  getSentAttachmentThumbUri: () => null,
  registerSentAttachmentThumb: async () => undefined,
}));
vi.mock('@/session/mobileAttachmentUpload', () => ({
  statMobileAttachmentFileSize: async () => 1000,
  discardMobileUploadedAttachment: (attachment: unknown) => { runtime.discarded.push(attachment); },
  uploadMobileAttachmentFromFile: (candidate: { name: string }) => new Promise((resolve) => {
    runtime.uploads.push({
      name: candidate.name,
      resolve: () => resolve({
        id: `att-${candidate.name}`,
        name: candidate.name,
        path: `cindy-oss-attach://key/${candidate.name}`,
        ext: '.png',
        size: 1000,
        category: 'image',
        mimeType: 'image/png',
      }),
    });
  }),
}));

let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  runtime.uploads = [];
  runtime.discarded = [];
  root = createRoot(document.createElement('div'));
});
afterEach(() => act(() => root.unmount()));

function mount(scopeKey: string) {
  const options: UseMobileLocalAttachmentsOptions = {
    attachmentScopeKey: scopeKey,
    getAccessToken: async () => 'token',
    getAttachmentCount: () => 0,
    onUploaded: vi.fn(),
    onError: vi.fn(),
  };
  const results: UseMobileLocalAttachmentsResult[] = [];
  function Harness({ scope }: { scope: string }) {
    results.push(useMobileLocalAttachments({ ...options, attachmentScopeKey: scope }));
    return null;
  }
  act(() => root.render(<Harness scope={scopeKey} />));
  return {
    options,
    first: results[0],
    rerender: (scope: string) => act(() => root.render(<Harness scope={scope} />)),
  };
}

const imageCandidate = (name: string, onAbandoned: () => void): MobileLocalAttachmentUploadCandidate => ({
  kind: 'image',
  uri: `file:///cache/annotation-burned/${name}`,
  name,
  size: 1000,
  mimeType: 'image/png',
  onAbandoned,
});
const flush = () => new Promise((resolve) => { setTimeout(resolve, 0); });

describe('useMobileLocalAttachments abandonment on scope change', () => {
  it('abandons a candidate enqueued from a stale scope without starting an upload', async () => {
    const harness = mount('session-a');
    act(() => harness.first.discardAllPendingUploadsForScopeChange());
    const abandoned = vi.fn();
    act(() => harness.first.enqueueUploads([imageCandidate('late.png', abandoned)], { token: 'token' }));
    await flush();
    expect(abandoned).toHaveBeenCalledTimes(1);
    expect(runtime.uploads).toHaveLength(0);
  });

  it('abandons exactly once when an upload finishes after the composer scope moved on', async () => {
    const harness = mount('session-a');
    const abandoned = vi.fn();
    act(() => harness.first.enqueueUploads([imageCandidate('a.png', abandoned)], { token: 'token' }));
    await act(async () => { await flush(); });
    expect(runtime.uploads.map((u) => u.name)).toEqual(['a.png']);
    // 作用域换到另一个任务,但旧任务没有被显式丢弃(防御性代际闸路径)。
    harness.rerender('session-b');
    await act(async () => {
      runtime.uploads[0].resolve();
      await flush();
      await flush();
    });
    expect(harness.options.onUploaded).not.toHaveBeenCalled();
    expect(runtime.discarded).toHaveLength(1);
    expect(abandoned).toHaveBeenCalledTimes(1);
  });
});
