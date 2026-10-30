import { expect, it, vi } from 'vitest';
import { LinuxWindowActions } from '../linuxWindowActions';
import { RemoteDesktopController, type DesktopControllerDeps } from '../controller';
import { parseRemoteDesktopRequest, type RemoteDesktopLease } from '@cindy/device-link';

function fixture(lua = false) {
  let workspace = '1';
  const run = vi.fn(async (args: string[]) => {
    if (args[0] === 'eval' && args[1].startsWith('assert(')) return lua ? 'ok' : 'unavailable';
    if (args[0] === 'eval' && args[1].includes('{workspace=')) {
      if (/workspace="[0-9]+"/.test(args[1])) return 'warning: Bad workspace';
      const value = args[1]
        .match(/workspace=(?:"([A-Za-z0-9_.:-]+)"|([0-9]+))/)
        ?.slice(1)
        .find(Boolean);
      if (value) workspace = value.replace(/^name:/, '');
    }
    if (args[1] === 'clients')
      return JSON.stringify([
        { address: '0xabc', mapped: true, hidden: false, title: 'Editor', class: 'code' },
        { address: 'bad; exec', mapped: true, title: 'bad', class: 'bad' },
      ]);
    if (args[1] === 'monitors')
      return JSON.stringify([{ name: 'eDP-2', activeWorkspace: { id: 1, name: workspace } }]);
    if (args[1] === 'workspace') workspace = args[2].replace(/^name:/, '');
    return 'ok';
  });
  const openMenu = vi.fn(async () => {});
  const unlocked = vi.fn(async () => true);
  const windows = new LinuxWindowActions(
    run,
    async () => ({
      name: 'eDP-2',
      width: 800,
      height: 600,
      x: 0,
      y: 0,
      scale: 1,
      transform: 0,
      refreshRate: 60,
      availableModes: [],
    }),
    openMenu,
    unlocked,
  );
  return {
    windows,
    run,
    openMenu,
    unlocked,
    workspace: () => workspace,
    navigate: (next: string) => {
      workspace = next;
    },
  };
}
it('enumerates bounded windows and never dispatches a forged address', async () => {
  const h = fixture();
  expect(await h.windows.request('list', undefined, 'hyprland:eDP-2', () => true)).toEqual([
    { id: '0xabc', title: 'Editor', app: 'code' },
  ]);
  await expect(
    h.windows.request('activate', '0xdef', 'hyprland:eDP-2', () => true),
  ).rejects.toThrow();
  expect(h.run.mock.calls.some(([args]) => args[0] === 'dispatch')).toBe(false);
  await h.windows.request('activate', '0xabc', 'hyprland:eDP-2', () => true);
  expect(h.run).toHaveBeenLastCalledWith(['dispatch', 'focuswindow', 'address:0xabc']);
});
it('toggles an empty workspace and restores it on disconnect', async () => {
  const h = fixture();
  await h.windows.request('desktop', undefined, 'hyprland:eDP-2', () => true);
  expect(h.workspace()).toMatch(/^cindy-desktop-/);
  await h.windows.request('desktop', undefined, 'hyprland:eDP-2', () => true);
  expect(h.workspace()).toBe('1');
  await h.windows.request('desktop', undefined, 'hyprland:eDP-2', () => true);
  await h.windows.stop();
  expect(h.workspace()).toBe('1');
});
it('retries a lock-deferred restore after the compositor unlocks', async () => {
  const h = fixture();
  await h.windows.request('desktop', undefined, 'hyprland:eDP-2', () => true);
  h.unlocked.mockResolvedValue(false);
  await expect(h.windows.stop()).rejects.toThrow('DESKTOP_INPUT_UNAVAILABLE');
  expect(h.workspace()).toMatch(/^cindy-desktop-/);
  h.unlocked.mockResolvedValue(true);
  await h.windows.unlock();
  expect(h.workspace()).toBe('1');
});
it('does not restore an active desktop toggle merely because the host unlocks', async () => {
  const h = fixture();
  await h.windows.request('desktop', undefined, 'hyprland:eDP-2', () => true);
  await h.windows.unlock();
  expect(h.workspace()).toMatch(/^cindy-desktop-/);
  await h.windows.stop();
  expect(h.workspace()).toBe('1');
});
it('uses typed Lua dispatchers on current Omarchy without replaying actions', async () => {
  const h = fixture(true);
  await h.windows.request('desktop', undefined, 'hyprland:eDP-2', () => true);
  expect(h.workspace()).toMatch(/^cindy-desktop-/);
  await h.windows.stop();
  expect(h.workspace()).toBe('1');
  await h.windows.request('activate', '0xabc', 'hyprland:eDP-2', () => true);
  expect(h.run).toHaveBeenLastCalledWith([
    'eval',
    'hl.dispatch(hl.dsp.focus({window="address:0xabc"}))',
  ]);
  expect(h.run.mock.calls.some(([args]) => args[0] === 'dispatch')).toBe(false);
});
it('does not undo independent local navigation or execute queued work after stop', async () => {
  const h = fixture();
  await h.windows.request('desktop', undefined, 'hyprland:eDP-2', () => true);
  h.navigate('3');
  await h.windows.stop();
  expect(h.workspace()).toBe('3');
  const late = h.windows.request('desktop', undefined, 'hyprland:eDP-2', () => true);
  const stopped = h.windows.stop();
  await expect(late).rejects.toThrow('DESKTOP_LEASE_EXPIRED');
  await stopped;
  expect(h.workspace()).toBe('3');
});
it('requires the controlling lease and discards a list that arrives after revocation', async () => {
  const action = vi.fn(async () => []);
  const deps: DesktopControllerDeps = {
    authorized: () => true,
    capabilities: async () => ({
      version: 1,
      enabled: true,
      platform: 'linux',
      canControl: true,
      displays: [{ id: '1', name: 'Main', width: 800, height: 600 }],
    }),
    startInput: async () => {},
    input: () => {},
    stopInput: () => {},
    stopVideo: () => {},
    changed: () => {},
    frame: async () => null,
    offer: async () => 'answer',
    windowAction: action,
  };
  const controller = new RemoteDesktopController(deps);
  const { lease } = (await controller.request('phone', {
    op: 'start',
    displayId: '1',
  })) as RemoteDesktopLease;
  const request = { op: 'windowAction', action: 'list', lease };
  await expect(controller.request('phone', request)).rejects.toThrow('DESKTOP_VIEW_ONLY');
  expect(action).not.toHaveBeenCalled();
  await controller.request('phone', { op: 'control', lease, enabled: true });
  let resolve!: (value: never[]) => void;
  action.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = controller.request('phone', request);
  await controller.stop();
  resolve([]);
  await expect(pending).rejects.toThrow('DESKTOP_LEASE_EXPIRED');
});
it('strictly parses the additive host action without accepting arbitrary commands', () => {
  expect(parseRemoteDesktopRequest({ op: 'windowAction', action: 'desktop', lease: 'a' })).toEqual({
    op: 'windowAction',
    action: 'desktop',
    lease: 'a',
  });
  for (const action of ['exec', 'activate'])
    expect(() =>
      parseRemoteDesktopRequest({ op: 'windowAction', action, lease: 'a', id: ';exec' }),
    ).toThrow();
});

