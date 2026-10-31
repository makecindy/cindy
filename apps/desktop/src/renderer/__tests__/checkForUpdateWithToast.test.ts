// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkForUpdateWithToast } from '../lib/checkForUpdateWithToast';
import { toast } from '../lib/toast';

vi.mock('../lib/toast', () => ({ toast: {
  loading: vi.fn(() => 'checking'), update: vi.fn(), dismiss: vi.fn(),
  success: vi.fn(), warning: vi.fn(), error: vi.fn(),
} }));

let listener: (payload: UpdateStatusPayload) => void;
const unsubscribe = vi.fn();
const check = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  window.electronAPI = {
    checkForUpdate: check,
    onUpdateStatus: (callback: typeof listener) => { listener = callback; return unsubscribe; },
  } as unknown as Window['electronAPI'];
});

// #4458: the first check remains pending through the download; feedback must not wait for IPC.
describe('manual update feedback', () => {
  it('shows checking immediately, follows download before IPC resolves, and shares repeated clicks', async () => {
    let resolve!: (result: { result: string }) => void;
    check.mockImplementation(() => new Promise(r => { resolve = r; }));
    const pending = checkForUpdateWithToast(key => key);
    expect(toast.loading).toHaveBeenCalledWith('splash.tips.checkingUpdate');
    expect(checkForUpdateWithToast(key => key)).toBe(pending);
    expect(check).toHaveBeenCalledTimes(1);
    listener({ status: 'downloading', progress: 12 });
    listener({ status: 'downloading', progress: 45 });
    expect(toast.update).toHaveBeenCalledTimes(1);
    expect(toast.update).toHaveBeenCalledWith('checking', 'titleBar.updateCheckToast.downloading');
    expect(toast.dismiss).not.toHaveBeenCalled();
    resolve({ result: 'ready' });
    await pending;
    expect(toast.success).toHaveBeenCalledWith('titleBar.updateCheckToast.ready');
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(toast.dismiss).toHaveBeenCalledWith('checking');
  });

  it.each([
    ['idle', 'success', 'alreadyLatest'], ['downloading', 'warning', 'downloading'],
    ['manifest_failed', 'error', 'manifestFailed'], ['download_failed', 'error', 'downloadFailed'],
    ['manual_download', 'warning', 'manualDownload'],
  ] as const)('preserves the %s result', async (result, variant, key) => {
    check.mockResolvedValue({ result });
    await checkForUpdateWithToast(key => key);
    expect(toast[variant]).toHaveBeenCalledWith(`titleBar.updateCheckToast.${key}`);
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('cleans up a rejected IPC and allows retry', async () => {
    check.mockRejectedValueOnce(new Error('IPC failed')).mockResolvedValueOnce({ result: 'idle' });
    await checkForUpdateWithToast(key => key);
    expect(toast.error).toHaveBeenCalledWith('titleBar.updateCheckToast.manifestFailed');
    expect(toast.dismiss).toHaveBeenCalled();
    await checkForUpdateWithToast(key => key);
    expect(check).toHaveBeenCalledTimes(2);
  });
});
