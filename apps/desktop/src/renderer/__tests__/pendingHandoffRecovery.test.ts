/**
 * pendingHandoffRecovery —— device-link 开协同交接的「可恢复副本」。
 *
 * 背景(issue #1170,greptile P1):remoteCollab 这条路径 consumePending 之后还要
 * await 被控端起 Worker(慢设备可到 30s 隧道超时 + 6×3s 回查)。内存 Map 已经删了,
 * 这段时间 app 被关掉正文就没有第二份。所以进等待前另存一份到 localStorage。
 *
 * 本文件锁住这份副本的语义:只存正文、按 kind 各取各的、按归属人分命名空间、
 * 天级 TTL 兜底、localStorage 不可用时静默降级(绝不能把首轮发送本身弄失败)。
 *
 * 项目 vitest env=node,无 window。沿用 newMakerDraft.test.ts 的做法,
 * 用 vi.stubGlobal 注入最小 localStorage,而不是为这一个文件切 jsdom。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const STORAGE_KEY = 'xdt:pendingHandoffRecovery:v1';

class MemLocalStorage {
  store = new Map<string, string>();
  getItem(k: string): string | null {
    return this.store.has(k) ? (this.store.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.store.set(k, v);
  }
  removeItem(k: string): void {
    this.store.delete(k);
  }
  clear(): void {
    this.store.clear();
  }
}

let memStorage: MemLocalStorage;

beforeEach(() => {
  memStorage = new MemLocalStorage();
  vi.stubGlobal('window', { localStorage: memStorage });
  vi.stubGlobal('localStorage', memStorage);
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function loadModule() {
  return await import('@/state/pendingFirstMessage');
}

describe('可恢复副本的基本语义', () => {
  it('remember 后能 take 回来,且 take 即清除(不会重复恢复)', async () => {
    const m = await loadModule();
    m.rememberRecoverableHandoff('s1', 'message', '写个登录页');

    expect(m.takeRecoverableHandoff('s1', 'message')).toBe('写个登录页');
    expect(m.takeRecoverableHandoff('s1', 'message')).toBeNull();
  });

  it('kind 不匹配时不取走 —— 首条消息与目标各自恢复各自的', async () => {
    const m = await loadModule();
    m.rememberRecoverableHandoff('s1', 'goal', '把测试补全');

    expect(m.takeRecoverableHandoff('s1', 'message')).toBeNull();
    // 没被上一步顺手清掉。
    expect(m.takeRecoverableHandoff('s1', 'goal')).toBe('把测试补全');
  });

  it('交付成功才丢副本,且只影响目标会话', async () => {
    const m = await loadModule();
    m.rememberRecoverableHandoff('s1', 'message', 'a');
    m.rememberRecoverableHandoff('s2', 'message', 'b');

    await expect(m.deliverRecoverableHandoff('s1', () => true)).resolves.toBe(true);
    // 幂等:再交付一次不会误伤别的会话。
    await expect(m.deliverRecoverableHandoff('s1', () => true)).resolves.toBe(true);

    expect(m.takeRecoverableHandoff('s1', 'message')).toBeNull();
    expect(m.takeRecoverableHandoff('s2', 'message')).toBe('b');
  });

  it('空正文不落盘 —— 免得回填出一个空输入框还弹个提示', async () => {
    const m = await loadModule();
    m.rememberRecoverableHandoff('s1', 'message', '');

    expect(m.takeRecoverableHandoff('s1', 'message')).toBeNull();
    expect(memStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('全部取走后不留空对象残留在 localStorage', async () => {
    const m = await loadModule();
    m.rememberRecoverableHandoff('s1', 'message', 'a');
    m.takeRecoverableHandoff('s1', 'message');

    expect(memStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe('交付语义:只有确认交付成功才丢副本', () => {
  it('deliver resolve false(设备离线 / 访问被撤销 / 远端 enqueue 拒绝)→ 保留副本', async () => {
    // 这是 codex P1 的要害:sendMessage 这类失败**不抛错**,而是 resolve false,
    // 并且对远程会话还会把乐观气泡从 transcript 里撤掉。不看返回值就丢副本,
    // 等于正文从界面和磁盘上同时消失。
    const m = await loadModule();
    m.rememberRecoverableHandoff('s1', 'message', '没发出去的话');

    await expect(m.deliverRecoverableHandoff('s1', () => false)).resolves.toBe(false);

    expect(m.takeRecoverableHandoff('s1', 'message')).toBe('没发出去的话');
  });

  it('deliver 抛错 → 保留副本,且错误照常向上冒泡', async () => {
    const m = await loadModule();
    m.rememberRecoverableHandoff('s1', 'goal', '没起成的目标');

    await expect(
      m.deliverRecoverableHandoff('s1', async () => {
        throw new Error('[DEVICE_LINK_NOT_CONNECTED] link down');
      }),
    ).rejects.toThrow('DEVICE_LINK_NOT_CONNECTED');

    // 调用方的 catch 负责提示;副本留着,下次进这个会话回填。
    expect(m.takeRecoverableHandoff('s1', 'goal')).toBe('没起成的目标');
  });

  it('deliver resolve true → 丢副本', async () => {
    const m = await loadModule();
    m.rememberRecoverableHandoff('s1', 'message', '发出去了');

    await expect(m.deliverRecoverableHandoff('s1', async () => true)).resolves.toBe(true);

    expect(m.takeRecoverableHandoff('s1', 'message')).toBeNull();
  });
});

describe('跨重启与命名空间', () => {
  it('副本活在 localStorage 里 —— 重置模块(模拟重启)后仍读得到', async () => {
    const m = await loadModule();
    m.rememberRecoverableHandoff('s1', 'message', '重启前没发出去的话');

    // 重置模块内存态,memStorage 不清:等价于渲染进程重新起来。
    vi.resetModules();
    const fresh = await loadModule();

    expect(fresh.takeRecoverableHandoff('s1', 'message')).toBe('重启前没发出去的话');
  });

  it('按数据归属人分命名空间 —— 换账号读不到上一个账号的正文', async () => {
    const m = await loadModule();
    m.setPendingHandoffOwner('owner-a');
    m.rememberRecoverableHandoff('s1', 'message', 'A 的内容');

    m.setPendingHandoffOwner('owner-b');
    expect(m.takeRecoverableHandoff('s1', 'message')).toBeNull();

    m.setPendingHandoffOwner('owner-a');
    expect(m.takeRecoverableHandoff('s1', 'message')).toBe('A 的内容');
  });

  it('超过 TTL 的残留在下次读取时被丢弃(导航失败的孤儿不无限堆积)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const m = await loadModule();
    m.rememberRecoverableHandoff('s1', 'message', '很久以前');

    vi.setSystemTime(new Date('2026-01-09T00:00:00Z')); // +8 天 > 7 天 TTL
    expect(m.takeRecoverableHandoff('s1', 'message')).toBeNull();
  });

  it('过期项必须真的从磁盘上消失,而不只是读的时候过滤掉', async () => {
    // 只过滤不写回的话,这个账号只要不再写新交接项,正文就永远赖在 localStorage 里,
    // 与声明的 TTL 和「持久数据要有明确生命周期」不符。
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const m = await loadModule();
    m.rememberRecoverableHandoff('s1', 'message', '敏感的半句话');
    expect(memStorage.getItem(STORAGE_KEY)).toContain('敏感的半句话');

    vi.setSystemTime(new Date('2026-01-09T00:00:00Z'));
    // 只是读一次(哪怕读的是别的会话),过期正文就该被清出磁盘。
    m.takeRecoverableHandoff('other-session', 'message');

    expect(memStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('过期项被清掉时不牵连同表里仍在有效期内的条目', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const m = await loadModule();
    m.rememberRecoverableHandoff('old', 'message', '旧的');

    vi.setSystemTime(new Date('2026-01-09T00:00:00Z'));
    m.rememberRecoverableHandoff('fresh', 'message', '新的');

    const raw = memStorage.getItem(STORAGE_KEY) ?? '';
    expect(raw).not.toContain('旧的');
    expect(raw).toContain('新的');
    expect(m.takeRecoverableHandoff('fresh', 'message')).toBe('新的');
  });

  it('损坏的整份 JSON 会被覆盖掉,不留在磁盘上', async () => {
    const m = await loadModule();
    memStorage.setItem(STORAGE_KEY, '{ not json');

    expect(m.takeRecoverableHandoff('s1', 'message')).toBeNull();
    expect(memStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('TTL 之内的正常恢复', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const m = await loadModule();
    m.rememberRecoverableHandoff('s1', 'message', '昨天的');

    vi.setSystemTime(new Date('2026-01-02T00:00:00Z'));
    expect(m.takeRecoverableHandoff('s1', 'message')).toBe('昨天的');
  });
});

describe('降级:副本是尽力而为,不能反过来弄坏发送', () => {
  it('localStorage 写失败(配额满 / 私密窗口)不抛错', async () => {
    const m = await loadModule();
    const spy = vi.spyOn(memStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    expect(() => m.rememberRecoverableHandoff('s1', 'message', 'x')).not.toThrow();

    spy.mockRestore();
  });

  it('localStorage 读失败不抛错,按"没有副本"处理', async () => {
    const m = await loadModule();
    const spy = vi.spyOn(memStorage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });

    expect(m.takeRecoverableHandoff('s1', 'message')).toBeNull();

    spy.mockRestore();
  });

  it('schema 损坏(手改 / 老版本)静默回退,不炸也不返回垃圾', async () => {
    const m = await loadModule();

    memStorage.setItem(STORAGE_KEY, '{ not json');
    expect(m.takeRecoverableHandoff('s1', 'message')).toBeNull();

    memStorage.setItem(STORAGE_KEY, JSON.stringify(['not', 'an', 'object']));
    expect(m.takeRecoverableHandoff('s1', 'message')).toBeNull();

    // 字段类型不对的条目被逐条剔除,不影响同表里的合法条目。
    memStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        bad: { kind: 'message', text: 42, createdAt: Date.now() },
        good: { kind: 'message', text: 'ok', createdAt: Date.now() },
      }),
    );
    expect(m.takeRecoverableHandoff('bad', 'message')).toBeNull();
    expect(m.takeRecoverableHandoff('good', 'message')).toBe('ok');
  });
});
