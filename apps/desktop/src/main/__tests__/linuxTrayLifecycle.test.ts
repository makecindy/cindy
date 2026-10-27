import { describe, expect, it, vi } from 'vitest';

import { createLinuxTrayController } from '../linuxTrayLifecycle';

function harness() {
  let destroyed = false;
  const tray = {
    isDestroyed: () => destroyed,
    destroy: vi.fn(() => {
      destroyed = true;
    }),
    setContextMenu: vi.fn(),
    on: vi.fn<(event: 'click', listener: () => void) => void>(),
  };
  const deps = {
    createTray: vi.fn(() => tray),
    buildMenu: vi.fn(() => ({ label: 'Show Cindy' })),
    showWindow: vi.fn(),
    onError: vi.fn(),
  };
  return { tray, deps, controller: createLinuxTrayController(deps) };
}

describe('Linux tray lifetime', () => {
  it('publishes a native menu and restores the window on activation', () => {
    const { tray, deps, controller } = harness();
    expect(controller.ensure()).toBe(true);
    expect(controller.ensure()).toBe(true);
    expect(deps.createTray).toHaveBeenCalledOnce();
    expect(tray.setContextMenu).toHaveBeenCalledWith({ label: 'Show Cindy' });
    const [event, activate] = tray.on.mock.calls[0];
    expect(event).toBe('click');
    activate();
    expect(deps.showWindow).toHaveBeenCalledOnce();
  });

  it('republishes localized menus without recreating the icon', () => {
    const { tray, deps, controller } = harness();
    controller.ensure();
    deps.buildMenu.mockReturnValue({ label: '显示 Cindy' });
    controller.refreshMenu();
    expect(tray.setContextMenu).toHaveBeenLastCalledWith({ label: '显示 Cindy' });
    expect(deps.createTray).toHaveBeenCalledOnce();
  });

  it('does not create a tray on language changes before startup or after disposal', () => {
    const { tray, deps, controller } = harness();
    controller.refreshMenu();
    expect(deps.createTray).not.toHaveBeenCalled();
    controller.ensure();
    controller.dispose();
    controller.dispose();
    controller.refreshMenu();
    expect(tray.destroy).toHaveBeenCalledOnce();
    expect(tray.setContextMenu).toHaveBeenCalledOnce();
  });

  it('cleans up a partially initialized icon and reports setup failure', () => {
    const { tray, deps, controller } = harness();
    const error = new Error('menu unavailable');
    tray.setContextMenu.mockImplementation(() => {
      throw error;
    });
    expect(controller.ensure()).toBe(false);
    expect(tray.destroy).toHaveBeenCalledOnce();
    expect(deps.onError).toHaveBeenCalledWith(error);
  });

  it('does not throw if the desktop cannot create a tray', () => {
    const { deps, controller } = harness();
    deps.createTray.mockImplementation(() => {
      throw new Error('no tray');
    });
    expect(controller.ensure()).toBe(false);
    expect(deps.onError).toHaveBeenCalledOnce();
  });

  it('reports refresh failure while preserving the existing icon', () => {
    const { tray, deps, controller } = harness();
    controller.ensure();
    deps.buildMenu.mockImplementation(() => {
      throw new Error('menu failure');
    });
    controller.refreshMenu();
    expect(deps.onError).toHaveBeenCalledOnce();
    expect(tray.destroy).not.toHaveBeenCalled();
  });
});
