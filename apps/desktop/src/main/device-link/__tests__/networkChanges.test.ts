import { afterEach, expect, it, vi } from 'vitest';
import { networkInterfaces } from 'node:os';
import { watchNetworkChanges } from '../networkChanges';
vi.mock('node:os', () => ({ networkInterfaces: vi.fn() }));
afterEach(() => vi.useRealTimers());
it('ignores stable/reordered interfaces and stops on teardown', () => {
  vi.useFakeTimers();
  const read = vi.mocked(networkInterfaces);
  const wifi = {
    internal: false,
    family: 'IPv4' as const,
    address: '192.0.2.1',
    netmask: '255.255.255.0',
    mac: '00:00:00:00:00:00',
    cidr: '192.0.2.1/24',
  };
  const vpn = { ...wifi, address: '192.0.2.2', cidr: '192.0.2.2/24' };
  read.mockReturnValue({ en0: [wifi], utun: [vpn] });
  const changed = vi.fn();
  const stop = watchNetworkChanges(changed);
  read.mockReturnValue({ utun: [vpn], en0: [wifi] });
  vi.advanceTimersByTime(2_000);
  expect(changed).not.toHaveBeenCalled();
  read.mockReturnValue({ en0: [wifi] });
  vi.advanceTimersByTime(2_000);
  expect(changed).toHaveBeenCalledTimes(1);
  read.mockImplementation(() => {
    throw new Error('OS unavailable');
  });
  vi.advanceTimersByTime(2_000);
  expect(changed).toHaveBeenCalledTimes(1);
  stop();
  vi.advanceTimersByTime(2_000);
  expect(read).toHaveBeenCalledTimes(4);
});

/**
 * 测试价值
 * - 生产入口与可观察结果：`watchNetworkChanges(onChange, { readProxy })` 在物理网卡不变、但系统代理配置切换时
 *   触发一次 `onChange`；读取失败或返回 null 不误报；同轮网卡与代理同时变化去重为一次；`stop()` 后在途读取不再触发。
 * - Bug／规则依据：macOS 代理软件切换时网卡 IP 可能不变，仅系统代理变化时也需通知 Agent-Net 重探。
 * - 现有覆盖缺口：原用例仅覆盖 `networkInterfaces()` 变化。
 * - 最小失败输入：网卡固定不变，`readProxy` 由 `PROXY 127.0.0.1:7890` 变为 `DIRECT`。
 * - tier：unit，假计时器。
 */
it('detects system proxy changes even when interfaces stay unchanged, deduplicates same-poll changes, and ignores errors after stop', async () => {
  vi.useFakeTimers();
  const read = vi.mocked(networkInterfaces);
  const wifi = {
    internal: false,
    family: 'IPv4' as const,
    address: '192.0.2.1',
    netmask: '255.255.255.0',
    mac: '00:00:00:00:00:00',
    cidr: '192.0.2.1/24',
  };
  read.mockReturnValue({ en0: [wifi] });
  let proxyFactory: () => Promise<string | null> = () => Promise.resolve('PROXY 127.0.0.1:7890');
  const readProxy = vi.fn(() => proxyFactory());
  const changed = vi.fn();
  const stop = watchNetworkChanges(changed, { readProxy });
  await Promise.resolve();
  expect(changed).not.toHaveBeenCalled();

  // Proxy switched to DIRECT while interface IP stays identical -> triggers onChange once.
  proxyFactory = () => Promise.resolve('DIRECT');
  await vi.advanceTimersByTimeAsync(2_000);
  expect(changed).toHaveBeenCalledTimes(1);

  // Proxy lookup failure / null must not trigger false change.
  proxyFactory = () => Promise.reject(new Error('resolveProxy failed'));
  await vi.advanceTimersByTimeAsync(2_000);
  proxyFactory = () => Promise.resolve(null);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(changed).toHaveBeenCalledTimes(1);

  // Interface and proxy both change in the same poll cycle -> deduplicated to 1 notification.
  read.mockReturnValue({ en0: [{ ...wifi, address: '192.0.2.9', cidr: '192.0.2.9/24' }] });
  proxyFactory = () => Promise.resolve('PROXY 127.0.0.1:7890');
  await vi.advanceTimersByTimeAsync(2_000);
  expect(changed).toHaveBeenCalledTimes(2);

  // In-flight proxy lookup resolving after stop() must not fire onChange.
  let resolveLate!: (value: string) => void;
  proxyFactory = () => new Promise<string>((resolve) => { resolveLate = resolve; });
  await vi.advanceTimersByTimeAsync(2_000);
  stop();
  resolveLate('DIRECT');
  await Promise.resolve();
  expect(changed).toHaveBeenCalledTimes(2);
});

