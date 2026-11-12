import { expect, it, vi } from 'vitest';
import { preparePluginAttachmentResult } from '../pluginAttachment';

// Unit: production result adapter + real Response streams, memory-only storage.
// Existing file-grant tests sign View URLs, but do not import composer results.
// Minimal failure: an arbitrary returned path, or a delayed response after revoke.
it('preserves pass results and imports only owned links using host metadata', async () => {
  const stage = vi.fn(async () => ({ path: '/cache/converted.txt.bin' }));
  const access = { describe: vi.fn(async (_instance: string, uri: string) => uri === 'handoff:own'
    ? { size: 5, mimeType: 'text/plain' } : null), read: vi.fn(async () => new Response('hello')) };
  const ports = { access, stage, cleanup: vi.fn(), assertCurrent: async () => {}, signal: new AbortController().signal };
  expect(await preparePluginAttachmentResult('example', { structuredContent: { handled: false } }, ports)).toEqual({ handled: false });
  expect(stage).not.toHaveBeenCalled();
  const output = await preparePluginAttachmentResult('example', { structuredContent: { handled: true, text: 'Extracted', files: [
    { type: 'resource_link', uri: 'handoff:own', name: 'converted.txt', size: 999, mimeType: 'image/png' },
  ] } }, ports);
  expect(output).toEqual({ handled: true, text: 'Extracted', files: [{ name: 'converted.txt', path: '/cache/converted.txt.bin', size: 5, mimeType: 'text/plain' }] });
  expect(stage).toHaveBeenCalledWith('converted.txt', Buffer.from('hello'), 'text/plain');
  for (const uri of ['/etc/private', 'https://example.invalid/data', 'library:other']) {
    await expect(preparePluginAttachmentResult('example', { structuredContent: { handled: true,
      files: [{ type: 'resource_link', uri, name: 'file.txt' }] } }, ports)).rejects.toThrow();
  }
});

it('does not stage a result after the source is revoked while reading', async () => {
  let current = true;
  const stage = vi.fn();
  const access = { describe: async () => ({ size: 1, mimeType: 'text/plain' }),
    read: async () => { current = false; return new Response('x'); } };
  await expect(preparePluginAttachmentResult('example', { structuredContent: { handled: true,
    files: [{ type: 'resource_link', uri: 'library:one.txt', name: 'one.txt' }] } }, {
    access, stage, cleanup: vi.fn(), assertCurrent: async () => { if (!current) throw new Error('revoked'); },
    signal: new AbortController().signal,
  })).rejects.toThrow('revoked');
  expect(stage).not.toHaveBeenCalled();
});
