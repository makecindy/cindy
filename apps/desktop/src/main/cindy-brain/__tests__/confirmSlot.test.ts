/** confirmSlot.test — 确认弹窗槽(confirm)的假 deps 单测。 */

import { describe, expect, it, vi } from 'vitest';

import {
  GHOST_CONFIRM_BODY_MAX_CHARS,
  GHOST_CONFIRM_BUTTON_MAX_CHARS,
  type InstalledGhost,
} from '../../../shared/ghost';
import {
  GhostConfirmSlot,
  type ConfirmSlotDeps,
  type GhostConfirmShowParams,
} from '../confirmSlot';

function confirmGhost(options: { slots?: string[]; enabled?: boolean; icon?: string } = {}): InstalledGhost {
  return {
    manifest: {
      schemaVersion: 2,
      id: 'confirm-ghost',
      name: '确认插件',
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      slots: options.slots ?? ['confirm'],
    },
    dir: '/fake/confirm-ghost',
    enabled: options.enabled ?? true,
    ...(options.icon ? { iconDataUrl: options.icon } : {}),
  } as InstalledGhost;
}

/** 假弹窗:参数带类型,好让用例直接断言主机递过去的那份载荷。 */
function showConfirmMock(answer = true) {
  return vi.fn(async (_params: GhostConfirmShowParams) => answer);
}

function makeSlot(overrides: Partial<ConfirmSlotDeps> = {}) {
  // 缺省时钟每次前进 60s,免得正常用例撞上 3 秒限速
  let clock = 0;
  const showConfirm = (overrides.showConfirm ?? showConfirmMock()) as ReturnType<typeof showConfirmMock>;
  const deps: ConfirmSlotDeps = {
    getGhost: () => confirmGhost(),
    now: () => (clock += 60_000),
    ...overrides,
    showConfirm,
  };
  return { slot: new GhostConfirmSlot(deps), deps, showConfirm };
}

/** mock.calls[0][0] 的类型安全取法(断言前先确认真被调过)。 */
function firstShown(mock: ReturnType<typeof showConfirmMock>): GhostConfirmShowParams {
  const call = mock.mock.calls[0];
  expect(call).toBeDefined();
  return call![0];
}

const OK_BODY = { body: '把项目目录切到 fix/xxx 分支?' };

describe('confirmSlot · 资格审与载荷校验', () => {
  it('未声明 confirm 槽 / 未启用 一律 PERMISSION_DENIED', async () => {
    const noSlot = makeSlot({ getGhost: () => confirmGhost({ slots: ['tool'] }) });
    expect(await noSlot.slot.handleRequest('confirm-ghost', OK_BODY)).toMatchObject({
      ok: false,
      errorCode: 'PERMISSION_DENIED',
    });
    const disabled = makeSlot({ getGhost: () => confirmGhost({ enabled: false }) });
    expect(await disabled.slot.handleRequest('confirm-ghost', OK_BODY)).toMatchObject({
      ok: false,
      errorCode: 'PERMISSION_DENIED',
    });
    const missing = makeSlot({ getGhost: () => null });
    expect(await missing.slot.handleRequest('confirm-ghost', OK_BODY)).toMatchObject({
      ok: false,
      errorCode: 'PERMISSION_DENIED',
    });
    // 一次都不该弹
    expect(noSlot.showConfirm).not.toHaveBeenCalled();
    expect(disabled.showConfirm).not.toHaveBeenCalled();
  });

  it('载荷不是对象 / body 缺失或空 一律 INVALID_REQUEST,且不弹框', async () => {
    const { slot, showConfirm } = makeSlot();
    for (const payload of [null, 'x', [], {}, { body: 42 }, { body: '   ' }]) {
      expect(await slot.handleRequest('confirm-ghost', payload)).toMatchObject({
        ok: false,
        errorCode: 'INVALID_REQUEST',
      });
    }
    expect(showConfirm).not.toHaveBeenCalled();
  });

  it('body 超限拒单;控制字符先剥再量长度(不许注水绕过上限)', async () => {
    const { slot } = makeSlot();
    expect(
      await slot.handleRequest('confirm-ghost', { body: 'x'.repeat(GHOST_CONFIRM_BODY_MAX_CHARS + 1) }),
    ).toMatchObject({ ok: false, errorCode: 'INVALID_REQUEST' });

    // 满长度正文 + 一堆控制字符:剥完刚好合规,应放行
    const fresh = makeSlot();
    const padded = `${'y'.repeat(GHOST_CONFIRM_BODY_MAX_CHARS)}${''.repeat(50)}`;
    expect(await fresh.slot.handleRequest('confirm-ghost', { body: padded })).toEqual({
      ok: true,
      confirmed: true,
    });
    expect(firstShown(fresh.showConfirm).body).toBe('y'.repeat(GHOST_CONFIRM_BODY_MAX_CHARS));
  });

  it('按钮文案超限拒单;空串当没给(回 null 让主机用缺省文案)', async () => {
    const { slot } = makeSlot();
    expect(
      await slot.handleRequest('confirm-ghost', {
        ...OK_BODY,
        confirmText: 'x'.repeat(GHOST_CONFIRM_BUTTON_MAX_CHARS + 1),
      }),
    ).toMatchObject({ ok: false, errorCode: 'INVALID_REQUEST' });

    const fresh = makeSlot();
    expect(
      await fresh.slot.handleRequest('confirm-ghost', { ...OK_BODY, confirmText: '  ', cancelText: 42 }),
    ).toMatchObject({ ok: false, errorCode: 'INVALID_REQUEST' }); // cancelText 类型不对
    const ok = makeSlot();
    await ok.slot.handleRequest('confirm-ghost', { ...OK_BODY, confirmText: '   ' });
    expect(firstShown(ok.showConfirm).confirmText).toBeNull();
  });

  it('danger 必须是布尔;身份三件套取自已装清单而不是载荷自报', async () => {
    const { slot } = makeSlot();
    expect(await slot.handleRequest('confirm-ghost', { ...OK_BODY, danger: 'yes' })).toMatchObject({
      ok: false,
      errorCode: 'INVALID_REQUEST',
    });

    const withIcon = makeSlot({ getGhost: () => confirmGhost({ icon: 'data:image/png;base64,AAA' }) });
    await withIcon.slot.handleRequest('confirm-ghost', {
      ...OK_BODY,
      // 插件试图自报身份:这些字段必须被无视
      ghostName: '系统',
      iconDataUrl: 'data:image/png;base64,EVIL',
      title: '主机安全提示',
    });
    const shown = firstShown(withIcon.showConfirm);
    expect(shown.ghostName).toBe('确认插件');
    expect(shown.iconDataUrl).toBe('data:image/png;base64,AAA');
    expect(shown).not.toHaveProperty('title');
  });
});

