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
 * - Strict SSRF boundary: UPnP `LOCATION` and `controlURL` must be plain `http:` on a private LAN
 *   IPv4 address and the `controlURL` must stay on the same `host:port` as the discovery document.
 * - All timers are `.unref()`'d and mappings are released best-effort on close or port change.
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
const MIN_RENEW_MS = 60_000;
const MAX_RENEW_MS = 30 * 60_000;

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

export function parseSsdpLocation(response: string): string | null {
  const match = response.match(/^location\s*:\s*(\S+)/im);
  if (!match) return null;
  try {
    const parsed = new URL(match[1].trim());
    if (parsed.protocol !== 'http:' || !isLanGatewayIpv4(parsed.hostname)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function parseUpnpControlEndpoint(xml: string, locationUrl: string): { controlUrl: string; serviceType: string } | null {
  let base: URL;
  try { base = new URL(locationUrl); } catch { return null; }
  if (base.protocol !== 'http:' || !isLanGatewayIpv4(base.hostname)) return null;
  const serviceBlocks = xml.match(/<service\b[^>]*>[\s\S]*?<\/service>/gi) ?? [];
  for (const preferred of UPNP_SERVICE_TYPES) {
    for (const block of serviceBlocks) {
      const typeMatch = block.match(/<serviceType>([^<]+)<\/serviceType>/i);
      if (!typeMatch || typeMatch[1].trim() !== preferred) continue;
      const urlMatch = block.match(/<controlURL>([^<]+)<\/controlURL>/i);
      if (!urlMatch) continue;
      try {
        const resolved = new URL(urlMatch[1].trim(), base);
        if (resolved.protocol !== 'http:' || resolved.host !== base.host) continue;
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
    socket.on('message', (msg) => {
      const location = parseSsdpLocation(msg.toString('utf8'));
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
        if (isLanGatewayIpv4(gatewayIp)) {
          try { socket.send(payload, SSDP_PORT, gatewayIp); } catch { /* ignore */ }
        }
      }
      timer = setTimeout(() => finish(null), SSDP_TIMEOUT_MS);
      timer.unref();
    });
  });
}

function httpRequest(url: string, options: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; timeoutMs?: number }): Promise<{ status: number; body: string } | null> {
  return new Promise((resolve) => {
    let parsed: URL;
    try { parsed = new URL(url); } catch { resolve(null); return; }
    if (parsed.protocol !== 'http:' || !isLanGatewayIpv4(parsed.hostname)) { resolve(null); return; }
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

function soapCall(controlUrl: string, serviceType: string, action: string, innerXml: string, timeoutMs = UPNP_HTTP_TIMEOUT_MS): Promise<{ status: number; body: string } | null> {
  const body = `<?xml version="1.0"?>\r\n`
    + `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">`
    + `<s:Body><u:${action} xmlns:u="${serviceType}">${innerXml}</u:${action}></s:Body></s:Envelope>`;
  return httpRequest(controlUrl, {
    method: 'POST',
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
  const desc = await httpRequest(location, { method: 'GET' });
  if (!desc || desc.status !== 200) return null;
  const endpoint = parseUpnpControlEndpoint(desc.body, location);
  if (!endpoint) return null;
  const extRes = await soapCall(endpoint.controlUrl, endpoint.serviceType, 'GetExternalIPAddress', '');
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
  const addRes = await soapCall(endpoint.controlUrl, endpoint.serviceType, 'AddPortMapping', addBody);
  if (!addRes || addRes.status !== 200) return null;
  const result: PortMappingResult = { address: externalIp, port: internalPort, lifetimeSec, protocol: 'upnp' };
  return {
    result,
    release: async () => {
      const delBody = `<NewRemoteHost></NewRemoteHost><NewExternalPort>${internalPort}</NewExternalPort><NewProtocol>UDP</NewProtocol>`;
      await soapCall(endpoint.controlUrl, endpoint.serviceType, 'DeletePortMapping', delBody, 500).catch(() => undefined);
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

/**
 * Manages a single UDP port mapping with automatic half-lifetime renewal and clean teardown.
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

  let generation = 0;
  let closed = false;
  let renewTimer: NodeJS.Timeout | null = null;
  let active: { result: PortMappingResult; internalPort: number; release: () => Promise<void> } | null = null;

  const clearTimer = () => {
    if (renewTimer) clearTimeout(renewTimer);
    renewTimer = null;
  };

  const emit = (next: PortMappingResult | null) => {
    try { onMapped(next); } catch { /* ignore listener errors */ }
  };

  const releasePrevious = (prev: typeof active) => {
    if (!prev) return;
    void prev.release().catch(() => undefined);
  };

  const run = async (gen: number, internalPort: number) => {
    if (closed || gen !== generation || internalPort < 1 || internalPort > 65_535) return;
    const gateway = await discover().catch(() => null);
    if (closed || gen !== generation || !gateway) return;
    let next: { result: PortMappingResult; internalPort: number; release: () => Promise<void> } | null = null;
    const pmp = await tryNatPmp(gateway.gatewayIp, internalPort, DEFAULT_LIFETIME_SEC).catch(() => null);
    if (closed || gen !== generation) {
      if (pmp) void releaseNatPmp(gateway.gatewayIp, internalPort).catch(() => undefined);
      return;
    }
    if (pmp) {
      next = {
        result: pmp,
        internalPort,
        release: () => releaseNatPmp(gateway.gatewayIp, internalPort),
      };
    } else {
      const upnp = await tryUpnp(gateway, internalPort, DEFAULT_LIFETIME_SEC).catch(() => null);
      if (closed || gen !== generation) {
        if (upnp) void upnp.release().catch(() => undefined);
        return;
      }
      if (upnp) {
        next = { result: upnp.result, internalPort, release: upnp.release };
      }
    }
    if (!next) {
      if (active) {
        releasePrevious(active);
        active = null;
        emit(null);
      }
      return;
    }
    const changed = !active
      || active.result.address !== next.result.address
      || active.result.port !== next.result.port
      || active.result.protocol !== next.result.protocol;
    if (active && active.internalPort !== internalPort) releasePrevious(active);
    active = next;
    if (changed) emit(next.result);
    clearTimer();
    const renewMs = Math.min(MAX_RENEW_MS, Math.max(MIN_RENEW_MS, Math.floor(next.result.lifetimeSec * 500)));
    renewTimer = setTimeout(() => { void run(gen, internalPort); }, renewMs);
    renewTimer.unref();
  };

  return {
    refresh(internalPort: number) {
      if (closed) return;
      clearTimer();
      const prev = active;
      if (prev && prev.internalPort !== internalPort) {
        active = null;
        releasePrevious(prev);
        emit(null);
      }
      const gen = ++generation;
      void run(gen, internalPort);
    },
    current(): PortMappingResult | null {
      return active?.result ?? null;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      generation += 1;
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
