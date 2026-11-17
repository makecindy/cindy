/**
 * 测试价值
 * - 生产入口与可观察结果:`classifyPeerTransportRoute` —— 出站路径诊断(#9537)用来决定
 *   「这个对端的真实 socket 是哪一条」的分类表;断言的是每种承载连接各自归到哪条线路。
 * - Bug/规则依据:#9959 Codex review P2「legacy 路由的 transport URL 要能解析出来」——
 *   旧同账号对端被路由到独立的 legacy 连接时,它的 WebSocket URL 是已知的(当前中转),
 *   早先当成「不可知的 scoped 连接」一律返回 null,那种配置下所有 degraded 的中继路径
 *   会话都变成「没有判定」。
 * - 现有覆盖缺口:这张表此前散在 if 链里,没有用例钉住;legacy 与跨账号连接可能是同一条
 *   (跨账号帧也走 legacy),顺序错了会把当前中转说成官方中转。
 * - 最小失败输入:承载连接既不是主连接也不是跨账号连接、而对端不是 scoped 对端。
 * - tier:unit(纯函数)。
 */
import { describe, expect, it } from 'vitest';

import { classifyPeerTransportRoute } from '../peerTransportRoute';

describe('classifyPeerTransportRoute', () => {
  it('承载连接是主连接 → primary', () => {
    expect(classifyPeerTransportRoute({
      isPrimary: true, isLegacy: false, isCrossAccount: false, isScopedPeer: false,
    })).toBe('primary');
  });

  it('承载连接是跨账号的官方连接 → cross-account', () => {
    expect(classifyPeerTransportRoute({
      isPrimary: false, isLegacy: false, isCrossAccount: true, isScopedPeer: true,
    })).toBe('cross-account');
  });

  it('承载连接是 legacy 连接 → legacy(哪怕它同时也是跨账号连接)', () => {
    // 跨账号帧也走 legacy 时(crossAccountUsesLegacy),这条连接用的是当前中转,
    // 不是官方中转 —— legacy 必须排在 cross-account 前面。
    expect(classifyPeerTransportRoute({
      isPrimary: false, isLegacy: true, isCrossAccount: true, isScopedPeer: true,
    })).toBe('legacy');
  });

  it('同账号对端落在别的连接上 → legacy(它的中转 URL 是已知的)', () => {
    expect(classifyPeerTransportRoute({
      isPrimary: false, isLegacy: false, isCrossAccount: false, isScopedPeer: false,
    })).toBe('legacy');
  });

  it('scoped 对端落在按资源安装的连接上 → scoped-unknown(URL 静态不可知)', () => {
    expect(classifyPeerTransportRoute({
      isPrimary: false, isLegacy: false, isCrossAccount: false, isScopedPeer: true,
    })).toBe('scoped-unknown');
  });
});
