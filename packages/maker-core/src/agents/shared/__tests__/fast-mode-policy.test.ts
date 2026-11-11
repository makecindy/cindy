import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionHandle } from '../../base-agent.js';
import { withFastModePolicy } from '../fast-mode-policy.js';

// Protects live subscription speed enforcement through the production handle:
// stale enables must not reach the engine, and failed native updates cannot admit a new message.
function fixture() {
  let allowed = true;
  let listener: (() => Promise<void>) | undefined;
  let fast: boolean | 'ultrafast' = true;
  const native = {
    setFastMode: vi.fn(async (value: boolean | 'ultrafast') => {
      fast = value;
    }),
    getFastMode: () => fast,
    send: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const off = vi.fn();
  const changed = vi.fn();
  const handle = withFastModePolicy(native as unknown as AgentSessionHandle, {
    isAllowed: () => allowed,
    onFastModeChanged: changed,
    subscribe: (callback) => {
      listener = callback;
      return off;
    },
  });
  return {
    handle,
    native,
    off,
    changed,
    change: async (value: boolean) => {
      allowed = value;
      await listener!();
    },
  };
}

describe('host subscription Fast policy', () => {
  it('downgrades an active handle without a new message and blocks stale Fast/Ultrafast enables', async () => {
    const f = fixture();
    await f.change(false);
    expect(f.native.getFastMode()).toBe(false);
    expect(f.changed).toHaveBeenLastCalledWith(false);
    await f.handle.setFastMode!(true);
    await f.handle.setFastMode!('ultrafast');
    expect(f.native.setFastMode.mock.calls).toEqual([[false], [false], [false]]);
    await f.change(true);
    expect(f.native.getFastMode()).toBe(false);
    await f.handle.setFastMode!(true);
    expect(f.changed).toHaveBeenLastCalledWith(true);
    await f.handle.close();
    expect(f.off).toHaveBeenCalledOnce();
  });

  it('rechecks queued enables after a policy change', async () => {
    const f = fixture();
    const enable = f.handle.setFastMode!('ultrafast');
    const prohibit = f.change(false);
    await Promise.all([enable, prohibit]);
    expect(f.native.setFastMode.mock.calls.every(([value]) => value === false)).toBe(true);
  });

  it('does not send another message when the native standard-mode update fails', async () => {
    const f = fixture();
    f.native.setFastMode.mockRejectedValue(new Error('native settings unavailable'));
    await expect(f.change(false)).rejects.toThrow('native settings unavailable');
    expect(f.changed).toHaveBeenLastCalledWith(false);
    await expect(f.handle.send({ type: 'user', content: 'hello' })).rejects.toThrow(
      'native settings unavailable',
    );
    expect(f.native.send).not.toHaveBeenCalled();
  });

  it('preserves unrelated providers without a host policy', () => {
    const native = {} as AgentSessionHandle;
    expect(withFastModePolicy(native)).toBe(native);
  });

  it('reports a suppressed turn as standard until an explicit enable succeeds', async () => {
    let suppressed = true;
    const native = {
      getFastMode: () => true,
      setFastMode: vi.fn(async () => {}),
    } as unknown as AgentSessionHandle;
    const handle = withFastModePolicy(native, {
      isAllowed: () => true,
      isRequestAllowed: () => !suppressed,
      onFastModeChanged: (enabled) => {
        suppressed = !enabled;
      },
      subscribe: () => () => {},
    });
    expect(handle.getFastMode!()).toBe(false);
    await handle.setFastMode!(true);
    expect(handle.getFastMode!()).toBe(true);
  });
});
