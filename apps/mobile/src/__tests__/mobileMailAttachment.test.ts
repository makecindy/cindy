import { beforeEach, expect, it, vi } from 'vitest';
import { pickMobileMailAttachment } from '../plugins/mobileMailAttachment';

// This native picker/upload handoff is separate from the card component: test
// cancellation, size admission and cleanup without loading a renderer or Expo.
const h = vi.hoisted(() => ({ pick: vi.fn(), info: vi.fn(), remove: vi.fn(), upload: vi.fn(), discard: vi.fn() }));
vi.mock('expo-document-picker', () => ({ getDocumentAsync: h.pick }));
vi.mock('expo-file-system/legacy', () => ({ getInfoAsync: h.info, deleteAsync: h.remove }));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('../session/mobileAttachmentUpload', () => ({ uploadMobileAttachmentFromFile: h.upload, discardMobileUploadedAttachment: h.discard }));
beforeEach(() => {
  vi.clearAllMocks();
  h.pick.mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///cache/plan.pdf', name: 'plan.pdf', mimeType: 'application/pdf' }] });
  h.info.mockResolvedValue({ exists: true, isDirectory: false, size: 100 });
  h.remove.mockResolvedValue(undefined);
  h.upload.mockResolvedValue({ path: 'uploaded-reference' });
});
const options = (isActive = () => true) => ({ deviceId: 'host', getAccessToken: async () => 'token', signal: new AbortController().signal, isActive, deliver: vi.fn(async () => true) });
it.each(['rejected', 'thrown'])('discards an upload when card delivery is %s', async failure => {
  const input = options();
  input.deliver.mockImplementation(async () => { if (failure === 'thrown') throw new Error('disconnected'); return false; });
  if (failure === 'thrown') await expect(pickMobileMailAttachment(input)).rejects.toThrow('disconnected');
  else expect(await pickMobileMailAttachment(input)).toBeNull();
  expect(h.discard).toHaveBeenCalledWith({ path: 'uploaded-reference' }, expect.any(Object));
  const cleanup = h.discard.mock.calls[0][1];
  expect(await cleanup.getToken()).toBe('token');
  expect(h.remove).toHaveBeenCalledOnce();
});
it('picker cancel performs no upload or file deletion', async () => {
  h.pick.mockResolvedValue({ canceled: true });
  expect(await pickMobileMailAttachment(options())).toBeNull();
  expect(h.upload).not.toHaveBeenCalled(); expect(h.remove).not.toHaveBeenCalled();
});
it('oversized files are rejected before token/upload and the selected cache copy is removed', async () => {
  h.info.mockResolvedValue({ exists: true, isDirectory: false, size: 17 * 1024 * 1024 });
  await expect(pickMobileMailAttachment(options())).rejects.toThrow('plugins.mailAttachTooLarge');
  expect(h.upload).not.toHaveBeenCalled(); expect(h.remove).toHaveBeenCalledOnce();
});
it('passes exact file bytes and host destination to the existing uploader', async () => {
  expect(await pickMobileMailAttachment(options())).toEqual({ url: 'uploaded-reference', name: 'plan.pdf' });
  expect(h.upload).toHaveBeenCalledWith({ name: 'plan.pdf', size: 100, mimeType: 'application/pdf' }, 'file:///cache/plan.pdf',
    expect.objectContaining({ deviceId: 'host', token: 'token' }));
  expect(h.remove).toHaveBeenCalledOnce(); expect(h.discard).not.toHaveBeenCalled();
});
it('leaving the card during upload discards the late result instead of attaching it', async () => {
  let active = true;
  h.upload.mockImplementation(async () => { active = false; return { path: 'uploaded-reference' }; });
  expect(await pickMobileMailAttachment(options(() => active))).toBeNull();
  expect(h.discard).toHaveBeenCalledWith({ path: 'uploaded-reference' }, expect.any(Object));
  expect(h.remove).toHaveBeenCalledOnce();
});
