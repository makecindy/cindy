/**
 * remoteProjectsStore — vitest 单测(push 驱动纯镜像)
 *
 * 覆盖 device-link 控制端内存层的核心不变量:
 *  - setDeviceSessions:打 device-link origin 标记 + 合并扁平列表 + sessionId→deviceId 注册 + 引用稳定
 *  - applyPatch:就地幂等合并 / status=deleted|archived 移出分片 / 落到未知 session 丢弃
 *  - epoch:旧 snapshot 不覆盖新 snapshot(乱序保护)
 *  - markDeviceDisconnected:断线保留快照 + 在线索引清理;removeDevice / clear:明确移除时清理
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  remoteProjectsStore,
  getSessionDeviceId,
  retryRemoteSessionBootstrap,
  setRemoteReseedImpl,
  setRemoteSessionBootstrapRetryImpl,
} from '@/features/device-link/remoteProjectsStore';
import type { Session } from '@/lib/ccAgent.types';

/** 造一个最小可用 Session(store 只存/透传,不校验字段)。 */
function mk(id: string, partial: Partial<Session> = {}): Session {
  return {
    id,
    userId: 'u',
    title: partial.title ?? id,
    workingDir: partial.workingDir ?? `/proj/${id}`,
    workspaceKind: 'project',
    model: partial.model ?? 'gpt-5.4',
    effort: (partial.effort ?? 'medium') as Session['effort'],
    permissionMode: (partial.permissionMode ?? 'default') as Session['permissionMode'],
    sdkSessionId: null,
    totalTokenUsage: 0,
    totalCostUsd: 0,
    contextTokens: 0,
    contextWindow: 0,
    fastMode: partial.fastMode ?? false,
    clearedAt: null,
    pinnedAt: partial.pinnedAt ?? null,
    userSendAt: '2026-01-01T00:00:00.000Z',
    status: partial.status ?? 'active',
    agentKind: partial.agentKind ?? 'cc',
    // fork 占位判据要看它(与被控端 getOverwritableAutoTitle 同一条规则)。
    parentSessionId: partial.parentSessionId ?? null,
    extraDirs: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('remoteProjectsStore', () => {
  beforeEach(() => {
    setRemoteReseedImpl(null);
    setRemoteSessionBootstrapRetryImpl(null);
    remoteProjectsStore.clear();
    remoteProjectsStore.__resetPendingTitlePreviewForTest();
    // 钉子刻意不随 clear() 消失(见 pinnedOrigins),所以测试间必须显式清,否则会串用例。
    remoteProjectsStore.__resetPinnedOriginsForTest();
  });

  it('把用户的任务重试动作交给 listing tier 注册的 bootstrap 实现', () => {
    const retry = vi.fn();
    setRemoteSessionBootstrapRetryImpl(retry);

    retryRemoteSessionBootstrap('dev-B');

    expect(retry).toHaveBeenCalledWith('dev-B');
    expect(retry).toHaveBeenCalledTimes(1);
  });

  describe('origin 钉子(pinSessionOrigin)', () => {
    it('远程新建会话后 origin 立刻可判定,即使权威快照还没到', () => {
      remoteProjectsStore.pinSessionOrigin('dev-B', 'new-1');
      // 传输层据此走隧道 —— 没有钉子时它返回 undefined,首条消息就发给本机 maker。
      expect(getSessionDeviceId('new-1')).toBe('dev-B');
    });

    it('钉子只影响 origin 判定,不伪造会话行', () => {
      remoteProjectsStore.pinSessionOrigin('dev-B', 'new-1');
      // 会话进列表仍等权威快照:侧边栏不该出现一条字段全靠猜的行。
      expect(remoteProjectsStore.getMergedRemoteSessions()).toHaveLength(0);
      expect(remoteProjectsStore.getDeviceSessions('dev-B')).toHaveLength(0);
    });

    it('权威快照到达后归属不变,且该会话正常进入列表', () => {
      remoteProjectsStore.pinSessionOrigin('dev-B', 'new-1');
      remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('new-1'), mk('s2')]);
      expect(getSessionDeviceId('new-1')).toBe('dev-B');
      expect(remoteProjectsStore.getMergedRemoteSessions()).toHaveLength(2);
    });

    it('钉子跨 clear() 存活:relay 瞬时重连不该让远程会话看起来像本机会话', () => {
      remoteProjectsStore.pinSessionOrigin('dev-B', 'new-1');
      remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('new-1')]);
      remoteProjectsStore.clear();
      // 分片没了(镜像随链路重建),但归属仍然成立 —— 否则重建窗口里的操作会落到本机执行。
      expect(remoteProjectsStore.getMergedRemoteSessions()).toHaveLength(0);
      expect(getSessionDeviceId('new-1')).toBe('dev-B');
    });

    it('重复钉同一条是幂等的', () => {
      remoteProjectsStore.pinSessionOrigin('dev-B', 'new-1');
      const before = remoteProjectsStore.getMergedRemoteSessions();
      remoteProjectsStore.pinSessionOrigin('dev-B', 'new-1');
      expect(remoteProjectsStore.getMergedRemoteSessions()).toBe(before);
      expect(getSessionDeviceId('new-1')).toBe('dev-B');
    });
  });

  it('stamps device-link origin, merges sessions, and registers sessionId→deviceId', () => {
    remoteProjectsStore.setDeviceSessions('dev-B', 'Bob Mac', [mk('s1'), mk('s2')]);
    const merged = remoteProjectsStore.getMergedRemoteSessions();
    expect(merged).toHaveLength(2);
    for (const s of merged) {
      expect(s.deviceLinkDeviceId).toBe('dev-B');
      expect(s.deviceLinkDeviceName).toBe('Bob Mac');
      expect(s.deviceLinkConnectionStatus).toBe('connected');
    }
    expect(getSessionDeviceId('s1')).toBe('dev-B');
    expect(getSessionDeviceId('unknown')).toBeUndefined();
  });

  it('merges multiple devices and keeps origin per device', () => {
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1')]);
    remoteProjectsStore.setDeviceSessions('dev-C', 'C', [mk('s2')]);
    expect(remoteProjectsStore.getMergedRemoteSessions()).toHaveLength(2);
    expect(getSessionDeviceId('s1')).toBe('dev-B');
    expect(getSessionDeviceId('s2')).toBe('dev-C');
  });

  it('snapshot reference is stable across no-op (useSyncExternalStore safety)', () => {
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1')]);
    const a = remoteProjectsStore.getMergedRemoteSessions();
    const b = remoteProjectsStore.getMergedRemoteSessions();
    expect(a).toBe(b);
  });

  describe('applyPatch(push 驱动镜像)', () => {
    it('就地幂等合并字段(title / pinnedAt / model)', () => {
      remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1', { model: 'gpt-5.4' })]);
      remoteProjectsStore.applyPatch('dev-B', 's1', { title: 'New', model: 'opus-4-8' });
      const s = remoteProjectsStore.getMergedRemoteSessions().find((x) => x.id === 's1')!;
      expect(s.title).toBe('New');
      expect(s.model).toBe('opus-4-8');
      expect(getSessionDeviceId('s1')).toBe('dev-B'); // origin 标记不丢
    });

    it('status=deleted / archived → 移出分片', () => {
      remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1'), mk('s2')]);
      remoteProjectsStore.applyPatch('dev-B', 's1', { status: 'deleted' });
      expect(remoteProjectsStore.getMergedRemoteSessions().map((x) => x.id)).toEqual(['s2']);
      remoteProjectsStore.applyPatch('dev-B', 's2', { status: 'archived' });
      expect(remoteProjectsStore.getMergedRemoteSessions()).toHaveLength(0);
      expect(getSessionDeviceId('s1')).toBeUndefined();
    });

    it('unpin 后触发 reseed,让仅因 includePinned 补入的旧会话被后续 snapshot 剔除', () => {
      const reseed = vi.fn();
      setRemoteReseedImpl(reseed);
      remoteProjectsStore.setDeviceSessions('dev-B', 'B', [
        mk('old-pinned', { pinnedAt: '2026-01-02T00:00:00.000Z' }),
      ]);

      remoteProjectsStore.applyPatch('dev-B', 'old-pinned', { pinnedAt: null });

      expect(remoteProjectsStore.getMergedRemoteSessions()[0].pinnedAt).toBeNull();
      expect(reseed).toHaveBeenCalledWith('dev-B');
      expect(reseed).toHaveBeenCalledTimes(1);
    });

    it('落到未知 session 丢弃(不造壳)', () => {
      remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1')]);
      remoteProjectsStore.applyPatch('dev-B', 'ghost', { title: 'X' });
      expect(remoteProjectsStore.getMergedRemoteSessions().map((x) => x.id)).toEqual(['s1']);
    });

    it('未知设备 no-op', () => {
      remoteProjectsStore.applyPatch('dev-Z', 's1', { title: 'X' });
      expect(remoteProjectsStore.getMergedRemoteSessions()).toHaveLength(0);
    });
  });

  describe('snapshot epoch(乱序保护)', () => {
    it('旧 snapshot 不覆盖新 snapshot', () => {
      remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1', { model: 'old' })]);
      // 模拟两次重拉:先发起 e1(旧),再发起 e2(新);e2 先 set,e1 后到应被丢弃。
      const e1 = remoteProjectsStore.nextSnapshotEpoch('dev-B');
      const e2 = remoteProjectsStore.nextSnapshotEpoch('dev-B');
      expect(remoteProjectsStore.isLatestSnapshotEpoch('dev-B', e2)).toBe(true);
      // e2 的结果落地
      if (remoteProjectsStore.isLatestSnapshotEpoch('dev-B', e2)) {
        remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1', { model: 'new' })]);
      }
      // e1(旧)回来:已非最新 → 调用方据 isLatestSnapshotEpoch 丢弃,不 set
      expect(remoteProjectsStore.isLatestSnapshotEpoch('dev-B', e1)).toBe(false);
      const s = remoteProjectsStore.getMergedRemoteSessions().find((x) => x.id === 's1')!;
      expect(s.model).toBe('new');
    });

    it('removeDevice 即使无 shard 也失效 epoch:在途 refresh 不会把已移除设备会话加回', () => {
      // 设备首次 bootstrap 还没建 shard 就被移除(下线/关被控),此刻在途 refresh 已取 epoch。
      const e = remoteProjectsStore.nextSnapshotEpoch('dev-X'); // 无 shard
      remoteProjectsStore.removeDevice('dev-X');
      // 在途 refresh await 回来:epoch 已失效 → isLatestSnapshotEpoch=false → 调用方丢弃结果。
      expect(remoteProjectsStore.isLatestSnapshotEpoch('dev-X', e)).toBe(false);
    });

    it('clear() 即使无 shard 也清 epoch:断连时在途首拉不会把会话加回', () => {
      // relay 断连(connecting/stopped)调 clear();某设备首拉还在途、shard 未建,此刻已取 epoch。
      const e = remoteProjectsStore.nextSnapshotEpoch('dev-Y'); // 无 shard
      remoteProjectsStore.clear();
      // 在途首拉 await 回来:epoch 已被 clear 失效 → 调用方据 isLatestSnapshotEpoch 丢弃,不 set。
      expect(remoteProjectsStore.isLatestSnapshotEpoch('dev-Y', e)).toBe(false);
    });

    it('[ABA] removeDevice 后重新 bootstrap 的 epoch 不复用旧值,断连前的在途响应永久失效', () => {
      const e1 = remoteProjectsStore.nextSnapshotEpoch('dev-A'); // 断连前在途
      remoteProjectsStore.removeDevice('dev-A'); // 移除 → 自增(非归零)
      const e2 = remoteProjectsStore.nextSnapshotEpoch('dev-A'); // reconnect 后新一轮
      expect(e2).not.toBe(e1); // 关键:不复用 → 无 ABA
      expect(e2).toBeGreaterThan(e1);
      // 断连前在途响应(e1)即使在新一轮发起后回来,也已永久失效,不会盖回新 snapshot。
      expect(remoteProjectsStore.isLatestSnapshotEpoch('dev-A', e1)).toBe(false);
      expect(remoteProjectsStore.isLatestSnapshotEpoch('dev-A', e2)).toBe(true);
    });

    it('[ABA] clear() 后重新 bootstrap 的 epoch 不复用旧值', () => {
      const e1 = remoteProjectsStore.nextSnapshotEpoch('dev-A');
      remoteProjectsStore.clear(); // 断连 → 全部自增(非 clear-to-0)
      const e2 = remoteProjectsStore.nextSnapshotEpoch('dev-A');
      expect(e2).not.toBe(e1);
      expect(e2).toBeGreaterThan(e1);
      expect(remoteProjectsStore.isLatestSnapshotEpoch('dev-A', e1)).toBe(false);
    });
  });

  it('removeDevice clears shard + registry', () => {
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1')]);
    remoteProjectsStore.removeDevice('dev-B');
    expect(remoteProjectsStore.getMergedRemoteSessions()).toHaveLength(0);
    expect(getSessionDeviceId('s1')).toBeUndefined();
    expect(remoteProjectsStore.getDeviceIds()).toHaveLength(0);
  });

  it('markDeviceDisconnected keeps sessions visible but removes the device from the online index', () => {
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1'), mk('s2')]);
    remoteProjectsStore.markDeviceDisconnected('dev-B');

    const merged = remoteProjectsStore.getMergedRemoteSessions();
    expect(merged.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(merged.every((s) => s.deviceLinkConnectionStatus === 'disconnected')).toBe(true);
    // origin 保留:打开会话仍知道要走哪个 device-link 隧道,连接状态由 banner / invoke 错误处理。
    expect(getSessionDeviceId('s1')).toBe('dev-B');
    // 在线索引清掉:useRemoteSessionConnection 会显示 host-offline。
    expect(remoteProjectsStore.getDeviceIds()).toEqual([]);
    expect(remoteProjectsStore.getDeviceList()).toEqual([
      { deviceId: 'dev-B', deviceName: 'B', sessionCount: 2, connected: false },
    ]);
  });

  it('setDeviceSessions reconnects a disconnected cached shard', () => {
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1')]);
    remoteProjectsStore.markDeviceDisconnected('dev-B');
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1')]);

    expect(remoteProjectsStore.getMergedRemoteSessions()[0].deviceLinkConnectionStatus).toBe(
      'connected',
    );
    expect(remoteProjectsStore.getDeviceIds()).toEqual(['dev-B']);
    expect(remoteProjectsStore.getDeviceList()).toEqual([
      { deviceId: 'dev-B', deviceName: 'B', sessionCount: 1, connected: true },
    ]);
  });

  it('tracks loading/error independently from an existing shard and clears both after a successful snapshot', () => {
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('old')]);
    remoteProjectsStore.markBootstrapLoading('dev-B');
    expect([...remoteProjectsStore.getBootstrapLoadingDeviceIds()]).toEqual(['dev-B']);
    expect(remoteProjectsStore.getDeviceSessions('dev-B').map((session) => session.id)).toEqual([
      'old',
    ]);

    const before = remoteProjectsStore.getBootstrapFailedDeviceIds();
    remoteProjectsStore.markBootstrapFailed('dev-B');
    expect(remoteProjectsStore.getBootstrapLoadingDeviceIds().size).toBe(0);
    const failed = remoteProjectsStore.getBootstrapFailedDeviceIds();
    expect(failed).not.toBe(before);
    expect([...failed]).toEqual(['dev-B']);

    remoteProjectsStore.markBootstrapFailed('dev-B');
    expect(remoteProjectsStore.getBootstrapFailedDeviceIds()).toBe(failed);

    remoteProjectsStore.setDeviceSessions('dev-B', 'B', []);
    expect(remoteProjectsStore.getBootstrapLoadingDeviceIds().size).toBe(0);
    expect(remoteProjectsStore.getBootstrapFailedDeviceIds().size).toBe(0);
  });

  it('disconnect, removeDevice and clear discard bootstrap activity even before a shard exists', () => {
    remoteProjectsStore.markBootstrapLoading('dev-loading');
    remoteProjectsStore.markDeviceDisconnected('dev-loading');
    expect(remoteProjectsStore.getBootstrapLoadingDeviceIds().size).toBe(0);

    remoteProjectsStore.markBootstrapFailed('dev-A');
    remoteProjectsStore.removeDevice('dev-A');
    expect(remoteProjectsStore.getBootstrapFailedDeviceIds().size).toBe(0);

    remoteProjectsStore.markBootstrapLoading('dev-A');
    remoteProjectsStore.markBootstrapFailed('dev-B');
    remoteProjectsStore.clear();
    expect(remoteProjectsStore.getBootstrapLoadingDeviceIds().size).toBe(0);
    expect(remoteProjectsStore.getBootstrapFailedDeviceIds().size).toBe(0);
  });

  it('clear resets everything', () => {
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1'), mk('s2')]);
    remoteProjectsStore.clear();
    expect(remoteProjectsStore.getMergedRemoteSessions()).toHaveLength(0);
    expect(getSessionDeviceId('s1')).toBeUndefined();
    expect(remoteProjectsStore.getDeviceIds()).toHaveLength(0);
  });

  it('applyPatch 只换被 patch 设备的会话对象引用,其它设备会话引用稳定(防级联重渲染)', () => {
    remoteProjectsStore.setDeviceSessions('dev-A', 'A', [mk('a1'), mk('a2')]);
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('b1')]);
    const before = remoteProjectsStore.getMergedRemoteSessions();
    const a1Before = before.find((x) => x.id === 'a1')!;
    const a2Before = before.find((x) => x.id === 'a2')!;

    remoteProjectsStore.applyPatch('dev-B', 'b1', { title: 'B1!' });

    const after = remoteProjectsStore.getMergedRemoteSessions();
    expect(after).not.toBe(before); // 扁平快照 recompute 换新数组
    // dev-A 的会话对象引用未变(只有 dev-B 分片被 .map);否则 React 会无谓重渲所有设备项。
    expect(after.find((x) => x.id === 'a1')).toBe(a1Before);
    expect(after.find((x) => x.id === 'a2')).toBe(a2Before);
    // 被 patch 的 dev-B 会话是新对象 + 新值。
    expect(after.find((x) => x.id === 'b1')!.title).toBe('B1!');
  });

  it('renameDevice:重打 deviceLinkDeviceName + 通知 subscribeRename;同名时不重算(引用稳定)', () => {
    remoteProjectsStore.setDeviceSessions('dev-B', 'Old', [mk('s1')]);
    const seen: Array<[string, string]> = [];
    const off = remoteProjectsStore.subscribeRename((id, name) => seen.push([id, name]));

    remoteProjectsStore.renameDevice('dev-B', 'New');
    expect(
      remoteProjectsStore.getMergedRemoteSessions().find((x) => x.id === 's1')!
        .deviceLinkDeviceName,
    ).toBe('New');
    expect(seen).toEqual([['dev-B', 'New']]);

    // 同名:分片名未变 → 不 recompute(扁平快照引用不变),避免无谓重渲。
    const beforeSameName = remoteProjectsStore.getMergedRemoteSessions();
    remoteProjectsStore.renameDevice('dev-B', 'New');
    expect(remoteProjectsStore.getMergedRemoteSessions()).toBe(beforeSameName);
    off();
  });
});

