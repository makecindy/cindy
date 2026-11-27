import { execFile } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import type {
  LocalNetworkAccess,
  LocalNetworkRequestOptions,
  LocalNetworkSettingsStage,
} from '../../shared/localNetwork';

export type { LocalNetworkAccess, LocalNetworkRequestOptions, LocalNetworkSettingsStage };

/**
 * macOS Local Network privacy for this app and every child it is responsible for.
 *
 * Apple exposes no status API. A denied app gets `EHOSTUNREACH` at once for any
 * LAN address, including the gateway, while public and VPN routes keep working
 * (see docs/dev-rules/remote-and-mobile-adaptation.md, "macOS「本地网络」权限").
 * Probing the gateway is therefore the observable truth; the same probe in the
 * foreground is also what makes macOS show its one-time permission prompt for an
 * undecided app (provided the main executable has a unique Mach-O LC_UUID).
 */

export type LocalNetworkConnectOutcome =
  | 'connected'
  | 'refused'
  | 'timeout'
  | 'hostUnreachable'
  | 'other';

export interface LocalNetworkAccessDeps {
  platform: NodeJS.Platform;
  /** IPv4 gateway of a physical LAN interface, or null when there is no LAN. */
  lanGateway(): Promise<string | null>;
  connect(host: string, port: number, timeoutMs: number): Promise<LocalNetworkConnectOutcome>;
  openSettings(separateWindow: boolean): Promise<void>;
  wait(ms: number): Promise<void>;
  now(): number;
}

// macOS 15/26 direct pane identifier; on macOS 27.3 Apple omitted a Local Network
// reveal key so System Settings opens the Privacy & Security overview.
export const MAC_LOCAL_NETWORK_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?privacy-localnetwork';

/** TCP/53 is open or actively refused on almost every home router; either proves reachability. */
const PROBE_PORT = 53;
const PROBE_TIMEOUT_MS = 1500;
/** Settings rows poll every 1.5 s; reuse one probe across overlapping readers. */
const CACHE_MS = 1000;
/** Brief settle window after triggering the OS prompt before returning to the UI. */
const PROMPT_SETTLE_MS = 1200;

/** Validate optional IPC request parameters from the renderer. */
export function parseLocalNetworkRequestOptions(value: unknown): LocalNetworkRequestOptions | null {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'openSettings' && key !== 'separateWindow')) return null;
  if (record.openSettings !== undefined && typeof record.openSettings !== 'boolean') return null;
  if (record.separateWindow !== undefined && typeof record.separateWindow !== 'boolean') return null;
  return {
    ...(record.openSettings !== undefined ? { openSettings: record.openSettings } : {}),
    ...(record.separateWindow !== undefined ? { separateWindow: record.separateWindow } : {}),
  };
}

export function classifyLocalNetworkProbe(
  outcome: LocalNetworkConnectOutcome | null,
): Exclude<LocalNetworkAccess, 'notRequired'> {
  if (outcome === null) return 'unknown';
  if (outcome === 'hostUnreachable') return 'denied';
  // A refusal or a silent drop still crossed the LAN; only the privacy filter fails instantly.
  if (outcome === 'connected' || outcome === 'refused' || outcome === 'timeout') return 'granted';
  return 'unknown';
}

export class LocalNetworkAccessService {
  private reading: Promise<LocalNetworkAccess> | null = null;
  private cached: { value: LocalNetworkAccess; at: number } | null = null;
  private promptRequesting: Promise<LocalNetworkAccess> | null = null;
  private settingsRequesting: Promise<LocalNetworkAccess> | null = null;
  private readonly listeners = new Set<(access: LocalNetworkAccess, previous: LocalNetworkAccess | null) => void>();
  private last: LocalNetworkAccess | null = null;
  private settingsStage: LocalNetworkSettingsStage = 'none';

  constructor(private readonly deps: LocalNetworkAccessDeps) {}

  get settingsOpenStage(): LocalNetworkSettingsStage {
    return this.settingsStage;
  }

  /** Current access. Reads never open System Settings. */
  read(options: { fresh?: boolean } = {}): Promise<LocalNetworkAccess> {
    if (this.deps.platform !== 'darwin') return Promise.resolve('notRequired');
    const cached = this.cached;
    if (!options.fresh && cached && this.deps.now() - cached.at < CACHE_MS) {
      return Promise.resolve(cached.value);
    }
    if (this.reading) return this.reading;
    this.reading = this.probe()
      .then((value) => {
        this.cached = { value, at: this.deps.now() };
        this.publish(value);
        return value;
      })
      .finally(() => {
        this.reading = null;
      });
    return this.reading;
  }

