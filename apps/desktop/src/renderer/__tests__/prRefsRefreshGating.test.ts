/**
 * prRefsRefreshGating.test.ts
 * ---------------------------------------------------------------------------
 * PR 状态刷新的两道省流门控(2026-08-13 用户裁决):
 *   1. 窗口失焦 / 隐藏时跳过 90s 周期刷新——没人在看,后台空转的查询(GitHub
 *      配额 + device-link 隧道)纯属浪费;回到前台由既有的 focus 监听立即全量
 *      补一次,数据不停留在过期态。
 *   2. 设备明确断线时跳过远程隧道查询——失败路径刻意不写 TTL 时间戳(瞬断要
 *      立即重试),但长离线下就成了每周期一轮注定失败的调用 + 告警日志;断线
 *      标记本地同步可得,先看一眼再发。fail-open:shard 缺失(尚未建立 / 设备
 *      已移除)照常尝试,不能把首次查询吞掉。
 *
 * 门控位置用静态扫描守卫(renderer 测试环境无 jsdom;跳过行为的端到端用例见
 * hooks/__tests__/useSessionGitContext.remote.test.ts);断线判定本身是纯 store
 * 读取,直接行为测试。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  isRemoteDeviceMarkedDisconnected,
  remoteProjectsStore,
} from '@/features/device-link/remoteProjectsStore';

const read = (...seg: string[]) => readFileSync(resolve(__dirname, '..', ...seg), 'utf8');

const prRefsSource = read('contexts', 'PrRefsContext.tsx');

describe('PR 状态刷新的省流门控', () => {
  it('周期刷新在失焦/隐藏时跳过,聚焦监听保留(回前台即补)', () => {
    // 守卫必须在 refreshAll 开头——插在循环里或别处等于每会话重复判断/漏判。
    expect(prRefsSource).toMatch(
      /const refreshAll = \(\) => \{\s*\n(?:\s*\/\/[^\n]*\n)*\s*if \(typeof document !== 'undefined' && \(document\.hidden \|\| !document\.hasFocus\(\)\)\) return;/,
    );
    // 暂停的前提:focus 时立即全量刷新的监听还在。删掉它,后台停摆会延续到下个周期。
    expect(prRefsSource).toContain("window.addEventListener('focus', refreshAll)");
  });

  it('远程引用与状态查询都先看设备断线标记', () => {
    // 引用拉取(fetchRefsForRemoteSession):deviceId 是必传参,直接判。
    expect(prRefsSource).toContain('if (isRemoteDeviceMarkedDisconnected(deviceId)) return;');
    // 状态查询(fetchStatusesForRefs 的远程分支):deviceId 可空,先短路。
    expect(prRefsSource).toContain(
      'if (deviceId && isRemoteDeviceMarkedDisconnected(deviceId)) return;',
    );
    expect(prRefsSource).toContain('store.applyStatuses(sessionId, results)');
  });

  it('断线判定只认明确的 disconnected 标记(fail-open)', () => {
    const deviceId = 'pr-gating-test-device';
    try {
      // shard 不存在 → false(首次查询不能被吞掉)。
      expect(isRemoteDeviceMarkedDisconnected(deviceId)).toBe(false);
      // 权威列表到达 = connected。
      remoteProjectsStore.setDeviceSessions(deviceId, 'Test Device', []);
      expect(isRemoteDeviceMarkedDisconnected(deviceId)).toBe(false);
      // 断线快照仍在侧栏展示,正是要跳过的长离线场景。
      remoteProjectsStore.markDeviceDisconnected(deviceId);
      expect(isRemoteDeviceMarkedDisconnected(deviceId)).toBe(true);
      // 重连(权威列表再次到达)即恢复。
      remoteProjectsStore.setDeviceSessions(deviceId, 'Test Device', []);
      expect(isRemoteDeviceMarkedDisconnected(deviceId)).toBe(false);
    } finally {
      remoteProjectsStore.removeDevice(deviceId);
    }
  });
});
