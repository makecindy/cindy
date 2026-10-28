import type { HudPointerRegion } from '../../shared/hud';

/** Owns native click routing and its toggle shortcut for the entire HUD lifetime. */
export function createHudPassThroughController(deps: {
  shouldIgnore(region: HudPointerRegion): boolean;
  ignore(value: boolean): void;
  registerShortcut(callback: () => void): boolean;
  unregisterShortcut(): void;
  recoverFocus(): void;
  changed(): void;
}) {
  let active = false;
  let registered = false;
  let suspended = false;
  let generation = 0;
  let enabled = false;
  let ignored = false;
  let region: HudPointerRegion = 'controls';
  const sync = () => {
    const next = active && enabled && !suspended && deps.shouldIgnore(region);
    if (next === ignored) return;
    deps.ignore(next);
    ignored = next;
  };
  const register = (): boolean => {
    if (suspended) return false;
    if (registered) return true;
    const token = ++generation;
    try {
      registered = deps.registerShortcut(() => {
        if (!active || suspended || token !== generation) return;
        const recovering = enabled;
        setEnabled(!enabled);
        if (recovering) deps.recoverFocus();
      });
    } catch {
      registered = false;
    }
    return registered;
  };
  const setEnabled = (next: boolean) => {
    if (next === enabled) return;
    if (next && !active) throw new Error('HUD_INACTIVE');
    if (next && !register()) throw new Error('HUD_SHORTCUT_UNAVAILABLE');
    enabled = next;
    // Keep the latest region so a keyboard toggle works without moving the mouse.
    sync();
    deps.changed();
  };
  return {
    isEnabled: () => enabled,
    refreshShortcut() {
      generation++;
      if (registered) deps.unregisterShortcut();
      registered = false;
      if (active && !suspended && !register()) setEnabled(false);
      sync();
    },
    suspendShortcut(value: boolean) {
      suspended = value;
      this.refreshShortcut();
    },
    activate() {
      active = true;
      region = 'controls';
      register();
    },
    deactivate() {
      active = false;
      generation++;
      setEnabled(false);
      if (registered) deps.unregisterShortcut();
      registered = false;
      region = 'controls';
    },
    setEnabled,
    sync,
    setRegion(next: HudPointerRegion) {
      region = next;
      sync();
    },
  };
}
