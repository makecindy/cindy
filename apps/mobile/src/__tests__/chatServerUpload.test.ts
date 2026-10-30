import { describe, expect, it, vi } from 'vitest';
import { createChatServerUpload } from '@/chat/chatServerUpload';

const room = '00000000-0000-4000-8000-000000000001';
const media = '00000000-0000-4000-8000-000000000002';
const file = { name: 'report.pdf', size: 42, mimeType: 'application/pdf' };
function fixture() {
  let current = true;
  const request = vi.fn().mockResolvedValue({ id: media, uploadUrl: 'https://upload.example.invalid/signed' });
  const put = vi.fn(async () => {});
  const upload = createChatServerUpload({ request, put, current: () => current, operationId: () => 'upload-operation' });
  return { request, put, upload, invalidate: () => { current = false; } };
}

describe('mobile direct private media upload', () => {
  it.each(['application/pdf', 'image/jpeg'])('prepares, uploads and seals %s without exposing the signed URL in the draft', async mimeType => {
    const f = fixture();
    const result = await f.upload(room, { ...file, mimeType }, 'file:///picked');
    expect(f.request.mock.calls).toEqual([
      [`/conversations/${room}/media`, 'POST', { operationId: 'media:upload-operation', name: file.name, type: mimeType, size: 42 }],
      [`/conversations/${room}/media/${media}/complete`, 'POST', { operationId: `seal:${media}` }],
    ]);
    expect(f.put).toHaveBeenCalledWith('https://upload.example.invalid/signed', 'file:///picked', mimeType, undefined);
    // Unit: the upload entry returns the same dotted extension metadata as the existing attachment pipeline.
    // report.pdf exposed the direct adapter's divergent 'pdf' value; existing success checks missed this field.
    expect(result).toMatchObject({ id: media, name: file.name, path: '', ext: '.pdf', category: mimeType.startsWith('image/') ? 'image' : 'file' });
    expect(JSON.stringify(result)).not.toContain('https:');
  });
  it('does not seal or send after a failed PUT', async () => {
    const f = fixture(); f.put.mockRejectedValue(new Error('NETWORK'));
    await expect(f.upload(room, file, 'file:///picked')).rejects.toThrow('NETWORK');
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it.each(['prepare', 'put', 'complete'])('rejects a late result after owner changes during %s', async stage => {
    const f = fixture();
    if (stage === 'put') f.put.mockImplementation(async () => { f.invalidate(); });
    else f.request.mockImplementation(async path => {
      if ((stage === 'prepare' && path.endsWith('/media')) || path.endsWith('/complete')) f.invalidate();
      return { id: media, uploadUrl: 'https://upload.example.invalid/signed' };
    });
    await expect(f.upload(room, file, 'file:///picked')).rejects.toThrow('OWNER_CHANGED');
    expect(f.request).toHaveBeenCalledTimes(stage === 'complete' ? 2 : 1);
    if (stage === 'prepare') expect(f.put).not.toHaveBeenCalled();
  });
  it('does not seal an upload cancelled while PUT is completing', async () => {
    const f = fixture(); const controller = new AbortController();
    f.put.mockImplementation(async () => { controller.abort(); });
    await expect(f.upload(room, file, 'file:///picked', controller.signal)).rejects.toThrow('UPLOAD_CANCELLED');
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it.each(['file:///private/file', 'http://upload.example.invalid/file', 'https://user:secret@upload.example.invalid/file'])('rejects an unsafe signed target %s', async uploadUrl => {
    const f = fixture(); f.request.mockResolvedValue({ id: media, uploadUrl });
    await expect(f.upload(room, file, 'file:///picked')).rejects.toThrow('INVALID_CHAT_URL');
    expect(f.put).not.toHaveBeenCalled();
  });
  it.each([0, -1, Number.NaN, 100 * 1024 * 1024 + 1])('rejects invalid or oversized bytes before prepare: %s', async size => {
    const f = fixture();
    await expect(f.upload(room, { ...file, size }, 'file:///picked')).rejects.toThrow(size > 0 ? 'ATTACHMENT_TOO_LARGE' : 'ATTACHMENT_UNAVAILABLE');
    expect(f.request).not.toHaveBeenCalled();
  });
  it('propagates revoked membership without uploading bytes', async () => {
    const f = fixture(); f.request.mockRejectedValue(Object.assign(new Error('NOT_MEMBER'), { status: 403 }));
    await expect(f.upload(room, file, 'file:///picked')).rejects.toMatchObject({ status: 403 });
    expect(f.put).not.toHaveBeenCalled();
  });
});
