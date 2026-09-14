// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invokeOpenPath } from '../../preload/openPath';
import { shouldOpenTextLightbox } from '../lib/filePreview';
import { toast } from '../lib/toast';

vi.mock('../lib/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('../lib/remoteFileOpen', () => ({ openRemoteChatFile: vi.fn() }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('opening a non-text file from chat', () => {
  it.each([
    ['reply was never sent', false],
    ['Render frame was disposed before WebFrameMain could be accessed', false],
    ["No handler registered for 'shell:open-path'", true],
    ['Permission denied', true],
  ])('handles invoke rejection %s', async (message, visible) => {
    const invoke = vi.fn().mockRejectedValue(new Error(message));
    vi.stubGlobal('electronAPI', undefined);
    window.electronAPI = {
      openPath: (target: string) => invokeOpenPath(invoke, target),
    } as typeof window.electronAPI;
    expect(await shouldOpenTextLightbox('report.pdf')).toBe(false);
    expect(toast.error).toHaveBeenCalledTimes(visible ? 1 : 0);
    if (visible) expect(toast.error).toHaveBeenCalledWith(message);
  });

  it('still shows an ordinary system error returned by main', async () => {
    vi.stubGlobal('electronAPI', {
      openPath: vi.fn().mockResolvedValue({ success: false, error: 'No application associated' }),
    });
    await shouldOpenTextLightbox('report.pdf');
    expect(toast.error).toHaveBeenCalledWith('No application associated');
  });
});
