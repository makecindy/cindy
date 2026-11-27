import { describe, expect, it, vi } from 'vitest';

const ipc = vi.hoisted(() => ({ sendSync: vi.fn(), on: vi.fn() }));
vi.mock('electron', () => ({ ipcRenderer: ipc }));
import { createMicrophonePermissionSnapshot } from '../microphonePermissionSnapshot';

// KFJS unit regression: hover/press reads used to wait on Main every time.
// New preload-only module needs its own Electron mock; other voice tests cover
// OS permission policy, not the bridge's hot-read and revocation behavior.
describe('microphone permission snapshot', () => {
  it('bootstraps once, reads without IPC and accepts permission revocation', () => {
    ipc.sendSync.mockReturnValue({ ok: true, status: 'granted' });
    const read = createMicrophonePermissionSnapshot();
    expect(read()).toEqual({ ok: true, status: 'granted' });
    expect(read()).toEqual({ ok: true, status: 'granted' });
    expect(ipc.sendSync).toHaveBeenCalledTimes(1);
    const changed = ipc.on.mock.calls[0]![1];
    changed({}, { ok: false, status: 'denied', error: 'permission denied' });
    expect(read()).toEqual({ ok: false, status: 'denied', error: 'permission denied' });
    expect(ipc.sendSync).toHaveBeenCalledTimes(1);
  });
});
