import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('node:util', () => ({ promisify: () => h.exec }));
vi.mock('node:fs', () => ({ accessSync: vi.fn(), constants: { X_OK: 1 } }));
vi.mock('../linuxSessionLock', () => ({ isLinuxDesktopUnlocked: async () => true }));
vi.mock('../linuxDesktop', () => ({ linuxMonitor: async () => ({ name: 'eDP-2' }) }));
import { LinuxWindowActions } from '../linuxWindowActions';

beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
  h.exec.mockReset();
});
afterEach(() => vi.restoreAllMocks());

it('lets Omarchy own menu visibility so the second press closes it', async () => {
  let visible = false;
  h.exec.mockImplementation(async (program, args) => {
    if (program === '/usr/bin/omarchy') {
      expect(args).toEqual(['menu', 'toggle']);
      visible = !visible;
    }
    return { stdout: 'ok' };
  });
  const windows = new LinuxWindowActions();
  await windows.request('omarchyMenu', undefined, 'hyprland:eDP-2', () => true);
  expect(visible).toBe(true);
  await windows.request('omarchyMenu', undefined, 'hyprland:eDP-2', () => true);
  expect(visible).toBe(false);
  // The same command also works when the menu was opened locally.
  visible = true;
  await windows.request('omarchyMenu', undefined, 'hyprland:eDP-2', () => true);
  expect(visible).toBe(false);
});
