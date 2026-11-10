// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invokeOpenPath } from '../../preload/openPath';
import { shouldOpenTextLightbox } from '../lib/filePreview';

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
    const result = await window.electronAPI.openPath('report.pdf');
    expect(result).toEqual({ success: false, error: message, ...(!visible ? { failureKind: 'ipc_lifecycle' } : {}) });
  });

  it('routes PDF to the in-app preview without invoking the system app', async () => {
    vi.stubGlobal('electronAPI', {
      openPath: vi.fn().mockResolvedValue({ success: false, error: 'No application associated' }),
    });
    expect(await shouldOpenTextLightbox('report.pdf')).toBe(true);
    expect(window.electronAPI.openPath).not.toHaveBeenCalled();
    const systemError = { success: false, error: 'No application associated' };
    expect(await invokeOpenPath(vi.fn().mockResolvedValue(systemError), 'report.pdf')).toEqual(systemError);
  });
});