/**
 * 标题预览叠加层:控制端发送瞬间即时显示占位,不等被控端那一次隧道往返;
 * 分片数据仍是纯镜像(不被本地改写),被控端权威标题一到自动让位。
 */
describe('remoteProjectsStore pending title preview', () => {
  beforeEach(() => {
    setRemoteReseedImpl(null);
    remoteProjectsStore.clear();
    remoteProjectsStore.__resetPendingTitlePreviewForTest();
  });

  it('shows the preview while the authoritative title is still the default placeholder', () => {
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1', { title: 'New Maker' })]);

    remoteProjectsStore.setPendingTitlePreview('s1', '帮我排查登录失败');

    expect(remoteProjectsStore.getMergedRemoteSessions()[0]?.title).toBe('帮我排查登录失败');
    // 分片本身没有被改写 —— 纯镜像不变量。
    expect(remoteProjectsStore.getDeviceSessions('dev-B')[0]?.title).toBe('New Maker');
  });

  it('yields to the authoritative title as soon as the controlled device writes one', () => {
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1', { title: 'New Maker' })]);
    remoteProjectsStore.setPendingTitlePreview('s1', '帮我排查登录失败');

    // 被控端回流占位 → 权威值胜出。
    remoteProjectsStore.applyPatch('dev-B', 's1', { title: '帮我排查登录失败' });
    expect(remoteProjectsStore.getMergedRemoteSessions()[0]?.title).toBe('帮我排查登录失败');

    // 再回流智能标题 → 预览已回收,不会把它顶回去。
    remoteProjectsStore.applyPatch('dev-B', 's1', { title: '登录失败排查' });
    expect(remoteProjectsStore.getMergedRemoteSessions()[0]?.title).toBe('登录失败排查');
  });

  it('previews over a synthesized placeholder the controller itself registered', () => {
    // 纯附件首条消息:被控端把标题写成文件名。用户随后打下第一句话时,控制端同样
    // 要即时顶上 —— 只认默认占位的话,即时性恰好在这条恢复路径上缺席(review P1)。
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1', { title: 'New Maker' })]);
    remoteProjectsStore.setPendingTitlePreview('s1', '设计稿-v3.png', false);
    remoteProjectsStore.applyPatch('dev-B', 's1', { title: '设计稿-v3.png' });
    expect(remoteProjectsStore.getMergedRemoteSessions()[0]?.title).toBe('设计稿-v3.png');

    remoteProjectsStore.setPendingTitlePreview('s1', '这个报错怎么修');

    expect(remoteProjectsStore.getMergedRemoteSessions()[0]?.title).toBe('这个报错怎么修');
    // 分片仍是纯镜像。
    expect(remoteProjectsStore.getDeviceSessions('dev-B')[0]?.title).toBe('设计稿-v3.png');

    // 智能标题落地 → 归属作废,后续预览不再生效。
    remoteProjectsStore.applyPatch('dev-B', 's1', { title: '报错排查' });
    expect(remoteProjectsStore.getMergedRemoteSessions()[0]?.title).toBe('报错排查');
    remoteProjectsStore.setPendingTitlePreview('s1', '又一条消息');
    expect(remoteProjectsStore.getMergedRemoteSessions()[0]?.title).toBe('报错排查');
  });

  it('previews over a fork placeholder (system-owned, parentSessionId present)', () => {
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [
      mk('s1', { title: '[Fork] 源会话标题', parentSessionId: 'src-1' }),
    ]);

    remoteProjectsStore.setPendingTitlePreview('s1', '这个报错怎么修');

    expect(remoteProjectsStore.getMergedRemoteSessions()[0]?.title).toBe('这个报错怎么修');
  });

  it('treats a user-named "[Fork] ..." session without parentSessionId as manual', () => {
    // 与被控端 getOverwritableAutoTitle 同一条判据:没有 parentSessionId 就不是
    // fork 占位,是用户自己起的名。
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [
      mk('s1', { title: '[Fork] 我自己起的名' }),
    ]);

    remoteProjectsStore.setPendingTitlePreview('s1', '这个报错怎么修');

    expect(remoteProjectsStore.getMergedRemoteSessions()[0]?.title).toBe('[Fork] 我自己起的名');
  });

  it('drops synthesized-title provenance together with the session (archive / device removal)', () => {
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1', { title: 'New Maker' })]);
    remoteProjectsStore.setPendingTitlePreview('s1', '设计稿-v3.png', false);
    remoteProjectsStore.applyPatch('dev-B', 's1', { title: '设计稿-v3.png' });
    remoteProjectsStore.applyPatch('dev-B', 's1', { status: 'archived' });

    // unarchive 回来:归属已随会话回收,旧的合成标题不再被当成系统占位。
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1', { title: '设计稿-v3.png' })]);
    remoteProjectsStore.setPendingTitlePreview('s1', '这个报错怎么修');

    expect(remoteProjectsStore.getMergedRemoteSessions()[0]?.title).toBe('设计稿-v3.png');
  });

  it('does not claim provenance for a prose title that the host settles on', () => {
    // 首句是用户文字、标题模型无结果时,被控端就地定稿 —— 那是终态标题,不是占位。
    // 靠"预览与权威值相等"推断归属会把它记成系统占位,之后每条消息的预览都能盖着
    // 它不放,而权威侧再也不会发新 patch 纠正(review P1)。
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1', { title: 'New Maker' })]);
    remoteProjectsStore.setPendingTitlePreview('s1', '帮我排查登录失败', true);
    remoteProjectsStore.applyPatch('dev-B', 's1', { title: '帮我排查登录失败' });

    remoteProjectsStore.setPendingTitlePreview('s1', '第二条消息', true);

    expect(remoteProjectsStore.getMergedRemoteSessions()[0]?.title).toBe('帮我排查登录失败');
  });

  it('keeps the newer prose preview when an older synthesized patch lands late', () => {
    // 用户在附件占位回流之前就打了字:旧占位 A 随后才到,它既不等于当前预览 B、
    // 也不在归属表里,会被当成手动改名而把 B 整个丢掉,侧边栏回退到附件名
    // 直到下一跳(review P1)。
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1', { title: 'New Maker' })]);
    remoteProjectsStore.setPendingTitlePreview('s1', '设计稿-v3.png', false);
    remoteProjectsStore.setPendingTitlePreview('s1', '这个报错怎么修', true);

    // 迟到的 A 补丁。
    remoteProjectsStore.applyPatch('dev-B', 's1', { title: '设计稿-v3.png' });
    expect(remoteProjectsStore.getMergedRemoteSessions()[0]?.title).toBe('这个报错怎么修');

    // 随后 B 的权威补丁到达 → 叠加层整体作废,后续预览不再生效。
    remoteProjectsStore.applyPatch('dev-B', 's1', { title: '这个报错怎么修' });
    expect(remoteProjectsStore.getMergedRemoteSessions()[0]?.title).toBe('这个报错怎么修');
    remoteProjectsStore.setPendingTitlePreview('s1', '又一条消息', true);
    expect(remoteProjectsStore.getMergedRemoteSessions()[0]?.title).toBe('这个报错怎么修');
  });

  it('never treats a manual rename arriving mid-preview as a synthesized confirmation', () => {
    // 用户在合成预览在途时手动改了名 —— 那是权威的、他自己起的名字。若把"下一个
    // 非默认标题"一律当成合成占位登记,之后的预览就能长期顶掉它,而被控端正确地
    // 拒绝给手动命名的会话改名、不会有 patch 来纠正(review P1)。
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1', { title: 'New Maker' })]);
    remoteProjectsStore.setPendingTitlePreview('s1', '设计稿-v3.png', false);

    remoteProjectsStore.applyPatch('dev-B', 's1', { title: '我自己起的名字' });
    remoteProjectsStore.setPendingTitlePreview('s1', '这个报错怎么修', true);

    expect(remoteProjectsStore.getMergedRemoteSessions()[0]?.title).toBe('我自己起的名字');
  });

  it('跨语种占位登记不上时只丢失即时预览,不影响权威改名', () => {
    // 已知且刻意接受的降级:两端 UI 语言不同、且首条消息只能回落到 i18n 类别词
    // (粘贴截图)时,两端算出的串不逐字相等,归属登记不上。表现为后续首句话没有
    // 即时预览,仍会经隧道往返正常改名 —— 少一次即时性,好过顶掉用户的名字。
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1', { title: 'New Maker' })]);
    remoteProjectsStore.setPendingTitlePreview('s1', 'Image', false);
    remoteProjectsStore.applyPatch('dev-B', 's1', { title: '图片' });

    remoteProjectsStore.setPendingTitlePreview('s1', '这个报错怎么修', true);
    expect(remoteProjectsStore.getMergedRemoteSessions()[0]?.title).toBe('图片');

    // 权威改名照常到达。
    remoteProjectsStore.applyPatch('dev-B', 's1', { title: '这个报错怎么修' });
    expect(remoteProjectsStore.getMergedRemoteSessions()[0]?.title).toBe('这个报错怎么修');
  });

  it('drops overlays for sessions a full snapshot no longer contains', () => {
    // 权威快照整片替换分片:patch 丢失期间被归档的会话就此离场,叠加层若不在这里
    // 回收,removeDevice 也够不着它,unarchive/reseed 后旧预览会复活(review P1)。
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [
      mk('s1', { title: 'New Maker' }),
      mk('s2', { title: 'New Maker' }),
    ]);
    remoteProjectsStore.setPendingTitlePreview('s1', '帮我排查登录失败');

    // s1 没在这次快照里回来 → 离场。
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s2', { title: 'New Maker' })]);
    // unarchive/reseed 把它拉回来,权威标题仍是默认占位。
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [
      mk('s1', { title: 'New Maker' }),
      mk('s2', { title: 'New Maker' }),
    ]);

    expect(remoteProjectsStore.getMergedRemoteSessions().find((s) => s.id === 's1')?.title).toBe(
      'New Maker',
    );
  });

  it('keeps overlays for sessions merged back by a partial anti-entropy window', () => {
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [
      mk('s1', { title: 'New Maker' }),
      mk('s2', { title: 'New Maker' }),
    ]);
    remoteProjectsStore.setPendingTitlePreview('s1', '帮我排查登录失败');

    // 半窗口 anti-entropy:s1 不在本次窗口内,但 mergeDeviceSessions 会把它并回来。
    remoteProjectsStore.mergeDeviceSessions('dev-B', 'B', [mk('s2', { title: 'New Maker' })]);

    expect(remoteProjectsStore.getMergedRemoteSessions().find((s) => s.id === 's1')?.title).toBe(
      '帮我排查登录失败',
    );
  });

  it('clears stale synthesized provenance once a prose preview is confirmed', () => {
    // 合成占位 A 落地后又来了用户文字 B;B 被权威确认时 A 的归属必须一并作废,
    // 否则用户日后手动把标题改回 A,会被误判成系统占位而被预览长期顶替 —— 权威侧
    // 正确地拒绝给手动命名的会话改名,不会有 patch 来纠正(review P1)。
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1', { title: 'New Maker' })]);
    remoteProjectsStore.setPendingTitlePreview('s1', '设计稿-v3.png', false);
    remoteProjectsStore.applyPatch('dev-B', 's1', { title: '设计稿-v3.png' });
    remoteProjectsStore.setPendingTitlePreview('s1', '这个报错怎么修', true);
    remoteProjectsStore.applyPatch('dev-B', 's1', { title: '这个报错怎么修' });

    // 用户手动改回那个合成串。
    remoteProjectsStore.applyPatch('dev-B', 's1', { title: '设计稿-v3.png' });
    remoteProjectsStore.setPendingTitlePreview('s1', '又一条消息', true);

    expect(remoteProjectsStore.getMergedRemoteSessions()[0]?.title).toBe('设计稿-v3.png');
  });

  it('never overrides a title the user already renamed on the controlled device', () => {
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1', { title: '我自己起的名字' })]);

    remoteProjectsStore.setPendingTitlePreview('s1', '帮我排查登录失败');

    expect(remoteProjectsStore.getMergedRemoteSessions()[0]?.title).toBe('我自己起的名字');
  });

  it('survives a snapshot rebuild while the authoritative title stays default', () => {
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1', { title: 'New Maker' })]);
    remoteProjectsStore.setPendingTitlePreview('s1', '帮我排查登录失败');

    // anti-entropy 重拉:权威标题仍是默认占位 → 预览继续顶着,不闪回 New Maker。
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1', { title: 'New Maker' })]);

    expect(remoteProjectsStore.getMergedRemoteSessions()[0]?.title).toBe('帮我排查登录失败');
  });

  it('drops previews for a removed device (revoke / stop control)', () => {
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1', { title: 'New Maker' })]);
    remoteProjectsStore.setPendingTitlePreview('s1', '帮我排查登录失败');

    remoteProjectsStore.removeDevice('dev-B');
    // 重新接入后权威标题仍是默认占位 —— 边界前的旧预览不得复活。
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1', { title: 'New Maker' })]);

    expect(remoteProjectsStore.getMergedRemoteSessions()[0]?.title).toBe('New Maker');
  });

  it('drops previews on clear() (logout / device-link stopped)', () => {
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1', { title: 'New Maker' })]);
    remoteProjectsStore.setPendingTitlePreview('s1', '帮我排查登录失败');

    remoteProjectsStore.clear();
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1', { title: 'New Maker' })]);

    expect(remoteProjectsStore.getMergedRemoteSessions()[0]?.title).toBe('New Maker');
  });

  it('drops the preview when the session leaves the shard (archive / delete)', () => {
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1', { title: 'New Maker' })]);
    remoteProjectsStore.setPendingTitlePreview('s1', '帮我排查登录失败');

    // 归档移出分片 —— removeDevice 之后也遍历不到它,预览必须在这里回收。
    remoteProjectsStore.applyPatch('dev-B', 's1', { status: 'archived' });
    // unarchive / reseed 把同一个仍是默认标题的会话拉回来,旧预览不得复活。
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1', { title: 'New Maker' })]);

    expect(remoteProjectsStore.getMergedRemoteSessions()[0]?.title).toBe('New Maker');
  });

  it('no-ops when the authoritative title is already set (avoids write/recompute churn)', () => {
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1', { title: '登录失败排查' })]);
    const before = remoteProjectsStore.getMergedRemoteSessions();

    remoteProjectsStore.setPendingTitlePreview('s1', '帮我排查登录失败');

    // 预览本来就不会生效 —— 不写、不 recompute,快照引用保持不变。
    expect(remoteProjectsStore.getMergedRemoteSessions()).toBe(before);
    expect(remoteProjectsStore.getMergedRemoteSessions()[0]?.title).toBe('登录失败排查');
  });

  it('ignores empty previews and keeps the snapshot reference stable on repeat calls', () => {
    remoteProjectsStore.setDeviceSessions('dev-B', 'B', [mk('s1', { title: 'New Maker' })]);
    remoteProjectsStore.setPendingTitlePreview('s1', '   ');
    expect(remoteProjectsStore.getMergedRemoteSessions()[0]?.title).toBe('New Maker');

    remoteProjectsStore.setPendingTitlePreview('s1', '帮我排查登录失败');
    const first = remoteProjectsStore.getMergedRemoteSessions();
    remoteProjectsStore.setPendingTitlePreview('s1', '帮我排查登录失败');
    expect(remoteProjectsStore.getMergedRemoteSessions()).toBe(first);
  });
});
