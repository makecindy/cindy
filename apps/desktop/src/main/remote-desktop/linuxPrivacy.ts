import { app, nativeTheme } from 'electron';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { t } from '../i18n';

const exec = promisify(execFile);
async function run(args: string[]): Promise<string> {
  const { stdout } = await exec('/usr/bin/hyprctl', args, { timeout: 3000, maxBuffer: 16384 });
  return stdout.trim();
}
async function version() {
  const value = JSON.parse(await run(['-j', 'version']));
  if (value.version !== '0.56.2' || !/^[a-f0-9]{40}$/.test(value.commit) || value.dirty)
    throw new Error('DESKTOP_PRIVACY_UNAVAILABLE');
  return value;
}
export async function supportsLinuxPrivacy(): Promise<boolean> {
  if (process.platform !== 'linux' || !process.env.HYPRLAND_INSTANCE_SIGNATURE) return false;
  try {
    const current = await version();
    if (app.isPackaged) {
      const meta = JSON.parse(
        await fs.readFile(
          path.join(
            process.resourcesPath,
            'tools',
            'remote-desktop',
            'cindy-hyprland-privacy.json',
          ),
          'utf8',
        ),
      );
      return meta.hash === current.commit;
    }
    const header = await fs.readFile('/usr/include/hyprland/src/version.h', 'utf8');
    return header.includes(`"${current.commit}"`);
  } catch {
    return false;
  }
}
export async function prepareLinuxPrivacy(
  currentOwner: () => boolean,
  allowLoad = false,
): Promise<void> {
  const current = await version();
  const source = path.join(app.getAppPath(), 'native', 'remote-desktop', 'hyprland-privacy');
  let directory = path.join(process.resourcesPath, 'tools', 'remote-desktop');
  if (!app.isPackaged) {
    const hash = createHash('sha256').update(current.abiHash).update(process.arch);
    for (const file of ['main.cpp', 'gate.hpp', 'build.mjs'])
      hash.update(await fs.readFile(path.join(source, file)));
    for (const file of ['illustration.webp', 'wordmark.png', 'wordmark-light.png'])
      hash.update(
        await fs.readFile(path.join(source, '../../../src/renderer/assets/splash', file)),
      );
    directory = path.join(app.getPath('userData'), 'remote-desktop', 'native', hash.digest('hex'));
    try {
      await fs.access(path.join(directory, 'cindy-hyprland-privacy.json'));
    } catch {
      await exec('node', [path.join(source, 'build.mjs'), directory], {
        timeout: 120000,
        maxBuffer: 64000,
      });
    }
  }
  const meta = JSON.parse(
    await fs.readFile(path.join(directory, 'cindy-hyprland-privacy.json'), 'utf8'),
  );
  if (meta.hash !== current.commit) throw new Error('DESKTOP_PRIVACY_UNAVAILABLE');
  // Hyprland reloads configuration after plugin load/unload. Install only
  // before a lease exists, never while a temporary viewer layout is active.
  const identity = `ready:${meta.source}`;
  const existing = await run(['cindy-privacy', '{"op":"probe"}']).catch(() => '');
  if (!currentOwner()) throw new Error('DESKTOP_LEASE_EXPIRED');
  if (existing !== identity && !allowLoad) throw new Error('DESKTOP_PRIVACY_UNAVAILABLE');
  if (existing.startsWith('ready:') && existing !== identity) {
    // The old plugin atomically refuses retirement while owned and refuses new
    // owners after retirement. Never unload another connection's active mask.
    const retired = await run(['cindy-privacy', '{"op":"retire"}']);
    if (!path.isAbsolute(retired) || !retired.endsWith('/cindy-hyprland-privacy.so'))
      throw new Error('DESKTOP_PRIVACY_UNAVAILABLE');
    await run(['plugin', 'unload', retired]);
  }
  if (existing !== identity) {
    if (!currentOwner()) throw new Error('DESKTOP_LEASE_EXPIRED');
    await run(['plugin', 'load', path.join(directory, 'cindy-hyprland-privacy.so')]);
  }
  const deadline = Date.now() + 3000;
  let state = await run(['cindy-privacy', '{"op":"probe"}']);
  while (state === `loading:${meta.source}` && Date.now() < deadline && currentOwner()) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    state = await run(['cindy-privacy', '{"op":"probe"}']);
  }
  if (state !== identity || !currentOwner()) throw new Error('DESKTOP_PRIVACY_UNAVAILABLE');
}
interface Runtime {
  prepare(): Promise<void>;
  call(request: Record<string, unknown>): Promise<string>;
  labels(): string[];
}
const runtime: Runtime = {
  prepare: () => prepareLinuxPrivacy(() => true),
  call: (request) => run(['cindy-privacy', JSON.stringify(request)]),
  labels: () =>
    ['status', 'hint', 'title', 'detail', 'cancel', 'disconnect'].map((key) =>
      t(`privacyExit.${key}`),
    ),
};

