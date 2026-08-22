import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  computeLoginKeyboardShift,
  controlsFullyVisibleAfterShift,
  DOCKED_KEYBOARD_WIDTH_RATIO,
  isDockedKeyboard,
  LOGIN_KEYBOARD_PANEL_GAP,
  rectsIntersect,
  type LoginKeyboardShiftInput,
} from '../loginKeyboardAvoidance';

/**
 * PR4b 键盘契约参数化单测(Step 5b.1 冻结向量;SC-7 slice pr4b keyboard 行)。
 * U-8b 硬标准:每例断言「当前输入框 + 主按钮完整可见」(clamped-fallback 除外,
 * 该模式按定义回退窄窗弹性规则);U-11=B:Android 悬浮键盘显式例外。
 * 纯函数直测(判定引擎零 RN)+ hook/页面接线走读源码断言(仓内既有双轨形态)。
 */

// 基线场景(iPhone 15 档 393×852 pt;union = 输入框顶(158)到主按钮底(380),
// 按 groupScale≈0.524 折算的典型物理框;panelBottom = 面板底)
const BASE: Omit<LoginKeyboardShiftInput, 'keyboard' | 'visible' | 'platform'> = {
  panelBottomY: 650,
  controlsUnion: { x: 60, y: 500, width: 280, height: 120 },
  viewportWidth: 393,
  viewportHeight: 852,
  safeTop: 59,
  // 全高 = viewportHeight(iOS 不缩窗;Android resize 测试单独覆写全高 > viewport 模拟缩窗)
  fullViewportHeight: 852,
  // 系统栏底 inset(nav bar;Android 未缩窗兜底用;iOS 路径不读)
  systemBarBottom: 48,
};

function iosCase(keyboard: LoginKeyboardShiftInput['keyboard']): LoginKeyboardShiftInput {
  return { ...BASE, platform: 'ios', visible: true, keyboard };
}

