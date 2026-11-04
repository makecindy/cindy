// @vitest-environment jsdom

/**
 * Preview panel geometry against the window drag band (#8777).
 *
 * 测试价值
 * - 生产入口与可观察结果：`previewCompactPanelStyle()` 的返回值直接决定预览面板的落点；
 *   用户可观察结果是面板顶栏的保存 / 更多 / 关闭按钮能否点击、标题是否被红绿灯遮挡。
 * - Bug／规则依据：#8777；`PreviewScrim` 把窗口顶部 0..PREVIEW_PANEL_MARGIN 声明为拖拽区，
 *   而 `windowDrag.tsx` 记录 Electron 的拖拽区只按几何判定、不看层级。
 * - 现有覆盖缺口：`__tests__` 下的 lightbox 用例都测交互手势，没有任何用例断言面板顶边
 *   与拖拽带的关系；紧凑分支（打不开的文件）此前把 `top` 覆写成 0 也无人拦截。
 * - 最小失败输入：`previewCompactPanelStyle(0)`，修复前返回 `top: 0`。
 * - tier：unit（纯函数 + 常量几何推导，无真实窗口）。
 */
import { describe, expect, it } from 'vitest';

import { PREVIEW_PANEL_MARGIN, previewCompactPanelStyle } from '../PreviewChrome';

// PreviewHeader renders `h-16`; PREVIEW_BUTTON_CLASS renders `h-8 w-8` centred inside it.
const HEADER_HEIGHT = 64;
const BUTTON_HEIGHT = 32;

describe('compact preview panel geometry', () => {
  it.each([0, 64])('keeps the header clear of the drag band (extraHeight %i)', (extraHeight) => {
    const style = previewCompactPanelStyle(extraHeight);
    const top = Number(style.top);
    expect(top).toBeGreaterThanOrEqual(PREVIEW_PANEL_MARGIN);
    const buttonTop = top + (HEADER_HEIGHT - BUTTON_HEIGHT) / 2;
    expect(buttonTop).toBeGreaterThanOrEqual(PREVIEW_PANEL_MARGIN);
  });

  it('still renders the compact box instead of a full-size panel', () => {
    const style = previewCompactPanelStyle(64);
    expect(style.height).toBe(424);
    expect(String(style.width)).toContain('480px');
  });
});
