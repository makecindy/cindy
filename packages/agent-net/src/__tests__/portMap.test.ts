import { describe, expect, it, vi } from 'vitest';
import { generateIdentity } from '@cindy/agent-net-relay';
import {
  buildNatPmpExternalAddressRequest,
  buildNatPmpMapRequest,
  computePortMapRenewDelayMs,
  createPortMapSession,
  parseDarwinRouteOutput,
  parseLinuxProcRoute,
  parseNatPmpExternalAddressResponse,
  parseNatPmpMapResponse,
  parseSsdpLocation,
  parseUpnpControlEndpoint,
  parseUpnpExternalIp,
} from '../portMap.js';
import {
  classifyNatMapping,
  formatTransportDiagnosticsLog,
  type PortMappingEntry,
} from '../types.js';
import { NativeTransport, type NativeEnginePort } from '../nativeTransport.js';

/** 测试价值
 * - 生产入口与可观察结果：验证 `portMap.ts` 的 NAT-PMP (RFC 6886) 与 UPnP IGD 编解码及路由解析，
 *   确保只接受合法公网 IPv4 映射、严格拒绝非局域网 / 非 http / 跨主机 `controlURL`（SSRF 边界）。
 * - Bug／规则依据：直连增强引入路由器端口映射后，若接受私网/0.0.0.0 外部地址或未限制 UPnP XML 跳转目标，
 *   会导致候选污染或在不可信局域网内触发 SSRF。
 * - 现有覆盖缺口：新增模块，此前无任何端口映射协议编解码或 SSRF 边界测试。
 * - 最小失败输入：正常/异常 NAT-PMP 回包、私网/公网/跨主机 SSDP+UPnP XML、macOS 与 Linux 默认路由文本。
 * - tier：unit，纯内存无网络；约 5 毫秒。
 */