  /**
   * Ask for access or open System Settings.
   *
   * Default (`openSettings` omitted/false): probes in the foreground so macOS can
   * present its one-time Allow/Don't Allow alert, without yanking focus away to
   * System Settings while the user is still reading the alert.
   *
   * Explicit (`openSettings: true`): opens System Settings only when the user asks
   * for it (for example when macOS already recorded a denial and will not prompt
   * again). Tracked separately from prompt probes so clicking "Open System Settings"
   * in one surface is never swallowed by an in-flight prompt settle wait from another.
   * A second open uses a separate System Settings window (`open -n`), falling back
   * to the standard window if macOS refuses another instance.
   */
  request(options: LocalNetworkRequestOptions = {}): Promise<LocalNetworkAccess> {
    if (this.deps.platform !== 'darwin') return Promise.resolve('notRequired');
    if (options.openSettings) {
      if (this.settingsRequesting) return this.settingsRequesting;
      const run = (async () => {
        const current = await this.read({ fresh: true });
        if (current !== 'denied') return current;
        const useSeparate = options.separateWindow === true || this.settingsStage === 'standard';
        if (useSeparate) {
          this.settingsStage = 'separate';
          try {
            await this.deps.openSettings(true);
          } catch {
            if (this.last === 'denied') await this.deps.openSettings(false);
          }
        } else {
          this.settingsStage = 'standard';
          await this.deps.openSettings(false);
        }
        return current;
      })().finally(() => {
        if (this.settingsRequesting === run) this.settingsRequesting = null;
      });
      this.settingsRequesting = run;
      return run;
    }
    if (this.settingsRequesting) return this.settingsRequesting;
    if (this.promptRequesting) return this.promptRequesting;
    const run = (async () => {
      const first = await this.read({ fresh: true });
      if (first !== 'denied') return first;
      await this.deps.wait(PROMPT_SETTLE_MS);
      return this.read({ fresh: true });
    })().finally(() => {
      if (this.promptRequesting === run) this.promptRequesting = null;
    });
    this.promptRequesting = run;
    return run;
  }

  /** Called on every observed change, including the first reading. */
  onChange(listener: (access: LocalNetworkAccess, previous: LocalNetworkAccess | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async probe(): Promise<LocalNetworkAccess> {
    let gateway: string | null = null;
    try {
      gateway = await this.deps.lanGateway();
    } catch {
      gateway = null;
    }
    if (!gateway) return 'unknown';
    const outcome = await this.deps
      .connect(gateway, PROBE_PORT, PROBE_TIMEOUT_MS)
      .catch(() => 'other' as const);
    return classifyLocalNetworkProbe(outcome);
  }

  private publish(value: LocalNetworkAccess): void {
    if (value !== 'denied') this.settingsStage = 'none';
    const previous = this.last;
    if (previous === value) return;
    this.last = value;
    for (const listener of this.listeners) {
      try {
        listener(value, previous);
      } catch {
        /* A listener must not break the probe. */
      }
    }
  }
}

const TUNNEL_INTERFACE = /^(utun|ipsec|ppp|tun|tap|gif|stf)\d*$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export function parseRouteGateway(output: string): { gateway: string; iface: string } | null {
  const gateway = /^\s*gateway:\s*(\S+)\s*$/m.exec(output)?.[1];
  const iface = /^\s*interface:\s*(\S+)\s*$/m.exec(output)?.[1];
  if (!gateway || !iface || !IPV4.test(gateway)) return null;
  return { gateway, iface };
}

function runRoute(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('/sbin/route', ['-n', 'get', ...args, 'default'], { timeout: 1000 }, (error, stdout) => {
      resolve(error ? '' : String(stdout));
    });
  });
}

/**
 * The default route may belong to a VPN; Local Network privacy only concerns
 * physical LAN interfaces, so fall back to the gateway scoped to one of them.
 */
export async function readMacLanGateway(
  route: (args: string[]) => Promise<string> = runRoute,
  interfaces: () => NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces,
): Promise<string | null> {
  const primary = parseRouteGateway(await route([]));
  if (primary && !TUNNEL_INTERFACE.test(primary.iface)) return primary.gateway;
  const physical = Object.entries(interfaces())
    .filter(([name, entries]) =>
      !TUNNEL_INTERFACE.test(name)
      && (entries ?? []).some((entry) => entry.family === 'IPv4' && !entry.internal))
    .map(([name]) => name);
  for (const name of physical) {
    const scoped = parseRouteGateway(await route(['-ifscope', name]));
    if (scoped && scoped.iface === name) return scoped.gateway;
  }
  return null;
}

export function connectProbe(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<LocalNetworkConnectOutcome> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (outcome: LocalNetworkConnectOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    socket.once('connect', () => finish('connected'));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EHOSTUNREACH') finish('hostUnreachable');
      else if (error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET') finish('refused');
      else if (error.code === 'ETIMEDOUT' || error.code === 'EHOSTDOWN') finish('timeout');
      else finish('other');
    });
  });
}
