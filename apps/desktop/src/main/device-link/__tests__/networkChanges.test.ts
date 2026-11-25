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
