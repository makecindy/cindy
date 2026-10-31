// New on the phone (群设置 → 本群头像): the same presign + signed PUT contract as Desktop's
// ossPublicUpload.ts. Unit tier through the production function; the phone had no public upload before.
import { expect, it, vi } from 'vitest';
import { uploadPublicAvatar } from '@/chat/publicAvatarUpload';

const file = { uri: 'file:///cache/avatar.jpg', size: 2048, mimeType: 'image/jpeg' as const };

it('puts the bytes with exactly the signed headers and returns the public URL only after the PUT', async () => {
  const order: string[] = [];
  const presign = vi.fn(async () => { order.push('presign'); return {
    putUrl: 'https://oss.example/put?sig=1', publicUrl: 'https://cdn.example/a.jpg', key: 'a.jpg',
    headers: { 'Content-Type': 'image/jpeg', 'x-oss-meta': 'v', ignored: 1 },
  }; });
  const put = vi.fn(async () => { order.push('put'); });
  await expect(uploadPublicAvatar({ presign, put, current: () => true }, file)).resolves.toBe('https://cdn.example/a.jpg');
  expect(presign).toHaveBeenCalledWith({ scene: 'avatar', contentType: 'image/jpeg', size: 2048 });
  expect(put).toHaveBeenCalledWith('https://oss.example/put?sig=1', file.uri, { 'Content-Type': 'image/jpeg', 'x-oss-meta': 'v' });
  expect(order).toEqual(['presign', 'put']);
});

it('rejects an unsigned or non-HTTPS answer and an account change before writing anything', async () => {
  const put = vi.fn();
  await expect(uploadPublicAvatar({ presign: async () => ({ putUrl: 'http://oss.example/put', publicUrl: 'https://cdn.example/a.jpg' }), put, current: () => true }, file))
    .rejects.toThrow('PROFILE_AVATAR_UPLOAD_FAILED');
  let live = true;
  await expect(uploadPublicAvatar({ presign: async () => { live = false; return { putUrl: 'https://oss.example/put', publicUrl: 'https://cdn.example/a.jpg' }; },
    put, current: () => live }, file)).rejects.toThrow('OWNER_CHANGED');
  expect(put).not.toHaveBeenCalled();
});
