/**
 * DiffPanelShell 无障碍语义回归测试。
 *
 * 项目 renderer 单测运行在 node 环境，没有 jsdom / RTL。这里用源码契约
 * 锁住 drawer 旧用法和 floating 预览新用法的语义边界，避免新变体顺手改掉
 * SessionDiffPanel / HelpAssistantPanel 等旧 drawer 的 landmark 与 resize 语义。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourcePath = resolve(__dirname, '..', 'components', 'diff-panel', 'DiffPanelShell.tsx');
const source = readFileSync(sourcePath, 'utf8');
const localeRoot = resolve(__dirname, '..', 'i18n', 'locales');

function readLocale(locale: string): { diffPanel: { shell: { resizeHandleAria: string } } } {
  return JSON.parse(readFileSync(resolve(localeRoot, locale, 'common.json'), 'utf8'));
}

describe('DiffPanelShell — drawer accessibility contract', () => {
  it('drawer variant keeps the complementary landmark role', () => {
    expect(source).toContain("role={isFloating ? undefined : 'complementary'}");
  });

  it('resizable handle keeps separator semantics, i18n label, and keyboard focus', () => {
    expect(source).toContain('!isFloating &&');
    expect(source).toContain('<hr');
    expect(source).toContain('aria-orientation="vertical"');
    expect(source).toContain("aria-label={t('diffPanel.shell.resizeHandleAria')}");
    expect(source).toContain('aria-valuemin={MIN_WIDTH}');
    expect(source).toContain('aria-valuemax={maxWidth}');
    expect(source).toContain('aria-valuenow={width}');
    expect(source).toContain('tabIndex={0}');
    expect(source).toContain('onKeyDown={onResizeKeyDown}');
  });

  it('floating preview uses default width and does not render the resize handle', () => {
    expect(source).toContain('const panelWidth = isFloating ? defaultWidth : width');
    expect(source).toMatch(
      /style=\{\{\s*width:\s*`\$\{panelWidth\}px`,\s*maxWidth:\s*'90vw'\s*\}\}/,
    );
  });

  it('keeps shadows only while open or closing', () => {
    expect(source).toContain('const [retainShadow, setRetainShadow] = useState(open)');
    expect(source).toContain('const reducedMotion = useReducedMotion()');
    expect(source).toContain('if (reducedMotion) setRetainShadow(false)');
    expect(source).toContain('const showShadow = open || (!reducedMotion && retainShadow)');
    expect(source).toContain("propertyName !== 'transform'");
    expect(source).toContain('if (!open) setRetainShadow(false)');
    expect(source).toContain('onTransitionEnd={onShadowTransitionEnd}');
    expect(source).toContain(
      "showShadow && (isFloating ? 'shadow-[var(--shadow-menu)]' : 'shadow-xl')",
    );
    expect(source).not.toContain('text-popover-foreground shadow-xl');
  });

  it('resizeHandleAria remains translated in all supported locales while drawer references it', () => {
    expect(readLocale('zh-CN').diffPanel.shell.resizeHandleAria).toBe('调整面板宽度');
    expect(readLocale('zh-TW').diffPanel.shell.resizeHandleAria).toBe('調整面板寬度');
    expect(readLocale('en').diffPanel.shell.resizeHandleAria).toBe('Resize panel width');
    expect(readLocale('ja').diffPanel.shell.resizeHandleAria).toBe('パネル幅を調整');
    expect(readLocale('ko').diffPanel.shell.resizeHandleAria).toBe('패널 너비 조정');
  });
});
