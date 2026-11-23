import { execFile } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';

/**
 * macOS Local Network privacy for this app and every child it is responsible for.
 *
 * Apple exposes no status API. A denied app gets `EHOSTUNREACH` at once for any
 * LAN address, including the gateway, while public and VPN routes keep working
 * (see docs/dev-rules/remote-and-mobile-adaptation.md, "macOS「本地网络」权限").
 * Probing the gateway is therefore the observable truth; the same probe is also
 * what makes macOS show its one-time permission prompt for an undecided app.
 */
export type LocalNetworkAccess = 'granted' | 'denied' | 'unknown' | 'notRequired';

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
  openSettings(): Promise<void>;
  wait(ms: number): Promise<void>;
  now(): number;
}

// System Settings uses this pane's lowercase identifier; Privacy_LocalNetwork opens the overview.
export const MAC_LOCAL_NETWORK_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?privacy-localnetwork';

/** TCP/53 is open or actively refused on almost every home router; either proves reachability. */
const PROBE_PORT = 53;
const PROBE_TIMEOUT_MS = 1500;
/** Settings rows poll every 1.5 s; reuse one probe across overlapping readers. */
const CACHE_MS = 1000;
/** Time for an undecided app's system prompt to be answered before offering System Settings. */
const PROMPT_GRACE_MS = 1200;

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
  private requesting: Promise<LocalNetworkAccess> | null = null;
  private readonly listeners = new Set<(access: LocalNetworkAccess, previous: LocalNetworkAccess | null) => void>();
  private last: LocalNetworkAccess | null = null;

  constructor(private readonly deps: LocalNetworkAccessDeps) {}

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
   * Ask for access: the probe itself shows the system prompt when macOS has not
   * decided yet. If access is still missing afterwards, open the exact System
   * Settings pane, because macOS never prompts again once it has a decision.
   */
  request(): Promise<LocalNetworkAccess> {
    if (this.deps.platform !== 'darwin') return Promise.resolve('notRequired');
    if (this.requesting) return this.requesting;
    this.requesting = (async () => {
      const first = await this.read({ fresh: true });
      if (first !== 'denied') return first;
      await this.deps.wait(PROMPT_GRACE_MS);
      const second = await this.read({ fresh: true });
      if (second === 'denied') await this.deps.openSettings();
      return second;
    })().finally(() => {
      this.requesting = null;
    });
    return this.requesting;
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
