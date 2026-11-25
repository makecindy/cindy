// @vitest-environment jsdom

/**
 * 测试价值
 * - 生产入口与可观察结果:页签拖拽落点的纯判定(computeChatEdgeZones / pickTabDropZone);
 *   可观察的是聊天区四条边带的位置与厚度、源组所在边不成为落点、角落按先到先得归左右边、
 *   边带外返回 null。亮区与提交共用同一判定,所见即所得。
 * - Bug / 规则依据:页签可拖到聊天区任一边(页签组模型);边带太薄抓不住、太厚会盖住聊天正文。
 * - 现有覆盖缺口:新模块。
 * - 最小失败输入:一个 1000×800 的聊天区矩形。
 * - tier:unit。
 */

import { fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  computeChatEdgeZones,
  isPointerOutsideWindow,
  pickTabDropZone,
  TabDragController,
} from '../TabDragController';
import { getTabGroup, setTabGroup } from '../tabGroups';

describe('computeChatEdgeZones / pickTabDropZone', () => {
  const chat = { left: 100, top: 50, width: 1000, height: 800 };

  it('四条边带厚度取短边 22% 并夹到 [72,180];排除源组所在的边', () => {
    const zones = computeChatEdgeZones(chat, new Set(['right']));
    expect(zones.map((z) => z.group)).toEqual(['left', 'top', 'bottom']);
    const left = zones.find((z) => z.group === 'left')!.rect;
    expect(left).toEqual({ left: 100, top: 50, width: 176, height: 800 });
    const bottom = zones.find((z) => z.group === 'bottom')!.rect;
    expect(bottom).toEqual({ left: 100, top: 674, width: 1000, height: 176 });

    const tiny = computeChatEdgeZones({ left: 0, top: 0, width: 200, height: 200 });
    expect(tiny[0].rect.width).toBe(72);
    expect(computeChatEdgeZones({ left: 0, top: 0, width: 0, height: 0 })).toEqual([]);
  });

  it('命中按先到先得:角落归左右边;边带外与无落点返回 null', () => {
    const zones = computeChatEdgeZones(chat);
    expect(pickTabDropZone(150, 60, zones)?.group).toBe('left');
    expect(pickTabDropZone(600, 60, zones)?.group).toBe('top');
    expect(pickTabDropZone(1090, 840, zones)?.group).toBe('right');
    expect(pickTabDropZone(600, 400, zones)).toBeNull();
    expect(pickTabDropZone(600, 400, [])).toBeNull();
  });

  it('窗外判定:可视区外(含右 / 下边界本身)为真,区内为假', () => {
    expect(isPointerOutsideWindow(-1, 10, 800, 600)).toBe(true);
    expect(isPointerOutsideWindow(10, -1, 800, 600)).toBe(true);
    expect(isPointerOutsideWindow(800, 10, 800, 600)).toBe(true);
    expect(isPointerOutsideWindow(10, 600, 800, 600)).toBe(true);
    expect(isPointerOutsideWindow(0, 0, 800, 600)).toBe(false);
    expect(isPointerOutsideWindow(799, 599, 800, 600)).toBe(false);
  });
});

// 回归（unit）：经 TabDragController 实际拖放，断言亮区和页签归属。纯边带用例
// 不涵盖已展开面板；最小场景为左侧一个页签、右侧有页签，松手点位于右侧内容区。
it('右侧还有页签时，可将左侧对话拖回右侧栏正文', () => {
  const { container, queryByTestId, unmount } = render(
    createElement(TabDragController, { enabled: true, sessionId: null }),
  );
  container.innerHTML = `
    <div data-tab-group-strip="left"><button data-tab-pill="side-a">对话 A</button></div>
    <main data-panel-drag-root="chat-main"></main>
    <aside data-panel-drag-root="right-tabs">
      <div data-tab-group-strip="right"><button data-tab-pill="side-b">对话 B</button></div>
    </aside>
  `;
  const measure = (selector: string, x: number, y: number, width: number, height: number) => {
    vi.spyOn(container.querySelector(selector)!, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(x, y, width, height),
    );
  };
  measure('[data-tab-group-strip="left"]', 0, 0, 240, 40);
  measure('[data-panel-drag-root="chat-main"]', 240, 0, 480, 600);
  measure('[data-panel-drag-root="right-tabs"]', 720, 0, 280, 600);
  measure('[data-tab-group-strip="right"]', 720, 0, 280, 40);
  setTabGroup('side-a', 'left');
  try {
    fireEvent.pointerDown(container.querySelector('[data-tab-pill="side-a"]')!, {
      button: 0,
      clientX: 100,
      clientY: 20,
    });
    fireEvent.pointerMove(document, { clientX: 480, clientY: 300 });
    fireEvent.pointerMove(document, { clientX: 860, clientY: 300 });
    const highlighted = queryByTestId('tab-drop-zone') !== null;
    fireEvent.pointerUp(document, { clientX: 860, clientY: 300 });
    expect(getTabGroup('side-a')).toBe('right');
    expect(getTabGroup('side-b')).toBe('right');
    expect(highlighted).toBe(true);
  } finally {
    unmount();
    setTabGroup('side-a', 'right');
  }
});
