import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export function supportsLinuxMute(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    for (const tool of ['pactl', 'pw-dump', 'pw-cli'])
      accessSync(`/usr/bin/${tool}`, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
interface Sink {
  id: number;
  serial: number;
  name: string;
  muted: boolean;
}
/** Mute playback only, leaving the monitor branch audible remotely. Object
 * serial protects against numeric ID reuse after unplug. Writes are serialized. */
export class LinuxDesktopMute {
  private original = new Map<string, Sink>();
  private tail: Promise<void> = Promise.resolve();
  private watchTimer: ReturnType<typeof setInterval> | undefined;
  private restoreTimer: ReturnType<typeof setTimeout> | undefined;
  private restoreAttempt = 0;
  private enabled = false;
  private key(sink: Sink): string {
    return `${sink.id}:${sink.serial}`;
  }
  constructor(
    private readonly run = async (tool: string, args: string[]) => {
      const { stdout } = await exec(`/usr/bin/${tool}`, args, {
        timeout: 2000,
        maxBuffer: 4 * 1024 * 1024,
      });
      return stdout;
    },
  ) {}
  private async sinks(): Promise<Sink[]> {
    const nodes: unknown = JSON.parse(await this.run('pw-dump', []));
    if (!Array.isArray(nodes) || nodes.length > 10000)
      throw new Error('DESKTOP_HOST_MUTE_UNAVAILABLE');
    return nodes.flatMap((node) => {
      const props = node?.info?.props;
      const params = node?.info?.params?.Props;
      const mute = Array.isArray(params)
        ? params.find((p) => typeof p?.softMute === 'boolean')
        : undefined;
      const serial = Number(props?.['object.serial']);
      return Number.isSafeInteger(node?.id) &&
        node.id > 0 &&
        Number.isSafeInteger(serial) &&
        serial > 0 &&
        props?.['media.class'] === 'Audio/Sink' &&
        typeof props['node.name'] === 'string' &&
        mute
        ? [{ id: node.id, serial, name: props['node.name'], muted: mute.softMute }]
        : [];
    });
  }
  private async apply(enabled: boolean): Promise<void> {
    const sinks = await this.sinks();
    if (enabled) {
      const name = (await this.run('pactl', ['get-default-sink'])).trim();
      const current = sinks.find((sink) => sink.name === name);
      if (!current) {
        if (this.original.size) return;
        throw new Error('DESKTOP_HOST_MUTE_UNAVAILABLE');
      }
      this.original.set(this.key(current), this.original.get(this.key(current)) ?? current);
      for (const sink of sinks) {
        if (!this.original.has(this.key(sink))) continue;
        await this.run('pw-cli', ['set-param', String(sink.id), 'Props', `{ softMute: true }`]);
      }
      return;
    }
    const present = new Set(sinks.map((sink) => this.key(sink)));
    for (const key of this.original.keys()) {
      if (!present.has(key)) this.original.delete(key);
    }
    for (const sink of sinks) {
      const saved = this.original.get(this.key(sink));
      if (!saved) continue;
      await this.run('pw-cli', [
        'set-param',
        String(sink.id),
        'Props',
        `{ softMute: ${saved.muted ? 'true' : 'false'} }`,
      ]);
      this.original.delete(this.key(sink));
    }
    // A missing exact id/serial is conclusively unplugged and must not be
    // applied to a replacement node.
    if (this.original.size === 0) this.restoreAttempt = 0;
  }
  private startWatch(): void {
    if (this.watchTimer) return;
    this.watchTimer = setInterval(() => {
      void this.enqueue(true, true).catch(() => {});
    }, 1000);
    this.watchTimer.unref?.();
  }
  private stopWatch(): void {
    clearInterval(this.watchTimer);
    this.watchTimer = undefined;
    clearTimeout(this.restoreTimer);
    this.restoreTimer = undefined;
    this.restoreAttempt = 0;
    this.original.clear();
  }
  private scheduleRestore(): void {
    if (this.enabled || this.restoreTimer || !this.original.size || this.restoreAttempt >= 5)
      return;
    const delay = [250, 500, 1000, 2000, 4000][this.restoreAttempt++];
    this.restoreTimer = setTimeout(() => {
      this.restoreTimer = undefined;
      void this.enqueue(false, true)
        .then(() => {
          if (this.original.size) this.scheduleRestore();
        })
        .catch(() => this.scheduleRestore());
    }, delay);
    this.restoreTimer.unref?.();
  }
  private enqueue(enabled: boolean, background = false): Promise<void> {
    const result = this.tail
      .then(async () => {
        if (background && enabled !== this.enabled) return;
        if (!enabled && !this.original.size) return;
        await this.apply(enabled);
      })
      .catch(() => {
        throw new Error('DESKTOP_HOST_MUTE_UNAVAILABLE');
      });
    this.tail = result.catch(() => {});
    return result;
  }
  set(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    clearTimeout(this.restoreTimer);
    this.restoreTimer = undefined;
    this.restoreAttempt = 0;
    if (enabled) {
      const result = this.enqueue(true);
      this.startWatch();
      return result;
    }
    clearInterval(this.watchTimer);
    this.watchTimer = undefined;
    const result = this.enqueue(false);
    void result.catch(() => this.scheduleRestore());
    return result;
  }
  stop(): void {
    this.enabled = false;
    this.stopWatch();
  }
}
