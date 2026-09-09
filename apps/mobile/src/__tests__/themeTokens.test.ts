import { describe, expect, it } from 'vitest';
import {
  darkColors,
  fontWeight,
  iconSize,
  lightColors,
  lineHeight,
  motionDuration,
  palettes,
  textStyles,
  typeScale,
  type ThemeColors,
} from '@/theme/tokens';

// WCAG 2.1 对比度工具 —— 仅用于本文件 CTA 契约断言(sRGB 相对亮度法)。
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function contrastRatio(fg: string, bg: string): number {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

describe('theme tokens', () => {
  it('light / dark 色板 key 集合完全一致', () => {
    expect(Object.keys(lightColors).sort()).toEqual(Object.keys(darkColors).sort());
  });

  it('palettes 指向同一份 light / dark 对象', () => {
    expect(palettes.light).toBe(lightColors);
    expect(palettes.dark).toBe(darkColors);
  });

  it('语义动效例外与 DESIGN.md §14.4 保持一致', () => {
    expect(motionDuration.spinnerCycle).toBe(1000);
    expect(motionDuration.sidebarTitleMarqueePerViewport).toBe(2400);
  });

  it('每个颜色 token 都是非空字符串(login 登录皮嵌套组下钻)', () => {
    for (const palette of [lightColors, darkColors]) {
      for (const [key, value] of Object.entries(palette)) {
        if (key === 'login') {
          // 登录皮双态色板(暗色实现 PR):嵌套组逐 key 校验
          for (const [loginKey, loginValue] of Object.entries(
            value as Record<string, string>,
          )) {
            expect(typeof loginValue, `login.${loginKey}`).toBe('string');
            expect(loginValue.length, `login.${loginKey}`).toBeGreaterThan(0);
          }
          continue;
        }
        expect(typeof value, key).toBe('string');
        expect((value as string).length, key).toBeGreaterThan(0);
      }
    }
  });

  it('状态四色跨 light / dark 一致(设计定稿 2026-07-17:running #EA6B17 / awaiting #19D2C1 / error #D91F37 / done #2AAE5B)', () => {
    expect(darkColors.statusReady).toBe(lightColors.statusReady);
    expect(darkColors.statusAccent).toBe(lightColors.statusAccent);
    expect(darkColors.statusRecording).toBe(lightColors.statusRecording);
    expect(darkColors.statusAwaiting).toBe(lightColors.statusAwaiting);
    expect(darkColors.statusError).toBe(lightColors.statusError);
    expect(darkColors.statusDone).toBe(lightColors.statusDone);
    // 状态色设计定稿(2026-07-17),L=D 同值,与桌面 E5D 三端一致;CINDY 不接管状态语义色。
    expect(lightColors.statusAccent).toBe('#EA6B17');
    expect(lightColors.statusAwaiting).toBe('#19D2C1');
    expect(lightColors.statusError).toBe('#D91F37');
    expect(lightColors.statusDone).toBe('#2AAE5B');
    expect(lightColors.statusRecording).toBe('#D91F37');
    expect(lightColors.statusReady).toBe('#19D2C1');
    // permAutoAccent:Auto Approval 蓝 #417CDD,L=D 同值(设计定稿 2026-07-17,取代 M2 拆值)。
    expect(lightColors.permAutoAccent).toBe('#417CDD');
    expect(darkColors.permAutoAccent).toBe('#417CDD');
  });

  it('CTA 契约:中性反相(light 深底浅字 / dark 浅底深字),对比度 ≥4.5:1(用户红色新规 2026-07-17)', () => {
    // 契约第二次改写依据:用户红色新规 2026-07-17——常规按钮不用红,红只留警告/报错。
    // 取代 U3+U8 时期的全态红契约(M2 的 cta=#DF0C27 L=D 红底白字作废),CTA 回归中性反相。
    // 这是显式契约改写,非绕过;PR 描述须写明依据。
    expect(lightColors.cta).toBe('#3C3F43');
    expect(darkColors.cta).toBe('#EEEEEE');
    expect(lightColors.ctaText).toBe('#FCFCFC');
    expect(darkColors.ctaText).toBe('#252222');
    // 亮暗反相回归:dark cta ≠ light cta(深底 ↔ 浅底)。
    expect(darkColors.cta).not.toBe(lightColors.cta);
    expect(darkColors.ctaText).not.toBe(lightColors.ctaText);
    // 中性反相对比度:light 10.32:1 / dark 13.60:1,过 AA 普通文本门槛 4.5:1。
    expect(contrastRatio(lightColors.ctaText, lightColors.cta)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(darkColors.ctaText, darkColors.cta)).toBeGreaterThanOrEqual(4.5);
  });

  it('行内 code 压暗档:比正文淡但仍过 AA 4.5:1', () => {
    // 移动端行内 code 走「零底色 + 文字压暗」形态(聊天流的 RN 嵌套 Text 做不出圆角
    // 底);桌面端另走 GitHub 淡底 + 圆角,两端刻意不同,不要在这里做跨端一致性断言。
    // 它承载 id / 路径 / 字段名 —— 正文流里的实义内容,所以 4.5:1 是硬线,不能为了
    // "更像 code"继续压。
    // 实测 light 4.56:1 / dark 5.81:1;对正文 Δ1.98 / Δ1.70(压暗肉眼可辨)。
    expect(lightColors.chatInlineCodeText).toBe('#686B72');
    expect(darkColors.chatInlineCodeText).toBe('#A3A3A3');
    for (const palette of [lightColors, darkColors]) {
      const dim = contrastRatio(palette.chatInlineCodeText, palette.surface);
      expect(dim).toBeGreaterThanOrEqual(4.5);
      // 方向:比正文更靠近底色 —— 是压暗,不是加重。
      expect(dim).toBeLessThan(contrastRatio(palette.textPrimary, palette.surface));
      // 刻意不复用 textSecondary(2.80:1 / 2.92:1,掉 AA)—— 钉住这个区别,
      // 防止将来有人"顺手"把两者合并。
      expect(palette.chatInlineCodeText).not.toBe(palette.textSecondary);
    }
  });

  it('毛玻璃 token 契约(R1 audit 模式1/3,E4M 新增 surfaceTranslucentSidebar / surfaceGlassPanel)', () => {
    // R1 audit:@2x 稿折半;模式1 侧栏 blur≈50 dark #120F0F@0.85 / light #F6F6F6@0.90;
    // 模式3 浮层卡 light #F8F8F8 / dark #3B3B3B@0.95。surface 不叠 blur 规避 Android 热路径。
    expect(lightColors.surfaceTranslucentSidebar).toBe('rgba(246, 246, 246, 0.90)');
    expect(darkColors.surfaceTranslucentSidebar).toBe('rgba(18, 15, 15, 0.85)');
    expect(lightColors.surfaceGlassPanel).toBe('#F8F8F8');
    expect(darkColors.surfaceGlassPanel).toBe('rgba(59, 59, 59, 0.95)');
    // 遮罩双模式恒深(用户定稿 2026-07-21):LIGHT 模式 scrim 也必须深色。
    // light overlay 0.24 太浅近白、0.50 实机过重,用户两轮定稿 0.35;侧栏底色另有
    // surfaceTranslucentSidebar,不受影响。
    expect(lightColors.overlay).toBe('rgba(38, 38, 38, 0.35)');
    expect(darkColors.overlay).toBe('rgba(0, 0, 0, 0.45)');
  });

  it('M1 mobile 专用 token 契约: list / chat / sheet / caret 双模式精确值', () => {
    expect(lightColors.surfaceListRow).toBe('#F6F6F6');
    expect(darkColors.surfaceListRow).toBe('#312F2F');
    expect(lightColors.surfaceListExpanded).toBe('#EAEAEA');
    expect(darkColors.surfaceListExpanded).toBe('#2A2828');
    expect(lightColors.activeGlyph).toBe('#DF0C27');
    expect(darkColors.activeGlyph).toBe('#A61629');
    expect(lightColors.homeListFabBorder).toBe('transparent');
    expect(darkColors.homeListFabBorder).toBe('#FFFFFF');
    expect(lightColors.chatHeaderSurface).toBe('rgba(246, 246, 246, 0.90)');
    expect(darkColors.chatHeaderSurface).toBe('rgba(37, 35, 35, 0.80)');
    expect(lightColors.chatHeaderDivider).toBe('#DCDFE3');
    expect(darkColors.chatHeaderDivider).toBe('rgba(255, 255, 255, 0.05)');
    expect(lightColors.chatCodeSurface).toBe('#F8F8F8');
    expect(darkColors.chatCodeSurface).toBe('#353333');
    expect(lightColors.chatCodeBorder).toBe('#DCDFE3');
    expect(darkColors.chatCodeBorder).toBe('#3C3C3C');
    // 二次改稿 2026-07-18 晚:撤红改蓝,对齐 Mac caret-accent。
    expect(lightColors.inputCaret).toBe('#417CDD');
    expect(darkColors.inputCaret).toBe('#417CDD');
    expect(lightColors.sheetSurface).toBe('rgba(248, 248, 248, 0.95)');
    expect(darkColors.sheetSurface).toBe('rgba(59, 59, 59, 0.95)');
    expect(lightColors.sheetActionSurface).toBe('#F6F6F6');
    expect(darkColors.sheetActionSurface).toBe('rgba(59, 59, 59, 0.5)');
    expect(lightColors.sheetActionBorder).toBe('#DCDFE3');
    expect(darkColors.sheetActionBorder).toBe('#505050');
    expect(lightColors.sheetActionText).toBe('#3C3F43');
    expect(darkColors.sheetActionText).toBe('#C1C1C1');
    expect(lightColors.sheetGrabber).toBe('#DCDFE3');
    expect(darkColors.sheetGrabber).toBe('#6F6F6F');
    // 破坏性红继续走 Mac red-audit-spec / token-decision-table 的 destructive 语义,不采用 Figma #DF0C27。
    expect(lightColors.destructive).toBe('#f43d3f');
    expect(darkColors.destructive).toBe('#f43d3f');
  });

  it('M4 app 内 splash 专用 token 契约:品牌红只服务 splash,不回流普通 CTA', () => {
    expect(lightColors.brandSplashBackground).toBe('#DF0C27');
    expect(darkColors.brandSplashBackground).toBe('#DF0C27');
    expect(lightColors.brandSplashForeground).toBe('#FFFFFF');
    expect(darkColors.brandSplashForeground).toBe('#FFFFFF');
    expect(lightColors.brandSplashMuted).toBe('rgba(255, 255, 255, 0.82)');
    expect(darkColors.brandSplashMuted).toBe('rgba(255, 255, 255, 0.82)');
    expect(lightColors.cta).not.toBe(lightColors.brandSplashBackground);
    expect(darkColors.cta).not.toBe(darkColors.brandSplashBackground);
  });

  it('Beta 渠道状态徽标使用跨主题固定红底白字,且小字对比度 ≥4.5:1', () => {
    expect(lightColors.betaChannelBadgeBackground).toBe('#DF0C27');
    expect(darkColors.betaChannelBadgeBackground).toBe('#DF0C27');
    expect(lightColors.betaChannelBadgeForeground).toBe('#FFFFFF');
    expect(darkColors.betaChannelBadgeForeground).toBe('#FFFFFF');
    expect(contrastRatio(
      lightColors.betaChannelBadgeForeground,
      lightColors.betaChannelBadgeBackground,
    )).toBeGreaterThanOrEqual(4.5);
  });

  it('typeScale 严格单调递增', () => {
    const sizes = Object.values(typeScale);
    for (let i = 1; i < sizes.length; i += 1) {
      expect(sizes[i]).toBeGreaterThan(sizes[i - 1]);
    }
  });

  it('lineHeight / iconSize 各号均为正数', () => {
    for (const value of [...Object.values(lineHeight), ...Object.values(iconSize)]) {
      expect(value).toBeGreaterThan(0);
    }
  });

  it('M1 List typography / icon 语义档补齐施工图缺口', () => {
    expect(typeScale.listBody).toBe(14);
    expect(lineHeight.listBody).toBe(20);
    expect(textStyles.listBody).toEqual({ fontSize: 14, lineHeight: 20 });
    expect(typeScale.listTitle).toBe(19);
    expect(lineHeight.listTitleCompact).toBe(27);
    expect(textStyles.listTitle).toEqual({ fontSize: 19, lineHeight: 27 });
    expect(iconSize.listGlyph).toBe(21);
  });

  it('fontWeight 只暴露四档字符串(bold 仅限 login 品牌 hero)', () => {
    expect(fontWeight).toEqual({ regular: '400', medium: '500', semibold: '600', bold: '700' });
  });

  it('ThemeColors 类型与运行时 key 对齐(编译期保证)', () => {
    // 类型层面:任意 ThemeColors 必须能由 lightColors 满足。
    const sample: ThemeColors = lightColors;
    expect(sample.surface).toBe(lightColors.surface);
  });
});
