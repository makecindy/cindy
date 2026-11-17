/**
 * 测试价值
 * - 生产入口与可观察结果:`createPinnedSocketProxyStore` —— 出站路径诊断(#9537)用来
 *   记住「活着的 relay socket 走没走代理」的存储;断言的是**什么时候**这条判定才算
 *   生效(真的 open 之后)与**什么时候**失效(socket 关掉之后)。
 * - Bug/规则依据:#9959 Codex review P1「判定要钉在 socket 真的建立之后」—— 客户端
 *   按连接世代丢弃过期的建连结果(`packages/device-link/src/client.ts` 的 epoch 闸),
 *   过期的那次若先写,诊断会报一条根本没被采用的线路。
 * - 现有覆盖缺口:该存储是本轮新增,此前没有任何用例钉住写入时机。
 * - 最小失败输入:一条登记后**从未 open** 就被 close 的孤儿 socket(过期建连的典型形状)。
 * - tier:unit(纯内存,无 Electron、无真实等待)。
 */
import { describe, expect, it } from 'vitest';

import { createPinnedSocketProxyStore } from '../pinnedSocketProxy';

class FakeSocket {
  private handlers = new Map<string, Array<() => void>>();

  once(event: 'open' | 'close', listener: () => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener]);
  }

  open(): void {
    for (const listener of this.handlers.get('open') ?? []) listener();
  }

  close(): void {
    for (const listener of this.handlers.get('close') ?? []) listener();
  }
}

const PROXY = { kind: 'proxy', proxy: 'http://127.0.0.1:7890' } as const;
const DIRECT = { kind: 'direct', reason: 'no-proxy' } as const;

describe('pinnedSocketProxy', () => {
  it('判定在 socket 真的 open 之后才生效', () => {
    const store = createPinnedSocketProxyStore();
    const socket = new FakeSocket();
    store.track('wss://relay.example/ws', PROXY, socket);

    // 还没 open:这条线路还没被采用,不该有判定。
    expect(store.get('wss://relay.example/ws')).toBeNull();

    socket.open();
    expect(store.get('wss://relay.example/ws')).toEqual(PROXY);
  });

  it('孤儿 socket(从未 open 就被关掉)不写判定', () => {
    const store = createPinnedSocketProxyStore();
    const orphan = new FakeSocket();
    store.track('wss://relay.example/ws', PROXY, orphan);

    // 过期建连的典型形状:客户端立刻把它 close 掉,走不到 open。
    orphan.close();
    expect(store.get('wss://relay.example/ws')).toBeNull();
  });

  it('活着的 socket 关掉后判定清空 —— 此刻没有活着的 socket,就没有可报的判定', () => {
    const store = createPinnedSocketProxyStore();
    const socket = new FakeSocket();
    store.track('wss://relay.example/ws', DIRECT, socket);
    socket.open();
    expect(store.get('wss://relay.example/ws')).toEqual(DIRECT);

    socket.close();
    expect(store.get('wss://relay.example/ws')).toBeNull();
  });

  it('同一个 URL 上新的 socket 接管后,旧 socket 的关闭不抹掉新判定', () => {
    const store = createPinnedSocketProxyStore();
    const oldSocket = new FakeSocket();
    const newSocket = new FakeSocket();
    store.track('wss://relay.example/ws', PROXY, oldSocket);
    store.track('wss://relay.example/ws', DIRECT, newSocket);

    oldSocket.open();
    newSocket.open();
    expect(store.get('wss://relay.example/ws')).toEqual(DIRECT);

    // 旧 socket 关闭时,当前判定已经是新 socket 的 —— 不能被抹掉。
    oldSocket.close();
    expect(store.get('wss://relay.example/ws')).toEqual(DIRECT);
  });
});
