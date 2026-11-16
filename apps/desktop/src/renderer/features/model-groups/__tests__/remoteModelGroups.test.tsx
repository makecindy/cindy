// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果：useRemoteModelGroups / commitRemoteModelGroup——给另一台电脑开新任务时，选择器拿到的是
 *   那台的模式、隐藏还是「这次没读到」，以及提交时交给那台的请求。
 * - 规则依据：docs/product-rules/model-groups.md「在另一台电脑上开的新任务」(那台版本较旧时不显示、不改用本机的模式；
 *   读不到时那台重新上线再读一次；只限同账号自己的电脑)。
 * - 现有覆盖缺口：协议与被控端处理在 main 侧测试，这里是发起端唯一区分「旧版不支持」与「暂时读不到」的地方。
 * - 最小失败输入：旧版那台回 CHANNEL_NOT_ALLOWED；读到过之后一次重读超时；一直在线时没读到(要靠发送被挡下重读)；共享任务访客的对端；没有选路凭据的结果；超过协议上限的模型名。
 * - tier：unit，经真实 hook 与真实重连代次，只替换 preload 的 deviceLink 桥。
 * - 实测耗时：单独运行约 1 秒。
 */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { MODEL_GROUPS_REMOTE_CHANNEL, sharedTaskHostPeer } from '@cindy/device-link';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModelGroupResolveResult } from '../../../../shared/modelGroups';
import { parseModelGroupsRemoteRequest } from '../../../../shared/modelGroupsRemote';
import { commitRemoteModelGroup, useRemoteModelGroups } from '../remoteModelGroups';

const CONFIG = {
  routes: [{
    id: 'r1', name: 'Daily', strategy: 'order',
    candidates: [{ agentKind: 'codex', providerId: 'openai', model: 'gpt' }],
  }],
};

function installBridge(invoke: ReturnType<typeof vi.fn>) {
  const presence: Array<(snapshot: { deviceId: string; online: boolean }) => void> = [];
  window.electronAPI = {
    deviceLink: {
      invoke,
      onPresenceChanged: (listener: (snapshot: { deviceId: string; online: boolean }) => void) => {
        presence.push(listener);
        return () => {};
      },
      onStatusChanged: () => () => {},
    },
  } as never;
  return { reconnect: (deviceId: string) => presence.forEach((listener) => {
    listener({ deviceId, online: false });
    listener({ deviceId, online: true });
  }) };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('remote model groups', () => {
  it('hides modes for an older computer instead of borrowing this computer’s', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error(`[DEVICE_LINK_CHANNEL_NOT_ALLOWED] channel '${MODEL_GROUPS_REMOTE_CHANNEL}' is not allowed`));
    installBridge(invoke);
    const { result } = renderHook(() => useRemoteModelGroups('host-pc', true));
    await waitFor(() => expect(result.current).toEqual({ status: 'unsupported' }));
    expect(invoke).toHaveBeenCalledExactlyOnceWith('host-pc', MODEL_GROUPS_REMOTE_CHANNEL, [{ action: 'list' }]);
  });

  it('keeps modes already read when a re-read fails, and re-reads only on reconnect', async () => {
    const invoke = vi.fn().mockResolvedValueOnce({ config: CONFIG }).mockRejectedValueOnce(new Error('[DEVICE_UNRESPONSIVE] timeout'));
    const bridge = installBridge(invoke);
    const { result } = renderHook(() => useRemoteModelGroups('host-pc', true));
    await waitFor(() => expect(result.current).toMatchObject({ status: 'ready', config: { routes: [{ id: 'r1' }] } }));
    act(() => bridge.reconnect('host-pc'));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(result.current).toMatchObject({ status: 'ready', config: { routes: [{ id: 'r1' }] } });

    // 从来没读到过时，这次没读到不当成「没有模式」，也不当成旧版。
    invoke.mockRejectedValueOnce(new Error('[DEVICE_UNRESPONSIVE] timeout'));
    const other = renderHook(({ retry }) => useRemoteModelGroups('other-pc', true, retry), { initialProps: { retry: 0 } });
    await waitFor(() => expect(other.result.current).toEqual({ status: 'error' }));
    // 那台一直在线、没有重连代次时，被挡下的发送触发重读。
    invoke.mockResolvedValueOnce({ config: CONFIG });
    other.rerender({ retry: 1 });
    await waitFor(() => expect(other.result.current).toMatchObject({ status: 'ready' }));
  });

  it('never asks for shared-task peers, and commits only results carrying a receipt', async () => {
    const invoke = vi.fn().mockResolvedValue({ committed: true });
    installBridge(invoke);
    const { result } = renderHook(() => useRemoteModelGroups(sharedTaskHostPeer('task-1', 'owner-pc'), true));
    expect(result.current).toEqual({ status: 'off' });

    const kept = { outcome: 'unavailable', groupName: 'Daily', trace: [] } as ModelGroupResolveResult;
    commitRemoteModelGroup('host-pc', kept, 'session-1', null);
    commitRemoteModelGroup('host-pc', { ...kept, decisionId: 'd1' }, 'session-1', {
      pluginName: 'Daily', outcome: 'kept', modelName: 'GPT', why: 'failed', source: 'model-group',
    });
    expect(invoke).toHaveBeenCalledExactlyOnceWith('host-pc', MODEL_GROUPS_REMOTE_CHANNEL, [{
      action: 'commit', decisionId: 'd1', note: { sessionId: 'session-1', pluginName: 'Daily', outcome: 'kept', modelName: 'GPT' },
    }]);
    // 模型名连同供应商与电脑名超过协议上限时截短，那台照样收下这次提交(PR #10883 review)。
    invoke.mockClear();
    commitRemoteModelGroup('host-pc', { ...kept, decisionId: 'd2' }, 'session-1', {
      pluginName: 'Daily', outcome: 'routed', modelName: `${'m'.repeat(256)} · Pro · Studio`, source: 'model-group',
    });
    const [request] = invoke.mock.calls[0][2];
    expect(parseModelGroupsRemoteRequest(request)).toMatchObject({ action: 'commit', decisionId: 'd2', note: { outcome: 'routed' } });
  });
});
