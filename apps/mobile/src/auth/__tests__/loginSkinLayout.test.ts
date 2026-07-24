import { describe, expect, it, vi } from 'vitest';

/**
 * PR4a 750 stage 布局引擎 + 42s 倒计时纯函数测试(SC-7 slice pr4a)。
 * 期望值全部来自权威链硬编码(demo phoneLayout wave3.5 旧表 / Step 3a 契约),
 * 不引用实现内部公式回算,防「实现测实现」自证。
 */
vi.mock('expo-localization', () => ({
  getLocales: () => [{ languageTag: 'zh-CN' }],
}));

import {
  createResendDeadline,
  formatResendCountdown,
  LOGIN_STAGE_LONG,
  LOGIN_STAGE_SHORT,
  PAD_LANDSCAPE_MIN_SCALE,
  RESEND_COUNTDOWN_SECONDS,
  resendCountdownRemaining,
  resolveLoginStage,
  resolveLoginSurface,
  resolveLoginSurfaceMode,
  type LoginStageBox,
} from '@/auth/loginSkinLayout';
import { loginMessages } from '@/auth/loginMessages';

function expectBox(actual: LoginStageBox, expected: LoginStageBox) {
  expect(actual.x).toBeCloseTo(expected.x, 6);
  expect(actual.y).toBeCloseTo(expected.y, 6);
  expect(actual.w).toBeCloseTo(expected.w, 6);
  expect(actual.h).toBeCloseTo(expected.h, 6);
}

describe('loginSkin 750 stage 布局引擎', () => {
  it('scale 与 designHeight clamp:vw/750 缩放,dh clamp [600,1800]', () => {
    const layout = resolveLoginStage(390, 844);
    expect(layout.scale).toBeCloseTo(390 / 750, 10);
    expect(layout.designHeight).toBeCloseTo(844 / (390 / 750), 6);
    // clamp 下限:dh < 600 → 600
    expect(resolveLoginStage(750, 500).designHeight).toBe(600);
    // clamp 上限:dh > 1800 → 1800
    expect(resolveLoginStage(750, 2000).designHeight).toBe(1800);
  });

  it('短屏档 1334:cindy/slogan/word/loginY 逐字段等于 wave3.5 旧表(2026-07-24 拍板整体上移 40 设计px,hero 不动)', () => {
    const layout = resolveLoginStage(375, 667); // scale 0.5 → dh 1334
    expect(layout.designHeight).toBe(1334);
    expectBox(layout.cindy, { x: 75, y: 107, w: 599, h: 720 });
    expectBox(layout.slogan, { x: 462.55, y: 440.33, w: 254.01, h: 72.8 });
    expectBox(layout.word, { x: 199, y: 554.48, w: 352.93, h: 120.54 });
    expect(layout.loginY).toBe(694);
  });

  it('长屏档 1624:双区统一 y=116 的 long 表逐字段命中(2026-07-24 拍板整体上移 40 设计px,hero 不动)', () => {
    const layout = resolveLoginStage(375, 812); // scale 0.5 → dh 1624
    expect(layout.designHeight).toBe(1624);
    expectBox(layout.cindy, { x: 0, y: 116, w: 750, h: 902 });
    expectBox(layout.slogan, { x: 387, y: 646, w: 321, h: 92 });
    expectBox(layout.word, { x: 175, y: 774, w: 401, h: 137 });
    expect(layout.loginY).toBe(933);
  });

  it('两档间 lerp:designHeight=1479 中点全字段线性插值(含 loginY)', () => {
    const layout = resolveLoginStage(750, 1479); // scale 1 → dh 1479,t=0.5
    expectBox(layout.cindy, { x: 37.5, y: 111.5, w: 674.5, h: 811 });
    expectBox(layout.slogan, { x: 424.775, y: 543.165, w: 287.505, h: 82.4 });
    expectBox(layout.word, { x: 187, y: 664.24, w: 376.965, h: 128.77 });
    expect(layout.loginY).toBeCloseTo(813.5, 6);
  });

  it('两档外超长:designHeight clamp 1800 → t=1 长屏几何原样', () => {
    const layout = resolveLoginStage(750, 2400); // dh 2400 → clamp 1800
    expect(layout.designHeight).toBe(1800);
    expectBox(layout.cindy, LOGIN_STAGE_LONG.cindy);
    expectBox(layout.slogan, LOGIN_STAGE_LONG.slogan);
    expectBox(layout.word, LOGIN_STAGE_LONG.word);
    expect(layout.loginY).toBe(LOGIN_STAGE_LONG.loginY);
  });

  it('两档外短屏:功能区优先 v 压缩视觉区,loginY=max(0,dh-640)(2026-07-24 拍板上移 40:dh-600→dh-640,dh=1334 边界与 SHORT.loginY=694 连续)', () => {
    // dh=1000:v=(1000-600)/734≈0.5449591;视觉区以 (375,0) 为锚缩放(v 公式不动)
    const layout = resolveLoginStage(750, 1000);
    expect(layout.loginY).toBe(360);
    expectBox(layout.cindy, {
      x: 211.51226158038146,
      y: 58.31062670299727,
      w: 326.43051771117164,
      h: 392.3705722070845,
    });
    // v 下限 0.25:dh=600 时 v=max(0.25, 0)=0.25,loginY=0
    const floor = resolveLoginStage(750, 600);
    expect(floor.loginY).toBe(0);
    expectBox(floor.cindy, { x: 300, y: 26.75, w: 149.75, h: 180 });
    // 短屏表仍是压缩基准(锚定回归:防有人把基准换成 long 表)
    expect(LOGIN_STAGE_SHORT.cindy).toEqual({ x: 75, y: 107, w: 599, h: 720 });
  });
});