it.each([false, true])(
  'includes empty workspaces on the captured monitor without moving windows (Lua=%s)',
  async (lua) => {
    const h = fixture(lua);
    for (const [action, direction] of [
      ['workspaceLeft', 'r-1'],
      ['workspaceRight', 'r+1'],
    ] as const) {
      await h.windows.request(action, undefined, 'hyprland:eDP-2', () => true);
      expect(h.run).toHaveBeenLastCalledWith(
        lua
          ? ['eval', `hl.dispatch(hl.dsp.focus({workspace="${direction}"}))`]
          : ['dispatch', 'workspace', direction],
      );
      expect(h.run).toHaveBeenCalledWith(
        lua
          ? ['eval', 'hl.dispatch(hl.dsp.focus({monitor="eDP-2"}))']
          : ['dispatch', 'focusmonitor', 'eDP-2'],
      );
    }
    const calls = h.run.mock.calls.length;
    await h.windows.stop();
    expect(h.run).toHaveBeenCalledTimes(calls);
  },
);

it('opens the Omarchy menu only after focusing the selected monitor and while authorized', async () => {
  const h = fixture(true);
  await h.windows.request('omarchyMenu', undefined, 'hyprland:eDP-2', () => true);
  expect(h.run).toHaveBeenLastCalledWith(['eval', 'hl.dispatch(hl.dsp.focus({monitor="eDP-2"}))']);
  expect(h.openMenu).toHaveBeenCalledOnce();
  await expect(
    h.windows.request('omarchyMenu', undefined, 'hyprland:eDP-2', () => false),
  ).rejects.toThrow('DESKTOP_LEASE_EXPIRED');
  expect(h.openMenu).toHaveBeenCalledOnce();
});

