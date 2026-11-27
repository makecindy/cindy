/**
 * Lightweight best-effort router port mapping (NAT-PMP RFC 6886 with UPnP IGD v1/v2 fallback).
 *
 * Home and SOHO routers frequently support NAT-PMP or UPnP IGD. Requesting an explicit UDP mapping
 * for the local Agent-Net socket opens a stable external `publicIP:port` candidate even behind
 * address/port-restricted NATs or short router UDP timeouts.
 *
 * Design invariants:
 * - Zero external dependencies (pure Node `dgram`, `http`, `net`, `os`, `child_process`).
 * - Completely non-blocking and bounded in time: never stalls transport startup or candidate flow.
 * - Strict SSRF boundary: UPnP SSDP replies must originate from the discovered default gateway IP,
 *   and both `LOCATION` and `controlURL` must be plain `http:` on that exact gateway IP (same `host:port`
 *   for `controlURL`, no embedded credentials).
 * - All timers are `.unref()`'d and mappings are serialized per session and released best-effort on
 *   port/gateway change or close.
 */
import dgram from 'node:dgram';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isIPv4 } from 'node:net';
import os from 'node:os';
import type { Address } from '@cindy/agent-net-core/node';

export type PortMapProtocol = 'nat-pmp' | 'upnp';

export interface PortMappingResult {
  address: string;
  port: number;
  lifetimeSec: number;
  protocol: PortMapProtocol;
}

export interface PortMapGateway {
  gatewayIp: string;
  localIp: string;
}

export interface PortMapDeps {
  discoverGateway?: () => Promise<PortMapGateway | null>;
  tryNatPmp?: (gatewayIp: string, internalPort: number, lifetimeSec: number) => Promise<PortMappingResult | null>;
  releaseNatPmp?: (gatewayIp: string, internalPort: number) => Promise<void>;
  tryUpnp?: (gateway: PortMapGateway, internalPort: number, lifetimeSec: number) => Promise<UpnpMappingHandle | null>;
}

export interface UpnpMappingHandle {
  result: PortMappingResult;
  release: () => Promise<void>;
}

const NAT_PMP_PORT = 5351;
const NAT_PMP_VERSION = 0;
const NAT_PMP_OP_EXTERNAL_ADDR = 0;
const NAT_PMP_OP_MAP_UDP = 1;
const NAT_PMP_ATTEMPT_TIMEOUT_MS = 350;
const NAT_PMP_ATTEMPTS = 2;

const SSDP_MULTICAST = '239.255.255.250';
const SSDP_PORT = 1900;
const SSDP_TIMEOUT_MS = 800;
const UPNP_HTTP_TIMEOUT_MS = 1_200;
const UPNP_MAX_BODY_BYTES = 64 * 1024;

const DEFAULT_LIFETIME_SEC = 3_600;
const MIN_RENEW_MS = 500;
const MAX_RENEW_MS = 30 * 60_000;
const INITIAL_RETRY_MS = 15_000;
const MAX_RETRY_MS = 30 * 60_000;

export function computePortMapRenewDelayMs(lifetimeSec: number): number {
  const safeLifetimeSec = Number.isFinite(lifetimeSec) && lifetimeSec > 0 ? lifetimeSec : 1;
  return Math.min(MAX_RENEW_MS, Math.max(MIN_RENEW_MS, Math.floor(safeLifetimeSec * 500)));
}

export function isPrivateIpv4(address: string): boolean {
  if (!isIPv4(address)) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b < 32)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254);
}

/** Strict LAN IPv4 check (RFC 1918 + CGNAT, excludes loopback and link-local). */
export function isLanGatewayIpv4(address: string): boolean {
  if (!isIPv4(address)) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b < 128);
}

// ─── NAT-PMP (RFC 6886) wire codecs ─────────────────────────────────────────

export function buildNatPmpExternalAddressRequest(): Buffer {
  return Buffer.from([NAT_PMP_VERSION, NAT_PMP_OP_EXTERNAL_ADDR]);
}

