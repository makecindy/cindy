/**
 * telegramRemoteControl.test.ts — 被控端跨设备上下线的执行契约。
 * -------------------------------------------------------------------------------------
 * 锁住三件事:
 *   1. **状态投影不带凭证**:过网线的只有 kind / appId / reason。ownerUserId(Telegram
 *      用户 id)与 botUsername(bot 身份)绝不出现 —— 控制端只需要判断"远端占的是不是
 *      同一个 bot", appId 就够了。
 *   2. set-online 只允许下线，并在副作用前重新核对探测时的 bot appId。
 *   3. 参数解析防御:缺参 / 非法形状一律报错且不执行副作用。
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
    expect(projected).toEqual({ kind: 'connected', appId: '999', reason: null, code: null });
    // 白名单式断言:未来给 IMStatus 加字段时, 不会悄悄漏到网线上。
    expect(Object.keys(projected).sort()).toEqual(['appId', 'code', 'kind', 'reason']);
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
    expect(readTelegramRemoteStatus()).toEqual({ kind: 'idle', appId: null, reason: null, code: null });
  });

  it('error: 带上 reason 供控制端显示"token 无效"这类原因', () => {
    getStatus.mockReturnValue({ kind: 'error', reason: 'invalid token', code: 'invalid-token' });
    expect(readTelegramRemoteStatus()).toEqual({
      kind: 'error',
      appId: null,
      reason: 'invalid token',
      code: 'invalid-token',
    });
  });

  it('未注入 source: 状态按未配置；携带旧 expectedAppId 的下线被拒绝', async () => {
    setTelegramRemoteSource(null);
    expect(readTelegramRemoteStatus()).toEqual({ kind: 'idle', appId: null, reason: null, code: null });
    await expect(
      setTelegramRemoteOnline({ online: false, expectedAppId: '999' }),
    ).rejects.toThrow(/PRECONDITION_FAILED/);
  });

  it('拒绝上线优先于一切 —— 未注入 source 时也不能被当成"成功"', async () => {
    setTelegramRemoteSource(null);
    await expect(
      setTelegramRemoteOnline({ online: true, expectedAppId: '999' }),
    ).rejects.toThrow(/PERMISSION_DENIED/);
  });
});

describe('telegram 远程上下线', () => {
  it('{online:false} → goOffline', async () => {
    getStatus.mockReturnValue({ kind: 'offline', appId: '999' });
    const result = await setTelegramRemoteOnline({ online: false, expectedAppId: '999' });
    expect(goOffline).toHaveBeenCalledTimes(1);
    expect(goOnline).not.toHaveBeenCalled();
    expect(result.kind).toBe('offline');
  });

  it('{online:true} 被硬拒绝 —— 远程不得撤销目标机自己选的下线', async () => {
    getStatus.mockReturnValue({ kind: 'offline', appId: '999' });
    // 控制端 UI 只发 false 是产品选择, 不是权限约束: deviceLink.invoke 通用入口
    // 允许任意参数, 放开上线等于让别的设备把这台拽回 409 争抢。
    await expect(
      setTelegramRemoteOnline({ online: true, expectedAppId: '999' }),
    ).rejects.toThrow(/PERMISSION_DENIED/);
    expect(goOnline).not.toHaveBeenCalled();
    expect(goOffline).not.toHaveBeenCalled();
  });

  it('畸形 payload 一律报错, 不执行任何副作用(不猜意图)', async () => {
    getStatus.mockReturnValue({ kind: 'connected', appId: '999' });
    // 跨设备入口不做宽松解析: 把 {} / {offline:true} 这类笔误默默当成下线, 会让
    // 目标机莫名其妙停止收消息, 而调用方永远发现不了自己发错了。
    for (const bad of [
      undefined,
      null,
      'online',
      42,
      [],
      [{ online: false }],
      {},
      { online: 'false' },
      { online: 0 },
      { offline: true },
      { online: false },
      { online: false, expectedAppId: '' },
      { online: false, expectedAppId: null },
      { online: false, expectedAppId: 999 },
    ]) {
      goOffline.mockClear();
      goOnline.mockClear();
      await expect(
        setTelegramRemoteOnline(bad),
        `payload ${JSON.stringify(bad) ?? 'undefined'} 应被拒绝`,
      ).rejects.toThrow(/INVALID_PARAMS/);
      expect(goOffline).not.toHaveBeenCalled();
      expect(goOnline).not.toHaveBeenCalled();
    }
  });

  it('合法的 { online: false } 正常执行下线', async () => {
    getStatus.mockReturnValue({ kind: 'offline', appId: '999' });
    await expect(
      setTelegramRemoteOnline({ online: false, expectedAppId: '999' }),
    ).resolves.toMatchObject({
      kind: 'offline',
    });
    expect(goOffline).toHaveBeenCalledTimes(1);
  });

  it('探测后目标端换绑 Bot: 旧 expectedAppId 被拒绝且不下线新 Bot', async () => {
    getStatus.mockReturnValue({ kind: 'connected', appId: '999' });
    const staleSnapshot = readTelegramRemoteStatus();
    getStatus.mockReturnValue({ kind: 'connected', appId: '888' });

    await expect(
      setTelegramRemoteOnline({ online: false, expectedAppId: staleSnapshot.appId }),
    ).rejects.toThrow(/PRECONDITION_FAILED/);

    expect(goOffline).not.toHaveBeenCalled();
    expect(getStatus()).toEqual({ kind: 'connected', appId: '888' });
  });
});