describe('portMap wire codecs and SSRF boundaries', () => {
  it('encodes and validates NAT-PMP external address and UDP mapping messages', () => {
    expect([...buildNatPmpExternalAddressRequest()]).toEqual([0, 0]);
    const addrOk = Buffer.from([0, 128, 0, 0, 0, 0, 1, 2, 161, 29, 200, 234]);
    expect(parseNatPmpExternalAddressResponse(addrOk)).toBe('161.29.200.234');
    // Private / zero external IP or non-zero result code must be rejected.
    const addrPrivate = Buffer.from([0, 128, 0, 0, 0, 0, 1, 2, 192, 168, 1, 1]);
    expect(parseNatPmpExternalAddressResponse(addrPrivate)).toBeNull();
    const addrErr = Buffer.from([0, 128, 0, 3, 0, 0, 1, 2, 161, 29, 200, 234]);
    expect(parseNatPmpExternalAddressResponse(addrErr)).toBeNull();

    const mapReq = buildNatPmpMapRequest(51234, 51234, 3600);
    expect(mapReq.length).toBe(12);
    expect(mapReq[1]).toBe(1);
    expect(mapReq.readUInt16BE(4)).toBe(51234);
    expect(mapReq.readUInt16BE(6)).toBe(51234);
    expect(mapReq.readUInt32BE(8)).toBe(3600);

    const mapOk = Buffer.alloc(16);
    mapOk[0] = 0; mapOk[1] = 129; mapOk.writeUInt16BE(0, 2);
    mapOk.writeUInt16BE(51234, 8); mapOk.writeUInt16BE(54321, 10); mapOk.writeUInt32BE(3600, 12);
    expect(parseNatPmpMapResponse(mapOk, 51234)).toEqual({ externalPort: 54321, lifetimeSec: 3600 });
    expect(parseNatPmpMapResponse(mapOk, 50000)).toBeNull();
  });

  it('enforces gateway-bound same-host boundaries for SSDP and UPnP IGD control URLs', () => {
    const gw = '192.168.68.1';
    expect(parseSsdpLocation('HTTP/1.1 200 OK\r\nLOCATION: http://192.168.68.1:1900/rootDesc.xml\r\n', gw)).toBe('http://192.168.68.1:1900/rootDesc.xml');
    // Must reject other LAN/VPN IPs even though they are private IPv4 addresses (prevents LAN SSDP SSRF).
    expect(parseSsdpLocation('HTTP/1.1 200 OK\r\nLOCATION: http://192.168.68.99:8080/internal\r\n', gw)).toBeNull();
    expect(parseSsdpLocation('HTTP/1.1 200 OK\r\nLOCATION: http://10.8.0.5:9000/admin\r\n', gw)).toBeNull();
    expect(parseSsdpLocation('HTTP/1.1 200 OK\r\nLOCATION: http://user:pass@192.168.68.1:1900/rootDesc.xml\r\n', gw)).toBeNull();
    expect(parseSsdpLocation('HTTP/1.1 200 OK\r\nLOCATION: http://169.254.169.254/latest/meta-data\r\n', gw)).toBeNull();
    expect(parseSsdpLocation('HTTP/1.1 200 OK\r\nLOCATION: http://127.0.0.1:8080/desc.xml\r\n', gw)).toBeNull();
    expect(parseSsdpLocation('HTTP/1.1 200 OK\r\nLOCATION: https://192.168.68.1/desc.xml\r\n', gw)).toBeNull();
    expect(parseSsdpLocation('HTTP/1.1 200 OK\r\nLOCATION: http://8.8.8.8/desc.xml\r\n', gw)).toBeNull();
    expect(parseSsdpLocation('HTTP/1.1 200 OK\r\nLOCATION: http://192.168.68.1:1900/rootDesc.xml\r\n', '8.8.8.8')).toBeNull();

    const validXml = `<root><device><serviceList><service>
      <serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
      <controlURL>/ctl/IPConn</controlURL>
    </service></serviceList></device></root>`;
    expect(parseUpnpControlEndpoint(validXml, 'http://192.168.68.1:1900/gximn/rootDesc.xml')).toEqual({
      controlUrl: 'http://192.168.68.1:1900/ctl/IPConn',
      serviceType: 'urn:schemas-upnp-org:service:WANIPConnection:1',
    });

    const ssrfXml = `<root><device><serviceList><service>
      <serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
      <controlURL>http://192.168.68.99:8080/evil</controlURL>
    </service></serviceList></device></root>`;
    expect(parseUpnpControlEndpoint(ssrfXml, 'http://192.168.68.1:1900/rootDesc.xml')).toBeNull();

    expect(parseUpnpExternalIp('<NewExternalIPAddress>161.29.200.234</NewExternalIPAddress>')).toBe('161.29.200.234');
    expect(parseUpnpExternalIp('<NewExternalIPAddress>10.0.0.1</NewExternalIPAddress>')).toBeNull();
  });

  it('parses macOS and Linux default gateway routes', () => {
    expect(parseDarwinRouteOutput('   route to: default\n    gateway: 192.168.68.1\n  interface: en0\n')).toEqual({
      gatewayIp: '192.168.68.1',
      interfaceName: 'en0',
    });
    expect(parseLinuxProcRoute('Iface\tDestination\tGateway\tFlags\neth0\t00000000\t0144A8C0\t0003\n')).toEqual({
      gatewayIp: '192.168.68.1',
      interfaceName: 'eth0',
    });
  });
});

/** 测试价值
 * - 生产入口与可观察结果：验证 `createPortMapSession` 的主备降级与生命周期：NAT-PMP 失败自动回退 UPnP、
 *   端口变化时释放旧映射并申请新映射、续租定时器按半租期触发、`close()` 释放当前映射。
 * - Bug／规则依据：换网或 UDP 重绑后若未释放旧映射或未触发新端口映射，路由器映射表会残留脏项并对外宣告过期端口。
 * - 现有覆盖缺口：此前无路由器端口映射生命周期覆盖。
 * - 最小失败输入：用桩函数模拟 NAT-PMP 失败→UPnP 成功→端口变化→关闭。
 * - tier：unit，假计时器 + 内存依赖桩；约 10 毫秒。
 */