export function parseNatPmpExternalAddressResponse(packet: Buffer): string | null {
  if (packet.length < 12) return null;
  if (packet[0] !== NAT_PMP_VERSION || packet[1] !== (128 | NAT_PMP_OP_EXTERNAL_ADDR)) return null;
  if (packet.readUInt16BE(2) !== 0) return null;
  const ip = `${packet[8]}.${packet[9]}.${packet[10]}.${packet[11]}`;
  return isIPv4(ip) && !isPrivateIpv4(ip) && ip !== '0.0.0.0' ? ip : null;
}

export function buildNatPmpMapRequest(internalPort: number, externalPort: number, lifetimeSec: number): Buffer {
  const buf = Buffer.alloc(12);
  buf[0] = NAT_PMP_VERSION;
  buf[1] = NAT_PMP_OP_MAP_UDP;
  buf.writeUInt16BE(0, 2);
  buf.writeUInt16BE(internalPort, 4);
  buf.writeUInt16BE(externalPort, 6);
  buf.writeUInt32BE(lifetimeSec, 8);
  return buf;
}

export function parseNatPmpMapResponse(packet: Buffer, expectedInternalPort: number): { externalPort: number; lifetimeSec: number } | null {
  if (packet.length < 16) return null;
  if (packet[0] !== NAT_PMP_VERSION || packet[1] !== (128 | NAT_PMP_OP_MAP_UDP)) return null;
  if (packet.readUInt16BE(2) !== 0) return null;
  const internalPort = packet.readUInt16BE(8);
  const externalPort = packet.readUInt16BE(10);
  const lifetimeSec = packet.readUInt32BE(12);
  if (internalPort !== expectedInternalPort || externalPort < 1 || externalPort > 65_535) return null;
  return { externalPort, lifetimeSec };
}

async function natPmpExchange(gatewayIp: string, request: Buffer): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let attempt = 0;
    const finish = (value: Buffer | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      try { socket.close(); } catch { /* ignore */ }
      resolve(value);
    };
    socket.on('error', () => finish(null));
    socket.on('message', (msg, rinfo) => {
      if (rinfo.address !== gatewayIp || rinfo.port !== NAT_PMP_PORT) return;
      finish(Buffer.from(msg));
    });
    const sendAttempt = () => {
      if (settled) return;
      attempt += 1;
      try {
        socket.send(request, NAT_PMP_PORT, gatewayIp, (err) => {
          if (err) finish(null);
        });
      } catch {
        finish(null);
        return;
      }
      timer = setTimeout(() => {
        if (attempt < NAT_PMP_ATTEMPTS) sendAttempt();
        else finish(null);
      }, NAT_PMP_ATTEMPT_TIMEOUT_MS * attempt);
      timer.unref();
    };
    socket.bind(0, () => sendAttempt());
  });
}

async function defaultTryNatPmp(gatewayIp: string, internalPort: number, lifetimeSec: number): Promise<PortMappingResult | null> {
  if (!isLanGatewayIpv4(gatewayIp)) return null;
  const addrReply = await natPmpExchange(gatewayIp, buildNatPmpExternalAddressRequest());
  const externalIp = addrReply ? parseNatPmpExternalAddressResponse(addrReply) : null;
  if (!externalIp) return null;
  const mapReply = await natPmpExchange(gatewayIp, buildNatPmpMapRequest(internalPort, internalPort, lifetimeSec));
  const mapped = mapReply ? parseNatPmpMapResponse(mapReply, internalPort) : null;
  if (!mapped || mapped.lifetimeSec <= 0) return null;
  return { address: externalIp, port: mapped.externalPort, lifetimeSec: mapped.lifetimeSec, protocol: 'nat-pmp' };
}

