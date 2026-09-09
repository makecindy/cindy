import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopCaptureSource, enumerateDesktopSources } from '../captureSource';

afterEach(() => vi.useRealTimers());
it.each([2000, 5000])('bounds enumeration at %s ms and ignores late completion', async (timeout) => {
  vi.useFakeTimers();
  let resolve!: (value: string[]) => void;
  const result = enumerateDesktopSources(() => new Promise<string[]>(yes => { resolve = yes; }), timeout);
  const rejection = expect(result).rejects.toThrow('DESKTOP_VIDEO_TIMEOUT');
  await vi.advanceTimersByTimeAsync(timeout);
  await rejection;
  resolve(['old']);
  await expect(enumerateDesktopSources(async () => ['new'], timeout)).resolves.toEqual(['new']);
  expect(vi.getTimerCount()).toBe(0);
});
it('cleans enumeration timers on success and rejection', async () => {
  vi.useFakeTimers();
  await expect(enumerateDesktopSources(async () => [], 5000)).resolves.toEqual([]);
  await expect(enumerateDesktopSources(async () => { throw new Error('capture failed'); }, 5000)).rejects.toThrow('capture failed');
  expect(vi.getTimerCount()).toBe(0);
});

describe('desktop capture availability', () => {
  it('waits for the same attached display when capture temporarily omits it', () => {
    const displays = [{ id: 1 }, { id: 2 }];
    const other = { display_id: '2', id: 'screen:2:0' };
    const selected = { display_id: '1', id: 'screen:1:0' };
    expect(desktopCaptureSource([], '1', displays)).toBeNull();
    expect(desktopCaptureSource([other], '1', displays)).toBeNull();
    expect(desktopCaptureSource([other, selected], '1', displays)).toBe(selected);
  });
  it('still rejects a detached display and does not infer undocumented IDs', () => {
    expect(() => desktopCaptureSource([{ display_id: '1' }], '1', [])).toThrow('DESKTOP_DISPLAY_MISSING');
    expect(desktopCaptureSource([{ display_id: '', id: 'screen:1:0' }], '1', [{ id: 1 }])).toBeNull();
  });
});