describe('loginKeyboard U-8b 键盘可见性硬标准(参数化冻结向量)', () => {
  it('向量1 停靠键盘:面板底 10px 贴附(shift = panelBottom + 10 - keyboardTop)', () => {
    const input = iosCase({ x: 0, y: 600, width: 393, height: 252 });
    const result = computeLoginKeyboardShift(input);
    expect(result.mode).toBe('docked');
    expect(result.shift).toBe(650 + LOGIN_KEYBOARD_PANEL_GAP - 600);
    expect(controlsFullyVisibleAfterShift(input, result)).toBe(true);
  });

  it('向量2 浮动键盘遮挡输入框:二维相交,按纵向遮挡量上移', () => {
    const input = iosCase({ x: 80, y: 520, width: 220, height: 200 });
    const result = computeLoginKeyboardShift(input);
    expect(result.mode).toBe('floating-overlap');
    expect(result.shift).toBe(500 + 120 - 520);
    expect(controlsFullyVisibleAfterShift(input, result)).toBe(true);
  });

  it('向量3 浮动键盘遮挡主按钮:union 底越过键盘顶的深度即位移', () => {
    const input = iosCase({ x: 80, y: 600, width: 220, height: 120 });
    const result = computeLoginKeyboardShift(input);
    expect(result.mode).toBe('floating-overlap');
    expect(result.shift).toBe(620 - 600);
    expect(controlsFullyVisibleAfterShift(input, result)).toBe(true);
  });

  it('向量4 浮动键盘横向不相交:不动(shift=0)', () => {
    // union x∈[60,340],键盘 x∈[350,393]:纵向重叠但横向分离
    const input = iosCase({ x: 350, y: 500, width: 43, height: 200 });
    const result = computeLoginKeyboardShift(input);
    expect(result.mode).toBe('floating-clear');
    expect(result.shift).toBe(0);
    expect(rectsIntersect(input.keyboard!, input.controlsUnion)).toBe(false);
    expect(controlsFullyVisibleAfterShift(input, result)).toBe(true);
  });

  it('向量5 分离键盘(半宽矩形):与悬浮同一二维相交判定', () => {
    const input = iosCase({ x: 0, y: 560, width: 195, height: 150 });
    expect(isDockedKeyboard(input.keyboard!, input.viewportWidth)).toBe(false);
    const result = computeLoginKeyboardShift(input);
    expect(result.mode).toBe('floating-overlap');
    expect(result.shift).toBe(620 - 560);
    expect(controlsFullyVisibleAfterShift(input, result)).toBe(true);
  });

  it('向量6 320pt 分屏窄窗:停靠键盘贴附规则不变', () => {
    const input: LoginKeyboardShiftInput = {
      platform: 'ios',
      visible: true,
      keyboard: { x: 0, y: 500, width: 320, height: 268 },
      panelBottomY: 580,
      controlsUnion: { x: 40, y: 430, width: 240, height: 120 },
      viewportWidth: 320,
      viewportHeight: 768,
      safeTop: 24,
      fullViewportHeight: 768,
      systemBarBottom: 0,
    };
    const result = computeLoginKeyboardShift(input);
    expect(result.mode).toBe('docked');
    expect(result.shift).toBe(580 + LOGIN_KEYBOARD_PANEL_GAP - 500);
    expect(controlsFullyVisibleAfterShift(input, result)).toBe(true);
  });

  it('向量7 浮动键盘已显示后横移/重停靠改 frame:逐帧重判定(keyboardWillChangeFrame 驱动)', () => {
    // 帧1:停靠 → 60;帧2:拖成右侧浮动不相交 → 0;帧3:重停靠 → 60
    const docked = iosCase({ x: 0, y: 600, width: 393, height: 252 });
    const floatingClear = iosCase({ x: 350, y: 500, width: 43, height: 200 });
    const first = computeLoginKeyboardShift(docked);
    const second = computeLoginKeyboardShift(floatingClear);
    const third = computeLoginKeyboardShift(docked);
    expect(first).toEqual({ shift: 60, mode: 'docked' });
    expect(second).toEqual({ shift: 0, mode: 'floating-clear' });
    expect(third).toEqual(first);
    for (const [input, result] of [
      [docked, first],
      [floatingClear, second],
      [docked, third],
    ] as const) {
      expect(controlsFullyVisibleAfterShift(input, result)).toBe(true);
    }
  });

  it('U-11=B Android 悬浮键盘显式例外:不自定义上移(adjustResize 保底)', () => {
    const input: LoginKeyboardShiftInput = {
      ...BASE,
      platform: 'android',
      visible: true,
      keyboard: { x: 80, y: 520, width: 220, height: 200 },
    };
    const result = computeLoginKeyboardShift(input);
    expect(result).toEqual({ shift: 0, mode: 'android-floating-exception' });
  });

  it('Android 停靠 + resize 已生效:以 resize 后 viewport 底为键盘顶,位移只计一次', () => {
    // 系统 resize 后 viewportHeight=500(全高 852)、基线重测后面板底 460 已在键盘上方 →
    // 自定义位移 0(缩窗 → screenY 可靠 = 500;若误用 height-based = 852-300-48=504,required 仍 ≤ 0)
    const input: LoginKeyboardShiftInput = {
      platform: 'android',
      visible: true,
      keyboard: { x: 0, y: 500, width: 393, height: 300 },
      panelBottomY: 460,
      controlsUnion: { x: 60, y: 310, width: 280, height: 120 },
      viewportWidth: 393,
      viewportHeight: 500,
      safeTop: 24,
      fullViewportHeight: 852,
      systemBarBottom: 48,
    };
    const result = computeLoginKeyboardShift(input);
    expect(result.mode).toBe('docked');
    expect(result.shift).toBe(0);
    expect(controlsFullyVisibleAfterShift(input, result)).toBe(true);
  });

  it('Android 停靠 + 未缩窗(edge-to-edge insets / adjustPan,screenY 不可靠):height-based 兜底', () => {
    // edge-to-edge:viewport 不缩窗,screenY(= getWindowVisibleDisplayFrame.bottom)退化
    // 为 viewportHeight(误判无遮挡,required ≤ 0 → 不位移,主按钮被截——用户 2026-07-21
    // 拍板四形态含 Android 必须完整露出)。兜底 keyboardTop = 全高 - 键盘高 - 系统栏底
    // = 852 - 300 - 48 = 504(真实键盘顶);required = 740 + 10 - 504 = 246;位移后
    // 面板底 740 - 246 = 494,距键盘顶 504 - 494 = 10px(§4.5 10px gap 命中)。
    const input: LoginKeyboardShiftInput = {
      platform: 'android',
      visible: true,
      keyboard: { x: 0, y: 852, width: 393, height: 300 },
      panelBottomY: 740,
      controlsUnion: { x: 60, y: 500, width: 280, height: 120 },
      viewportWidth: 393,
      viewportHeight: 852,
      safeTop: 59,
      fullViewportHeight: 852,
      systemBarBottom: 48,
    };
    const result = computeLoginKeyboardShift(input);
    expect(result.mode).toBe('docked');
    expect(result.shift).toBe(246);
    expect(controlsFullyVisibleAfterShift(input, result)).toBe(true);
  });

  it('Android 停靠 + 缩窗(panel 在键盘下):screenY 可靠,不用 height-based', () => {
    // adjustResize 缩窗:viewport 552 < 全高 852 → screenY 可靠(= 缩窗后 viewport 底 = 键盘顶)。
    // panel 底 600 在键盘顶 552 下方 → required = 600 + 10 - 552 = 58。
    // (若误用 height-based:keyboardTop = 852 - 300 - 48 = 504 → required = 106;断言 58 锁定 screenY 路径)
    const input: LoginKeyboardShiftInput = {
      platform: 'android',
      visible: true,
      keyboard: { x: 0, y: 552, width: 393, height: 300 },
      panelBottomY: 600,
      controlsUnion: { x: 60, y: 430, width: 280, height: 120 },
      viewportWidth: 393,
      viewportHeight: 552,
      safeTop: 59,
      fullViewportHeight: 852,
      systemBarBottom: 48,
    };
    const result = computeLoginKeyboardShift(input);
    expect(result.mode).toBe('docked');
    expect(result.shift).toBe(58);
    expect(controlsFullyVisibleAfterShift(input, result)).toBe(true);
  });

  it('safe-top 上限:需求位移超限时钳到上限并回退窄窗弹性规则(clamped-fallback)', () => {
    const input: LoginKeyboardShiftInput = {
      platform: 'ios',
      visible: true,
      keyboard: { x: 0, y: 150, width: 390, height: 450 },
      panelBottomY: 260,
      controlsUnion: { x: 60, y: 80, width: 280, height: 120 },
      viewportWidth: 390,
      viewportHeight: 600,
      safeTop: 59,
      fullViewportHeight: 600,
      systemBarBottom: 0,
    };
    const result = computeLoginKeyboardShift(input);
    expect(result.mode).toBe('clamped-fallback');
    // maxShift = union 顶(80) - safeTop(59) = 21 < 需求 120:不无限上移
    expect(result.shift).toBe(21);
  });

  it('键盘不可见/无矩形:hidden,不动;停靠阈值冻结 0.95', () => {
    expect(
      computeLoginKeyboardShift({ ...BASE, platform: 'ios', visible: false, keyboard: null }),
    ).toEqual({ shift: 0, mode: 'hidden' });
    expect(DOCKED_KEYBOARD_WIDTH_RATIO).toBe(0.95);
    expect(LOGIN_KEYBOARD_PANEL_GAP).toBe(10);
  });
});

