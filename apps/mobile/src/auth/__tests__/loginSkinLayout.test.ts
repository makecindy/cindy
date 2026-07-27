import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
  LOGIN_CONSENT_ROW,
  LOGIN_CONTROL,
  LOGIN_DELETION_BUBBLE,
  LOGIN_ERROR_TEXT,
  LOGIN_GROUP,
  LOGIN_KEYBOARD_DOCK_ANCHOR_Y,
  LOGIN_SKIP_LOGIN,
  LOGIN_SOCIAL,
  LOGIN_STAGE_LONG,
  LOGIN_STAGE_SHORT,
  PAD_LANDSCAPE_MIN_SCALE,
  RESEND_COUNTDOWN_SECONDS,
  resendCountdownRemaining,
  resolveDeletionBubbleFrame,
  resolveDeletionBubbleLinkHitSlop,
  resolveLoginStage,
  resolveLoginSurface,
  resolveLoginSurfaceMode,
  type LoginStageBox,
} from '@/auth/loginSkinLayout';
import { loginMessages } from '@/auth/loginMessages';
import { loginSizes } from '@/theme/tokens';

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

  it('短屏档 1334:cindy/slogan/word/loginY 逐字段等于登录改版新稿 figma 705:915 实测值', () => {
    const layout = resolveLoginStage(375, 667); // scale 0.5 → dh 1334
    expect(layout.designHeight).toBe(1334);
    // 立绘 599×720 @(75,60)(新稿 hero y=87,2026-07-27 用户拍板方案 B 再上移 27 避脸)
    expectBox(layout.cindy, { x: 75, y: 60, w: 599, h: 720 });
    // slogan 可见图形框 = 容器 @(385,387) + vector(77.55,21.37);尺寸稿内未变
    expectBox(layout.slogan, { x: 462.55, y: 408.37, w: 254.01, h: 72.8 });
    // 字标图像框 = 主容器 @(35,422) + WORD_MARK 内字标 @(173,65) = (208,487),335×115
    expectBox(layout.word, { x: 208, y: 487, w: 335, h: 115 });
    // Log_in 组顶 = 主容器 422 + 组在主容器内 200
    expect(layout.loginY).toBe(622);
  });

  it('长屏档 1624:新稿 figma 705:799 逐字段命中(hero y=106,面板 500 后组顶 827)', () => {
    const layout = resolveLoginStage(375, 812); // scale 0.5 → dh 1624
    expect(layout.designHeight).toBe(1624);
    expectBox(layout.cindy, { x: 0, y: 106, w: 750, h: 902 });
    // slogan 可见图形框 = 容器 @(362.57,545.32) + vector(82.33,22.68),269.66×77.29
    // (2026-07-27 用户审 demo 拍板:slogan 下移避脸,inner y 536.68 → 568,距字标 24px)
    expectBox(layout.slogan, { x: 444.9, y: 568, w: 269.66, h: 77.29 });
    // 字标 = 主容器 @(35,627) + 字标 @(147,42.17) = (182,669.17),387×132.18
    expectBox(layout.word, { x: 182, y: 669.17, w: 387, h: 132.18 });
    expect(layout.loginY).toBe(827);
  });

  it('两档间 lerp:designHeight=1479 中点全字段线性插值(含 loginY)', () => {
    const layout = resolveLoginStage(750, 1479); // scale 1 → dh 1479,t=0.5
    // 立绘 y 中点 = (60 + 106)/2(短屏档上移 27 后)
    expectBox(layout.cindy, { x: 37.5, y: 83, w: 674.5, h: 811 });
    // slogan y 中点 = (408.37 + 568)/2(2026-07-27 LONG 档下移避脸后)
    expectBox(layout.slogan, { x: 453.725, y: 488.185, w: 261.835, h: 75.045 });
    expectBox(layout.word, { x: 195, y: 578.085, w: 361, h: 123.59 });
    expect(layout.loginY).toBeCloseTo(724.5, 6);
  });

  it('两档外超长:designHeight clamp 1800 → t=1 长屏几何原样', () => {
    const layout = resolveLoginStage(750, 2400); // dh 2400 → clamp 1800
    expect(layout.designHeight).toBe(1800);
    expectBox(layout.cindy, LOGIN_STAGE_LONG.cindy);
    expectBox(layout.slogan, LOGIN_STAGE_LONG.slogan);
    expectBox(layout.word, LOGIN_STAGE_LONG.word);
    expect(layout.loginY).toBe(LOGIN_STAGE_LONG.loginY);
  });

  it('两档外短屏:功能区优先 v 压缩视觉区,loginY=max(0,dh-712)(2026-07-27 面板增高:dh-640→dh-712,dh=1334 边界与 SHORT.loginY=622 连续)', () => {
    // dh=1000:v=(1000-600)/734≈0.5449591;视觉区以 (375,0) 为锚缩放(v 公式不动)
    const layout = resolveLoginStage(750, 1000);
    // 712 = 组底 682(组高 620 + 协议行溢出 62)+ 新稿底距 30
    expect(layout.loginY).toBe(288);
    expectBox(layout.cindy, {
      x: 211.51226158038146,
      y: 32.697547683923706,
      w: 326.43051771117164,
      h: 392.3705722070845,
    });
    // v 下限 0.25:dh=600 时 v=max(0.25, 0)=0.25,loginY=0
    const floor = resolveLoginStage(750, 600);
    expect(floor.loginY).toBe(0);
    expectBox(floor.cindy, { x: 300, y: 15, w: 149.75, h: 180 });
    // 短屏表仍是压缩基准(锚定回归:防有人把基准换成 long 表)
    expect(LOGIN_STAGE_SHORT.cindy).toEqual({ x: 75, y: 60, w: 599, h: 720 });
  });

  it('新稿底距不变式:两档组底 = designHeight − 30(短屏)/ 在屏内(长屏),字标框底不压面板顶', () => {
    // 组底 = loginY + 组底 682(组高 620 + 协议行溢出 62)
    const flowBottom = 682;
    // 短屏 1334:1304,距屏底 30(= 新稿服务条款距屏底实测)
    expect(LOGIN_STAGE_SHORT.loginY + flowBottom).toBe(1304);
    expect(LOGIN_STAGE_SHORT.designHeight - (LOGIN_STAGE_SHORT.loginY + flowBottom)).toBe(30);
    // 长屏 1624:1509,距屏底 115(新稿实测)
    expect(LOGIN_STAGE_LONG.loginY + flowBottom).toBe(1509);
    expect(LOGIN_STAGE_LONG.designHeight - (LOGIN_STAGE_LONG.loginY + flowBottom)).toBe(115);
    // 字标可见框底 < 面板顶:两档都留正间距(面板不透明,压上去会盖住字标)
    expect(LOGIN_STAGE_SHORT.word.y + LOGIN_STAGE_SHORT.word.h).toBeLessThan(
      LOGIN_STAGE_SHORT.loginY,
    );
    expect(LOGIN_STAGE_LONG.word.y + LOGIN_STAGE_LONG.word.h).toBeLessThan(
      LOGIN_STAGE_LONG.loginY,
    );
    // slogan 可见框与字标框不重叠(inner vector 口径下两档均无交叠)
    expect(LOGIN_STAGE_SHORT.slogan.y + LOGIN_STAGE_SHORT.slogan.h).toBeLessThan(
      LOGIN_STAGE_SHORT.word.y,
    );
    expect(LOGIN_STAGE_LONG.slogan.y + LOGIN_STAGE_LONG.slogan.h).toBeLessThan(
      LOGIN_STAGE_LONG.word.y,
    );
    // 2026-07-27 用户审 demo 拍板:LONG 档 slogan 下移避脸后,底↔字标顶 ≈24 设计px
    // (钉住下限,防后续再往下挪撞字标)
    expect(
      LOGIN_STAGE_LONG.word.y - (LOGIN_STAGE_LONG.slogan.y + LOGIN_STAGE_LONG.slogan.h),
    ).toBeCloseTo(23.88, 2);
  });

  it('避脸不变式(2026-07-27 方案 B):短屏立绘上移 27 且可见发顶仍在 Status Bar 下沿之下', () => {
    // 上移量固定:稿值 87 → 60。像素级实测依据 = 上移后 dh ≤1450 全段 slogan ink ∩ 脸 = 0
    expect(LOGIN_STAGE_SHORT.cindy.y).toBe(60);
    // hero 资产(750×902)不透明内容起于 y=86(上方是透明留白),contain 缩放 720/902
    const heroScale = LOGIN_STAGE_SHORT.cindy.h / 902;
    const visibleHairTop = LOGIN_STAGE_SHORT.cindy.y + 86 * heroScale;
    expect(visibleHairTop).toBeCloseTo(128.65, 2);
    // Status Bar 高 115.67(见 LOGIN_DELETION_BUBBLE 注释的同一权威值):发顶不侵入状态栏
    expect(visibleHairTop).toBeGreaterThan(115.67);
    // 长屏档立绘不跟着动(新稿实测值)
    expect(LOGIN_STAGE_LONG.cindy.y).toBe(106);
  });
});