async function defaultReleaseNatPmp(gatewayIp: string, internalPort: number): Promise<void> {
  if (!isLanGatewayIpv4(gatewayIp)) return;
  await new Promise<void>((resolve) => {
    const socket = dgram.createSocket('udp4');
    const done = () => { try { socket.close(); } catch { /* ignore */ } resolve(); };
    socket.on('error', done);
    socket.bind(0, () => {
      try { socket.send(buildNatPmpMapRequest(internalPort, 0, 0), NAT_PMP_PORT, gatewayIp, done); }
      catch { done(); }
    });
  });
}

// ─── UPnP IGD (SSDP + SOAP) fallback ────────────────────────────────────────

const UPNP_SERVICE_TYPES = [
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];

export function parseSsdpLocation(response: string, expectedGatewayIp: string): string | null {
  if (!isLanGatewayIpv4(expectedGatewayIp)) return null;
  const match = response.match(/^location\s*:\s*(\S+)/im);
  if (!match) return null;
  try {
    const parsed = new URL(match[1].trim());
    if (
      parsed.protocol !== 'http:'
      || parsed.username
      || parsed.password
      || parsed.hostname !== expectedGatewayIp
    ) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export function parseUpnpControlEndpoint(xml: string, locationUrl: string): { controlUrl: string; serviceType: string } | null {
  let base: URL;
  try { base = new URL(locationUrl); } catch { return null; }
  if (base.protocol !== 'http:' || base.username || base.password || !isLanGatewayIpv4(base.hostname)) return null;
  const serviceBlocks = xml.match(/<service\b[^>]*>[\s\S]*?<\/service>/gi) ?? [];
  for (const preferred of UPNP_SERVICE_TYPES) {
    for (const block of serviceBlocks) {
      const typeMatch = block.match(/<serviceType>([^<]+)<\/serviceType>/i);
      if (!typeMatch || typeMatch[1].trim() !== preferred) continue;
      const urlMatch = block.match(/<controlURL>([^<]+)<\/controlURL>/i);
      if (!urlMatch) continue;
      try {
        const resolved = new URL(urlMatch[1].trim(), base);
        if (resolved.protocol !== 'http:' || resolved.username || resolved.password || resolved.host !== base.host) continue;
        return { controlUrl: resolved.toString(), serviceType: preferred };
      } catch {
        continue;
      }
    }
  }
  return null;
}

export function parseUpnpExternalIp(xml: string): string | null {
  const match = xml.match(/<NewExternalIPAddress>([^<]+)<\/NewExternalIPAddress>/i);
  const ip = match?.[1]?.trim() ?? '';
  return isIPv4(ip) && !isPrivateIpv4(ip) && ip !== '0.0.0.0' ? ip : null;
}

async function discoverUpnpLocation(gatewayIp: string): Promise<string | null> {
  if (!isLanGatewayIpv4(gatewayIp)) return null;
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      try { socket.close(); } catch { /* ignore */ }
      resolve(value);
    };
    socket.on('error', () => finish(null));
    socket.on('message', (msg, rinfo) => {
      if (rinfo.address !== gatewayIp) return;
      const location = parseSsdpLocation(msg.toString('utf8'), gatewayIp);
      if (location) finish(location);
    });
    socket.bind(0, () => {
      const probes = [
        'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
        'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
      ];
      for (const st of probes) {
        const payload = Buffer.from(
          `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_MULTICAST}:${SSDP_PORT}\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: ${st}\r\n\r\n`,
          'utf8',
        );
        try { socket.send(payload, SSDP_PORT, SSDP_MULTICAST); } catch { /* ignore */ }
        try { socket.send(payload, SSDP_PORT, gatewayIp); } catch { /* ignore */ }
      }
      timer = setTimeout(() => finish(null), SSDP_TIMEOUT_MS);
      timer.unref();
    });
  });
}

