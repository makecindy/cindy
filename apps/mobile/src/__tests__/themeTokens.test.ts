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
  it('file tile micro labels meet normal-text contrast on both attachment surfaces', () => {
    for (const colors of [lightColors, darkColors]) {
      for (const background of [colors.surface, colors.surfaceElevated]) {
        expect(contrastRatio(colors.textPrimary, background)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
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

  it('房主皇冠使用醒目的金色语义 token并跨 light / dark 一致', () => {
    expect(lightColors.warningFg).toBe('#F3A115');
    expect(darkColors.warningFg).toBe('#F3A115');
  });

  it('CTA 契约:中性反相(light 深底浅字 / dark 浅底深字),对比度 ≥4.5:1(用户红色新规 2026-07-17)', () => {
    // 契约第二次改写依据:用户红色新规 2026-07-17——常规按钮不用红,红只留警告/报错。
    // 取代 U3+U8 时期的全态红契约(M2 的 cta=#DF0C27 L=D 红底白字作废),CTA 回归中性反相。
    // 这是显式契约改写,非绕过;PR 描述须写明依据。
    expect(lightColors.cta).toBe('#0F0F0F');
    expect(darkColors.cta).toBe('#EDEDED');
    expect(lightColors.ctaText).toBe('#FFFFFF');
    expect(darkColors.ctaText).toBe('#121212');
    // 亮暗反相回归:dark cta ≠ light cta(深底 ↔ 浅底)。
    expect(darkColors.cta).not.toBe(lightColors.cta);
    expect(darkColors.ctaText).not.toBe(lightColors.ctaText);
    // 中性反相对比度:light 19.17:1 / dark 16.00:1(2026-09-26 移动端象牙白色板),过 AA 4.5:1。
    expect(contrastRatio(lightColors.ctaText, lightColors.cta)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(darkColors.ctaText, darkColors.cta)).toBeGreaterThanOrEqual(4.5);
  });

  it('行内 code 压暗档:比正文淡但仍过 AA 4.5:1', () => {
    // 移动端行内 code 走「零底色 + 文字压暗」形态(聊天流的 RN 嵌套 Text 做不出圆角
    // 底);桌面端另走 GitHub 淡底 + 圆角,两端刻意不同,不要在这里做跨端一致性断言。
    // 它承载 id / 路径 / 字段名 —— 正文流里的实义内容,所以 4.5:1 是硬线,不能为了
    // "更像 code"继续压。
    // 实测 light 5.31:1 / dark 6.58:1(2026-09-26 取 textTertiary),明显比正文浅。
    expect(lightColors.chatInlineCodeText).toBe('#686864');
    expect(darkColors.chatInlineCodeText).toBe('#999999');
    for (const palette of [lightColors, darkColors]) {
      const dim = contrastRatio(palette.chatInlineCodeText, palette.surface);
      expect(dim).toBeGreaterThanOrEqual(4.5);
      // 方向:比正文更靠近底色 —— 是压暗,不是加重。
      expect(dim).toBeLessThan(contrastRatio(palette.textPrimary, palette.surface));
      // 刻意不复用 textSecondary(离正文太近,标识符看不出压暗)—— 钉住这个区别,
      // 防止将来有人"顺手"把两者合并。
      expect(palette.chatInlineCodeText).not.toBe(palette.textSecondary);
    }
  });

  it('毛玻璃 token 契约(R1 audit 模式1/3,E4M 新增 surfaceTranslucentSidebar / surfaceGlassPanel)', () => {
    // 侧栏保留 R1 audit 的透明度(light 0.90 / dark 0.85);浮层卡两模式都不透明(2026-09-26
    // 用户定稿,原 dark 0.95 与 light 不一致)。surface 不叠 blur 规避 Android 热路径。
    expect(lightColors.surfaceTranslucentSidebar).toBe('rgba(255, 255, 252, 0.90)');
    expect(darkColors.surfaceTranslucentSidebar).toBe('rgba(10, 10, 10, 0.85)');
    expect(lightColors.surfaceGlassPanel).toBe('#FFFFFC');
    expect(darkColors.surfaceGlassPanel).toBe('#242424');
    // 遮罩双模式恒深(用户定稿 2026-07-21):LIGHT 模式 scrim 也必须深色。
    // light overlay 0.24 太浅近白、0.50 实机过重,用户两轮定稿 0.35;侧栏底色另有
    // surfaceTranslucentSidebar,不受影响。
    expect(lightColors.overlay).toBe('rgba(38, 38, 38, 0.35)');
    expect(darkColors.overlay).toBe('rgba(0, 0, 0, 0.45)');
  });

  it('文字层级:正文 → 二级 → 三级由深到浅,在所在底色上都 ≥ 4.5:1(2026-09-26 移动端色板)', () => {
    // 取代 U2 时期二级文字比三级更浅(且只有 2.8 / 2.9:1)的颠倒排序。
    for (const palette of [lightColors, darkColors]) {
      const planes = [palette.surface, palette.surfaceElevated, palette.surfaceChip, palette.chatCodeSurface];
      const tiers = [palette.textPrimary, palette.textSecondary, palette.textTertiary];
      for (const plane of planes) {
        const ratios = tiers.map((tier) => contrastRatio(tier, plane));
        for (const ratio of ratios) expect(ratio).toBeGreaterThanOrEqual(4.5);
        expect(ratios[0]).toBeGreaterThan(ratios[1]);
        expect(ratios[1]).toBeGreaterThan(ratios[2]);
      }
    }
  });

  it('占位字专用档:比三级更淡,但在可承载输入框的底色上仍 ≥ 3:1(2026-09-27 用户定稿)', () => {
    expect(lightColors.textPlaceholder).toBe('#858581');
    expect(darkColors.textPlaceholder).toBe('#757575');
    for (const palette of [lightColors, darkColors]) {
      const planes = [palette.surface, palette.surfaceElevated, palette.surfaceChip];
      for (const plane of planes) {
        const ratio = contrastRatio(palette.textPlaceholder, plane);
        expect(ratio).toBeGreaterThanOrEqual(3);
        expect(ratio).toBeLessThan(contrastRatio(palette.textTertiary, plane));
      }
    }
  });

  it('共享任务确认钮前景并入中性反色(纯白 / #121212),红底上 ≥ 4.5:1', () => {
    expect(lightColors.sharedTaskConfirmForeground).toBe(lightColors.ctaText);
    expect(darkColors.sharedTaskConfirmForeground).toBe(darkColors.ctaText);
    for (const palette of [lightColors, darkColors]) {
      expect(contrastRatio(palette.sharedTaskConfirmForeground, palette.sharedTaskConfirmBackground)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('跟随关系:文档声明「跟随」的 token 与被跟随者同值,吸顶层是页面色加透明度', () => {
    const rgbOf = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ');
    for (const palette of [lightColors, darkColors]) {
      expect(palette.errorText).toBe(palette.textPrimary);
      expect(palette.errorBorder).toBe(palette.borderStrong);
      expect(palette.chatInlineCodeText).toBe(palette.textTertiary);
      // 改页面色时这两层必须一起改,否则吸顶栏与页面出现色差。
      for (const layer of [palette.surfaceTranslucent, palette.chatHeaderSurface]) {
        expect(layer.startsWith(`rgba(${rgbOf(palette.surface)}, `)).toBe(true);
      }
    }
  });

  it('M1 mobile 专用 token 契约: list / chat / sheet / caret 双模式精确值', () => {
    expect(lightColors.surfaceListRow).toBe('#FFFFFC');
    expect(darkColors.surfaceListRow).toBe('#1E1E1E');
    expect(lightColors.surfaceListExpanded).toBe('#EAEAE6');
    expect(darkColors.surfaceListExpanded).toBe('#121212');
    expect(lightColors.activeGlyph).toBe('#DF0C27');
    expect(darkColors.activeGlyph).toBe('#A61629');
    expect(lightColors.homeListFabBorder).toBe('transparent');
    expect(darkColors.homeListFabBorder).toBe('#FFFFFF');
    expect(lightColors.chatHeaderSurface).toBe('rgba(249, 249, 246, 0.90)');
    expect(darkColors.chatHeaderSurface).toBe('rgba(18, 18, 18, 0.80)');
    expect(lightColors.chatHeaderDivider).toBe('#CCCCC8');
    expect(darkColors.chatHeaderDivider).toBe('rgba(255, 255, 255, 0.08)');
    expect(lightColors.chatCodeSurface).toBe('#F1F1EC');
    expect(darkColors.chatCodeSurface).toBe('#1A1A1A');
    expect(lightColors.chatCodeBorder).toBe('#CCCCC8');
    expect(darkColors.chatCodeBorder).toBe('#383838');
    // 二次改稿 2026-07-18 晚:撤红改蓝,对齐 Mac caret-accent。
    expect(lightColors.inputCaret).toBe('#417CDD');
    expect(darkColors.inputCaret).toBe('#417CDD');
    expect(lightColors.sheetSurface).toBe('rgba(249, 249, 246, 0.96)');
    expect(darkColors.sheetSurface).toBe('rgba(28, 28, 28, 0.96)');
    expect(lightColors.sheetActionSurface).toBe('#FFFFFC');
    expect(darkColors.sheetActionSurface).toBe('#262626');
    expect(lightColors.sheetActionBorder).toBe('#CCCCC8');
    expect(darkColors.sheetActionBorder).toBe('#383838');
    expect(lightColors.sheetGrabber).toBe('#C2C2BE');
    expect(darkColors.sheetGrabber).toBe('#5C5C5C');
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

  it('字号阶梯收拢为 11 档(2026-09-27 用户定稿:14 并入 15、19 并入 20)', () => {
    expect(Object.values(typeScale)).toEqual([11, 12, 13, 15, 16, 17, 18, 20, 24, 30, 40]);
    expect(typeScale.bodySmall).toBe(15);
    expect(lineHeight.bodySmall).toBe(20);
    expect(textStyles.bodySmall).toEqual({ fontSize: 15, lineHeight: 20 });
    // 旧 List 专用档已删除,不允许回潮。
    expect(Object.keys(typeScale)).not.toContain('listBody');
    expect(Object.keys(typeScale)).not.toContain('listTitle');
    expect(Object.keys(typeScale)).not.toContain('code');
    expect(Object.keys(lineHeight)).not.toContain('listTitleCompact');
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