it.each(['desktop', 'activate'] as const)(
  'cancels %s when control is revoked during syntax probing',
  async (action) => {
    const h = fixture(true);
    const original = h.run.getMockImplementation()!;
    let current = true;
    h.run.mockImplementation(async (args) => {
      const result = await original(args);
      if (args[0] === 'eval' && args[1].startsWith('assert(')) current = false;
      return result;
    });
    await expect(
      h.windows.request(action, '0xabc', 'hyprland:eDP-2', () => current),
    ).rejects.toThrow('DESKTOP_LEASE_EXPIRED');
    expect(
      h.run.mock.calls.some(
        ([args]) => args[0] === 'dispatch' || args[1]?.startsWith('hl.dispatch'),
      ),
    ).toBe(false);
  },
);

it.each(['workspaceLeft', 'workspaceRight', 'omarchyMenu'] as const)(
  'validates %s and cancels it when control is revoked during syntax probing',
  async (action) => {
    expect(parseRemoteDesktopRequest({ op: 'windowAction', action, lease: 'test' })).toEqual({
      op: 'windowAction',
      action,
      lease: 'test',
    });
    const h = fixture(true);
    let current = true;
    h.run.mockImplementationOnce(async () => {
      current = false;
      return 'ok';
    });
    await expect(
      h.windows.request(action, undefined, 'hyprland:eDP-2', () => current),
    ).rejects.toThrow('DESKTOP_LEASE_EXPIRED');
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.openMenu).not.toHaveBeenCalled();
  },
);

it.each(['list', 'activate', 'desktop', 'workspaceLeft', 'workspaceRight', 'omarchyMenu'] as const)(
  'refuses %s without reading titles or dispatching when locked',
  async (action) => {
    const h = fixture();
    h.unlocked.mockResolvedValue(false);
    await expect(h.windows.request(action, '0xabc', 'hyprland:eDP-2', () => true)).rejects.toThrow(
      'DESKTOP_INPUT_UNAVAILABLE',
    );
    expect(h.run).not.toHaveBeenCalled();
    expect(h.openMenu).not.toHaveBeenCalled();
  },
);
it('discards titles if the session locks while clients are read', async () => {
  const h = fixture();
  h.unlocked.mockResolvedValueOnce(true).mockResolvedValue(false);
  await expect(h.windows.request('list', undefined, 'hyprland:eDP-2', () => true)).rejects.toThrow(
    'DESKTOP_INPUT_UNAVAILABLE',
  );
});
it('does not dispatch after a syntax probe overlaps a local lock', async () => {
  const h = fixture();
  const run = h.run.getMockImplementation()!;
  h.run.mockImplementation(async (args) => {
    if (args[0] === 'eval') h.unlocked.mockResolvedValue(false);
    return run(args);
  });
  await expect(
    h.windows.request('activate', '0xabc', 'hyprland:eDP-2', () => true),
  ).rejects.toThrow('DESKTOP_INPUT_UNAVAILABLE');
  expect(h.run.mock.calls.some(([args]) => args[0] === 'dispatch')).toBe(false);
});
