import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reclaimLoopbackPort } from '../portReclaim.js';

// Unit: real reclaim entry with synthetic OS command responses; no socket or real
// termination. Contract: show the process, confirm, then recheck its identity.
// The resource tests cover address parsing but did not exercise consent or PID replacement.
const h = vi.hoisted(() => ({ exec: vi.fn(), generation: 0 }));
vi.mock('node:util', async original => ({ ...await original<typeof import('node:util')>(), promisify: () => h.exec }));
const pid = process.pid + 10_000;
afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(process, 'kill').mockReturnValue(true);
  h.generation = 0;
  h.exec.mockReset().mockImplementation(async (file: string) => {
    if (file === 'lsof') return { stdout: `p${pid}\nn127.0.0.1:53682\n` };
    if (file === 'netstat') return { stdout: ` TCP 127.0.0.1:53682 0.0.0.0:0 LISTENING ${pid}\n` };
    if (file === 'ps') return { stdout: `Mon Nov  2 12:00:0${h.generation} 2026 /fixture/mock-program\n` };
    if (file === 'powershell.exe') return { stdout: JSON.stringify({ Name: 'mock-program', CreationDate: String(h.generation) }) };
    return { stdout: '' };
  });
});
const terminated = () => process.platform === 'win32'
  ? h.exec.mock.calls.some(([file]) => file === 'taskkill') : vi.mocked(process.kill).mock.calls.length > 0;

describe('port reclaim consent', () => {
  it('does not terminate a process without an explicit confirmation handler', async () => {
    expect(await reclaimLoopbackPort(53682)).toBe(false);
    expect(terminated()).toBe(false);
  });
  it('shows the process and leaves it running when the owner declines', async () => {
    const confirm = vi.fn(async () => false);
    expect(await reclaimLoopbackPort(53682, undefined, confirm)).toBe(false);
    expect(confirm).toHaveBeenCalledWith([expect.objectContaining({ pid, name: 'mock-program' })]);
    expect(terminated()).toBe(false);
  });
  it('terminates only after approval and a matching second identity probe', async () => {
    expect(await reclaimLoopbackPort(53682, undefined, async () => true)).toBe(true);
    expect(terminated()).toBe(true);
  });
  it('does not terminate a replacement process after an old confirmation', async () => {
    expect(await reclaimLoopbackPort(53682, undefined, async () => { h.generation++; return true; })).toBe(false);
    expect(terminated()).toBe(false);
  });
});
