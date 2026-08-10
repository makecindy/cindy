import { describe, expect, it, vi } from "vitest";

/**
 * PR4a 750 stage 布局引擎 + 42s 倒计时纯函数测试(SC-7 slice pr4a)。
 * 期望值全部来自权威链硬编码(demo phoneLayout wave3.5 旧表 / Step 3a 契约),
 * 不引用实现内部公式回算,防「实现测实现」自证。
 */
vi.mock("expo-localization", () => ({
  getLocales: () => [{ languageTag: "zh-CN" }],
}));

import {
  createResendDeadline,
  formatResendCountdown,
  LOGIN_DELETION_BUBBLE,
  LOGIN_PAD_LANDSCAPE_STAGE,
  LOGIN_PAD_PORTRAIT_STAGE,
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
} from "@/auth/loginSkinLayout";
import { loginMessages } from "@/auth/loginMessages";

function expectBox(actual: LoginStageBox, expected: LoginStageBox) {
  expect(actual.x).toBeCloseTo(expected.x, 6);
  expect(actual.y).toBeCloseTo(expected.y, 6);
  expect(actual.w).toBeCloseTo(expected.w, 6);
  expect(actual.h).toBeCloseTo(expected.h, 6);
}

describe("loginSkin 750 stage 布局引擎", () => {
  it("scale 与 designHeight clamp:vw/750 缩放,dh clamp [600,1800]", () => {
    const layout = resolveLoginStage(390, 844);
    expect(layout.scale).toBeCloseTo(390 / 750, 10);
    expect(layout.designHeight).toBeCloseTo(844 / (390 / 750), 6);
    // clamp 下限:dh < 600 → 600
    expect(resolveLoginStage(750, 500).designHeight).toBe(600);
    // clamp 上限:dh > 1800 → 1800
    expect(resolveLoginStage(750, 2000).designHeight).toBe(1800);
  });

  it("短屏档 1334:品牌簇 + 功能区落位逐字段等于登录改版新稿 figma 705:915 实测值(loginY 622)", () => {
    const layout = resolveLoginStage(375, 667); // scale 0.5 → dh 1334
    expect(layout.designHeight).toBe(1334);
    // 立绘 599×720 @(75,60)(新稿 hero y=87,2026-07-27 用户拍板方案 B 再上移 27 避脸)
    expectBox(layout.cindy, { x: 75, y: 60, w: 599, h: 720 });
    // slogan 可见图形框 = 容器 @(385,387) + vector(77.55,21.37);尺寸稿内未变
    expectBox(layout.slogan, { x: 462.55, y: 408.37, w: 254.01, h: 72.8 });
    // 字标图像框 = 主容器 @(35,422) + WORD_MARK 内字标 @(173,65) = (208,487),335×115
    expectBox(layout.word, { x: 208, y: 487, w: 335, h: 115 });
    // 功能区落位取新稿标注值(Log_in 组 @(35,622));2026-07-29 审图拍板方案 B——
    // 品牌簇既已整档换新稿基准,loginY 必须同源,否则字标↔面板会空出 92 设计px
    expect(layout.loginY).toBe(622);
  });

  it("长屏档 1624:新稿 figma 705:799 品牌簇 + 功能区落位逐字段命中(hero y=106,loginY 827)", () => {
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

  it("两档间 lerp:designHeight=1479 中点全字段线性插值(含 loginY)", () => {
    const layout = resolveLoginStage(750, 1479); // scale 1 → dh 1479,t=0.5
    // 立绘 y 中点 = (60 + 106)/2(短屏档上移 27 后)
    expectBox(layout.cindy, { x: 37.5, y: 83, w: 674.5, h: 811 });
    // slogan y 中点 = (408.37 + 568)/2(2026-07-27 LONG 档下移避脸后)
    expectBox(layout.slogan, { x: 453.725, y: 488.185, w: 261.835, h: 75.045 });
    expectBox(layout.word, { x: 195, y: 578.085, w: 361, h: 123.59 });
    // loginY 中点 = (622 + 827)/2(2026-07-29 两档同换新稿标注值后)
    expect(layout.loginY).toBeCloseTo(724.5, 6);
  });

  it("两档外超长:designHeight clamp 1800 → t=1 长屏几何原样", () => {
    const layout = resolveLoginStage(750, 2400); // dh 2400 → clamp 1800
    expect(layout.designHeight).toBe(1800);
    expectBox(layout.cindy, LOGIN_STAGE_LONG.cindy);
    expectBox(layout.slogan, LOGIN_STAGE_LONG.slogan);
    expectBox(layout.word, LOGIN_STAGE_LONG.word);
    expect(layout.loginY).toBe(LOGIN_STAGE_LONG.loginY);
  });

  it("两档外短屏:功能区优先 v 压缩视觉区,loginY=min(SHORT.loginY, max(0,dh-640))——紧凑底距锚底 + 钳到短屏档落位", () => {
    // dh=1000:v=(1000-600)/734≈0.5449591;视觉区以 (375,0) 为锚缩放(v 公式不动)
    // loginY = min(622, 1000-640) = 360(未触顶,仍是 main 逐值行为)
    const layout = resolveLoginStage(750, 1000);
    expect(layout.loginY).toBe(360);
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

  it("品牌簇不重叠不变式:字标框底不压面板顶、slogan 不压字标(两档)", () => {
    // 字标可见框底 < 面板顶:两档都留正间距(面板不透明,压上去会盖住字标)
    expect(LOGIN_STAGE_SHORT.word.y + LOGIN_STAGE_SHORT.word.h).toBeLessThan(
      LOGIN_STAGE_SHORT.loginY,
    );
    expect(LOGIN_STAGE_LONG.word.y + LOGIN_STAGE_LONG.word.h).toBeLessThan(
      LOGIN_STAGE_LONG.loginY,
    );
    // slogan 可见框与字标框不重叠(inner vector 口径下两档均无交叠)
    expect(
      LOGIN_STAGE_SHORT.slogan.y + LOGIN_STAGE_SHORT.slogan.h,
    ).toBeLessThan(LOGIN_STAGE_SHORT.word.y);
    expect(LOGIN_STAGE_LONG.slogan.y + LOGIN_STAGE_LONG.slogan.h).toBeLessThan(
      LOGIN_STAGE_LONG.word.y,
    );
    // 2026-07-27 用户审 demo 拍板:LONG 档 slogan 下移避脸后,底↔字标顶 ≈24 设计px
    // (钉住下限,防后续再往下挪撞字标)
    expect(
      LOGIN_STAGE_LONG.word.y -
        (LOGIN_STAGE_LONG.slogan.y + LOGIN_STAGE_LONG.slogan.h),
    ).toBeCloseTo(23.88, 2);
  });

  /**
   * 字标↔面板间距必须**恰好**是新稿标注值 —— 上界不变式(2026-07-29 事故直接产物)。
   *
   * 为什么必须钉死而不是只判「不重叠」:上一版把品牌簇整档换成新稿基准、却把 loginY
   * 留在配旧品牌簇的 694 / 933,间距从稿内的 20 / 25.65 变成 92 / 131.65(短屏多空
   * 73、长屏多空 109.65 设计px,实机上肉眼可见一条空白)。当时的不重叠断言
   * (word 底 < loginY)对这种「空太多」完全无感——只有下界没有上界,拼接错误静默通过。
   * 品牌簇与功能区是同一份稿的两半,任何一半单独改动都会先在这里红。
   */
  it("间距上界不变式:字标底↔面板顶 = 新稿标注间距(短屏 20 / 长屏 25.65),防只改一半", () => {
    expect(
      LOGIN_STAGE_SHORT.loginY -
        (LOGIN_STAGE_SHORT.word.y + LOGIN_STAGE_SHORT.word.h),
    ).toBe(20);
    expect(
      LOGIN_STAGE_LONG.loginY -
        (LOGIN_STAGE_LONG.word.y + LOGIN_STAGE_LONG.word.h),
    ).toBeCloseTo(25.65, 2);
  });

  /**
   * 短屏以下落位公式必须与 SHORT.loginY 在 dh=1334 处连续 —— 两侧不同源会让 1334
   * 上下一像素之差产生整组纵向跳变(用户旋转/分屏时可见)。这里不写死常量,让两侧
   * 自己对上,以后再改 SHORT.loginY 只需改一处。
   */
  it("锚常量连续性不变式:dh=1334 上下不跳变(短屏以下公式 ↔ SHORT.loginY 同源)", () => {
    const at1334 = resolveLoginStage(750, 1334).loginY;
    const justBelow = resolveLoginStage(750, 1333.9).loginY;
    expect(at1334).toBe(LOGIN_STAGE_SHORT.loginY);
    expect(justBelow).toBeCloseTo(LOGIN_STAGE_SHORT.loginY, 0);
  });

  /**
   * 短屏**以下**分支(dh<1334)同样不许让不透明面板盖住字标 —— 2026-07-29 review
   * 实证的盲区:上一版把锚常量直接改成 `dh-712`(想让窄屏也保留短屏档那 90 的底距),
   * 结果 dh∈[712,1222) 全段面板上移压住被 v 压缩后的字标(dh=1000 压 40 设计px),
   * 而当时的两条不变式只检查 SHORT / LONG 两个静态点,对这条独立公式分支完全无感。
   *
   * 下界取 850:dh<822 时 stage 高度已不足以同时放下压缩后的品牌簇与不缩放的功能区,
   * 字标与面板必然交叠(dh=800 压 4、dh=700 压 90.5)——那是 main 既有行为(同一公式、
   * 同一取值),属「功能区优先」的既定代价,不在本不变式范围。
   */
  it("间距不变式(短屏以下分支):dh∈[850,1334) 采样点上面板顶不得压到字标底", () => {
    const wordBottomUncompressed =
      LOGIN_STAGE_SHORT.word.y + LOGIN_STAGE_SHORT.word.h;
    for (const dh of [850, 900, 1000, 1100, 1200, 1262, 1300, 1333.9]) {
      const layout = resolveLoginStage(750, dh);
      const v = Math.max(0.25, (dh - 600) / 734);
      // 视觉区按 v 以 (375,0) 为锚压缩 → 字标底 = 未压缩底 × v
      expect(layout.word.y + layout.word.h).toBeCloseTo(
        wordBottomUncompressed * v,
        6,
      );
      expect(layout.loginY).toBeGreaterThanOrEqual(
        layout.word.y + layout.word.h,
      );
    }
  });

  it("避脸不变式(2026-07-27 方案 B):短屏立绘上移 27 且可见发顶仍在 Status Bar 下沿之下", () => {
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

describe("loginSkin 42s 重发倒计时纯函数(Step 3a 契约)", () => {
  it("42s 起点:deadline=now+42000,首帧显示 42", () => {
    expect(RESEND_COUNTDOWN_SECONDS).toBe(42);
    const now = 1_000_000;
    const deadline = createResendDeadline(now);
    expect(deadline).toBe(now + 42_000);
    expect(resendCountdownRemaining(deadline, now)).toBe(42);
  });

  it("显示数学边界:41999/1000/1/0ms 与超时(ceil 向上,非负 clamp)", () => {
    const deadline = 100_000;
    expect(resendCountdownRemaining(deadline, deadline - 41_999)).toBe(42);
    expect(resendCountdownRemaining(deadline, deadline - 1_000)).toBe(1);
    expect(resendCountdownRemaining(deadline, deadline - 1)).toBe(1);
    expect(resendCountdownRemaining(deadline, deadline)).toBe(0);
    expect(resendCountdownRemaining(deadline, deadline + 5_000)).toBe(0);
  });

  it("重置/保持语义:新 deadline 恢复满值,旧 deadline 不受 now 回拨影响非递减假设", () => {
    const now = 50_000;
    const first = createResendDeadline(now);
    // 重发成功 → 以成功时刻重建 deadline,剩余回到 42
    const second = createResendDeadline(now + 30_000);
    expect(resendCountdownRemaining(first, now + 30_000)).toBe(12);
    expect(resendCountdownRemaining(second, now + 30_000)).toBe(42);
    // 挂起恢复自校正:绝对 deadline 模型下,恢复时刻直接重算(可跳变,不递减计数)
    expect(resendCountdownRemaining(first, now + 41_500)).toBe(1);
  });

  it("模板渲染:{n} 占位替换,5 语 catalog resendCountdown 均带 {n}", () => {
    expect(formatResendCountdown("{n} 秒后可重新发送", 42)).toBe(
      "42 秒后可重新发送",
    );
    expect(formatResendCountdown("Resend available in {n}s", 7)).toBe(
      "Resend available in 7s",
    );
    for (const locale of ["zh-CN", "zh-TW", "en", "ja", "ko"] as const) {
      const template = loginMessages[locale].resendCountdown;
      expect(template, locale).toContain("{n}");
      expect(formatResendCountdown(template, 42), locale).toContain("42");
      expect(formatResendCountdown(template, 42), locale).not.toContain("{n}");
    }
  });
});

describe("loginSkin §3.6 平板/横竖屏 surface 构图(PR4b Step 5b.3;adaptation §3.6 + demo resolveMobileStage/ipadPortrait/ipadLandscape 仲裁)", () => {
  it("断点三分支:landscape∧w≥1000∧h≥690→pad-landscape;portrait∧w≥700→pad-portrait;其余→phone", () => {
    // 基准画布
    expect(resolveLoginSurfaceMode(1180, 820)).toBe("pad-landscape");
    expect(resolveLoginSurfaceMode(744, 1133)).toBe("pad-portrait");
    // 手机竖屏 → phone
    expect(resolveLoginSurfaceMode(393, 852)).toBe("phone");
    // 手机横屏(landscape 但 w<1000)→ phone 回退(§3.6 条4:不满足横屏断点落竖排)
    expect(resolveLoginSurfaceMode(852, 393)).toBe("phone");
    // landscape 满足宽但不满足高(600<690)→ phone 回退
    expect(resolveLoginSurfaceMode(1100, 600)).toBe("phone");
    // portrait 窄窗(Split View 320pt)→ phone
    expect(resolveLoginSurfaceMode(320, 768)).toBe("phone");
    // 断点边界含等号:恰好 1000×690 → pad-landscape;700×1000 → pad-portrait
    expect(resolveLoginSurfaceMode(1000, 690)).toBe("pad-landscape");
    expect(resolveLoginSurfaceMode(700, 1000)).toBe("pad-portrait");
    // 边界外一点:999×690 landscape → phone;699×1000 portrait → phone
    expect(resolveLoginSurfaceMode(999, 690)).toBe("phone");
    expect(resolveLoginSurfaceMode(699, 1000)).toBe("phone");
  });

  it("竖屏 scale = min(w/744, h/1133) 等比居中;loginGroupScale=0.794117;splashOffset=158", () => {
    const s = resolveLoginSurface(744, 1133);
    expect(s.mode).toBe("pad-portrait");
    expect(s.scale).toBeCloseTo(1, 10);
    expect(s.offsetX).toBeCloseTo(0, 6);
    expect(s.offsetY).toBeCloseTo(0, 6);
    expect(s.loginGroupScale).toBeCloseTo(0.794117, 6);
    // pad 帧未参与本轮视觉改版(新稿没有 pad frame):品牌簇与登录组几何、splash 偏移
    // 全部保持 main 原值。
    expect(s.splashOffset).toBe(158);
    // 组底(含协议行溢出 62)落 1114.94,在 stage 1133 内 → 消费端安全区抬升不被触发
    expect(s.loginY + 622 * s.loginGroupScale).toBeCloseTo(1114.94, 2);
    expect(s.phone).toBeNull();
    // 更矮视口按高度等比缩(w 定 744,h=1000<1133 → scale=min(1,0.8826)=0.8826)
    const tall = resolveLoginSurface(744, 1000);
    expect(tall.scale).toBeCloseTo(Math.min(744 / 744, 1000 / 1133), 10);
    expect(tall.offsetY).toBeCloseTo((1000 - 1133 * tall.scale) / 2, 6);
  });

  it("横屏 scale = max(0.85, min(w/1180, h/820))——仅下限 0.85、无 1.30 上限(权威链收口项)", () => {
    // 基准画布:raw=1 → scale=1
    const base = resolveLoginSurface(1180, 820);
    expect(base.mode).toBe("pad-landscape");
    expect(base.scale).toBeCloseTo(1, 10);
    expect(base.loginGroupScale).toBeCloseTo(0.655357, 6);
    expect(base.splashOffset).toBe(0);
    // 横屏组底(含协议行溢出)仍在 stage 820 内 → 几何原值不动
    expect(base.loginY + 622 * base.loginGroupScale).toBeLessThan(820);
    expect(base.phone).toBeNull();
    // raw<0.85 → 钳到 0.85 下限(§3.6 条3 仅下限;w≥1000∧h≥690∧landscape 命中 pad-landscape 但 raw<0.85)
    const floor = resolveLoginSurface(1100, 690); // min(1100/1180,690/820)=min(0.9322,0.8415)=0.8415
    expect(floor.mode).toBe("pad-landscape");
    expect(floor.scale).toBe(PAD_LANDSCAPE_MIN_SCALE);
    expect(floor.scale).toBeCloseTo(0.85, 10);
    // raw>1.30 → 无上限残留(旧 1.30 上限作废,§3.6 条3 + v5.2 收口;单测含 raw>1.30 断言无旧上限残留)
    const over = resolveLoginSurface(1534, 1066); // min(1.3,1.3)=1.3
    expect(over.scale).toBeCloseTo(1.3, 10); // 旧上限 1.30 恰好,不钳
    const far = resolveLoginSurface(1770, 1230); // min(1.5,1.5)=1.5 — 远超旧上限,原样不钳
    expect(far.scale).toBeCloseTo(1.5, 10);
  });

  /**
   * pad 两档的「字标底↔面板顶」间距钉值 —— 2026-07-29 事故的同源性防护延伸到 pad。
   *
   * phone 侧那次事故的机理是:品牌簇换了新稿基准、`loginY` 留在配旧品牌簇的值,两半
   * 不同源 → 间距漂成稿内不存在的 92 / 131.65。pad 现在**没有** figma 新稿帧,品牌簇
   * 与 `loginY` 都还是同一套 wave3 推导值,所以内部自洽(竖 14.84 / 横 33.88)。
   *
   * 但这份自洽此前没有任何断言守着:将来给 pad 换新稿基准时,只改品牌簇不改 `loginY`
   * (或反之)会原样重演 phone 那次的漂移,且静默通过。这里把两档间距钉住 —— 换稿时
   * 本用例必然红,迫使改动者同批处理 `loginY`(并在此更新钉值 + 记录依据)。
   */
  it("pad 同源性不变式:两档「字标底↔面板顶」间距钉值(竖 14.84 / 横 33.88),换稿只改一半即红", () => {
    const portrait = LOGIN_PAD_PORTRAIT_STAGE;
    expect(portrait.loginY - (portrait.word.y + portrait.word.h)).toBeCloseTo(
      14.84,
      2,
    );

    const landscape = LOGIN_PAD_LANDSCAPE_STAGE;
    expect(
      landscape.loginY - (landscape.word.y + landscape.word.h),
    ).toBeCloseTo(33.88, 2);

    // 不重叠是底线(面板不透明,压上去会盖住字标);两档都必须为正间距
    expect(portrait.loginY).toBeGreaterThan(portrait.word.y + portrait.word.h);
    expect(landscape.loginY).toBeGreaterThan(
      landscape.word.y + landscape.word.h,
    );
  });

  it("横屏居中偏移:offsetX/Y = (viewport - stage*scale)/2(画布居中锚)", () => {
    const s = resolveLoginSurface(1300, 900); // scale=min(1300/1180,900/820)=min(1.1017,1.0976)=1.09756
    expect(s.scale).toBeCloseTo(Math.min(1300 / 1180, 900 / 820), 10);
    expect(s.offsetX).toBeCloseTo((1300 - 1180 * s.scale) / 2, 6);
    expect(s.offsetY).toBeCloseTo((900 - 820 * s.scale) / 2, 6);
  });

  it("phone fallback:手机横屏/窄窗落 phone 构图,loginGroupScale=1,复用 resolveLoginStage(非 pad)", () => {
    const s = resolveLoginSurface(393, 852);
    expect(s.mode).toBe("phone");
    expect(s.loginGroupScale).toBe(1);
    expect(s.phone).toBeDefined();
    expect(s.scale).toBeCloseTo(393 / 750, 10); // resolveLoginStage 750 stage scale
    // 手机横屏(landscape w<1000)→ phone 回退,非 pad-landscape
    const horiz = resolveLoginSurface(852, 393);
    expect(horiz.mode).toBe("phone");
    expect(horiz.loginGroupScale).toBe(1);
    expect(horiz.phone).toBeDefined();
  });
});

describe("loginSkin 注销提示气泡浮层布局(figma 678:1075;**stage 设计单位** × surface.scale)", () => {
  it("常量契约:内部几何为设计单位,各端落位参数命中 figma 实读值", () => {
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
    expect(LOGIN_DELETION_BUBBLE.phone).toEqual({
      width: 670,
      x: 40,
      stageWidth: 750,
    });
    // pad 横屏:556 = WORD_MARK 框宽 @x=607(figma 679:1201),中心 885 与登录组同轴
    expect(LOGIN_DELETION_BUBBLE.padLandscape).toEqual({
      width: 556,
      x: 607,
      top: 72,
    });
    expect(
      LOGIN_DELETION_BUBBLE.padLandscape.x +
        LOGIN_DELETION_BUBBLE.padLandscape.width / 2,
    ).toBe(885);
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
    expect(resolveDeletionBubbleLinkHitSlop(1)).toEqual({
      top: 18,
      bottom: 18,
      left: 20,
      right: 20,
    });
    // 最窄 320pt(scale=320/750≈0.426667):top=9.386.., bottom=8.533..
    const narrow = resolveDeletionBubbleLinkHitSlop(320 / 750);
    expect(narrow.top).toBeCloseTo(22 * (320 / 750), 6);
    expect(narrow.bottom).toBeCloseTo(20 * (320 / 750), 6);
  });

  it("phone:宽 = 670 × 屏宽/750(随屏缩放,不写死),水平居中,top 原样带 safe-area", () => {
    // 390pt 屏:scale=0.52 → 宽 670×0.52=348.4,left=(390-348.4)/2=20.8(= 设计 40×0.52)
    const frame = resolveDeletionBubbleFrame(resolveLoginSurface(390, 844), 47);
    expect(frame.scale).toBeCloseTo(0.52, 10);
    expect(frame.width).toBeCloseTo(348.4, 6);
    expect(frame.left).toBeCloseTo(20.8, 6);
    expect(frame.left).toBeCloseTo(
      LOGIN_DELETION_BUBBLE.phone.x * frame.scale,
      6,
    );
    expect(frame.top).toBe(47);
    // 大屏 iPhone 393pt:宽 351.08(写死 335 会偏窄 16pt)
    const big = resolveDeletionBubbleFrame(resolveLoginSurface(393, 852), 59);
    expect(big.width).toBeCloseTo(670 * (393 / 750), 6);
    expect(big.width).toBeCloseTo(351.08, 6);
    expect(big.top).toBe(59);
    // safeTop 原样消费,不内嵌状态栏高
    expect(
      resolveDeletionBubbleFrame(resolveLoginSurface(390, 844), 0).top,
    ).toBe(0);
    // 窄屏(Split View 320pt):宽 285.867,边距 17.067(= 设计 40 × 0.426667)
    const narrow = resolveDeletionBubbleFrame(
      resolveLoginSurface(320, 768),
      20,
    );
    expect(narrow.width).toBeCloseTo(670 * (320 / 750), 6);
    expect(narrow.left).toBeCloseTo(40 * (320 / 750), 6);
    expect(narrow.left + narrow.width).toBeLessThanOrEqual(320);
  });

  it("pad-portrait:宽 = 504 × scale,水平居中(= 字标轴),top = 72 × scale", () => {
    // 744×1133 基准画布:scale=1 → 宽 504,left=(744-504)/2=120,top=72
    const frame = resolveDeletionBubbleFrame(
      resolveLoginSurface(744, 1133),
      24,
    );
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

  it("pad-landscape:宽 = 556 × scale,与字标同轴,top = offsetY + 72 × scale", () => {
    // 1180×820 基准画布:scale=1 → 宽 556,left=607,top=72
    const frame = resolveDeletionBubbleFrame(
      resolveLoginSurface(1180, 820),
      24,
    );
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

  it("pad-landscape 断点底线(1000×690,scale clamp 0.85):几何随之缩小,气泡不越右缘", () => {
    // scale=max(0.85,min(1000/1180,690/820))=0.85;offsetX=(1000-1003)/2=-1.5、offsetY=-3.5
    // → 宽 472.6、left=-1.5+607×0.85=514.45、右缘 987.05 未越屏;top=-3.5+61.2=57.7
    const frame = resolveDeletionBubbleFrame(
      resolveLoginSurface(1000, 690),
      24,
    );
    expect(frame.scale).toBeCloseTo(0.85, 10);
    expect(frame.width).toBeCloseTo(472.6, 6);
    expect(frame.left).toBeCloseTo(514.45, 6);
    expect(frame.left + frame.width).toBeLessThanOrEqual(1000);
    expect(frame.top).toBeCloseTo(57.7, 6);
  });
});
