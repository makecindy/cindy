import { describe, expect, it } from 'vitest';
import {
  lightColors,
  darkColors,
  loginColors,
  loginGradients,
  loginSizes,
} from '@/theme/tokens';

/**
 * 登录皮肤 token 守护测试(PR0a,implementation-plan Step 0 WHAT1)。
 *
 * 守三条纪律:
 * 1. 登录 token 跨主题恒定——独立于 ThemeColors,light/dark 色板里不得出现同名 key
 *    (防止后来者把登录色搬进主题色板导致随主题染色)。
 * 2. 错误文字必须走独立 `loginError`(#D91F37 族),不得复用 statusError——语义违规
 *    (implementation-plan Step 0 WHAT1 明文)。
 * 3. 关键色值/尺寸冻结——变更须回到 design.md §8 / figma-component-spec / U 裁决
 *    的权威链取值,不允许在 tokens.ts 里顺手漂移。
 */
describe('login token 守护', () => {
  it('登录 token 不进 ThemeColors(跨主题恒定,不随 light/dark 切换)', () => {
    const themeKeys = new Set([...Object.keys(lightColors), ...Object.keys(darkColors)]);
    for (const key of Object.keys(loginColors)) {
      expect(themeKeys.has(key), `loginColors.${key} 不应出现在 ThemeColors`).toBe(false);
    }
  });

  it('loginError 是独立语义 token(#D91F37;不复用 statusError 语义键——值同源但语义分离)', () => {
    expect(loginColors.loginError).toBe('#D91F37');
    // 语义守护:登录错误文字有自己的 token 键,ThemeColors 的 statusError 键
    // 不得被登录组件当作错误文字来源(值恰好同 hex 属色板同源,语义仍须分离——
    // statusError 随主题表意状态点,loginError 跨主题恒定表意登录错误文字)。
    expect(Object.prototype.hasOwnProperty.call(loginColors, 'loginError')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(loginColors, 'statusError')).toBe(false);
  });

  it('品牌 accent 语义冻结(#DF0C27 accent 专用;wave4 改判禁止表达页面背景)', () => {
    expect(loginColors.brandAccent).toBe('#DF0C27');
    expect(loginColors.brandAccentPressed).toBe('#A61629');
    // 命名守护:登录 token 组里不允许出现「背景语义 + 品牌红值」的组合键名
    for (const [key, value] of Object.entries(loginColors)) {
      if (value === '#DF0C27') {
        expect(/bg|background/i.test(key), `品牌红 token 命名不得含背景语义: ${key}`).toBe(false);
      }
    }
  });

  it('wave4 面板/描边/链接/渐变关键值冻结', () => {
    expect(loginColors.panelBg).toBe('#FBFBFB');
    expect(loginColors.panelBorder).toBe('#D4D4D4');
    expect(loginColors.primaryButtonBg).toBe('#2A2828');
    expect(loginColors.primaryButtonBorder).toBe('#434343');
    expect(loginColors.linkPressed).toBe('#1A1818'); // U-9 裁决值
    expect(loginColors.sloganInk).toBe('#2A2828');
    expect(loginColors.gradientTint).toBe('#F70121');
    expect(loginGradients.radial.layerOpacity).toBe(0.06);
    expect(loginGradients.radial.alphaStop).toBe(0.747);
    expect(loginGradients.linear.layerOpacity).toBe(0.05);
  });

  it('登录尺寸阶梯冻结(figma 750 稿刚性功能区)', () => {
    expect(loginSizes.panelWidth).toBe(680);
    expect(loginSizes.panelHeight).toBe(440);
    expect(loginSizes.panelRadius).toBe(36);
    expect(loginSizes.flowHeight).toBe(560);
    expect(loginSizes.controlWidth).toBe(540);
    expect(loginSizes.controlHeight).toBe(80);
    expect(loginSizes.controlRadius).toBe(40);
    expect(loginSizes.socialSize).toBe(80);
    expect(loginSizes.socialGap).toBe(70);
    expect(loginSizes.methodRowHeight).toBe(100);
    expect(loginSizes.methodRowRadius).toBe(60);
    // 派生关系守护:flowHeight = panel + gap + social
    expect(loginSizes.panelHeight + loginSizes.panelSocialGap + loginSizes.socialSize).toBe(
      loginSizes.flowHeight,
    );
  });
});
