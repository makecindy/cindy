import { describe, expect, it, vi } from 'vitest';
import { stopMakeTestProcess } from '../testProcess';

describe('Make test process cleanup', () => {
  it.each(['darwin', 'linux'] as const)('stops the private PTY group on %s', (platform) => {
    const child = { pid: 4242, kill: vi.fn() };
    const kill = vi.fn<typeof process.kill>(() => true);
    stopMakeTestProcess(child, platform, kill);
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('lets node-pty close its Windows console tree', () => {
    const child = { pid: 4242, kill: vi.fn() };
    const kill = vi.fn<typeof process.kill>();
    stopMakeTestProcess(child, 'win32', kill);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(kill).not.toHaveBeenCalled();
  });

  it('falls back to the PTY process when the process group is missing', () => {
    const child = { pid: 4242, kill: vi.fn() };
    const kill = vi.fn<typeof process.kill>();
    kill.mockImplementationOnce(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    stopMakeTestProcess(child, 'darwin', kill);
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('falls back to the PTY process when signalling the group is denied', () => {
    const child = { pid: 4242, kill: vi.fn() };
    const kill = vi.fn<typeof process.kill>();
    kill.mockImplementationOnce(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' });
    });
    stopMakeTestProcess(child, 'darwin', kill);
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('surfaces a permission failure when both group and process stop fail', () => {
    const child = {
      pid: 4242,
      kill: vi.fn(() => {
        throw Object.assign(new Error('leaf-denied'), { code: 'EPERM' });
      }),
    };
    const kill = vi.fn<typeof process.kill>(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' });
    });
    expect(() => stopMakeTestProcess(child, 'darwin', kill)).toThrow('denied');
    expect(child.kill).toHaveBeenCalledOnce();
  });
});