function httpRequest(
  url: string,
  options: { method: 'GET' | 'POST'; expectedHost: string; headers?: Record<string, string>; body?: string; timeoutMs?: number },
): Promise<{ status: number; body: string } | null> {
  return new Promise((resolve) => {
    let parsed: URL;
    try { parsed = new URL(url); } catch { resolve(null); return; }
    if (
      parsed.protocol !== 'http:'
      || parsed.username
      || parsed.password
      || !isLanGatewayIpv4(parsed.hostname)
      || parsed.hostname !== options.expectedHost
    ) {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (value: { status: number; body: string } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: `${parsed.pathname}${parsed.search}`,
      method: options.method,
      headers: options.headers,
      agent: false,
    }, (res) => {
      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > UPNP_MAX_BODY_BYTES) { res.destroy(); finish(null); return; }
        chunks.push(chunk);
      });
      res.on('end', () => finish({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => finish(null));
    });
    const timer = setTimeout(() => { req.destroy(); finish(null); }, options.timeoutMs ?? UPNP_HTTP_TIMEOUT_MS);
    timer.unref();
    req.on('error', () => finish(null));
    if (options.body) req.write(options.body);
    req.end();
  });
}

function soapCall(
  controlUrl: string,
  serviceType: string,
  action: string,
  innerXml: string,
  expectedHost: string,
  timeoutMs = UPNP_HTTP_TIMEOUT_MS,
): Promise<{ status: number; body: string } | null> {
  const body = `<?xml version="1.0"?>\r\n`
    + `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">`
    + `<s:Body><u:${action} xmlns:u="${serviceType}">${innerXml}</u:${action}></s:Body></s:Envelope>`;
  return httpRequest(controlUrl, {
    method: 'POST',
    expectedHost,
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      'Content-Length': String(Buffer.byteLength(body)),
      SOAPACTION: `"${serviceType}#${action}"`,
    },
    body,
    timeoutMs,
  });
}

async function defaultTryUpnp(gateway: PortMapGateway, internalPort: number, lifetimeSec: number): Promise<UpnpMappingHandle | null> {
  if (!isLanGatewayIpv4(gateway.gatewayIp) || !isLanGatewayIpv4(gateway.localIp)) return null;
  const location = await discoverUpnpLocation(gateway.gatewayIp);
  if (!location) return null;
  const desc = await httpRequest(location, { method: 'GET', expectedHost: gateway.gatewayIp });
  if (!desc || desc.status !== 200) return null;
  const endpoint = parseUpnpControlEndpoint(desc.body, location);
  if (!endpoint) return null;
  const extRes = await soapCall(endpoint.controlUrl, endpoint.serviceType, 'GetExternalIPAddress', '', gateway.gatewayIp);
  const externalIp = extRes && extRes.status === 200 ? parseUpnpExternalIp(extRes.body) : null;
  if (!externalIp) return null;
  const addBody = `<NewRemoteHost></NewRemoteHost>`
    + `<NewExternalPort>${internalPort}</NewExternalPort>`
    + `<NewProtocol>UDP</NewProtocol>`
    + `<NewInternalPort>${internalPort}</NewInternalPort>`
    + `<NewInternalClient>${gateway.localIp}</NewInternalClient>`
    + `<NewEnabled>1</NewEnabled>`
    + `<NewPortMappingDescription>Cindy Agent-Net</NewPortMappingDescription>`
    + `<NewLeaseDuration>${lifetimeSec}</NewLeaseDuration>`;
  const addRes = await soapCall(endpoint.controlUrl, endpoint.serviceType, 'AddPortMapping', addBody, gateway.gatewayIp);
  if (!addRes || addRes.status !== 200) return null;
  const result: PortMappingResult = { address: externalIp, port: internalPort, lifetimeSec, protocol: 'upnp' };
  return {
    result,
    release: async () => {
      const delBody = `<NewRemoteHost></NewRemoteHost><NewExternalPort>${internalPort}</NewExternalPort><NewProtocol>UDP</NewProtocol>`;
      await soapCall(endpoint.controlUrl, endpoint.serviceType, 'DeletePortMapping', delBody, gateway.gatewayIp, 500).catch(() => undefined);
    },
  };
}

