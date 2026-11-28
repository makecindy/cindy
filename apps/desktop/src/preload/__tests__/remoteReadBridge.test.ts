/**
 * 测试价值
 * - 生产入口与可观察结果：调用 preload 边界 `createRemoteReadBridge`（`openLink` / `closeLink` / `invoke`），
 *   验证可选只读通道在对端缺注册或远端 allowlist 明确拒绝时的按对端短路、非缺失错误的即时可恢复性，
 *   以及重连/版本升级/能力变更/切号后的重探行为。
 * - Bug／规则依据：PR #12556 与线上诊断 `maker:model-context-limit:get`（80 次）、`model-groups:get`（2 次）
 *   重复触发 `CHANNEL_NOT_ALLOWED`；`docs/dev-rules/remote-and-mobile-adaptation.md`。
 * - 现有覆盖缺口：#12556 原用例仅记忆线性通道的 `NOT_FOUND: no local IPC handler`，未覆盖同通道精确
 *   `channel '<channel>' not allowed remotely` 记忆，也未验证 `maker:model-context-limit:get` 冷启动缺 handler
 *   保持可恢复、以及本机传输策略 `CHANNEL_NOT_ALLOWED` 不被误锁死。
 * - 最小失败输入：旧对端返回 `[DEVICE_LINK_CHANNEL_NOT_ALLOWED] channel 'maker:model-context-limit:get' not allowed remotely`
 *   后连续读取；或本机策略返回 `[DEVICE_LINK_CHANNEL_NOT_ALLOWED] Transport disabled by current host policy` 后重试。
 * - tier：unit（纯 Node `EventEmitter` 模拟 `ipcRenderer`，无 Electron 进程或真实网络）。
 * - 实测耗时：0.99s（`pnpm --dir apps/desktop exec vitest run src/preload/__tests__/remoteReadBridge.test.ts`）
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { DEVICE_LINK_INVOKE, DEVICE_LINK_PUSH } from '../../shared/deviceLinkIpc';
import { createRemoteReadBridge } from '../remoteReadBridge';

const history = 'local-db:history:query';
const roster = 'maker:remote-resources:list';
const contextLimit = 'maker:model-context-limit:get';
const modelGroups = 'model-groups:get';

const missing = (channel: string) => new Error(
  `Error invoking remote method 'device-link:invoke': Error: [NOT_FOUND] no local IPC handler for channel '${channel}'`,
);
const disallowedRemotely = (channel: string) => new Error(
  `Error invoking remote method 'device-link:invoke': Error: [DEVICE_LINK_CHANNEL_NOT_ALLOWED] channel '${channel}' not allowed remotely`,
);

function fixture() {
  const events = new EventEmitter();
  const invoke = vi.fn();
  const bridge = createRemoteReadBridge({ invoke, on: events.on.bind(events) });
  const read = (device = 'old', channel = history) => bridge.invoke(device, channel, []);
  const push = (event: string, payload: unknown) => events.emit(event, {}, payload);
  return { bridge, invoke, read, push };
}

describe('remote optional reads at the desktop IPC boundary', () => {
  it('stops only the missing or remotely disallowed channel on the answering peer without caching data', async () => {
    const { read, invoke } = fixture();
    invoke
      .mockRejectedValueOnce(missing(history))
      .mockRejectedValueOnce(disallowedRemotely(contextLimit))
      .mockRejectedValueOnce(disallowedRemotely(modelGroups))
      .mockResolvedValueOnce(['teammate'])
      .mockResolvedValueOnce(['task']);

    await expect(read('old', history)).rejects.toThrow('no local IPC handler');
    await expect(read('old', history)).rejects.toThrow('[NOT_FOUND]');

    await expect(read('old', contextLimit)).rejects.toThrow('not allowed remotely');
    for (let i = 0; i < 80; i++) {
      await expect(read('old', contextLimit)).rejects.toThrow('[DEVICE_LINK_CHANNEL_NOT_ALLOWED]');
    }
    await expect(read('old', modelGroups)).rejects.toThrow('not allowed remotely');
    await expect(read('old', modelGroups)).rejects.toThrow('[DEVICE_LINK_CHANNEL_NOT_ALLOWED]');

    await expect(read('old', roster)).resolves.toEqual(['teammate']);
    await expect(read('new', contextLimit)).resolves.toEqual(['task']);
    expect(invoke).toHaveBeenCalledTimes(5);
  });

  it.each([
    '[DEVICE_LINK_TIMEOUT] no result within 30000ms',
    '[REQUEST_TIMEOUT] timed out waiting for the peer',
    '[BACKPRESSURE] peer is busy',
    '[PERMISSION_DENIED] history is private',
    '[PRECONDITION_FAILED] remote model groups require an owner controller',
    '[DEVICE_LINK_CONTROL_DISABLED] device control is disabled locally',
    '[DEVICE_LINK_CHANNEL_NOT_ALLOWED] Transport disabled by current host policy',
    '[DEVICE_LINK_CHANNEL_NOT_ALLOWED] Untrusted transport mode',
    '[DEVICE_LINK_CHANNEL_NOT_ALLOWED] Encrypted transport required',
    '[DEVICE_LINK_CHANNEL_NOT_ALLOWED] Not available for shared providers',
    '[DEVICE_LINK_CHANNEL_NOT_ALLOWED] An account-owned link is required',
    `[DEVICE_LINK_CHANNEL_NOT_ALLOWED] channel '${history}' not allowed`,
    `[DEVICE_LINK_CHANNEL_NOT_ALLOWED] channel '${roster}' not allowed remotely`,
    `[UNSUPPORTED_CAPABILITY] Capability ${history} is not supported in host client mode`,
    '[NOT_FOUND] Session does not exist',
    `[NOT_FOUND] no local IPC handler for channel '${roster}'`,
    '[UNSUPPORTED_CAPABILITY] This collection does not support the requested action',
  ])('allows a successful next read after %s', async (message) => {
    const { read, invoke } = fixture();
    const error = new Error(message);
    invoke.mockRejectedValueOnce(error).mockResolvedValueOnce(['task']);
    await expect(read()).rejects.toBe(error);
    await expect(read()).resolves.toEqual(['task']);
  });

  it('rechecks known misses on reconnect and ignores in-flight failures from before it', async () => {
    const { read, invoke, push } = fixture();
    invoke.mockRejectedValueOnce(disallowedRemotely(contextLimit));
    await expect(read('old', contextLimit)).rejects.toThrow('[DEVICE_LINK_CHANNEL_NOT_ALLOWED]');
    let rejectOld!: (cause: Error) => void;
    invoke.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
    const old = read();
    push(DEVICE_LINK_PUSH.PEER_LINK_REOPENED, { deviceId: 'old' });
    rejectOld(disallowedRemotely(history));
    await expect(old).rejects.toThrow('not allowed remotely');
    invoke.mockResolvedValue(['now supported']);
    await expect(read()).resolves.toEqual(['now supported']);
    await expect(read('old', contextLimit)).resolves.toEqual(['now supported']);
  });

  it.each([
    'maker:list-plugin-engines',
    contextLimit,
  ])('reads late-registered %s on the same link after splash missing-handler', async (channel) => {
    const { read, invoke } = fixture();
    invoke.mockRejectedValueOnce(missing(channel)).mockResolvedValueOnce(['ready']);
    await expect(read('old', channel)).rejects.toThrow('[NOT_FOUND]');
    await expect(read('old', channel)).resolves.toEqual(['ready']);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('lets a late-starting legacy scheduler become readable without reopening unrelated history', async () => {
    const { read, invoke, push } = fixture();
    const schedule = 'maker:schedule:list';
    invoke.mockRejectedValueOnce(missing(history)).mockRejectedValueOnce(missing(schedule)).mockResolvedValueOnce(['run']);
    await expect(read()).rejects.toThrow('[NOT_FOUND]');
    await expect(read('old', schedule)).rejects.toThrow('[NOT_FOUND]');
    push(DEVICE_LINK_PUSH.REMOTE_PUSH, { deviceId: 'old', channel: 'maker:schedule:event', payload: { type: 'ready' } });
    await expect(read()).rejects.toThrow('[NOT_FOUND]');
    await expect(read('old', schedule)).resolves.toEqual(['run']);
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['maker:schedule:list', missing('maker:schedule:list')],
    ['maker:schedule:list-sidebar-index-runs', missing('maker:schedule:list-sidebar-index-runs')],
    [contextLimit, disallowedRemotely(contextLimit)],
    [modelGroups, disallowedRemotely(modelGroups)],
  ])('retries %s on an upgraded peer even when initial presence arrived before the first probe', async (channel, failure) => {
    const { read, invoke, push } = fixture();
    const presence = (appVersion: string) => push(DEVICE_LINK_PUSH.PRESENCE_CHANGED, {
      deviceId: 'old', online: true, remoteControlEnabled: true, appVersion,
    });
    presence('1');
    invoke.mockRejectedValueOnce(failure).mockResolvedValueOnce(['run']);
    await expect(read('old', channel)).rejects.toThrow();
    await expect(read('old', channel)).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(1);
    presence('2');
    await expect(read('old', channel)).resolves.toEqual(['run']);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('invalidates a miss when the peer first reports its version after the read', async () => {
    const { read, invoke, push } = fixture();
    invoke.mockRejectedValueOnce(disallowedRemotely(modelGroups)).mockResolvedValueOnce(['available']);
    await expect(read('old', modelGroups)).rejects.toThrow('not allowed remotely');
    push(DEVICE_LINK_PUSH.PRESENCE_CHANGED, { deviceId: 'old', online: true, appVersion: '2' });
    await expect(read('old', modelGroups)).resolves.toEqual(['available']);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('rechecks after changed capabilities, but not an identical handshake or routine presence', async () => {
    const { bridge, invoke, read, push } = fixture();
    let capabilities: string[] = [];
    invoke.mockImplementation(async (method: string) => {
      if (method === DEVICE_LINK_INVOKE.OPEN_LINK) return { appVersion: '1', allowlistHash: 'a', capabilities };
      if (!capabilities.length) throw disallowedRemotely(modelGroups);
      return ['available'];
    });
    await bridge.openLink('old');
    await expect(read('old', modelGroups)).rejects.toThrow('[DEVICE_LINK_CHANNEL_NOT_ALLOWED]');
    push(DEVICE_LINK_PUSH.PRESENCE_CHANGED, { deviceId: 'old', online: true, remoteControlEnabled: true, appVersion: '1', busy: true });
    await bridge.openLink('old');
    await expect(read('old', modelGroups)).rejects.toThrow('[DEVICE_LINK_CHANNEL_NOT_ALLOWED]');
    expect(invoke.mock.calls.filter(([method]) => method === DEVICE_LINK_INVOKE.INVOKE)).toHaveLength(1);
    capabilities = ['new'];
    await bridge.openLink('old');
    await expect(read('old', modelGroups)).resolves.toEqual(['available']);
  });

  it('does not let a stale openLink handshake overwrite knownVersions after peer reset or upgrade', async () => {
    const { bridge, invoke, read, push } = fixture();
    let resolveStaleHandshake!: (accepted: { appVersion: string; allowlistHash: string; capabilities: string[] }) => void;
    invoke
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveStaleHandshake = resolve;
          }),
      )
      .mockRejectedValueOnce(disallowedRemotely(modelGroups))
      .mockResolvedValueOnce(['upgraded']);

    const staleOpen = bridge.openLink('old');
    // Peer resets and comes back at v2 before the old v1 openLink settles.
    push(DEVICE_LINK_PUSH.PEER_LINK_RESET, { deviceId: 'old' });
    push(DEVICE_LINK_PUSH.PRESENCE_CHANGED, {
      deviceId: 'old',
      online: true,
      remoteControlEnabled: true,
      appVersion: '2',
    });
    resolveStaleHandshake({ appVersion: '1', allowlistHash: 'old-hash', capabilities: [] });
    await staleOpen;

    // Subsequent probe at v2 caches miss under version '2' (not clobbered back to '1').
    await expect(read('old', modelGroups)).rejects.toThrow('[DEVICE_LINK_CHANNEL_NOT_ALLOWED]');
    // Routine v2 heartbeat keeps the cached miss because knownVersions stayed '2'.
    push(DEVICE_LINK_PUSH.PRESENCE_CHANGED, {
      deviceId: 'old',
      online: true,
      remoteControlEnabled: true,
      appVersion: '2',
    });
    await expect(read('old', modelGroups)).rejects.toThrow('[DEVICE_LINK_CHANNEL_NOT_ALLOWED]');
    expect(invoke.mock.calls.filter(([method]) => method === DEVICE_LINK_INVOKE.INVOKE)).toHaveLength(1);

    // Real upgrade to v3 clears the miss and succeeds.
    push(DEVICE_LINK_PUSH.PRESENCE_CHANGED, {
      deviceId: 'old',
      online: true,
      remoteControlEnabled: true,
      appVersion: '3',
    });
    await expect(read('old', modelGroups)).resolves.toEqual(['upgraded']);
  });
});
