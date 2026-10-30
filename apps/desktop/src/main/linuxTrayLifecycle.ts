/** Linux exposes its menu through StatusNotifierItem/DBus, not Windows right-click events. */
export interface LinuxTray<TMenu> {
  isDestroyed(): boolean;
  destroy(): void;
  setContextMenu(menu: TMenu): void;
  on(event: 'click', listener: () => void): unknown;
}

export interface LinuxTrayDependencies<TMenu> {
  createTray(): LinuxTray<TMenu>;
  buildMenu(): TMenu;
  showWindow(): void;
  onError(error: unknown): void;
}

/** Own one icon for the app lifetime; menu updates must be republished on Linux. */
export function createLinuxTrayController<TMenu>(deps: LinuxTrayDependencies<TMenu>) {
  let tray: LinuxTray<TMenu> | null = null;

  const dispose = (): void => {
    const previous = tray;
    tray = null;
    try {
      if (previous && !previous.isDestroyed()) previous.destroy();
    } catch (error) {
      deps.onError(error);
    }
  };

  return {
    ensure(): boolean {
      if (tray && !tray.isDestroyed()) return true;
      try {
        tray = deps.createTray();
        tray.setContextMenu(deps.buildMenu());
        tray.on('click', deps.showWindow);
        return true;
      } catch (error) {
        dispose();
        deps.onError(error);
        return false;
      }
    },
    refreshMenu(): void {
      if (!tray || tray.isDestroyed()) return;
      try {
        tray.setContextMenu(deps.buildMenu());
      } catch (error) {
        deps.onError(error);
      }
    },
    dispose,
  };
}