describe('createPortMapSession lifecycle', () => {
  it('falls back from NAT-PMP to UPnP, renews at half lifetime, and releases on port change and close', async () => {
    vi.useFakeTimers();
    const events: Array<PortMappingEntry | null> = [];
    const released: string[] = [];
    let pmpOk = false;
    let upnpCalls = 0;

    const session = createPortMapSession((m) => events.push(m), {
      discoverGateway: async () => ({ gatewayIp: '192.168.68.1', localIp: '192.168.68.59' }),
      tryNatPmp: async (_gw, port) => (pmpOk ? { address: '161.29.200.234', port, lifetimeSec: 200, protocol: 'nat-pmp' } : null),
      releaseNatPmp: async (_gw, port) => { released.push(`pmp:${port}`); },
      tryUpnp: async (_gw, port) => {
        upnpCalls += 1;
        return {
          result: { address: '161.29.200.234', port, lifetimeSec: 200, protocol: 'upnp' },
          release: async () => { released.push(`upnp:${port}`); },
        };
      },
    });
    try {
      session.refresh(41000);
      await vi.advanceTimersByTimeAsync(10);
      expect(events).toEqual([{ address: '161.29.200.234', port: 41000, lifetimeSec: 200, protocol: 'upnp' }]);
      expect(upnpCalls).toBe(1);

      // Half of 200s lifetime = 100s triggers renewal.
      await vi.advanceTimersByTimeAsync(100_000);
      expect(upnpCalls).toBe(2);

      // Local UDP port changed and NAT-PMP is now available: old UPnP mapping released, new NAT-PMP acquired.
      pmpOk = true;
      session.refresh(42000);
      await vi.advanceTimersByTimeAsync(10);
      expect(released).toContain('upnp:41000');
      expect(session.current()).toEqual({ address: '161.29.200.234', port: 42000, lifetimeSec: 200, protocol: 'nat-pmp' });

      await session.close();
      expect(released).toContain('pmp:42000');
      expect(session.current()).toBeNull();
    } finally {
      await session.close();
      vi.useRealTimers();
    }
  });

  it('renews short leases before expiry, retries transiently failed renewals, and recovers after backoff', async () => {
    vi.useFakeTimers();
    expect(computePortMapRenewDelayMs(30)).toBe(15_000);
    expect(computePortMapRenewDelayMs(1)).toBe(500);
    expect(computePortMapRenewDelayMs(7200)).toBe(30 * 60_000);

    const events: Array<PortMappingEntry | null> = [];
    const released: string[] = [];
    let routerReachable = true;
    let pmpCalls = 0;

    const session = createPortMapSession((m) => events.push(m), {
      discoverGateway: async () => ({ gatewayIp: '192.168.68.1', localIp: '192.168.68.59' }),
      tryNatPmp: async (_gw, port) => {
        pmpCalls += 1;
        if (!routerReachable) return null;
        return { address: '161.29.200.234', port, lifetimeSec: 30, protocol: 'nat-pmp' };
      },
      releaseNatPmp: async (gw, port) => { released.push(`${gw}:${port}`); },
      tryUpnp: async () => null,
    });
    try {
      session.refresh(41000);
      await vi.advanceTimersByTimeAsync(10);
      expect(pmpCalls).toBe(1);
      expect(session.current()?.lifetimeSec).toBe(30);

      // Router goes temporarily unreachable before the 15s half-lifetime renewal.
      routerReachable = false;
      await vi.advanceTimersByTimeAsync(15_000);
      expect(pmpCalls).toBe(2);
      // Still unexpired (< 30s): candidate must stay active while retrying before actual expiry.
      expect(session.current()).not.toBeNull();

      // Advance past the 30s lease expiry: active mapping clears and emits null.
      await vi.advanceTimersByTimeAsync(16_000);
      expect(session.current()).toBeNull();
      expect(events.at(-1)).toBeNull();

      // Router recovers: exponential backoff retry automatically re-acquires the mapping without external refresh().
      routerReachable = true;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(session.current()).toEqual({ address: '161.29.200.234', port: 41000, lifetimeSec: 30, protocol: 'nat-pmp' });
      expect(released).toContain('192.168.68.1:41000');
    } finally {
      await session.close();
      vi.useRealTimers();
    }
  });

  it('releases old gateway mapping on network change with same UDP port and serializes overlapping refreshes', async () => {
    vi.useFakeTimers();
    const events: Array<PortMappingEntry | null> = [];
    const released: string[] = [];
    let gateway: { gatewayIp: string; localIp: string } | null = { gatewayIp: '192.168.1.1', localIp: '192.168.1.10' };
    const pendingResolvers: Array<(value: { address: string; port: number; lifetimeSec: number; protocol: 'nat-pmp' } | null) => void> = [];
    let holdFirstPmp = true;
    let pmpStarts = 0;

    const session = createPortMapSession((m) => events.push(m), {
      discoverGateway: async () => gateway,
      tryNatPmp: async (gw, port) => {
        pmpStarts += 1;
        if (holdFirstPmp) {
          holdFirstPmp = false;
          return new Promise((resolve) => { pendingResolvers.push(resolve); });
        }
        return { address: gw === '192.168.1.1' ? '161.29.200.1' : '161.29.200.2', port, lifetimeSec: 120, protocol: 'nat-pmp' };
      },
      releaseNatPmp: async (gw, port) => { released.push(`${gw}:${port}`); },
      tryUpnp: async () => null,
    });
    try {
      // Two rapid refreshes for the same gateway + port must serialize and NEVER delete the acquired mapping.
      session.refresh(45000);
      await Promise.resolve();
      await Promise.resolve();
      expect(pmpStarts).toBe(1);
      session.refresh(45000);
      expect(pmpStarts).toBe(1);

      pendingResolvers.shift()?.({ address: '161.29.200.1', port: 45000, lifetimeSec: 120, protocol: 'nat-pmp' });
      await vi.advanceTimersByTimeAsync(10);
      expect(released).toEqual([]);
      expect(session.current()).toEqual({ address: '161.29.200.1', port: 45000, lifetimeSec: 120, protocol: 'nat-pmp' });

      // Network switches to gateway B with the SAME local UDP port (45000): old gateway A mapping must be cleared and released.
      gateway = { gatewayIp: '192.168.68.1', localIp: '192.168.68.59' };
      session.refresh(45000);
      await vi.advanceTimersByTimeAsync(10);
      expect(released).toContain('192.168.1.1:45000');
      expect(events).toContain(null);
      expect(session.current()).toEqual({ address: '161.29.200.2', port: 45000, lifetimeSec: 120, protocol: 'nat-pmp' });

      // Network switches to no LAN gateway: old gateway B mapping must be cleared and released.
      gateway = null;
      session.refresh(45000);
      await vi.advanceTimersByTimeAsync(10);
      expect(released).toContain('192.168.68.1:45000');
      expect(session.current()).toBeNull();
    } finally {
      await session.close();
      vi.useRealTimers();
    }
  });
});