describe('confirmSlot · 答案与失败分档', () => {
  it('ok:true 只代表问到了:确认与取消分别回 confirmed true/false', async () => {
    const yes = makeSlot({ showConfirm: vi.fn(async () => true) });
    expect(await yes.slot.handleRequest('confirm-ghost', OK_BODY)).toEqual({ ok: true, confirmed: true });
    const no = makeSlot({ showConfirm: vi.fn(async () => false) });
    expect(await no.slot.handleRequest('confirm-ghost', OK_BODY)).toEqual({ ok: true, confirmed: false });
  });

  it('弹不出来(没有可挂靠窗口)回 UNAVAILABLE —— 不谎报成用户拒绝', async () => {
    const { slot } = makeSlot({
      showConfirm: vi.fn(async () => {
        throw new Error('没有可挂靠的宿主窗口');
      }),
    });
    expect(await slot.handleRequest('confirm-ghost', OK_BODY)).toMatchObject({
      ok: false,
      errorCode: 'UNAVAILABLE',
    });
  });
});

describe('confirmSlot · 骚扰钳制', () => {
  it('同插件 3 秒内第二次回 RATE_LIMITED,且按尝试记账(刷请求顺延窗口)', async () => {
    let clock = 1_000_000;
    const { slot, showConfirm } = makeSlot({ now: () => clock });
    expect(await slot.handleRequest('confirm-ghost', OK_BODY)).toEqual({ ok: true, confirmed: true });

    clock += 1000; // 1 秒后再问
    expect(await slot.handleRequest('confirm-ghost', OK_BODY)).toMatchObject({
      ok: false,
      errorCode: 'RATE_LIMITED',
    });
    // 被拒的这次也记了账:再过 2.5 秒(距首次 3.5 秒但距上次尝试只 2.5 秒)仍然拒
    clock += 2500;
    expect(await slot.handleRequest('confirm-ghost', OK_BODY)).toMatchObject({
      ok: false,
      errorCode: 'RATE_LIMITED',
    });
    clock += 3001;
    expect(await slot.handleRequest('confirm-ghost', OK_BODY)).toEqual({ ok: true, confirmed: true });
    expect(showConfirm).toHaveBeenCalledTimes(2);
  });

  it('已有确认框在场时回 BUSY(不排队)', async () => {
    let release: (v: boolean) => void = () => {};
    const { slot, showConfirm } = makeSlot({
      showConfirm: vi.fn(() => new Promise<boolean>((resolve) => (release = resolve))),
    });
    const first = slot.handleRequest('confirm-ghost', OK_BODY);
    // 第一单还挂着(用户没点),第二单直接 BUSY
    expect(await slot.handleRequest('confirm-ghost', OK_BODY)).toMatchObject({
      ok: false,
      errorCode: 'BUSY',
    });
    release(true);
    expect(await first).toEqual({ ok: true, confirmed: true });
    expect(showConfirm).toHaveBeenCalledTimes(1);
  });

  it('在场标记会释放:上一单结束后还能再问(异常路径也释放)', async () => {
    let clock = 0;
    const showConfirm = showConfirmMock();
    showConfirm.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(true);
    const { slot } = makeSlot({ showConfirm, now: () => (clock += 60_000) });
    expect(await slot.handleRequest('confirm-ghost', OK_BODY)).toMatchObject({
      ok: false,
      errorCode: 'UNAVAILABLE',
    });
    expect(await slot.handleRequest('confirm-ghost', OK_BODY)).toEqual({ ok: true, confirmed: true });
  });
});