// ─── Default gateway discovery ──────────────────────────────────────────────

function execText(file: string, args: string[], timeoutMs = 1_000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 }, (err, stdout) => {
      resolve(err ? null : String(stdout));
    });
  });
}

function localIpv4ForInterface(ifname?: string): string | null {
  const ifaces = os.networkInterfaces();
  if (ifname && ifaces[ifname]) {
    for (const entry of ifaces[ifname] ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && isLanGatewayIpv4(entry.address)) return entry.address;
    }
  }
  for (const entries of Object.values(ifaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && isLanGatewayIpv4(entry.address)) return entry.address;
    }
  }
  return null;
}

export function parseDarwinRouteOutput(output: string): { gatewayIp: string; interfaceName?: string } | null {
  const gw = output.match(/^\s*gateway:\s*(\d+\.\d+\.\d+\.\d+)\s*$/m)?.[1];
  if (!gw || !isLanGatewayIpv4(gw)) return null;
  const iface = output.match(/^\s*interface:\s*(\S+)\s*$/m)?.[1];
  return { gatewayIp: gw, interfaceName: iface };
}

export function parseLinuxProcRoute(content: string): { gatewayIp: string; interfaceName?: string } | null {
  for (const line of content.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 3 || cols[1] !== '00000000') continue;
    const hex = cols[2];
    if (!/^[0-9a-fA-F]{8}$/.test(hex)) continue;
    const num = parseInt(hex, 16);
    const gw = `${num & 255}.${(num >>> 8) & 255}.${(num >>> 16) & 255}.${(num >>> 24) & 255}`;
    if (isLanGatewayIpv4(gw)) return { gatewayIp: gw, interfaceName: cols[0] };
  }
  return null;
}

async function defaultDiscoverGateway(): Promise<PortMapGateway | null> {
  if (process.platform === 'darwin') {
    const out = await execText('/sbin/route', ['-n', 'get', 'default']);
    const parsed = out ? parseDarwinRouteOutput(out) : null;
    if (!parsed) return null;
    const localIp = localIpv4ForInterface(parsed.interfaceName);
    return localIp ? { gatewayIp: parsed.gatewayIp, localIp } : null;
  }
  if (process.platform === 'linux') {
    const content = await readFile('/proc/net/route', 'utf8').catch(() => null);
    const parsed = content ? parseLinuxProcRoute(content) : null;
    if (!parsed) return null;
    const localIp = localIpv4ForInterface(parsed.interfaceName);
    return localIp ? { gatewayIp: parsed.gatewayIp, localIp } : null;
  }
  if (process.platform === 'win32') {
    const out = await execText('route', ['print', '0.0.0.0']);
    const match = out?.match(/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)/m);
    if (!match || !isLanGatewayIpv4(match[1]) || !isLanGatewayIpv4(match[2])) return null;
    return { gatewayIp: match[1], localIp: match[2] };
  }
  return null;
}

// ─── Managed port mapping lifecycle ─────────────────────────────────────────

export interface PortMapSession {
  refresh(internalPort: number): void;
  current(): PortMappingResult | null;
  close(): Promise<void>;
}

interface ActivePortMapping {
  result: PortMappingResult;
  gatewayIp: string;
  localIp: string;
  internalPort: number;
  expiresAtMs: number;
  release: () => Promise<void>;
}

function sameGateway(a: { gatewayIp: string; localIp: string }, b: { gatewayIp: string; localIp: string }): boolean {
  return a.gatewayIp === b.gatewayIp && a.localIp === b.localIp;
}

/**
 * Manages a single UDP port mapping with serialized acquire/release cycles, half-lifetime renewal,
 * bounded backoff retry on transient failures, gateway-aware invalidation, and clean teardown.
 * Never throws; calls `onMapped` whenever the mapped external endpoint changes (or clears to null).
 */
