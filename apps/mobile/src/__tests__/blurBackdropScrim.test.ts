import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Windows checkout(core.autocrlf)下源码是 CRLF;统一归一成 LF,跨平台断言成立。
const readTextLf = (...args: Parameters<typeof readFileSync>): string =>
  String(readFileSync(...args)).replace(/\r\n/g, '\n');

/**
 * BlurBackdrop scrim 双模式恒深守护(用户定稿 2026-07-21)。
 * 用户实机反馈:LIGHT 模式 ActionSheet / bottom sheet 弹出时背后遮罩近白——
 * 哪怕 LIGHT 模式,scrim 也必须深色。本测试锁定该口径不被回退。
 */
describe('BlurBackdrop scrim 双模式恒深 (用户定稿 2026-07-21)', () => {
  it('scrim 默认走 colors.overlay 深色遮罩 + tint 恒 dark;surface 显式 overlayColor 走主题 tint', () => {
    const src = readTextLf(resolve(process.cwd(), 'src/session/BlurBackdrop.tsx'), 'utf8');

    // scrim 默认叠层 = colors.overlay(深色遮罩 token),不再沿用 surfaceTranslucentSidebar(近白)。
    expect(src).toContain('overlayColor ?? colors.overlay');
    expect(src).not.toContain('colors.surfaceTranslucentSidebar');
    // scrim tint 恒 'dark';surface tint 跟随 mode。
    expect(src).toContain('const isScrim = overlayColor === undefined;');
    expect(src).toContain("isScrim ? 'dark' : mode === 'dark' ? 'dark' : 'light'");
  });

  it('scrim 消费点用裸 BlurBackdrop(走恒深默认):SheetModal / SessionActionSheet 背板', () => {
    const sheetModal = readTextLf(resolve(process.cwd(), 'src/session/SheetModal.tsx'), 'utf8');
    const actionSheet = readTextLf(resolve(process.cwd(), 'src/session/SessionActionSheet.tsx'), 'utf8');
    expect(sheetModal).toContain('<BlurBackdrop />');
    expect(actionSheet).toContain('<BlurBackdrop />');
  });

  it('surface 消费点保留显式浅色 overlayColor(面板表面不染深)', () => {
    const sheetSurface = readTextLf(resolve(process.cwd(), 'src/session/SheetSurface.tsx'), 'utf8');
    const actionSheet = readTextLf(resolve(process.cwd(), 'src/session/SessionActionSheet.tsx'), 'utf8');
    // SheetSurface 面板底色(tasksheet=sheetSurface / default=surfaceGlassPanel)。
    expect(sheetSurface).toContain(
      "overlayColor={variant === 'tasksheet' ? colors.sheetSurface : colors.surfaceGlassPanel}",
    );
    // SessionActionSheet 操作卡 / 取消卡底色(sheetActionSurface)。
    expect(actionSheet).toContain('intensity={32}');
    expect(actionSheet).toContain('overlayColor={colors.sheetActionSurface}');
    // 会话顶栏 chrome 底色(chatHeaderSurface)——非 scrim,走 surface 语义。
    const sessionHeader = readTextLf(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8');
    expect(sessionHeader).toContain(
      'return <BlurBackdrop intensity={40} overlayColor={colors.chatHeaderSurface} style={styles.translucentBackdrop} />;',
    );
  });

  it('colors.overlay 直消费的 scrim/遮罩点统一恒深(ModelPickerSheet/SessionMenuSheet/InlineQueue/ContextSheetMedia/ComposerAttachmentTray)', () => {
    // 这些直接用 colors.overlay 做背板/遮罩底色——token 加深后 LIGHT 下全部转深,无需逐个改。
    const files = [
      'ModelPickerSheet.tsx',
      'SessionMenuSheet.tsx',
      // 待发送气泡的附件上传遮罩:气泡已从 InlineQueueSection(现在只剩队列状态横幅)
      // 搬进消息流渲染项 PendingSendBubble。
      'PendingSendBubble.tsx',
      'ContextSheetMediaViews.tsx',
      'ComposerAttachmentTray.tsx',
    ];
    for (const f of files) {
      const src = readTextLf(resolve(process.cwd(), `src/session/${f}`), 'utf8');
      expect(src).toContain('colors.overlay');
    }
  });

  it('ImageLightbox 保持纯黑背板(媒体查看器惯例,不进遮罩口径)', () => {
    const src = readTextLf(resolve(process.cwd(), 'src/session/ImageLightbox.tsx'), 'utf8');
    expect(src).toContain("backgroundColor: '#000000'");
    expect(src).not.toContain('colors.overlay');
  });
});
