/**
 * 每条 relay socket 在**真正建立之后**钉住的出站判定(#9537 出站路径诊断用)。
 *
 * 判定不能在建连那一刻就写:客户端按连接世代丢弃过期的建连结果
 * (`packages/device-link/src/client.ts` 的 epoch 闸 —— 过期的 socket 会被立刻 close),
 * 若晚完成的那次先写了判定,诊断就会报一条**根本没被采用**的线路(Codex review P1)。
 * 因此判定挂在 socket 上,等它真的 `open` 才算这条线路被采用;孤儿 socket 走不到
 * `open`,永远不会写入判定。
 *
 * 「这条 socket 走没走代理」这件事只有传输层知道(见 outbound-fetch 的
 * `createOutboundHttpAgentWithDecision`),这里只负责**在正确的时刻**把它记下来。
 */

import type { OutboundSocketProxyDecision } from '../maker-host/outbound-fetch.desktop';

/** socket 只需要这两件事:登记「open 了」与「关掉了」。 */
export interface PinableSocket {
  once(event: 'open' | 'close', listener: () => void): unknown;
}

export interface PinnedSocketProxyStore {
  /**
   * 登记一条建连尝试:`socket` 真的 open 时,这条 URL 的判定才换成 `decision`;
   * socket 关掉时,若当前判定仍是它,清空(此刻没有活着的 socket,没有可报的判定)。
   */
  track(url: string, decision: OutboundSocketProxyDecision, socket: PinableSocket): void;
  /** 取某个 URL 上当前生效的判定(没有则 null)。 */
  get(url: string): OutboundSocketProxyDecision | null;
}

export function createPinnedSocketProxyStore(): PinnedSocketProxyStore {
  const byUrl = new Map<string, OutboundSocketProxyDecision>();
  return {
    track(url, decision, socket) {
      socket.once('open', () => {
        byUrl.set(url, decision);
      });
      socket.once('close', () => {
        // 只清「仍是自己写的」那一条:同一个 URL 上可能已经有更新的 socket 接管,
        // 那时它的判定不能被旧 socket 的关闭事件抹掉。
        if (byUrl.get(url) === decision) byUrl.delete(url);
      });
    },
    get(url) {
      return byUrl.get(url) ?? null;
    },
  };
}
