import { describe, expect, it, vi } from 'vitest';
import type { Envelope } from '@cindy/device-link';
import {
  handlePeerLinkCloseFrame,
  invalidatePeerLinkState,
  liftRehydrateSuppressionForNewConnection,
  liftRehydrateSuppressionOnExplicitOpen,
  updateRehydrateSuppressionOnLinkClose,
} from '@/device-link/linkClose';

describe('handlePeerLinkCloseFrame', () => {
  it.each(['user', 'toggle-off', 'shutdown', 'revoked', 'transport-timeout'] as const)(
    'invalidates retained links on peer link-close (%s)',
    (reason) => {
      const onLinkClosed = vi.fn();
      const handled = handlePeerLinkCloseFrame({
        v: 1,
        kind: 'link-close',
        src: 'desktop-a',
        payload: { reason },
      } as Envelope, onLinkClosed);

      expect(handled).toBe(true);
      // reason 透传:transport-timeout 需要上层立即 rehydrate 重建,其它 reason
      // 维持只失效不重建的既有语义。
      expect(onLinkClosed).toHaveBeenCalledWith('desktop-a', reason);
    },
  );

  it('passes undefined reason for legacy frames without payload', () => {
    const onLinkClosed = vi.fn();
    const handled = handlePeerLinkCloseFrame({
      v: 1,
      kind: 'link-close',
      src: 'desktop-a',
    } as Envelope, onLinkClosed);
    expect(handled).toBe(true);
    expect(onLinkClosed).toHaveBeenCalledWith('desktop-a', undefined);
  });

  it('ignores unrelated frames', () => {
    const onLinkClosed = vi.fn();
    expect(handlePeerLinkCloseFrame({
      v: 1,
      kind: 'push',
      src: 'desktop-a',
    } as Envelope, onLinkClosed)).toBe(false);
    expect(onLinkClosed).not.toHaveBeenCalled();
  });
});

describe('updateRehydrateSuppressionOnLinkClose', () => {
  it.each(['user', 'toggle-off', 'shutdown', 'revoked', 'future-unknown', undefined])(
    '永久关闭 reason(%s)抑制后台重建',
    (reason) => {
      const suppressed = new Set<string>();
      updateRehydrateSuppressionOnLinkClose(suppressed, 'desktop-a', reason as string | undefined);
      expect(suppressed.has('desktop-a')).toBe(true);
    },
  );

  it('transport-timeout 解除抑制:只有它能继续恢复', () => {
    const suppressed = new Set<string>(['desktop-a']);
    updateRehydrateSuppressionOnLinkClose(suppressed, 'desktop-a', 'transport-timeout');
    expect(suppressed.has('desktop-a')).toBe(false);
  });

  it('抑制后收到 transport-timeout 再次可恢复(抑制 → 解除 → 再抑制 的往返稳定)', () => {
    const suppressed = new Set<string>();
    updateRehydrateSuppressionOnLinkClose(suppressed, 'desktop-a', 'user');
    expect(suppressed.has('desktop-a')).toBe(true);
    updateRehydrateSuppressionOnLinkClose(suppressed, 'desktop-a', 'transport-timeout');
    expect(suppressed.has('desktop-a')).toBe(false);
    updateRehydrateSuppressionOnLinkClose(suppressed, 'desktop-a', 'shutdown');
    expect(suppressed.has('desktop-a')).toBe(true);
  });

  it('解除点只有三个:transport-timeout / 新连接代际 / 显式 openLink 成功;普通可用快照不解除', () => {
    const suppressed = new Set<string>(['desktop-a', 'desktop-b']);

    // 普通 available=true presence 快照:没有对应的 lift API——在线 ≠ 重新授权,
    // context 的快照处理分支不碰抑制集(本用例固化该契约:抑制集只能经
    // 下列具名入口变更)。

    // 显式 openLink 成功:只解除目标设备
    liftRehydrateSuppressionOnExplicitOpen(suppressed, 'desktop-a');
    expect(suppressed.has('desktop-a')).toBe(false);
    expect(suppressed.has('desktop-b')).toBe(true);

    // 新连接代际:世界重置,全部解除
    liftRehydrateSuppressionForNewConnection(suppressed);
    expect(suppressed.size).toBe(0);
  });
});

describe('invalidatePeerLinkState', () => {
  it('clears retained link state and reports invalidated session topic ACKs', () => {
    const openLinks = new Map<string, unknown>([
      ['desktop-a', Promise.resolve()],
      ['desktop-b', Promise.resolve()],
    ]);
    const remoteTopicAcks = new Map<string, Set<string>>([
      ['desktop-a', new Set(['sessions', 'session:s1', 'session:s2'])],
      ['desktop-b', new Set(['sessions'])],
    ]);
    const onTopicsInterrupted = vi.fn();

    invalidatePeerLinkState(
      'desktop-a',
      openLinks,
      remoteTopicAcks,
      onTopicsInterrupted,
    );

    expect(openLinks.has('desktop-a')).toBe(false);
    expect(remoteTopicAcks.has('desktop-a')).toBe(false);
    expect(openLinks.has('desktop-b')).toBe(true);
    expect(remoteTopicAcks.has('desktop-b')).toBe(true);
    expect(onTopicsInterrupted).toHaveBeenCalledWith([
      'sessions',
      'session:s1',
      'session:s2',
    ]);
  });
});