/** 测试价值
 * - 生产入口与可观察结果：验证 `classifyNatMapping` 与 `formatTransportDiagnosticsLog` 对五类 NAT/出口状态的分类，
 *   以及在 `NativeTransport` 中融合端口映射候选、利用未去重 `stunObservations` 准确判定 `cone` 并输出不含任何明文 IP/端口/密钥的诊断日志。
 * - Bug／规则依据：2026-11-26 排查发现透明代理引发对称 NAT 与跨区出口分流时，日志缺乏 NAT 映射分类，无法直接归因；
 *   同时按 `docs/dev-rules/log-upload-and-redaction.md` 约束，传输诊断日志不得夹带原始公私网 IP 或端口号。
 * - 现有覆盖缺口：此前无多 STUN NAT 分类、无端口映射候选融合、无脱敏日志格式锁测试。
 * - 最小失败输入：同/异端口与同/异 IP 的 STUN 观察数组；带 `createPortMap` 与 `stunObservations` 的 `NativeTransport`。
 * - tier：unit，内存引擎无网络；约 20 毫秒。
 */
describe('NAT diagnostics and transport port-map integration', () => {
  it('classifies cone, symmetric, multi-egress NAT and formats logs without leaking IPs or ports', () => {
    expect(classifyNatMapping([], 50000)).toEqual({ natMapping: 'unknown', portPreserving: null });
    expect(classifyNatMapping([{ address: '161.29.200.234', port: 50000 }], 50000)).toEqual({ natMapping: 'single-server', portPreserving: true });
    expect(classifyNatMapping([
      { address: '161.29.200.234', port: 54520 },
      { address: '161.29.200.234', port: 54520 },
    ], 51458)).toEqual({ natMapping: 'cone', portPreserving: false });
    expect(classifyNatMapping([
      { address: '161.29.200.234', port: 51156 },
      { address: '161.29.200.234', port: 63133 },
    ], 56206)).toEqual({ natMapping: 'symmetric', portPreserving: false });
    expect(classifyNatMapping([
      { address: '161.29.200.234', port: 54520 },
      { address: '120.253.194.70', port: 49538 },
    ], 51458)).toEqual({ natMapping: 'multi-egress', portPreserving: false });

    const line = formatTransportDiagnosticsLog({
      natMapping: 'symmetric',
      portPreserving: false,
      stunResponses: 2,
      portMapped: 'nat-pmp',
      localCandidates: 1,
      publicCandidates: 2,
    });
    expect(line).toBe('agent-net nat=symmetric portPreserving=false stun=2 portMap=nat-pmp candidates=public:2,local:1');
    expect(line).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  it('merges port-mapped candidates and emits sanitized diagnostics in NativeTransport', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const local = generateIdentity('native-diag');
    let mapped = [{ address: '161.29.200.234', port: 51156 }, { address: '161.29.200.234', port: 63133 }];
    let stunObservations: Array<{ address: string; port: number }> | undefined = mapped;
    let pushMapping!: (entry: PortMappingEntry | null) => void;
    const refreshed: number[] = [];
    let closedPortMap = false;
    const logs: Array<{ level: string; message: string }> = [];
    const engine: NativeEnginePort = {
      async command<T>(command: Record<string, unknown>): Promise<T> {
        if (command.op === 'identity') {
          return { deviceId: local.deviceId, transportKey: local.transportKey, udpPort: 45000, features: ['stun'] } as T;
        }
        if (command.op === 'poll') {
          return { packets: [], connections: [], mapped, ...(stunObservations ? { stunObservations } : {}) } as T;
        }
        return true as T;
      },
      async destroy() {},
    };
    const transport = await NativeTransport.create(engine, {
      admit: () => true,
      admittedPeers: () => [],
      onIncoming: () => undefined,
      onLog: (level, message) => logs.push({ level, message }),
      createPortMap: (onMapped) => {
        pushMapping = onMapped;
        return {
          refresh(port) { refreshed.push(port); },
          current() { return null; },
          async close() { closedPortMap = true; },
        };
      },
    }, ['192.168.68.59'], true);
    try {
      expect(refreshed).toEqual([45000]);
      await vi.advanceTimersByTimeAsync(100);
      expect(transport.diagnostics()).toEqual({
        natMapping: 'symmetric',
        portPreserving: false,
        stunResponses: 2,
        portMapped: null,
        localCandidates: 1,
        publicCandidates: 2,
      });
      expect(logs.some((l) => l.level === 'warn' && l.message.includes('nat=symmetric'))).toBe(true);
      expect(logs.every((l) => !/\d+\.\d+\.\d+\.\d+/.test(l.message))).toBe(true);

      pushMapping({ address: '161.29.200.234', port: 45000, lifetimeSec: 3600, protocol: 'nat-pmp' });
      expect(transport.candidates()).toContainEqual({ address: '161.29.200.234', port: 45000 });
      expect(transport.diagnostics().portMapped).toBe('nat-pmp');
      expect(transport.diagnostics().publicCandidates).toBe(3);

      // Deduplicated `mapped` has 1 address while raw `stunObservations` has 2 identical answers -> must classify as `cone`!
      mapped = [{ address: '161.29.200.234', port: 45000 }];
      stunObservations = [{ address: '161.29.200.234', port: 45000 }, { address: '161.29.200.234', port: 45000 }];
      transport.networkChanged();
      expect(refreshed).toEqual([45000, 45000]);
      await vi.advanceTimersByTimeAsync(100);
      expect(transport.diagnostics()).toEqual({
        natMapping: 'cone',
        portPreserving: true,
        stunResponses: 2,
        portMapped: 'nat-pmp',
        localCandidates: 1,
        publicCandidates: 1,
      });
      expect(logs.some((l) => l.level === 'info' && l.message.includes('nat=cone') && l.message.includes('stun=2'))).toBe(true);
    } finally {
      await transport.close();
      vi.useRealTimers();
    }
    expect(closedPortMap).toBe(true);
  });
});
