import { describe, expect, it, vi } from 'vitest';
import type { HostSnapshot } from '@cindy/maker-remote-ssh';
import { confirmHostKeyChange } from '../host-key-recovery.js';

function fixture() {
  let snapshot: Pick<HostSnapshot, 'status' | 'hostKeyMismatch'> = {
    status: 'failed',
    hostKeyMismatch: { host: 'server:22', trusted: 'SHA256:old', presented: 'SHA256:new' },
  };
  const host = { snapshot: () => snapshot };
  const options = {
    getHost: vi.fn(() => host),
    store: { replace: vi.fn(async (_key: string, _old: string, _new: string, current: () => boolean) => {
      if (!current()) throw new Error('stale');
    }) },
    confirm: vi.fn(async () => true),
    isWindowAlive: vi.fn(() => true),
  };
  return { options, setSnapshot: (value: typeof snapshot) => { snapshot = value; } };
}

describe('host key recovery confirmation', () => {
  it('replaces exactly the pair displayed in the confirmation', async () => {
    const { options } = fixture();
    await expect(confirmHostKeyChange(options)).resolves.toBe(true);
    expect(options.confirm).toHaveBeenCalledWith({ host: 'server:22', trusted: 'SHA256:old', presented: 'SHA256:new' });
    expect(options.store.replace).toHaveBeenCalledWith('server:22', 'SHA256:old', 'SHA256:new', expect.any(Function));
  });

  it('does not modify trust when the user cancels', async () => {
    const { options } = fixture();
    options.confirm.mockResolvedValue(false);
    await expect(confirmHostKeyChange(options)).resolves.toBe(false);
    expect(options.store.replace).not.toHaveBeenCalled();
  });

  it('does not offer trust changes for a generic connection failure', async () => {
    const { options, setSnapshot } = fixture();
    setSnapshot({ status: 'failed' });
    await expect(confirmHostKeyChange(options)).rejects.toThrow();
    expect(options.confirm).not.toHaveBeenCalled();
    expect(options.store.replace).not.toHaveBeenCalled();
  });

  it.each(['connecting', 'changed-key', 'changed-endpoint', 'removed-host', 'closed-window'])('rejects %s while the confirmation is open', async (change) => {
    const { options, setSnapshot } = fixture();
    options.confirm.mockImplementation(async () => {
      if (change === 'closed-window') options.isWindowAlive.mockReturnValue(false);
      else if (change === 'removed-host') options.getHost.mockReturnValue({ snapshot: () => ({ status: 'failed' }) });
      else if (change === 'connecting') setSnapshot({ status: 'connecting' });
      else setSnapshot({ status: 'failed', hostKeyMismatch: {
        host: change === 'changed-endpoint' ? 'other:22' : 'server:22',
        trusted: 'SHA256:old', presented: change === 'changed-key' ? 'SHA256:third' : 'SHA256:new',
      } });
      return true;
    });
    await expect(confirmHostKeyChange(options)).rejects.toThrow('stale');
  });
});