export function createPortMapSession(
  onMapped: (mapping: PortMappingResult | null) => void,
  deps: PortMapDeps = {},
): PortMapSession {
  const discover = deps.discoverGateway ?? defaultDiscoverGateway;
  const tryNatPmp = deps.tryNatPmp ?? defaultTryNatPmp;
  const releaseNatPmp = deps.releaseNatPmp ?? defaultReleaseNatPmp;
  const tryUpnp = deps.tryUpnp ?? defaultTryUpnp;

  let closed = false;
  let desiredPort: number | null = null;
  let dirty = false;
  let renewTimer: NodeJS.Timeout | null = null;
  let active: ActivePortMapping | null = null;
  let consecutiveFailures = 0;
  let loop: Promise<void> | null = null;

  const clearTimer = () => {
    if (renewTimer) clearTimeout(renewTimer);
    renewTimer = null;
  };

  const emit = (next: PortMappingResult | null) => {
    try { onMapped(next); } catch { /* ignore listener errors */ }
  };

  const scheduleWake = (delayMs: number) => {
    clearTimer();
    if (closed) return;
    renewTimer = setTimeout(() => {
      renewTimer = null;
      if (closed || desiredPort === null) return;
      dirty = true;
      ensureLoop();
    }, Math.max(MIN_RENEW_MS, delayMs));
    renewTimer.unref();
  };

  const scheduleFailureRetry = () => {
    const nowMs = Date.now();
    if (active) {
      if (nowMs < active.expiresAtMs) {
        // Transient renewal failure while the current router lease is still valid: keep announcing it
        // and retry before actual expiry.
        const remainingMs = active.expiresAtMs - nowMs;
        const retryMs = remainingMs <= MIN_RENEW_MS * 2
          ? Math.max(MIN_RENEW_MS, remainingMs)
          : Math.min(INITIAL_RETRY_MS, Math.max(MIN_RENEW_MS, Math.floor(remainingMs / 2)));
        scheduleWake(retryMs);
        return;
      }
      const expired = active;
      active = null;
      emit(null);
      void expired.release().catch(() => undefined);
    }
    consecutiveFailures += 1;
    const backoffMs = Math.min(MAX_RETRY_MS, INITIAL_RETRY_MS * (2 ** Math.min(consecutiveFailures - 1, 10)));
    scheduleWake(backoffMs);
  };

  const releaseDetached = async (prev: ActivePortMapping, currentGateway: PortMapGateway | null) => {
    // Same gateway: await so release finishes before any subsequent add on that gateway;
    // different/unreachable gateway: fire-and-forget so network changes never stall on a dead router.
    if (currentGateway && prev.gatewayIp === currentGateway.gatewayIp) {
      await prev.release().catch(() => undefined);
    } else {
      void prev.release().catch(() => undefined);
    }
  };

  const runLoop = async (): Promise<void> => {
    let uncommitted: ActivePortMapping | null = null;
    try {
      while (!closed && dirty) {
        dirty = false;
        const targetPort = desiredPort;
        if (targetPort === null || targetPort < 1 || targetPort > 65_535) {
          if (uncommitted) {
            const orphan = uncommitted;
            uncommitted = null;
            await orphan.release().catch(() => undefined);
          }
          if (active) {
            const prev = active;
            active = null;
            emit(null);
            await prev.release().catch(() => undefined);
          }
          clearTimer();
          continue;
        }

        if (active && active.internalPort !== targetPort) {
          const prev = active;
          active = null;
          emit(null);
          await prev.release().catch(() => undefined);
          if (closed) break;
        }
        if (uncommitted && uncommitted.internalPort !== targetPort) {
          const orphan = uncommitted;
          uncommitted = null;
          await orphan.release().catch(() => undefined);
          if (closed) break;
        }

        const gateway = await discover().catch(() => null);
        if (closed) break;
        if (dirty) continue;

        if (uncommitted && (!gateway || !sameGateway(uncommitted, gateway))) {
          const orphan = uncommitted;
          uncommitted = null;
          await releaseDetached(orphan, gateway);
          if (closed) break;
        }

        if (active && (!gateway || !sameGateway(active, gateway))) {
          const prev = active;
          active = null;
          emit(null);
          await releaseDetached(prev, gateway);
          if (closed) break;
        }

        if (!gateway) {
          scheduleFailureRetry();
          continue;
        }

        let next: ActivePortMapping | null = null;
        if (uncommitted && sameGateway(uncommitted, gateway) && uncommitted.internalPort === targetPort) {
          next = uncommitted;
          uncommitted = null;
        } else {
          const pmp: PortMappingResult | null = await tryNatPmp(gateway.gatewayIp, targetPort, DEFAULT_LIFETIME_SEC).catch(() => null);
          if (closed) {
            if (pmp) void releaseNatPmp(gateway.gatewayIp, targetPort).catch(() => undefined);
            break;
          }
          if (pmp) {
            next = {
              result: pmp,
              gatewayIp: gateway.gatewayIp,
              localIp: gateway.localIp,
              internalPort: targetPort,
              expiresAtMs: Date.now() + pmp.lifetimeSec * 1_000,
              release: () => releaseNatPmp(gateway.gatewayIp, targetPort),
            };
          } else {
            if (dirty) continue;
            const upnp: UpnpMappingHandle | null = await tryUpnp(gateway, targetPort, DEFAULT_LIFETIME_SEC).catch(() => null);
            if (closed) {
              if (upnp) void upnp.release().catch(() => undefined);
              break;
            }
            if (upnp) {
              next = {
                result: upnp.result,
                gatewayIp: gateway.gatewayIp,
                localIp: gateway.localIp,
                internalPort: targetPort,
                expiresAtMs: Date.now() + upnp.result.lifetimeSec * 1_000,
                release: upnp.release,
              };
            }
          }
        }

        if (dirty) {
          if (next) {
            if (desiredPort !== targetPort) {
              await next.release().catch(() => undefined);
            } else {
              // Same port refreshed while in flight: hold rather than deleting a mapping that may still match
              // the active gateway on the next serialized iteration.
              uncommitted = next;
            }
          }
          continue;
        }

        if (!next) {
          scheduleFailureRetry();
          continue;
        }

        consecutiveFailures = 0;
        const prev = active;
        const changed = !prev
          || prev.result.address !== next.result.address
          || prev.result.port !== next.result.port
          || prev.result.protocol !== next.result.protocol;
        if (prev && prev.result.protocol === 'upnp' && next.result.protocol === 'upnp' && prev.result.port !== next.result.port) {
          void prev.release().catch(() => undefined);
        }
        active = next;
        if (changed) emit(next.result);
        scheduleWake(computePortMapRenewDelayMs(next.result.lifetimeSec));
      }
    } finally {
      if (uncommitted) {
        const orphan = uncommitted;
        uncommitted = null;
        void orphan.release().catch(() => undefined);
      }
    }
  };

  const ensureLoop = () => {
    if (closed || loop) return;
    loop = runLoop().finally(() => {
      loop = null;
      if (!closed && dirty) ensureLoop();
    });
  };

  return {
    refresh(internalPort: number) {
      if (closed) return;
      clearTimer();
      desiredPort = internalPort;
      consecutiveFailures = 0;
      dirty = true;
      ensureLoop();
    },
    current(): PortMappingResult | null {
      return active?.result ?? null;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      dirty = false;
      clearTimer();
      const prev = active;
      active = null;
      if (prev) await prev.release().catch(() => undefined);
    },
  };
}

export function portMappingToCandidate(mapping: PortMappingResult | null): Address | null {
  return mapping ? { address: mapping.address, port: mapping.port } : null;
}
