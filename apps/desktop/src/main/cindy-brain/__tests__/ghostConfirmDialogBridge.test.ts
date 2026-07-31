/** ghostConfirmDialogBridge.test — confirm 槽 main↔renderer 往返桥的单测。 */

import { describe, expect, it, vi } from 'vitest';

import {
  GhostConfirmDialogBridge,
  type GhostConfirmPush,
  type GhostConfirmDialogBridgeDeps,
} from '../ghostConfirmDialogBridge';

const ASK = {
  ghostId: 'g1',
  ghostName: '确认插件',
  body: '要切分支吗?',
  confirmText: null,
  cancelText: null,
  danger: false,
};

function makeBridge(overrides: Partial<GhostConfirmDialogBridgeDeps> = {}) {
  const sent: GhostConfirmPush[] = [];
  const deps: GhostConfirmDialogBridgeDeps = {
    sendToWindow: (payload) => {
      sent.push(payload);
      return true;
    },
    timeoutMs: 50,
    ...overrides,
  };
  return { bridge: new GhostConfirmDialogBridge(deps), sent };
}

describe('ghostConfirmDialogBridge · 正常往返', () => {
  it('投出去 → renderer 回包 → resolve 用户的点击', async () => {
    const { bridge, sent } = makeBridge();
    const pending = bridge.request(ASK);
    expect(sent).toHaveLength(1);
    expect(sent[0].requestId).toMatch(/[0-9a-f-]{36}/);
    expect(sent[0].body).toBe('要切分支吗?');
    expect(bridge.pendingCount).toBe(1);

    expect(bridge.resolve(sent[0].requestId, true)).toBe(true);
    expect(await pending).toBe(true);
    expect(bridge.pendingCount).toBe(0);
  });

  it('取消回包 → false', async () => {
    const { bridge, sent } = makeBridge();
    const pending = bridge.request(ASK);
    bridge.resolve(sent[0].requestId, false);
    expect(await pending).toBe(false);
  });
});

describe('ghostConfirmDialogBridge · fail closed', () => {
  it('没有可投窗口 → reject(区别于"用户拒绝")', async () => {
    const { bridge } = makeBridge({ sendToWindow: () => false });
    await expect(bridge.request(ASK)).rejects.toThrow('没有可挂靠的宿主窗口');
    expect(bridge.pendingCount).toBe(0);
  });

  it('没人应答到超时 → 当成没同意(false),并清掉 pending', async () => {
    const warn = vi.fn();
    const { bridge } = makeBridge({ timeoutMs: 10, log: { warn } });
    expect(await bridge.request(ASK)).toBe(false);
    expect(bridge.pendingCount).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it('回包不是布尔 → 一律按没同意兜底(不给靠畸形回包骗到同意的路)', async () => {
    const warn = vi.fn();
    const { bridge, sent } = makeBridge({ log: { warn } });
    const pending = bridge.request(ASK);
    bridge.resolve(sent[0].requestId, 'true');
    expect(await pending).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('陌生 / 重复的 requestId 直接忽略(返回 false,不抛)', async () => {
    const { bridge, sent } = makeBridge();
    expect(bridge.resolve('not-a-real-id', true)).toBe(false);
    const pending = bridge.request(ASK);
    expect(bridge.resolve(sent[0].requestId, true)).toBe(true);
    expect(bridge.resolve(sent[0].requestId, false)).toBe(false); // 二次回包无效
    expect(await pending).toBe(true);
  });

  it('cancelAll 清在途:全清 / 只清某个插件', async () => {
    const { bridge } = makeBridge({ timeoutMs: 60_000 });
    const a = bridge.request(ASK);
    // 第一单还在场时桥本身不拦(单飞在 confirmSlot),这里直接再投一单验证按 ghostId 清
    const b = bridge.request({ ...ASK, ghostId: 'g2' });
    expect(bridge.pendingCount).toBe(2);

    bridge.cancelAll('g1');
    expect(await a).toBe(false);
    expect(bridge.pendingCount).toBe(1);

    bridge.cancelAll();
    expect(await b).toBe(false);
    expect(bridge.pendingCount).toBe(0);
  });
});