describe('loginKeyboard 接线(hook 订阅拓扑 + 登录页测量拓扑,读源码断言)', () => {
  const hookSource = readFileSync(
    resolve(process.cwd(), 'src/session/useMobileKeyboardState.ts'),
    'utf8',
  );
  const loginSource = readFileSync(
    resolve(process.cwd(), 'app/(auth)/login.tsx'),
    'utf8',
  );
  const stageSource = readFileSync(
    resolve(process.cwd(), 'src/components/MobileLoginHandoffStage.tsx'),
    'utf8',
  );

  it('iOS 订阅升级(v6.7):will show/hide + keyboardWillChangeFrame,卸载全移除', () => {
    expect(hookSource).toContain("Keyboard.addListener('keyboardWillChangeFrame'");
    expect(hookSource).toContain("Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow'");
    expect(hookSource).toContain("Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide'");
    expect(hookSource).toContain('for (const subscription of subscriptions) subscription.remove();');
  });

  it('v5 冻结测量拓扑:外层未变换 wrapper measureInWindow,内层 translate 容器施加位移', () => {
    expect(loginSource).toContain('measureInWindow');
    expect(loginSource).toContain('外层未变换测量 wrapper');
    expect(loginSource).toContain('translateY: -keyboardShift');
    expect(loginSource).toContain('computeLoginKeyboardShift');
    // 候选层收在面板内：停靠锚恒为面板底，悬浮键盘 union 仍纳入候选层。
    expect(loginSource).toContain(
      'LOGIN_SSO_ORG_HISTORY.y + LOGIN_SSO_ORG_HISTORY.maxHeight',
    );
    expect(loginSource).toContain(
      'panelBottomY: groupBaseline.y + loginSizes.panelHeight * groupScale',
    );
    expect(loginSource).toContain(
      'height: (controlsUnionBottom - LOGIN_CONTROL.inputY) * groupScale',
    );
    expect(loginSource).toContain('LOGIN_CONTROL.inputY * groupScale');
    // Android 未缩窗兜底:page 跟踪全高 + 传系统栏底(computeDockedKeyboardTop)
    expect(loginSource).toContain('fullViewportHeight');
    expect(loginSource).toContain('systemBarBottom: insets.bottom');
  });

  it('品牌层随键盘整体上顶(demo kb-shift 同构),纯平底锚定根 View 不动', () => {
    expect(stageSource).toContain('keyboardShiftPx');
    expect(stageSource).toContain('translateY: -keyboardShiftPx');
    // 背景钉在根 View 的 backgroundColor 上,位于键盘位移层之外
    // (源码顺序:根 View 底色声明先于位移容器;wave4 双红渐变叠层已撤,对齐 PR#104)
    const backgroundAt = stageSource.indexOf('backgroundColor: colors.login.bgBase');
    const shiftAt = stageSource.indexOf('translateY: -keyboardShiftPx');
    expect(backgroundAt).toBeGreaterThan(0);
    expect(shiftAt).toBeGreaterThan(backgroundAt);
  });

  it('AndroidManifest 键盘配置零改动(方案 B):不出现 windowSoftInputMode 自定义', () => {
    expect(loginSource).not.toContain('windowSoftInputMode');
    expect(hookSource).not.toContain('windowSoftInputMode');
    expect(stageSource).not.toContain('windowSoftInputMode');
  });
});