describe('loginSkin 42s 重发倒计时纯函数(Step 3a 契约)', () => {
  it('42s 起点:deadline=now+42000,首帧显示 42', () => {
    expect(RESEND_COUNTDOWN_SECONDS).toBe(42);
    const now = 1_000_000;
    const deadline = createResendDeadline(now);
    expect(deadline).toBe(now + 42_000);
    expect(resendCountdownRemaining(deadline, now)).toBe(42);
  });

  it('显示数学边界:41999/1000/1/0ms 与超时(ceil 向上,非负 clamp)', () => {
    const deadline = 100_000;
    expect(resendCountdownRemaining(deadline, deadline - 41_999)).toBe(42);
    expect(resendCountdownRemaining(deadline, deadline - 1_000)).toBe(1);
    expect(resendCountdownRemaining(deadline, deadline - 1)).toBe(1);
    expect(resendCountdownRemaining(deadline, deadline)).toBe(0);
    expect(resendCountdownRemaining(deadline, deadline + 5_000)).toBe(0);
  });

  it('重置/保持语义:新 deadline 恢复满值,旧 deadline 不受 now 回拨影响非递减假设', () => {
    const now = 50_000;
    const first = createResendDeadline(now);
    // 重发成功 → 以成功时刻重建 deadline,剩余回到 42
    const second = createResendDeadline(now + 30_000);
    expect(resendCountdownRemaining(first, now + 30_000)).toBe(12);
    expect(resendCountdownRemaining(second, now + 30_000)).toBe(42);
    // 挂起恢复自校正:绝对 deadline 模型下,恢复时刻直接重算(可跳变,不递减计数)
    expect(resendCountdownRemaining(first, now + 41_500)).toBe(1);
  });

  it('模板渲染:{n} 占位替换,5 语 catalog resendCountdown 均带 {n}', () => {
    expect(formatResendCountdown('{n} 秒后可重新发送', 42)).toBe('42 秒后可重新发送');
    expect(formatResendCountdown('Resend available in {n}s', 7)).toBe(
      'Resend available in 7s',
    );
    for (const locale of ['zh-CN', 'en', 'ja', 'ko'] as const) {
      const template = loginMessages[locale].resendCountdown;
      expect(template, locale).toContain('{n}');
      expect(formatResendCountdown(template, 42), locale).toContain('42');
      expect(formatResendCountdown(template, 42), locale).not.toContain('{n}');
    }
  });
});

