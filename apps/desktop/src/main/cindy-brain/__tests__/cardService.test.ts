/**
 * cardService.test.ts — 意识聊天卡片供片服务单测(纯 DI,假时钟,无 Electron)。
 * 覆盖:接受链路(persist + broadcast + hasCard)、未注册/冒名/无卡槽拒、
 * 限速(首版免罚)、height clamp、finalize 宽限窗内外、sanitize 失败拒、
 * persist 失败不阻断推送。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  GhostCardService,
  parseCardHeightReport,
  withCardToken,
  type GhostCardServiceDeps,
} from '../cardService';
import {
  GHOST_CARD_HEIGHT_DEFAULT,
  GHOST_CARD_HEIGHT_MAX,
  GHOST_CARD_HEIGHT_MIN,
  GHOST_CARD_REOPEN_WINDOW_MS,
} from '../../../shared/ghost';

function makeService(overrides: Partial<GhostCardServiceDeps> = {}) {
  let nowMs = 1_000_000;
  const persist = vi.fn(async () => {});
  const broadcast = vi.fn();
  const deps: GhostCardServiceDeps = {
    hasCardSlot: () => true,
    sanitize: (html: string) => ({ ok: true, html: `S:${html}` }),
    persist,
    broadcast,
    now: () => nowMs,
    ...overrides,
  };
  const svc = new GhostCardService(deps);
  return {
    svc,
    persist,
    broadcast,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

const update = (callId: string, html = '<p>x</p>', extra: Record<string, unknown> = {}) => ({
  type: 'card-update',
  callId,
  html,
  ...extra,
});

describe('GhostCardService', () => {
  it('接受链路:sanitize 产物落库并推送,hasCard/finalize 语义正确', async () => {
    const { svc, persist, broadcast } = makeService();
    svc.registerCall('c1', { ghostId: 'g1', toolUseId: 'tu1', sessionId: 's1' });
    expect(svc.hasCard('c1')).toBe(false);

    const r = svc.handleCardUpdate('g1', update('c1', '<p>a</p>', { height: 300 }));
    expect(r.accepted).toBe(true);
    expect(svc.hasCard('c1')).toBe(true);
    expect(broadcast).toHaveBeenCalledWith({
      callId: 'c1',
      ghostId: 'g1',
      toolUseId: 'tu1',
      html: 'S:<p>a</p>',
      animatedHtml: null,
      height: 300,
      state: null,
    });
    await Promise.resolve();
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({ callId: 'c1', ghostId: 'g1', sessionId: 's1', height: 300, v: 1 }),
    );
    expect(svc.finalizeCall('c1')).toBe(true);
  });

  it('未注册 callId / 冒名 / 无卡槽 一律拒', () => {
    const { svc, broadcast } = makeService();
    expect(svc.handleCardUpdate('g1', update('nope')).reason).toBe('unknown-call');

    svc.registerCall('c1', { ghostId: 'g1', toolUseId: null, sessionId: null });
    expect(svc.handleCardUpdate('g2', update('c1')).reason).toBe('not-owner');

    const gated = makeService({ hasCardSlot: () => false });
    gated.svc.registerCall('c2', { ghostId: 'g1', toolUseId: null, sessionId: null });
    expect(gated.svc.handleCardUpdate('g1', update('c2')).reason).toBe('no-card-slot');
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('形状校验:type/callId/html/v', () => {
    const { svc } = makeService();
    svc.registerCall('c1', { ghostId: 'g1', toolUseId: null, sessionId: null });
    expect(svc.handleCardUpdate('g1', null).reason).toBe('bad-shape');
    expect(svc.handleCardUpdate('g1', { type: 'x' }).reason).toBe('bad-shape');
    expect(svc.handleCardUpdate('g1', update('')).reason).toBe('bad-call-id');
    expect(svc.handleCardUpdate('g1', { type: 'card-update', callId: 'c1', html: 1 }).reason).toBe(
      'bad-html',
    );
    // v:2 = 交互卡,是合法形态(手册教作者发它);v:3 及其它非法版本才拒。
    expect(svc.handleCardUpdate('g1', update('c1', '<p>x</p>', { v: 2 })).accepted).toBe(true);
    expect(svc.handleCardUpdate('g1', update('c1', '<p>x</p>', { v: 3 })).reason).toBe(
      'bad-version',
    );
  });

  it('v:2 交互卡落库真实版本号(非写死 1)', async () => {
    const { svc, persist } = makeService();
    svc.registerCall('c1', { ghostId: 'g1', toolUseId: null, sessionId: null });
    expect(svc.handleCardUpdate('g1', update('c1', '<p>x</p>', { v: 2 })).accepted).toBe(true);
    await Promise.resolve();
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ callId: 'c1', v: 2 }));
  });

  it('限速:首版免罚,1s 内第二版拒,过窗后放行', () => {
    const { svc, advance } = makeService();
    svc.registerCall('c1', { ghostId: 'g1', toolUseId: null, sessionId: null });
    expect(svc.handleCardUpdate('g1', update('c1')).accepted).toBe(true);
    expect(svc.handleCardUpdate('g1', update('c1')).reason).toBe('rate-limited');
    advance(1001);
    expect(svc.handleCardUpdate('g1', update('c1')).accepted).toBe(true);
  });

  it('height clamp 与缺省', () => {
    const { svc, broadcast, advance } = makeService();
    svc.registerCall('c1', { ghostId: 'g1', toolUseId: null, sessionId: null });
    svc.handleCardUpdate('g1', update('c1'));
    expect(broadcast).toHaveBeenLastCalledWith(
      expect.objectContaining({ height: GHOST_CARD_HEIGHT_DEFAULT }),
    );
    advance(1500);
    svc.handleCardUpdate('g1', update('c1', '<p>x</p>', { height: 10_000 }));
    expect(broadcast).toHaveBeenLastCalledWith(
      expect.objectContaining({ height: GHOST_CARD_HEIGHT_MAX }),
    );
    advance(1500);
    svc.handleCardUpdate('g1', update('c1', '<p>x</p>', { height: 1 }));
    expect(broadcast).toHaveBeenLastCalledWith(
      expect.objectContaining({ height: GHOST_CARD_HEIGHT_MIN }),
    );
  });

  it('finalize 宽限窗:窗内接受,窗外拒', () => {
    const { svc, advance } = makeService();
    svc.registerCall('c1', { ghostId: 'g1', toolUseId: null, sessionId: null });
    expect(svc.finalizeCall('c1')).toBe(false);
    advance(5000);
    expect(svc.handleCardUpdate('g1', update('c1')).accepted).toBe(true);
    advance(6000); // settle 后 11s
    expect(svc.handleCardUpdate('g1', update('c1')).reason).toBe('too-late');
  });

  it('card-action 重开:结算过宽限后重开,可再 card-update 换新卡', () => {
    const { svc, advance } = makeService();
    svc.registerCall('c1', { ghostId: 'g1', toolUseId: null, sessionId: 's1' });
    svc.finalizeCall('c1');
    advance(11_000); // 过 GRACE_MS
    expect(svc.handleCardUpdate('g1', update('c1')).reason).toBe('too-late');
    svc.reopenForAction('c1', { ghostId: 'g1', sessionId: 's1' }); // dispatcher 在 card-action 时调
    expect(svc.handleCardUpdate('g1', update('c1')).accepted).toBe(true);
  });

  it('reopenForAction 重建被清扫条目:用持久归属续会话,落该 sessionId', async () => {
    const { svc, persist } = makeService();
    // 从未 registerCall(模拟 settle 久 / 重启后内存条目已被清扫)
    svc.reopenForAction('gone', { ghostId: 'g9', sessionId: 'sess-x' });
    expect(svc.handleCardUpdate('g9', update('gone')).accepted).toBe(true);
    await Promise.resolve();
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({ callId: 'gone', ghostId: 'g9', sessionId: 'sess-x' }),
    );
  });

  it('重开窗口过期后由清扫回收 → 再更新按未注册拒', () => {
    const { svc, advance } = makeService();
    svc.reopenForAction('c1', { ghostId: 'g1', sessionId: null });
    advance(GHOST_CARD_REOPEN_WINDOW_MS + 1);
    expect(svc.handleCardUpdate('g1', update('c1')).reason).toBe('unknown-call');
  });

  it('state 校验:working/done 放行并透传推送,非法值拒', () => {
    const { svc, broadcast, advance } = makeService();
    svc.registerCall('c1', { ghostId: 'g1', toolUseId: null, sessionId: null });
    expect(svc.handleCardUpdate('g1', update('c1', '<p>x</p>', { state: 'working' })).accepted).toBe(true);
    expect(broadcast).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'working' }));
    advance(1500);
    expect(svc.handleCardUpdate('g1', update('c1', '<p>x</p>', { state: 'done' })).accepted).toBe(true);
    expect(broadcast).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'done' }));
    advance(1500);
    expect(svc.handleCardUpdate('g1', update('c1', '<p>x</p>', { state: 'busy' })).reason).toBe('bad-state');
  });

  it('onActivity:重开态或显式 state 上报,未声明 state 的普通供片不报', () => {
    const onActivity = vi.fn();
    const { svc, advance } = makeService({ onActivity });
    // 普通 tool-call 供片(无 state):不报(会话本就有真实 turn 运行态)。
    svc.registerCall('c1', { ghostId: 'g1', toolUseId: null, sessionId: 's1' });
    expect(svc.handleCardUpdate('g1', update('c1')).accepted).toBe(true);
    expect(onActivity).not.toHaveBeenCalled();
    // 普通 tool-call 供片但显式声明 working(生成类常驻过程卡):报。
    advance(1500);
    expect(svc.handleCardUpdate('g1', update('c1', '<p>x</p>', { state: 'working' })).accepted).toBe(true);
    expect(onActivity).toHaveBeenCalledWith({
      callId: 'c1', ghostId: 'g1', sessionId: 's1', state: 'working',
    });
    onActivity.mockClear();
    // 重开态(衍生卡位):每版被接受的更新都报,state 原样带出。
    svc.reopenForAction('c1::sp1', { ghostId: 'g1', sessionId: 's1' });
    expect(svc.handleCardUpdate('g1', update('c1::sp1', '<p>x</p>', { state: 'working' })).accepted).toBe(true);
    expect(onActivity).toHaveBeenCalledWith({
      callId: 'c1::sp1', ghostId: 'g1', sessionId: 's1', state: 'working',
    });
    advance(1500);
    expect(svc.handleCardUpdate('g1', update('c1::sp1', '<p>y</p>', { state: 'done' })).accepted).toBe(true);
    expect(onActivity).toHaveBeenLastCalledWith({
      callId: 'c1::sp1', ghostId: 'g1', sessionId: 's1', state: 'done',
    });
    // 被拒的更新(限速)不报。
    onActivity.mockClear();
    expect(svc.handleCardUpdate('g1', update('c1::sp1')).reason).toBe('rate-limited');
    expect(onActivity).not.toHaveBeenCalled();
  });

  it('working 跨调用窗口:settle 过宽限后仍可供片,done 关窗,30 分钟封顶', () => {
    const { svc, advance } = makeService();
    svc.registerCall('c1', { ghostId: 'g1', toolUseId: null, sessionId: 's1' });
    // 提交调用期间发 working 过程卡 → 开窗。
    expect(svc.handleCardUpdate('g1', update('c1', '<p>x</p>', { state: 'working' })).accepted).toBe(true);
    svc.finalizeCall('c1');
    advance(60_000); // 远超 10s 宽限
    // 窗口内跨调用刷进度:放行。
    expect(svc.handleCardUpdate('g1', update('c1', '<p>35%</p>', { state: 'working' })).accepted).toBe(true);
    advance(60_000);
    // done 关窗(终态卡本身放行)……
    expect(svc.handleCardUpdate('g1', update('c1', '<p>ok</p>', { state: 'done' })).accepted).toBe(true);
    // ……之后回到 settle 宽限语义:settledAt 早已过期,再更新判 too-late。
    advance(1500);
    expect(svc.handleCardUpdate('g1', update('c1')).reason).toBe('too-late');
  });

  it('working 窗口固定封顶:超 30 分钟后不再放行,清扫可回收', () => {
    const { svc, advance } = makeService();
    svc.registerCall('c1', { ghostId: 'g1', toolUseId: null, sessionId: 's1' });
    expect(svc.handleCardUpdate('g1', update('c1', '<p>x</p>', { state: 'working' })).accepted).toBe(true);
    svc.finalizeCall('c1');
    // 连续 working 也不能滑动续命:超封顶后拒。
    advance(30 * 60_000 + 1000);
    const r = svc.handleCardUpdate('g1', update('c1', '<p>y</p>', { state: 'working' }));
    expect(r.accepted).toBe(false);
  });

  it('sanitize 失败拒且不落 hasCard', () => {
    const { svc } = makeService({ sanitize: () => ({ ok: false, reason: 'oversize' }) });
    svc.registerCall('c1', { ghostId: 'g1', toolUseId: null, sessionId: null });
    expect(svc.handleCardUpdate('g1', update('c1')).reason).toBe('sanitize:oversize');
    expect(svc.hasCard('c1')).toBe(false);
  });

  it('persist 失败不阻断推送、不抛异常', async () => {
    const { svc, broadcast } = makeService({
      persist: vi.fn(async () => {
        throw new Error('db down');
      }),
    });
    svc.registerCall('c1', { ghostId: 'g1', toolUseId: null, sessionId: null });
    expect(svc.handleCardUpdate('g1', update('c1')).accepted).toBe(true);
    expect(broadcast).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 0));
  });

  it('finalize 未注册单返回 false', () => {
    const { svc } = makeService();
    expect(svc.finalizeCall('ghost-town')).toBe(false);
  });
});

describe('withCardToken(令牌注入纯函数)', () => {
  it('没供卡 / 失败结果原样返回', () => {
    expect(withCardToken({ ok: true, result: { a: 1 } }, false, 'c1')).toEqual({
      ok: true,
      result: { a: 1 },
    });
    const failed = { ok: false as const, errorCode: 'TIMEOUT' as const, message: 'x' };
    expect(withCardToken(failed, true, 'c1')).toBe(failed);
  });

  it('纯对象注入令牌;null/undefined 升格;原始值/数组原样', () => {
    expect(withCardToken({ ok: true, result: { a: 1 } }, true, 'c1')).toEqual({
      ok: true,
      result: { a: 1, xdt_card_id: 'c1' },
    });
    expect(withCardToken({ ok: true, result: null }, true, 'c1')).toEqual({
      ok: true,
      result: { xdt_card_id: 'c1' },
    });
    expect(withCardToken({ ok: true, result: 'text' }, true, 'c1')).toEqual({
      ok: true,
      result: 'text',
    });
    expect(withCardToken({ ok: true, result: [1] }, true, 'c1')).toEqual({
      ok: true,
      result: [1],
    });
  });

  it('inFlightCallInfoOf 只认真正在途:交卷/重开/查无一律 null(workspace 凭证语义)', () => {
    const { svc } = makeService();
    svc.registerCall('c1', { ghostId: 'g1', toolUseId: null, sessionId: 's1' });
    expect(svc.inFlightCallInfoOf('c1')).toEqual({ ghostId: 'g1', sessionId: 's1' });
    // 交卷后:宽限窗内 callInfoOf 仍可查(卡片供片语义),但在途凭证必须失效。
    svc.finalizeCall('c1');
    expect(svc.callInfoOf('c1')).not.toBeNull();
    expect(svc.inFlightCallInfoOf('c1')).toBeNull();
    // 重开态(card-action 换卡窗口)同样不是工具调用在途,不发凭证。
    svc.reopenForAction('c1', { ghostId: 'g1', sessionId: 's1' });
    expect(svc.inFlightCallInfoOf('c1')).toBeNull();
    expect(svc.inFlightCallInfoOf('nope')).toBeNull();
  });
});

describe('parseCardHeightReport(report-height IPC 校验 + clamp 纯函数)', () => {
  it('合法输入:取整并原样通过', () => {
    expect(parseCardHeightReport('c1', 340.4)).toEqual({ ok: true, callId: 'c1', height: 340 });
  });

  it('clamp 到同一对常量(过小取 MIN,过大取 MAX)', () => {
    expect(parseCardHeightReport('c1', 1)).toEqual({
      ok: true, callId: 'c1', height: GHOST_CARD_HEIGHT_MIN,
    });
    expect(parseCardHeightReport('c1', 99999)).toEqual({
      ok: true, callId: 'c1', height: GHOST_CARD_HEIGHT_MAX,
    });
  });

  it('callId 非法(空/超长/非串)拒', () => {
    expect(parseCardHeightReport('', 300).ok).toBe(false);
    expect(parseCardHeightReport('x'.repeat(129), 300).ok).toBe(false);
    expect(parseCardHeightReport(123, 300).ok).toBe(false);
  });

  it('height 非有限数(NaN/Infinity/非数)拒', () => {
    expect(parseCardHeightReport('c1', Number.NaN).ok).toBe(false);
    expect(parseCardHeightReport('c1', Number.POSITIVE_INFINITY).ok).toBe(false);
    expect(parseCardHeightReport('c1', '300').ok).toBe(false);
  });
});