/**
 * 测试价值
 * - 生产入口与可观察结果：`watchNetworkChanges` 在 macOS 出现/消失 `awdl0`/`llw0`/`anpi0`/`anri0`
 *   以及任意网卡上 `fe80::/10`、`169.254.0.0/16` 链路本地地址抖动时不触发 `onChange`；
 *   真实可路由 IPv4 或 ULA/公网 IPv6 变化时仍立即触发一次 `onChange`。
 * - Bug／规则依据：2026-11-26 本机实测 4 小时内触发 99 次 `network-changed` 误重绑，根因是
 *   `watchNetworkChanges` 把 `awdl0`/`llw0`/`utun*` 的 `fe80::` 抖动当成了换网。
 * - 现有覆盖缺口：原用例仅使用固定可路由 IPv4，未覆盖链路本地地址与 macOS 虚拟 P2P 网卡抖动。
 * - 最小失败输入：`en1` 保持 `192.168.68.59`，交替出现/移除 `awdl0`（`fe80::...`）与 `utun4`（`fe80::...`）。
 * - tier：unit，假计时器。
 */
it('ignores link-local addresses and ephemeral macOS P2P interfaces while still detecting routable changes', () => {
  vi.useFakeTimers();
  const read = vi.mocked(networkInterfaces);
  const wifiV4 = {
    internal: false,
    family: 'IPv4' as const,
    address: '192.168.68.59',
    netmask: '255.255.255.0',
    mac: '00:00:00:00:00:00',
    cidr: '192.168.68.59/24',
  };
  const linkLocalV6 = {
    internal: false,
    family: 'IPv6' as const,
    address: 'fe80::30d5:c4ff:febc:a718',
    netmask: 'ffff:ffff:ffff:ffff::',
    mac: '00:00:00:00:00:00',
    cidr: 'fe80::30d5:c4ff:febc:a718/64',
    scopeid: 1,
  };
  const linkLocalV4 = {
    ...wifiV4,
    address: '169.254.12.34',
    netmask: '255.255.0.0',
    cidr: '169.254.12.34/16',
  };
  read.mockReturnValue({ en1: [wifiV4, linkLocalV6] });
  const changed = vi.fn();
  const stop = watchNetworkChanges(changed);

  // Ephemeral macOS interfaces and link-local churn on utun/en1 must not trigger onChange.
  read.mockReturnValue({
    en1: [wifiV4, { ...linkLocalV6, address: 'fe80::1' }, linkLocalV4],
    awdl0: [linkLocalV6, { ...wifiV4, address: '10.99.0.1', cidr: '10.99.0.1/24' }],
    llw0: [linkLocalV6],
    anpi0: [linkLocalV6],
    anri0: [linkLocalV6],
    utun4: [{ ...linkLocalV6, address: 'fe90::1234' }],
  });
  vi.advanceTimersByTime(2_000);
  expect(changed).not.toHaveBeenCalled();

  read.mockReturnValue({ en1: [wifiV4] });
  vi.advanceTimersByTime(2_000);
  expect(changed).not.toHaveBeenCalled();

  // Routable Tailscale/VPN interface appearing still triggers onChange.
  read.mockReturnValue({
    en1: [wifiV4],
    utun12: [linkLocalV6, { ...wifiV4, address: '100.82.251.65', cidr: '100.82.251.65/32' }],
  });
  vi.advanceTimersByTime(2_000);
  expect(changed).toHaveBeenCalledTimes(1);

  stop();
});
