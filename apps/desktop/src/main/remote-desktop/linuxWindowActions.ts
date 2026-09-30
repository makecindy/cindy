import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { promisify } from 'node:util';
import type { RemoteDesktopWindow } from '@cindy/device-link';
import { linuxMonitor } from './linuxDesktop';
import { isLinuxDesktopUnlocked } from './linuxSessionLock';

const exec = promisify(execFile);
export function supportsOmarchyMenu(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    accessSync('/usr/bin/omarchy', constants.X_OK);
    accessSync('/usr/bin/omarchy-menu', constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
async function openOmarchyMenu(): Promise<void> {
  if (!supportsOmarchyMenu()) throw new Error('DESKTOP_INPUT_UNSUPPORTED');
  await exec('/usr/bin/omarchy', ['menu', 'toggle'], { timeout: 2000, maxBuffer: 16384 });
}
const invoke = async (args: string[]): Promise<string> => {
  const { stdout } = await exec('/usr/bin/hyprctl', args, { timeout: 2000, maxBuffer: 512000 });
  return stdout.trim();
};
type Monitor = { name: string; activeWorkspace: { id: number; name: string } };
/** Host actions never depend on the user's key bindings. A temporary empty
 * workspace preserves window positions; only our still-selected workspace is
 * restored, so local navigation is never undone on disconnect. */
export class LinuxWindowActions {
  private tail: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private restorePending = false;
  private lua?: boolean;
  private desktop?: { monitor: string; original: number; temporary: string };
  constructor(
    private readonly run = invoke,
    private readonly monitor = linuxMonitor,
    private readonly openMenu = openOmarchyMenu,
    private readonly unlocked = isLinuxDesktopUnlocked,
  ) {}
  private async requireUnlocked(): Promise<void> {
    if (!(await this.unlocked())) throw new Error('DESKTOP_INPUT_UNAVAILABLE');
  }
  private async clients(): Promise<RemoteDesktopWindow[]> {
    const value: unknown = JSON.parse(await this.run(['-j', 'clients']));
    if (!Array.isArray(value) || value.length > 2048) throw new Error('DESKTOP_INPUT_UNAVAILABLE');
    return value
      .filter(
        (w) =>
          w?.mapped &&
          !w.hidden &&
          /^0x[a-f0-9]{1,16}$/.test(w.address) &&
          typeof w.title === 'string' &&
          typeof w.class === 'string',
      )
      .slice(0, 256)
      .map((w) => ({ id: w.address, title: w.title.slice(0, 256), app: w.class.slice(0, 128) }));
  }
  private async dispatch(
    name: 'focuswindow' | 'focusmonitor' | 'workspace',
    value: string,
    check: () => Promise<void> = () => this.requireUnlocked(),
  ): Promise<void> {
    // Hyprland 0.55+ uses typed Lua dispatchers. Probe syntax without changing
    // configuration; never retry an already-issued action with another syntax.
    this.lua ??= await this.run(['eval', 'assert(type(hl.dsp.focus) == "function")']).then(
      (value) => value === 'ok',
      () => false,
    );
    await check();
    const field = { focuswindow: 'window', focusmonitor: 'monitor', workspace: 'workspace' }[name];
    if (!field || !/^[A-Za-z0-9_.:+-]{1,128}$/.test(value))
      throw new Error('DESKTOP_INPUT_UNAVAILABLE');
    const luaValue =
      name === 'workspace' && /^[1-9][0-9]*$/.test(value) ? value : JSON.stringify(value);
    const args = this.lua
      ? ['eval', `hl.dispatch(hl.dsp.focus({${field}=${luaValue}}))`]
      : ['dispatch', name, value];
    if ((await this.run(args)) !== 'ok') throw new Error('DESKTOP_INPUT_UNAVAILABLE');
  }
  async request(
    action: 'list' | 'activate' | 'desktop' | 'workspaceLeft' | 'workspaceRight' | 'omarchyMenu',
    id: string | undefined,
    displayId: string,
    current: () => boolean,
  ): Promise<RemoteDesktopWindow[] | null> {
    const generation = this.generation;
    const check = async () => {
      if (generation !== this.generation || !current()) throw new Error('DESKTOP_LEASE_EXPIRED');
      await this.requireUnlocked();
      if (generation !== this.generation || !current()) throw new Error('DESKTOP_LEASE_EXPIRED');
    };
    const operation = this.tail
      .catch(() => {})
      .then(async () => {
        await check();
        if (action === 'list') {
          const windows = await this.clients();
          await check();
          return windows;
        }
        if (action === 'activate') {
          const windows = await this.clients();
          await check();
          if (!windows.some((window) => window.id === id))
            throw new Error('DESKTOP_INPUT_UNAVAILABLE');
          await this.restore(check);
          await check();
          await this.dispatch('focuswindow', `address:${id}`, check);
          await check();
          return null;
        }
        if (action === 'workspaceLeft' || action === 'workspaceRight' || action === 'omarchyMenu') {
          await this.restore(check);
          await check();
          const selected = await this.monitor(displayId);
          await check();
          await this.dispatch('focusmonitor', selected.name, check);
          await check();
          if (action === 'omarchyMenu') await this.openMenu();
          // r includes empty workspaces on this monitor; m skips them.
          else await this.dispatch('workspace', action === 'workspaceLeft' ? 'r-1' : 'r+1', check);
          await check();
          return null;
        }
        if (this.desktop) {
          await this.restore(check);
          await check();
          return null;
        }
        const selected = await this.monitor(displayId);
        await check();
        const monitors: Monitor[] = JSON.parse(await this.run(['-j', 'monitors']));
        await check();
        const target = monitors.find((m) => m.name === selected.name);
        if (
          !target ||
          !Number.isSafeInteger(target.activeWorkspace?.id) ||
          target.activeWorkspace.id <= 0
        )
          throw new Error('DESKTOP_INPUT_UNAVAILABLE');
        this.desktop = {
          monitor: target.name,
          original: target.activeWorkspace.id,
          temporary: `cindy-desktop-${randomBytes(8).toString('hex')}`,
        };
        await this.dispatch('focusmonitor', target.name, check);
        await check();
        await this.dispatch('workspace', `name:${this.desktop.temporary}`, check);
        await check();
        return null;
      });
    this.tail = operation;
    return operation;
  }
  private async restore(check: () => Promise<void> = () => this.requireUnlocked()): Promise<void> {
    const saved = this.desktop;
    if (!saved) return;
    const monitors: Monitor[] = JSON.parse(await this.run(['-j', 'monitors']));
    await check();
    const selected = monitors.find((m) => m.name === saved.monitor);
    if (selected?.activeWorkspace.name === saved.temporary) {
      await this.dispatch('focusmonitor', saved.monitor, check);
      await this.dispatch('workspace', String(saved.original), check);
    }
    this.desktop = undefined;
    this.restorePending = false;
  }
  stop(): Promise<void> {
    this.generation++;
    this.restorePending = true;
    const stopped = this.tail.catch(() => {}).then(() => this.restore());
    this.tail = stopped;
    return stopped;
  }
  /** Retry a lock-deferred workspace restore after the compositor unlocks. */
  unlock(): Promise<void> {
    const restored = this.tail
      .catch(() => {})
      .then(() => {
        if (this.restorePending) return this.restore();
      });
    this.tail = restored;
    return restored;
  }
}
