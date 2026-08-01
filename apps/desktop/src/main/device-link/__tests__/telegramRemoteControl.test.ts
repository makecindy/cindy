/**
 * telegramRemoteControl.test.ts — 被控端跨设备上下线的执行契约。
 * -------------------------------------------------------------------------------------
 * 锁住三件事:
 *   1. **状态投影不带凭证**:过网线的只有 kind / appId / reason。ownerUserId(Telegram
 *      用户 id)与 botUsername(bot 身份)绝不出现 —— 控制端只需要判断"远端占的是不是
 *      同一个 bot", appId 就够了。
 *   2. set-online 只切轮询, 语义正确地转发到 goOffline / goOnline。
 *   3. 参数解析防御:缺参 / 非法形状一律按"下线"处理, 不会因为控制端发了脏 payload
 *      就把一台本该下线的机器意外拉上线(误上线会去抢另一台的轮询)。
 * 只 mock im/host 与 logger:本模块的价值就在投影与转发, 不需要真 transport。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { IMStatus } from '@cindy/im';

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { readTelegramRemoteStatus, setTelegramRemoteOnline, setTelegramRemoteSource } = await import(
  '../telegramRemoteControl'
);

const goOffline = vi.fn(async () => {});
const goOnline = vi.fn(async () => true);
const getStatus = vi.fn<() => IMStatus>();

beforeEach(() => {
  goOffline.mockClear();
  goOnline.mockClear();
  getStatus.mockReset();
  setTelegramRemoteSource({ getStatus, goOffline, goOnline });
});

describe('telegram 远程状态投影', () => {
  it('connected: 只带 kind + appId, 不泄漏任何凭证/身份字段', () => {
    getStatus.mockReturnValue({ kind: 'connected', appId: '999' });
    const projected = readTelegramRemoteStatus();
    expect(projected).toEqual({ kind: 'connected', appId: '999', reason: null });
    // 白名单式断言:未来给 IMStatus 加字段时, 不会悄悄漏到网线上。
    expect(Object.keys(projected).sort()).toEqual(['appId', 'kind', 'reason']);
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toMatch(/ownerUserId|botUsername|token|secret/i);
  });

  it('offline / conflict 同样带 appId(控制端据此判断是否同一个 bot)', () => {
    getStatus.mockReturnValue({ kind: 'offline', appId: '999' });
    expect(readTelegramRemoteStatus().appId).toBe('999');
    getStatus.mockReturnValue({ kind: 'conflict', appId: '999' });
    expect(readTelegramRemoteStatus().kind).toBe('conflict');
  });

  it('idle: 无 appId 时回 null 而不是 undefined(过 JSON 后形状稳定)', () => {
    getStatus.mockReturnValue({ kind: 'idle' });
    expect(readTelegramRemoteStatus()).toEqual({ kind: 'idle', appId: null, reason: null });
  });

  it('error: 带上 reason 供控制端显示"token 无效"这类原因', () => {
    getStatus.mockReturnValue({ kind: 'error', reason: 'invalid token' });
    expect(readTelegramRemoteStatus()).toEqual({
      kind: 'error',
      appId: null,
      reason: 'invalid token',
    });
  });

  it('未注入 source(IM 子系统没接线): 按未配置处理, 不抛错给控制端', async () => {
    setTelegramRemoteSource(null);
    expect(readTelegramRemoteStatus()).toEqual({ kind: 'idle', appId: null, reason: null });
    await expect(setTelegramRemoteOnline({ online: false })).resolves.toEqual({
      kind: 'idle',
      appId: null,
      reason: null,
    });
  });
});

describe('telegram 远程上下线', () => {
  it('{online:false} → goOffline', async () => {
    getStatus.mockReturnValue({ kind: 'offline', appId: '999' });
    const result = await setTelegramRemoteOnline({ online: false });
    expect(goOffline).toHaveBeenCalledTimes(1);
    expect(goOnline).not.toHaveBeenCalled();
    expect(result.kind).toBe('offline');
  });

  it('{online:true} → goOnline', async () => {
    getStatus.mockReturnValue({ kind: 'connected', appId: '999' });
    const result = await setTelegramRemoteOnline({ online: true });
    expect(goOnline).toHaveBeenCalledTimes(1);
    expect(goOffline).not.toHaveBeenCalled();
    expect(result.kind).toBe('connected');
  });

  it('脏 payload(缺参 / 非对象 / online 非 true)一律按下线处理, 绝不误上线', async () => {
    getStatus.mockReturnValue({ kind: 'offline', appId: '999' });
    for (const bad of [undefined, null, {}, 'online', 42, [], { online: 'true' }, { online: 1 }]) {
      goOffline.mockClear();
      goOnline.mockClear();
      await setTelegramRemoteOnline(bad);
      expect(goOnline, `payload ${JSON.stringify(bad)} 不得触发上线`).not.toHaveBeenCalled();
      expect(goOffline).toHaveBeenCalledTimes(1);
    }
  });
});
