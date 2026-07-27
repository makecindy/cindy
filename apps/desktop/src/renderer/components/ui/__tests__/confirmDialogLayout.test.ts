import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * 长权限清单不得把确认框撑出视口。Header 与 Footer 留在固定 flex 区域，
 * 只有富内容区负责滚动；否则插件更新确认会把底部操作按钮推出屏幕。
 */
describe('ConfirmDialog bounded layout', () => {
  const source = readFileSync(resolve(__dirname, '..', 'confirm-dialog.tsx'), 'utf8');

  it('caps the dialog at 80vh and scrolls only the content section', () => {
    expect(source).toContain('flex max-h-[80vh]');
    expect(source).toContain('flex-col overflow-hidden');
    expect(source).toContain('data-confirm-dialog-section="header" className="shrink-0"');
    expect(source).toContain(
      'className="mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1"',
    );
    expect(source).toContain('data-confirm-dialog-section="footer"');
    expect(source).toContain('className="mt-6 flex shrink-0 justify-end gap-2.5"');
  });
});