describe('loginSkin 面板内几何(2026-07-27 面板 440→500 + 「跳过登录」槽;figma 705:1062/1067/1068)', () => {
  it('面板 500 / 组 620 / 圆钮行 540 / 协议行 642 派生关系自洽', () => {
    expect(loginSizes.panelHeight).toBe(500);
    // 组高 = 面板 500 + gap 40 + 圆钮行 80
    expect(loginSizes.flowHeight).toBe(620);
    expect(LOGIN_GROUP.height).toBe(loginSizes.flowHeight);
    // 圆钮行接面板底 + 40 gap
    expect(LOGIN_SOCIAL.y).toBe(loginSizes.panelHeight + loginSizes.panelSocialGap);
    // 协议行接圆钮行底 + 22(新稿 705:1075:主容器 y=842 = 组内 642)
    expect(LOGIN_CONSENT_ROW.y).toBe(LOGIN_SOCIAL.y + LOGIN_SOCIAL.size + 22);
    // 协议行底 = 组高 + 溢出量(安全区抬升按此预留)
    expect(LOGIN_CONSENT_ROW.y + LOGIN_CONSENT_ROW.height).toBe(
      loginSizes.flowHeight + LOGIN_CONSENT_ROW.bottomOverflow,
    );
  });

  it('error 槽(380..430)与「跳过登录」槽(430..490)首尾相接、同时可见不重叠,槽底距面板底 10', () => {
    // error 槽顶不动(接主按钮底),高 60→50
    expect(LOGIN_ERROR_TEXT.y).toBe(LOGIN_CONTROL.buttonY + LOGIN_CONTROL.height);
    expect(LOGIN_ERROR_TEXT.height).toBe(50);
    // 跳过登录槽紧接 error 槽底,680×60
    expect(LOGIN_SKIP_LOGIN.y).toBe(LOGIN_ERROR_TEXT.y + LOGIN_ERROR_TEXT.height);
    expect(LOGIN_SKIP_LOGIN.y).toBe(430);
    expect(LOGIN_SKIP_LOGIN.width).toBe(loginSizes.panelWidth);
    expect(LOGIN_SKIP_LOGIN.height).toBe(60);
    // 槽底 490,距面板底 10(新稿面板下内边距)
    expect(loginSizes.panelHeight - (LOGIN_SKIP_LOGIN.y + LOGIN_SKIP_LOGIN.height)).toBe(10);
    // 文本规格:24 Regular,行框 29(稿内文本 96×29)
    expect(LOGIN_SKIP_LOGIN.font).toBe(24);
    expect(LOGIN_SKIP_LOGIN.lineHeight).toBe(29);
    // 命中区:文字按钮(非文字链接),可点区 = 当前语言实际文字宽 + 左右各 50 设计px
    // (用户 2026-07-27 拍板,原 30 作废);扩张后仍在 680 槽宽内 —— 以最长语言
    // ja「ログインをスキップ」9 全角 ×24 ≈ 216 估宽算,216+100=316 < 680
    expect(LOGIN_SKIP_LOGIN.pressPadX).toBe(50);
    expect(216 + LOGIN_SKIP_LOGIN.pressPadX * 2).toBeLessThan(LOGIN_SKIP_LOGIN.width);
  });

  it('键盘停靠锚 = error 槽底 430(用户 2026-07-27 拍板;不再用面板底 500)', () => {
    expect(LOGIN_KEYBOARD_DOCK_ANCHOR_Y).toBe(430);
    expect(LOGIN_KEYBOARD_DOCK_ANCHOR_Y).toBe(
      LOGIN_ERROR_TEXT.y + LOGIN_ERROR_TEXT.height,
    );
    // 锚在 error 槽底 = 停靠时错误文案完整露出(与改版前面板底 440 同语义);
    // 面板底(500)比锚低 70 设计px,新增的「跳过登录」槽允许被键盘遮挡
    expect(loginSizes.panelHeight - LOGIN_KEYBOARD_DOCK_ANCHOR_Y).toBe(70);
    expect(LOGIN_KEYBOARD_DOCK_ANCHOR_Y).toBeLessThan(loginSizes.panelHeight);
    // 锚必须落在面板内、且不高于主按钮底(否则主按钮会被键盘压住)
    expect(LOGIN_KEYBOARD_DOCK_ANCHOR_Y).toBeGreaterThanOrEqual(
      LOGIN_CONTROL.buttonY + LOGIN_CONTROL.height,
    );
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

  it('竖屏 scale = min(w/744, h/1133) 等比居中;loginGroupScale=0.794117;splashOffset=206(面板增高后簇上移 47.647,splash 位不变)', () => {
    const s = resolveLoginSurface(744, 1133);
    expect(s.mode).toBe('pad-portrait');
    expect(s.scale).toBeCloseTo(1, 10);
    expect(s.offsetX).toBeCloseTo(0, 6);
    expect(s.offsetY).toBeCloseTo(0, 6);
    expect(s.loginGroupScale).toBeCloseTo(0.794117, 6);
    // 2026-07-27 面板增高:品牌簇 + 登录组同量上移 60×0.794117 = 47.64702,
    // splashOffset 158→206 使 splash 期簇位保持不变(word.y + splashOffset ≈ 672)
    expect(s.splashOffset).toBe(206);
    expect(s.word.y + s.splashOffset).toBeCloseTo(672.46, 2);
    // 组底(含协议行)仍落 1114.94:与改版前逐像素一致,消费端 lift 不被触发放大
    expect(s.loginY + 682 * s.loginGroupScale).toBeCloseTo(1114.94, 2);
    // 字标框底↔面板顶间距不变(14.84):增高不许把面板顶推到字标上
    expect(s.loginY - (s.word.y + s.word.h)).toBeCloseTo(14.84, 2);
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
    // 面板增高后横屏组底 774.95 仍在 stage 820 内(底距 45.05)→ 几何原值不动
    expect(base.loginY + 682 * base.loginGroupScale).toBeCloseTo(774.95, 2);
    expect(base.loginY + 682 * base.loginGroupScale).toBeLessThan(820);
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

describe('loginSkin 注销提示气泡浮层布局(figma 678:1075;**stage 设计单位** × surface.scale)', () => {
  it('常量契约:内部几何为设计单位,各端落位参数命中 figma 实读值', () => {
    // 组件内部(670 宽组件坐标系):子元素坐标反算 padding 20 / 标题↔正文 5 / 行高 23,
    // 无钮变体总高 91 = 20+23+5+23+20(figma 678:1074 实读)
    expect(LOGIN_DELETION_BUBBLE.radius).toBe(22);
    expect(LOGIN_DELETION_BUBBLE.padding).toBe(20);
    expect(LOGIN_DELETION_BUBBLE.borderWidth).toBe(1);
    expect(LOGIN_DELETION_BUBBLE.font).toBe(20);
    expect(LOGIN_DELETION_BUBBLE.lineHeight).toBe(23);
    expect(LOGIN_DELETION_BUBBLE.titleBodyGap).toBe(5);
    expect(LOGIN_DELETION_BUBBLE.bodyLinkGap).toBe(22);
    const { padding, lineHeight, titleBodyGap } = LOGIN_DELETION_BUBBLE;
    expect(padding + lineHeight + titleBodyGap + lineHeight + padding).toBe(91);
    // phone:stage 750 内 x=40 w=670(左右各 40 → 等价水平居中)
    expect(LOGIN_DELETION_BUBBLE.phone).toEqual({ width: 670, x: 40, stageWidth: 750 });
    // pad 横屏:556 = WORD_MARK 框宽 @x=607(figma 679:1201),中心 885 与登录组同轴
    expect(LOGIN_DELETION_BUBBLE.padLandscape).toEqual({ width: 556, x: 607, top: 72 });
    expect(LOGIN_DELETION_BUBBLE.padLandscape.x + LOGIN_DELETION_BUBBLE.padLandscape.width / 2).toBe(885);
    // pad 竖屏:字标框宽按可见图形等比反算 269.51 ×(556/297.32)≈ 504
    expect(LOGIN_DELETION_BUBBLE.padPortrait).toEqual({ width: 504, top: 72 });
    expect(Math.round(269.51 * (556 / 297.32))).toBe(504);
    // hitSlop:RN 不会越过父 View 边界,上/下取「气泡内可用空间」钳制(虚标无效);
    // 手算:scale=0.52(390pt 屏)→ top=min(18, 22×0.52)=11.44、bottom=min(18, 20×0.52)=10.4
    const s52 = resolveDeletionBubbleLinkHitSlop(0.52);
    expect(s52.top).toBeCloseTo(11.44, 10);
    expect(s52.bottom).toBeCloseTo(10.4, 10);
    expect(s52.left).toBe(20);
    expect(s52.right).toBe(20);
    // pad scale=1:间距 22/padding 20 均超 18 上限 → 钳到 18(名义扩张的上限)
    expect(resolveDeletionBubbleLinkHitSlop(1)).toEqual({ top: 18, bottom: 18, left: 20, right: 20 });
    // 最窄 320pt(scale=320/750≈0.426667):top=9.386.., bottom=8.533..
    const narrow = resolveDeletionBubbleLinkHitSlop(320 / 750);
    expect(narrow.top).toBeCloseTo(22 * (320 / 750), 6);
    expect(narrow.bottom).toBeCloseTo(20 * (320 / 750), 6);
  });

  it('phone:宽 = 670 × 屏宽/750(随屏缩放,不写死),水平居中,top 原样带 safe-area', () => {
    // 390pt 屏:scale=0.52 → 宽 670×0.52=348.4,left=(390-348.4)/2=20.8(= 设计 40×0.52)
    const frame = resolveDeletionBubbleFrame(resolveLoginSurface(390, 844), 47);
    expect(frame.scale).toBeCloseTo(0.52, 10);
    expect(frame.width).toBeCloseTo(348.4, 6);
    expect(frame.left).toBeCloseTo(20.8, 6);
    expect(frame.left).toBeCloseTo(LOGIN_DELETION_BUBBLE.phone.x * frame.scale, 6);
    expect(frame.top).toBe(47);
    // 大屏 iPhone 393pt:宽 351.08(写死 335 会偏窄 16pt)
    const big = resolveDeletionBubbleFrame(resolveLoginSurface(393, 852), 59);
    expect(big.width).toBeCloseTo(670 * (393 / 750), 6);
    expect(big.width).toBeCloseTo(351.08, 6);
    expect(big.top).toBe(59);
    // safeTop 原样消费,不内嵌状态栏高
    expect(resolveDeletionBubbleFrame(resolveLoginSurface(390, 844), 0).top).toBe(0);
    // 窄屏(Split View 320pt):宽 285.867,边距 17.067(= 设计 40 × 0.426667)
    const narrow = resolveDeletionBubbleFrame(resolveLoginSurface(320, 768), 20);
    expect(narrow.width).toBeCloseTo(670 * (320 / 750), 6);
    expect(narrow.left).toBeCloseTo(40 * (320 / 750), 6);
    expect(narrow.left + narrow.width).toBeLessThanOrEqual(320);
  });

  it('pad-portrait:宽 = 504 × scale,水平居中(= 字标轴),top = 72 × scale', () => {
    // 744×1133 基准画布:scale=1 → 宽 504,left=(744-504)/2=120,top=72
    const frame = resolveDeletionBubbleFrame(resolveLoginSurface(744, 1133), 24);
    expect(frame.scale).toBe(1);
    expect(frame.width).toBe(504);
    expect(frame.left).toBe(120);
    expect(frame.top).toBe(72);
    // 820×1180:scale=min(820/744,1180/1133)=1180/1133≈1.041482
    const wide = resolveDeletionBubbleFrame(resolveLoginSurface(820, 1180), 24);
    const k = 1180 / 1133;
    expect(wide.scale).toBeCloseTo(k, 10);
    expect(wide.width).toBeCloseTo(504 * k, 6);
    expect(wide.left).toBeCloseTo((820 - 504 * k) / 2, 6);
    expect(wide.top).toBeCloseTo(72 * k, 6);
  });

  it('pad-landscape:宽 = 556 × scale,与字标同轴,top = offsetY + 72 × scale', () => {
    // 1180×820 基准画布:scale=1 → 宽 556,left=607,top=72
    const frame = resolveDeletionBubbleFrame(resolveLoginSurface(1180, 820), 24);
    expect(frame).toEqual({ left: 607, top: 72, width: 556, scale: 1 });
    // iPad mini 横屏 1133×744:scale=min(1133/1180,744/820)=744/820≈0.907317,
    // offsetX=(1133-1180k)/2=31.1829 → left=31.1829+607k=581.9236,宽 504.468;
    // 气泡中心 = 581.9236+252.234 = 834.16 与字标轴一致(错用 viewport×0.75 会偏)
    const mini = resolveDeletionBubbleFrame(resolveLoginSurface(1133, 744), 24);
    const k = 744 / 820;
    expect(mini.scale).toBeCloseTo(k, 10);
    expect(mini.width).toBeCloseTo(556 * k, 6);
    expect(mini.left).toBeCloseTo((1133 - 1180 * k) / 2 + 607 * k, 4);
    expect(mini.left + mini.width / 2).toBeCloseTo(834.1585, 3);
    expect(mini.top).toBeCloseTo(72 * k, 6);
    expect(mini.left + mini.width).toBeLessThanOrEqual(1133);
  });

  it('pad-landscape 断点底线(1000×690,scale clamp 0.85):几何随之缩小,气泡不越右缘', () => {
    // scale=max(0.85,min(1000/1180,690/820))=0.85;offsetX=(1000-1003)/2=-1.5、offsetY=-3.5
    // → 宽 472.6、left=-1.5+607×0.85=514.45、右缘 987.05 未越屏;top=-3.5+61.2=57.7
    const frame = resolveDeletionBubbleFrame(resolveLoginSurface(1000, 690), 24);
    expect(frame.scale).toBeCloseTo(0.85, 10);
    expect(frame.width).toBeCloseTo(472.6, 6);
    expect(frame.left).toBeCloseTo(514.45, 6);
    expect(frame.left + frame.width).toBeLessThanOrEqual(1000);
    expect(frame.top).toBeCloseTo(57.7, 6);
  });
});

/**
 * 「跳过登录」文字按钮的防御性截断契约(DESIGN.md §16.3,修 final-review P1-2)。
 *
 * 组件依赖 RN 运行时、makeStyles 未导出,node vitest 下沿用仓内读源码断言(loginConsent
 * 同款)。锁的是意图:热区仍随语言 shrink-to-fit,但**含 padding 不得越 680 槽** ——
 * 超预算译文走单行 tail ellipsis,而不是被面板 overflow:hidden 静默裁边(可见省略号
 * = 文案 bug,改文案不改布局)。
 */
describe('LoginSkipLoginLink 防御性截断(桌面 LoginSkipEntry 同款)', () => {
  const controlsSource = readFileSync(
    resolve(process.cwd(), 'src/components/LoginSkinControls.tsx'),
    'utf8',
  );
  const pressStyle = (() => {
    const start = controlsSource.indexOf('  skipLoginPress: {');
    expect(start).toBeGreaterThan(0);
    return controlsSource.slice(start, controlsSource.indexOf('  },', start));
  })();
  const textStyle = (() => {
    const start = controlsSource.indexOf('  skipLoginText: {');
    expect(start).toBeGreaterThan(0);
    return controlsSource.slice(start, controlsSource.indexOf('  },', start));
  })();

  it('内层 Pressable 有 maxWidth = 680(槽宽),且宽度仍不写死', () => {
    expect(pressStyle).toContain('maxWidth: LOGIN_SKIP_LOGIN.width');
    expect(LOGIN_SKIP_LOGIN.width).toBe(680);
    // 热区仍 shrink-to-fit:不能出现固定 width(否则整槽变可点、违反 §16.3 自适应热区)
    expect(pressStyle).not.toMatch(/\bwidth:/);
    // 左右扩张量不变(热区 = 文字实宽 + 各 50)
    expect(pressStyle).toContain('paddingHorizontal: LOGIN_SKIP_LOGIN.pressPadX');
  });

  it('文本可收缩 + 单行 tail ellipsis(maxWidth 触顶时才生效)', () => {
    // row + flexShrink:1 = RN 标准横向收缩组合(column 下 flexShrink 作用在纵轴,
    // 横向只能靠隐式测量兜底 —— 不依赖隐式行为)
    expect(pressStyle).toContain("flexDirection: 'row'");
    expect(textStyle).toContain('flexShrink: 1');
    const jsxStart = controlsSource.indexOf('export function LoginSkipLoginLink');
    const jsx = controlsSource.slice(jsxStart, controlsSource.indexOf('\n}\n', jsxStart));
    expect(jsx).toContain('numberOfLines={1}');
    expect(jsx).toContain('ellipsizeMode="tail"');
    // 槽本体仍只做居中容器、不吃触摸
    expect(jsx).toContain('pointerEvents="box-none"');
  });
});