describe('loginSkin §3.6 平板/横竖屏 surface 构图(PR4b Step 5b.3;adaptation §3.6 + demo resolveMobileStage/ipadPortrait/ipadLandscape 仲裁)', () => {
  it('断点三分支:landscape∧w≥1000∧h≥690→pad-landscape;portrait∧w≥700→pad-portrait;其余→phone', () => {
    // 基准画布
    expect(resolveLoginSurfaceMode(1180, 820)).toBe('pad-landscape');
    expect(resolveLoginSurfaceMode(744, 1133)).toBe('pad-portrait');
    // 手机竖屏 → phone
    expect(resolveLoginSurfaceMode(393, 852)).toBe('phone');
    // 手机横屏(landscape 但 w<1000)→ phone 回退(§3.6 条4:不满足横屏断点落竖排)
    expect(resolveLoginSurfaceMode(852, 393)).toBe('phone');
    // landscape 满足宽但不满足高(600<690)→ phone 回退
    expect(resolveLoginSurfaceMode(1100, 600)).toBe('phone');
    // portrait 窄窗(Split View 320pt)→ phone
    expect(resolveLoginSurfaceMode(320, 768)).toBe('phone');
    // 断点边界含等号:恰好 1000×690 → pad-landscape;700×1000 → pad-portrait
    expect(resolveLoginSurfaceMode(1000, 690)).toBe('pad-landscape');
    expect(resolveLoginSurfaceMode(700, 1000)).toBe('pad-portrait');
    // 边界外一点:999×690 landscape → phone;699×1000 portrait → phone
    expect(resolveLoginSurfaceMode(999, 690)).toBe('phone');
    expect(resolveLoginSurfaceMode(699, 1000)).toBe('phone');
  });

  it('竖屏 scale = min(w/744, h/1133) 等比居中;loginGroupScale=0.794117;splashOffset=158', () => {
    const s = resolveLoginSurface(744, 1133);
    expect(s.mode).toBe('pad-portrait');
    expect(s.scale).toBeCloseTo(1, 10);
    expect(s.offsetX).toBeCloseTo(0, 6);
    expect(s.offsetY).toBeCloseTo(0, 6);
    expect(s.loginGroupScale).toBeCloseTo(0.794117, 6);
    expect(s.splashOffset).toBe(158);
    expect(s.phone).toBeNull();
    // 更矮视口按高度等比缩(w 定 744,h=1000<1133 → scale=min(1,0.8826)=0.8826)
    const tall = resolveLoginSurface(744, 1000);
    expect(tall.scale).toBeCloseTo(Math.min(744 / 744, 1000 / 1133), 10);
    expect(tall.offsetY).toBeCloseTo((1000 - 1133 * tall.scale) / 2, 6);
  });

  it('横屏 scale = max(0.85, min(w/1180, h/820))——仅下限 0.85、无 1.30 上限(权威链收口项)', () => {
    // 基准画布:raw=1 → scale=1
    const base = resolveLoginSurface(1180, 820);
    expect(base.mode).toBe('pad-landscape');
    expect(base.scale).toBeCloseTo(1, 10);
    expect(base.loginGroupScale).toBeCloseTo(0.655357, 6);
    expect(base.splashOffset).toBe(0);
    expect(base.phone).toBeNull();
    // raw<0.85 → 钳到 0.85 下限(§3.6 条3 仅下限;w≥1000∧h≥690∧landscape 命中 pad-landscape 但 raw<0.85)
    const floor = resolveLoginSurface(1100, 690); // min(1100/1180,690/820)=min(0.9322,0.8415)=0.8415
    expect(floor.mode).toBe('pad-landscape');
    expect(floor.scale).toBe(PAD_LANDSCAPE_MIN_SCALE);
    expect(floor.scale).toBeCloseTo(0.85, 10);
    // raw>1.30 → 无上限残留(旧 1.30 上限作废,§3.6 条3 + v5.2 收口;单测含 raw>1.30 断言无旧上限残留)
    const over = resolveLoginSurface(1534, 1066); // min(1.3,1.3)=1.3
    expect(over.scale).toBeCloseTo(1.3, 10); // 旧上限 1.30 恰好,不钳
    const far = resolveLoginSurface(1770, 1230); // min(1.5,1.5)=1.5 — 远超旧上限,原样不钳
    expect(far.scale).toBeCloseTo(1.5, 10);
  });

  it('横屏居中偏移:offsetX/Y = (viewport - stage*scale)/2(画布居中锚)', () => {
    const s = resolveLoginSurface(1300, 900); // scale=min(1300/1180,900/820)=min(1.1017,1.0976)=1.09756
    expect(s.scale).toBeCloseTo(Math.min(1300 / 1180, 900 / 820), 10);
    expect(s.offsetX).toBeCloseTo((1300 - 1180 * s.scale) / 2, 6);
    expect(s.offsetY).toBeCloseTo((900 - 820 * s.scale) / 2, 6);
  });

  it('phone fallback:手机横屏/窄窗落 phone 构图,loginGroupScale=1,复用 resolveLoginStage(非 pad)', () => {
    const s = resolveLoginSurface(393, 852);
    expect(s.mode).toBe('phone');
    expect(s.loginGroupScale).toBe(1);
    expect(s.phone).toBeDefined();
    expect(s.scale).toBeCloseTo(393 / 750, 10); // resolveLoginStage 750 stage scale
    // 手机横屏(landscape w<1000)→ phone 回退,非 pad-landscape
    const horiz = resolveLoginSurface(852, 393);
    expect(horiz.mode).toBe('phone');
    expect(horiz.loginGroupScale).toBe(1);
    expect(horiz.phone).toBeDefined();
  });
});
