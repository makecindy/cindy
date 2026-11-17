// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useRemoteMailImages } from '../useRemoteMailImages';

// #11099 review, unit: real hook output after an in-flight image list changes and after
// device switch/unmount. Existing mail tests never ran image IO. Separate file because the
// store tests use node; hook lifecycle needs jsdom. IPC is the production CSP-safe boundary.
afterEach(cleanup);
const image = (letter: string) => `cindy-media://blobs/${letter.repeat(64)}.png`;
it('reads through main and keeps required images when the list changes during IO', async () => {
  const reads: Array<(reply: { base64: string; mimeType: string }) => void> = [];
  const readImageBytes = vi.fn((_params: { url: string }) => new Promise<{ base64: string; mimeType: string }>(resolve => { reads.push(resolve); }));
  Object.assign(window, { electronAPI: { readImageBytes } });
  const a = image('a'); const b = image('b');
  const { result, rerender, unmount } = renderHook(({ device, urls }) => useRemoteMailImages(device, urls),
    { initialProps: { device: 'host', urls: [a] } });
  rerender({ device: 'host', urls: [a, b] });
  await act(async () => { reads[0]({ base64: 'b2xk', mimeType: 'image/png' }); });
  expect(result.current?.(a)).toBeUndefined();
  await act(async () => { reads[1]({ base64: 'bmV3', mimeType: 'image/png' }); reads[2]({ base64: 'Yg==', mimeType: 'image/png' }); });
  expect(result.current?.(a)).toBe('data:image/png;base64,bmV3');
  expect(result.current?.(b)).toBe('data:image/png;base64,Yg==');
  expect(readImageBytes.mock.calls[0][0]).toMatchObject({ url: expect.stringContaining('cindy-remote-media:') });
  rerender({ device: 'other', urls: [a] });
  expect(result.current?.(a)).toBeUndefined();
  unmount();
  await act(async () => { reads[3]({ base64: 'bGF0ZQ==', mimeType: 'image/png' }); });
});