/** The compositor owns masking/input exclusion and a six-second owner watchdog.
 * This adapter reuses the controller's lease and input-pause lifecycle. It never
 * creates a second viewer, changes system config or handles passwords. */
export class LinuxPrivacyScreen {
  private generation = 0;
  private token: string | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private resume?: () => Promise<void>;
  private pausing?: Promise<() => Promise<void>>;
  private cleanup: Promise<unknown> = Promise.resolve();
  get active(): boolean {
    return this.token !== null;
  }
  constructor(
    private readonly stopped: () => void | Promise<void>,
    private readonly suspendInput: () => Promise<() => Promise<void>>,
    private readonly native: Runtime = runtime,
  ) {}
  async set(enabled: boolean, current: () => boolean): Promise<void> {
    if (!enabled) {
      const resuming = this.pausing ?? Promise.resolve(this.resume);
      this.stop();
      await this.cleanup;
      const resume = await resuming;
      if (current()) await resume?.();
      return;
    }
    if (this.token && current()) return;
    const generation = ++this.generation;
    const valid = () => generation === this.generation && current();
    await this.cleanup;
    await this.native.prepare();
    if (!valid()) throw new Error('DESKTOP_LEASE_EXPIRED');
    const token = randomBytes(16).toString('hex');
    this.token = token;
    try {
      let state = await this.native.call({
        op: 'start',
        token,
        labels: this.native.labels(),
        dark: nativeTheme.shouldUseDarkColors,
      });
      // Do not acknowledge privacy until each powered display has rendered its
      // first mask. A disconnected/stalled output fails the toggle closed.
      const deadline = Date.now() + 2000;
      while (state === 'starting' && valid() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        state = await this.native.call({ op: 'ping', token });
      }
      if (!valid()) throw new Error('DESKTOP_LEASE_EXPIRED');
      if (state !== 'active') throw new Error('DESKTOP_PRIVACY_UNAVAILABLE');
      this.schedule(generation, current);
    } catch (error) {
      if (this.token === token) this.stop();
      else {
        // A stop may have reached the compositor before this late start. Retire
        // the old owner again after its reply, without touching a replacement.
        this.cleanup = this.native.call({ op: 'stop', token }).catch(() => {});
        await this.cleanup;
      }
      throw error;
    }
  }
  private schedule(generation: number, current: () => boolean): void {
    this.timer = setTimeout(() => {
      void this.poll(generation, current);
    }, 250);
    this.timer.unref();
  }
  private async poll(generation: number, current: () => boolean): Promise<void> {
    const token = this.token;
    const valid = () =>
      !!token && this.token === token && generation === this.generation && current();
    if (!valid()) {
      if (generation === this.generation) this.stop();
      return;
    }
    try {
      const state = await this.native.call({ op: 'ping', token });
      if (!valid()) return;
      if (state === 'pending') {
        const pausing = this.suspendInput();
        this.pausing = pausing;
        const resume = await pausing;
        if (this.pausing === pausing) this.pausing = undefined;
        if (!valid()) return;
        this.resume = resume;
        if ((await this.native.call({ op: 'confirm', token })) !== 'confirming')
          throw new Error('DESKTOP_PRIVACY_UNAVAILABLE');
      } else if (state === 'resume') {
        await this.resume?.();
        if (!valid()) return;
        this.resume = undefined;
        if ((await this.native.call({ op: 'resume', token })) !== 'active')
          throw new Error('DESKTOP_PRIVACY_UNAVAILABLE');
      } else if (state === 'disconnect') {
        await this.finish(generation);
        return;
      } else if (state !== 'active' && state !== 'confirming')
        throw new Error('DESKTOP_PRIVACY_UNAVAILABLE');
      if (valid()) this.schedule(generation, current);
    } catch {
      if (valid()) await this.finish(generation);
    }
  }
  private async finish(generation: number): Promise<void> {
    try {
      await this.stopped();
    } catch {
      /* Native watchdog also releases the mask. */
    } finally {
      if (generation === this.generation) this.stop();
    }
  }
  stop(): void {
    this.generation++;
    clearTimeout(this.timer);
    this.resume = undefined;
    this.pausing = undefined;
    const token = this.token;
    this.token = null;
    if (token) this.cleanup = this.native.call({ op: 'stop', token }).catch(() => {});
  }
}
