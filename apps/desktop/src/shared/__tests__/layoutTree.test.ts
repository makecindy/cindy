import { describe, expect, it } from 'vitest';

import {
  LAYOUT_SCHEMA_VERSION,
  MAX_TREE_DEPTH,
  coerceLayout,
  countPanelKind,
  createDefaultLayout,
  createDefaultLayoutPreservingGhostPanels,
  findPaneById,
  findSplitChildByPanelKind,
  insertRootSplitPane,
  moveGhostPaneToRootByKind,
  removeRootSplitPaneByKind,
  stackGhostPaneByKind,
  swapPanesByKind,
  swapRootSplitChildrenByKind,
  transferSplitFraction,
  transferSplitFractionRelay,
  setPaneCollapsed,
  setSplitChildFraction,
  validateLayout,
  walkPanes,
  type Layout,
  type LayoutNode,
  type SplitNode,
} from '../layoutTree';

/** 构造一棵最小合法树的便捷函数,测试里按需改坏它。 */
function makeLayout(mutate?: (l: Layout) => void): Layout {
  const layout = createDefaultLayout();
  mutate?.(layout);
  return layout;
}

describe('createDefaultLayout', () => {
  it('默认树通过校验', () => {
    expect(validateLayout(createDefaultLayout())).toEqual({ ok: true });
  });

  it('每次返回独立深拷贝(改一份不影响另一份)', () => {
    const a = createDefaultLayout();
    const b = createDefaultLayout();
    a.sidebar.collapsed = true;
    expect(b.sidebar.collapsed).toBeUndefined();
  });

  it('默认树形态 = 今天的三栏:sidebar 会话列表 + 内容区 chat/right 一刀竖切', () => {
    const layout = createDefaultLayout();
    expect(layout.sidebar.panelKind).toBe('session-list');
    expect(layout.sidebar.edge).toBe('left');
    const kinds = walkPanes(layout).map((p) => p.panelKind);
    expect(kinds).toEqual(['session-list', 'chat-main', 'right-tabs']);
  });
});

describe('createDefaultLayoutPreservingGhostPanels', () => {
  it('恢复内置默认排列时保留意识面板槽位、相对顺序与最小宽度', () => {
    const first = insertRootSplitPane(
      createDefaultLayout(),
      { id: 'custom-a', panelKind: 'ghost:alpha', minWidth: 280 },
      { index: 0, fraction: 0.25 },
    );
    const second = insertRootSplitPane(
      first.layout,
      { id: 'custom-b', panelKind: 'ghost:beta' },
      { index: 1, fraction: 0.15 },
    );
    expect(first.applied).toBe(true);
    expect(second.applied).toBe(true);

    const restored = createDefaultLayoutPreservingGhostPanels(second.layout);
    const children = (restored.content as SplitNode).children;
    expect(children.map((child) => child.node.type === 'pane' && child.node.panelKind)).toEqual([
      'ghost:alpha',
      'ghost:beta',
      'chat-main',
      'right-tabs',
    ]);
    expect(children[0].node).toMatchObject({
      id: 'ghost-alpha',
      panelKind: 'ghost:alpha',
      minWidth: 280,
    });
    expect(children[2].fraction).toBeCloseTo(children[3].fraction);
    expect(children.reduce((sum, child) => sum + child.fraction, 0)).toBeCloseTo(1);
    expect(validateLayout(restored)).toEqual({ ok: true });
    expect((second.layout.content as SplitNode).children[0].node).toMatchObject({ id: 'custom-a' });
  });

  it('没有意识面板时严格返回内置默认布局', () => {
    const current = createDefaultLayout();
    (current.content as SplitNode).children.reverse();
    expect(createDefaultLayoutPreservingGhostPanels(current)).toEqual(createDefaultLayout());
  });
});

describe('validateLayout · 结构性不变量', () => {
  it('chat-main 缺失被拒', () => {
    const layout = makeLayout((l) => {
      (l.content as { children: { node: LayoutNode }[] }).children[0].node = {
        type: 'pane',
        id: 'not-chat',
        panelKind: 'right-tabs',
      };
    });
    const r = validateLayout(layout);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('chat-main');
  });

  it('chat-main 出现两次被拒', () => {
    const layout = makeLayout((l) => {
      (l.content as { children: { node: LayoutNode }[] }).children[1].node = {
        type: 'pane',
        id: 'chat2',
        panelKind: 'chat-main',
      };
    });
    expect(validateLayout(layout).ok).toBe(false);
  });

  it('未知 panelKind(未安装的意识)是合法树 —— 卸载意识绝不能毁掉整份布局', () => {
    const layout = makeLayout((l) => {
      (l.content as { children: { node: LayoutNode }[] }).children[1].node = {
        type: 'pane',
        id: 'weekly',
        panelKind: 'ghost:weekly-report',
      };
    });
    expect(validateLayout(layout)).toEqual({ ok: true });
  });

  it('session-list 出现在内容区被拒(只能是树外固定柱)', () => {
    const layout = makeLayout((l) => {
      (l.content as { children: { node: LayoutNode }[] }).children[1].node = {
        type: 'pane',
        id: 'sessions2',
        panelKind: 'session-list',
      };
    });
    expect(validateLayout(layout).ok).toBe(false);
  });

  it('chat-main 标记 collapsed 被拒(主区不可折叠)', () => {
    const layout = makeLayout((l) => {
      const chat = (l.content as { children: { node: LayoutNode }[] }).children[0].node as Extract<
        LayoutNode,
        { type: 'pane' }
      >;
      chat.collapsed = true;
    });
    expect(validateLayout(layout).ok).toBe(false);
  });

  it('split 少于 2 个 children 被拒', () => {
    const layout = makeLayout((l) => {
      (l.content as { children: unknown[] }).children.pop();
    });
    expect(validateLayout(layout).ok).toBe(false);
  });

  it('fraction 非正 / NaN 被拒', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const layout = makeLayout((l) => {
        (l.content as { children: { fraction: number }[] }).children[0].fraction = bad;
      });
      expect(validateLayout(layout).ok, `fraction=${bad}`).toBe(false);
    }
  });

  it('split fractions 总和不为 1 被拒', () => {
    const layout = makeLayout((l) => {
      const children = (l.content as { children: { fraction: number }[] }).children;
      children[0].fraction = 0.9;
      children[1].fraction = 0.9;
    });
    expect(validateLayout(layout).ok).toBe(false);
  });

  it('节点 id 重复被拒', () => {
    const layout = makeLayout((l) => {
      (l.content as { children: { node: LayoutNode }[] }).children[1].node.id = 'chat';
    });
    expect(validateLayout(layout).ok).toBe(false);
  });

  it(`深度超过 ${MAX_TREE_DEPTH} 被拒`, () => {
    // 逐层嵌套 split,直到超过上限。
    let node: LayoutNode = { type: 'pane', id: 'chat', panelKind: 'chat-main' };
    for (let i = 0; i < MAX_TREE_DEPTH + 1; i += 1) {
      node = {
        type: 'split',
        id: `s${i}`,
        direction: 'row',
        children: [
          { fraction: 0.5, node },
          { fraction: 0.5, node: { type: 'pane', id: `p${i}`, panelKind: 'right-tabs' } },
        ],
      };
    }
    const layout = makeLayout((l) => {
      l.content = node;
    });
    expect(validateLayout(layout).ok).toBe(false);
  });

  it('v1 float 非空被拒', () => {
    const layout = makeLayout((l) => {
      (l.float as unknown[]).push({
        id: 'f',
        panelKind: 'right-tabs',
        x: 0,
        y: 0,
        width: 1,
        height: 1,
      });
    });
    expect(validateLayout(layout).ok).toBe(false);
  });

  it('schemaVersion 不匹配被拒', () => {
    const layout = makeLayout((l) => {
      (l as { schemaVersion: number }).schemaVersion = 999;
    });
    expect(validateLayout(layout).ok).toBe(false);
  });
});

describe('coerceLayout · 垃圾进,默认树出,永不抛异常', () => {
  it.each([null, undefined, 42, 'garbage', [], {}, { schemaVersion: 1 }])(
    '非法输入 %j 回退默认树',
    (raw) => {
      const r = coerceLayout(raw);
      expect(r.fallback).toBe(true);
      expect(r.reason).toBeTruthy();
      expect(validateLayout(r.layout)).toEqual({ ok: true });
    },
  );

  it('循环引用不抛异常,回退默认树', () => {
    const circular: Record<string, unknown> = { schemaVersion: LAYOUT_SCHEMA_VERSION };
    circular.self = circular;
    // structuredClone 支持循环引用,但形状校验会拒绝 —— 无论哪层拦下都必须回退而非抛出。
    expect(() => coerceLayout(circular)).not.toThrow();
    expect(coerceLayout(circular).fallback).toBe(true);
  });

  it('合法树原样通过(非 fallback),且与输入解耦(深拷贝)', () => {
    const input = createDefaultLayout();
    const r = coerceLayout(input);
    expect(r.fallback).toBe(false);
    expect(r.layout).toEqual(input);
    expect(r.layout).not.toBe(input);
  });

  it('含未安装意识面板的存档原样通过', () => {
    const input = makeLayout((l) => {
      (l.content as { children: { node: LayoutNode }[] }).children[1].node = {
        type: 'pane',
        id: 'weekly',
        panelKind: 'ghost:weekly-report',
      };
    });
    expect(coerceLayout(input).fallback).toBe(false);
  });
});

describe('walkPanes / findPaneById / countPanelKind', () => {
  it('遍历顺序:sidebar → content 深度优先', () => {
    const ids = walkPanes(createDefaultLayout()).map((p) => p.id);
    expect(ids).toEqual(['sessions', 'chat', 'right']);
  });

  it('findPaneById 命中与未命中', () => {
    const layout = createDefaultLayout();
    expect(findPaneById(layout, 'chat')?.panelKind).toBe('chat-main');
    expect(findPaneById(layout, 'nope')).toBeNull();
  });

  it('countPanelKind 统计整份布局', () => {
    const layout = createDefaultLayout();
    expect(countPanelKind(layout, 'chat-main')).toBe(1);
    expect(countPanelKind(layout, 'ghost:x')).toBe(0);
  });
});

describe('setPaneCollapsed', () => {
  it('折叠 right-tabs:返回新树,原树不动', () => {
    const layout = createDefaultLayout();
    const r = setPaneCollapsed(layout, 'right', true);
    expect(r.applied).toBe(true);
    expect(r.layout).not.toBe(layout);
    expect(findPaneById(r.layout, 'right')?.collapsed).toBe(true);
    expect(findPaneById(layout, 'right')?.collapsed).toBeUndefined();
  });

  it('折叠 sidebar(树外柱)同样可用', () => {
    const r = setPaneCollapsed(createDefaultLayout(), 'sessions', true);
    expect(r.applied).toBe(true);
    expect(r.layout.sidebar.collapsed).toBe(true);
  });

  it('折叠 chat-main 被拒:返回原引用 + applied=false', () => {
    const layout = createDefaultLayout();
    const r = setPaneCollapsed(layout, 'chat', true);
    expect(r.applied).toBe(false);
    expect(r.layout).toBe(layout);
    expect(r.reason).toContain('chat-main');
  });

  it('pane 不存在被拒', () => {
    const layout = createDefaultLayout();
    const r = setPaneCollapsed(layout, 'ghost', true);
    expect(r.applied).toBe(false);
    expect(r.layout).toBe(layout);
  });
});

describe('setSplitChildFraction', () => {
  it('设置后精确保持请求的 fraction,余量按比例分配给兄弟,原树不动', () => {
    const layout = createDefaultLayout();
    const r = setSplitChildFraction(layout, 'root', 0, 0.6);
    expect(r.applied).toBe(true);
    const children = (r.layout.content as { children: { fraction: number }[] }).children;
    const sum = children.reduce((acc, c) => acc + c.fraction, 0);
    expect(sum).toBeCloseTo(1);
    expect(children[0].fraction).toBeCloseTo(0.6);
    expect(children[1].fraction).toBeCloseTo(0.4);
    // 原树保持默认占比(0.5/0.5,B1b-1 对齐右栏既有 50/50 默认)。
    expect(
      (layout.content as { children: { fraction: number }[] }).children[0].fraction,
    ).toBeCloseTo(0.5);
  });

  it('split 不存在 / index 越界 / fraction 非法均被拒且返回原引用', () => {
    const layout = createDefaultLayout();
    expect(setSplitChildFraction(layout, 'ghost', 0, 0.5).applied).toBe(false);
    expect(setSplitChildFraction(layout, 'root', 9, 0.5).applied).toBe(false);
    expect(setSplitChildFraction(layout, 'root', 0.5, 0.5).applied).toBe(false);
    expect(setSplitChildFraction(layout, 'root', Number.NaN, 0.5).applied).toBe(false);
    expect(setSplitChildFraction(layout, 'root', 0, 0).applied).toBe(false);
    expect(setSplitChildFraction(layout, 'root', 0, Number.NaN).applied).toBe(false);
    expect(setSplitChildFraction(layout, 'root', 0, 1).applied).toBe(false);
    expect(setSplitChildFraction(layout, 'root', 0, 3).applied).toBe(false);
  });
});

describe('insertRootSplitPane / removeRootSplitPaneByKind(加装/卸载)', () => {
  it('插入第三块:份额等比让出、总和保持 1、原树不动', () => {
    const layout = createDefaultLayout();
    const r = insertRootSplitPane(
      layout,
      { id: 'demo-hello', panelKind: 'ghost:hello', minWidth: 240 },
      { index: 1, fraction: 0.2 },
    );
    expect(r.applied).toBe(true);
    const children = (
      r.layout.content as { children: { fraction: number; node: { panelKind: string } }[] }
    ).children;
    expect(children.map((c) => c.node.panelKind)).toEqual([
      'chat-main',
      'ghost:hello',
      'right-tabs',
    ]);
    expect(children.reduce((a, c) => a + c.fraction, 0)).toBeCloseTo(1);
    expect(children[1].fraction).toBeCloseTo(0.2);
    expect(validateLayout(r.layout)).toEqual({ ok: true });
    // 原树仍是两块。
    expect((layout.content as { children: unknown[] }).children.length).toBe(2);
  });

  it('index 越界夹取到末尾;fraction 夹取进 [0.05, 0.8]', () => {
    const layout = createDefaultLayout();
    const r = insertRootSplitPane(
      layout,
      { id: 'x', panelKind: 'ghost:x' },
      { index: 99, fraction: 5 },
    );
    expect(r.applied).toBe(true);
    const children = (
      r.layout.content as { children: { fraction: number; node: { panelKind: string } }[] }
    ).children;
    expect(children[2].node.panelKind).toBe('ghost:x');
    expect(children[2].fraction).toBeLessThanOrEqual(0.8);
  });

  it('id 与已有 pane 重复 → 出口校验拒绝,返回原树', () => {
    const layout = createDefaultLayout();
    const r = insertRootSplitPane(layout, { id: 'chat', panelKind: 'ghost:x' });
    expect(r.applied).toBe(false);
    expect(r.layout).toBe(layout);
  });

  it('卸载:移除目标并归一份额;round-trip 加装→卸载回到两块', () => {
    const layout = createDefaultLayout();
    const added = insertRootSplitPane(
      layout,
      { id: 'demo-hello', panelKind: 'ghost:hello' },
      { index: 1 },
    );
    const removed = removeRootSplitPaneByKind(added.layout, 'ghost:hello');
    expect(removed.applied).toBe(true);
    const children = (
      removed.layout.content as { children: { fraction: number; node: { panelKind: string } }[] }
    ).children;
    expect(children.map((c) => c.node.panelKind)).toEqual(['chat-main', 'right-tabs']);
    expect(children.reduce((a, c) => a + c.fraction, 0)).toBeCloseTo(1);
  });

  it('卸载拒绝:kind 不存在 / 移除后不足两块', () => {
    const layout = createDefaultLayout();
    expect(removeRootSplitPaneByKind(layout, 'ghost:ghost').applied).toBe(false);
    // 两块状态下移除 right-tabs 会剩一块 → 拒绝。
    expect(removeRootSplitPaneByKind(layout, 'right-tabs').applied).toBe(false);
  });

  it('卸载 chat-main 被出口校验拒绝(即使块数足够)', () => {
    const layout = createDefaultLayout();
    const added = insertRootSplitPane(
      layout,
      { id: 'demo-hello', panelKind: 'ghost:hello' },
      { index: 1 },
    );
    const r = removeRootSplitPaneByKind(added.layout, 'chat-main');
    expect(r.applied).toBe(false);
  });
});

describe('swapRootSplitChildrenByKind(N 面板换位)', () => {
  it('三块中交换源与目标,fraction 随面板走,其余不动', () => {
    const layout = createDefaultLayout();
    const added = insertRootSplitPane(
      layout,
      { id: 'demo-hello', panelKind: 'ghost:hello' },
      { index: 1, fraction: 0.2 },
    );
    const r = swapRootSplitChildrenByKind(added.layout, 'chat-main', 'right-tabs');
    expect(r.applied).toBe(true);
    const children = (
      r.layout.content as { children: { fraction: number; node: { panelKind: string } }[] }
    ).children;
    expect(children.map((c) => c.node.panelKind)).toEqual([
      'right-tabs',
      'ghost:hello',
      'chat-main',
    ]);
    // fraction 跟着面板走:hello 仍是 0.2。
    expect(children[1].fraction).toBeCloseTo(0.2);
    expect(validateLayout(r.layout)).toEqual({ ok: true });
  });

  it('kind 不存在 / 自己换自己 → 拒绝并返回原引用', () => {
    const layout = createDefaultLayout();
    expect(swapRootSplitChildrenByKind(layout, 'chat-main', 'ghost:ghost').applied).toBe(false);
    expect(swapRootSplitChildrenByKind(layout, 'chat-main', 'chat-main').applied).toBe(false);
  });
});

function layoutWithTwoGhostPanes(): Layout {
  const alpha = insertRootSplitPane(
    createDefaultLayout(),
    { id: 'ghost-alpha', panelKind: 'ghost:alpha' },
    { index: 0, fraction: 0.2 },
  );
  const beta = insertRootSplitPane(
    alpha.layout,
    { id: 'ghost-beta', panelKind: 'ghost:beta' },
    { index: 1, fraction: 0.25 },
  );
  expect(alpha.applied).toBe(true);
  expect(beta.applied).toBe(true);
  return beta.layout;
}

describe('插件面板 grid 停靠', () => {
  it('把两个根级插件上下合并为 column，外层宽度继承双方份额之和', () => {
    const layout = layoutWithTwoGhostPanes();
    const before = (layout.content as SplitNode).children;
    const alphaWidth = before[0].fraction;
    const betaWidth = before[1].fraction;

    const result = stackGhostPaneByKind(layout, 'ghost:alpha', 'ghost:beta', 'before');

    expect(result.applied).toBe(true);
    const root = result.layout.content as SplitNode;
    expect(root.direction).toBe('row');
    expect(root.children).toHaveLength(3);
    expect(root.children[0].fraction).toBeCloseTo(alphaWidth + betaWidth);
    expect(root.children[0].node).toMatchObject({ type: 'split', direction: 'column' });
    const column = root.children[0].node as SplitNode;
    expect(
      column.children.map((child) => child.node.type === 'pane' && child.node.panelKind),
    ).toEqual(['ghost:alpha', 'ghost:beta']);
    expect(column.children.map((child) => child.fraction)).toEqual([0.5, 0.5]);
    expect(validateLayout(result.layout)).toEqual({ ok: true });
    expect(layout.content).not.toEqual(result.layout.content);
  });

  it('同一纵向列内上下拖动只调整顺序，保留每块高度份额', () => {
    const stacked = stackGhostPaneByKind(
      layoutWithTwoGhostPanes(),
      'ghost:alpha',
      'ghost:beta',
      'before',
    );
    const column = (stacked.layout.content as SplitNode).children[0].node as SplitNode;
    column.children[0].fraction = 0.35;
    column.children[1].fraction = 0.65;

    const reordered = stackGhostPaneByKind(stacked.layout, 'ghost:alpha', 'ghost:beta', 'after');

    expect(reordered.applied).toBe(true);
    const nextColumn = (reordered.layout.content as SplitNode).children[0].node as SplitNode;
    expect(
      nextColumn.children.map((child) => child.node.type === 'pane' && child.node.panelKind),
    ).toEqual(['ghost:beta', 'ghost:alpha']);
    expect(nextColumn.children.map((child) => child.fraction)).toEqual([0.65, 0.35]);
  });

  it('从两块等分 column 抽回根横排时，恢复为两份相同列宽并折叠单子节点 split', () => {
    const stacked = stackGhostPaneByKind(
      layoutWithTwoGhostPanes(),
      'ghost:alpha',
      'ghost:beta',
      'before',
    );

    const result = moveGhostPaneToRootByKind(stacked.layout, 'ghost:alpha', 'chat-main', 'before');

    expect(result.applied).toBe(true);
    const root = result.layout.content as SplitNode;
    expect(
      root.children.map((child) => child.node.type === 'pane' && child.node.panelKind),
    ).toEqual(['ghost:beta', 'ghost:alpha', 'chat-main', 'right-tabs']);
    expect(root.children[0].fraction).toBeCloseTo(root.children[1].fraction);
    expect(validateLayout(result.layout)).toEqual({ ok: true });
  });

  it('中心交换支持纵向列中的插件槽位，且不会改变槽位高度', () => {
    const withGamma = insertRootSplitPane(
      layoutWithTwoGhostPanes(),
      { id: 'ghost-gamma', panelKind: 'ghost:gamma' },
      { index: 2, fraction: 0.1 },
    );
    const stacked = stackGhostPaneByKind(withGamma.layout, 'ghost:alpha', 'ghost:beta', 'before');
    const rootBefore = stacked.layout.content as SplitNode;
    const columnBefore = rootBefore.children[0].node as SplitNode;
    columnBefore.children[0].fraction = 0.4;
    columnBefore.children[1].fraction = 0.6;

    const result = swapPanesByKind(stacked.layout, 'ghost:alpha', 'ghost:gamma');

    expect(result.applied).toBe(true);
    const root = result.layout.content as SplitNode;
    const column = root.children[0].node as SplitNode;
    expect(column.children[0].node).toMatchObject({ panelKind: 'ghost:gamma' });
    expect(column.children.map((child) => child.fraction)).toEqual([0.4, 0.6]);
    expect(walkPanes(result.layout).map((pane) => pane.panelKind)).toContain('ghost:alpha');
    expect(validateLayout(result.layout)).toEqual({ ok: true });
  });

  it('内置面板可与整个插件纵向列交换，但仍拒绝进入列内槽位', () => {
    const stacked = stackGhostPaneByKind(
      layoutWithTwoGhostPanes(),
      'ghost:alpha',
      'ghost:beta',
      'before',
    );
    const before = stacked.layout.content as SplitNode;
    const columnFraction = before.children[0].fraction;
    const chatFraction = before.children[1].fraction;

    expect(swapPanesByKind(stacked.layout, 'chat-main', 'ghost:alpha').applied).toBe(false);
    const result = swapRootSplitChildrenByKind(stacked.layout, 'chat-main', 'ghost:alpha');
    expect(result.applied).toBe(true);
    const root = result.layout.content as SplitNode;
    expect(root.children[0].node).toMatchObject({ type: 'pane', panelKind: 'chat-main' });
    expect(root.children[0].fraction).toBeCloseTo(chatFraction);
    expect(root.children[1].node).toMatchObject({ type: 'split', direction: 'column' });
    expect(root.children[1].fraction).toBeCloseTo(columnFraction);
    expect(countPanelKind(result.layout, 'chat-main')).toBe(1);
    expect(validateLayout(result.layout)).toEqual({ ok: true });
  });

  it('上下停靠拒绝内置面板或缺失目标，保持 chat-main 不变量', () => {
    const layout = layoutWithTwoGhostPanes();
    expect(stackGhostPaneByKind(layout, 'chat-main', 'ghost:alpha', 'before').applied).toBe(false);
    expect(stackGhostPaneByKind(layout, 'ghost:alpha', 'ghost:missing', 'after').applied).toBe(
      false,
    );
    expect(validateLayout(layout)).toEqual({ ok: true });
    expect(countPanelKind(layout, 'chat-main')).toBe(1);
  });
});

describe('transferSplitFraction(缝把手拖宽提交)', () => {
  it('只动缝两侧邻居:from 减 to 增,第三方不受影响,总和保持 1', () => {
    const layout = createDefaultLayout();
    const added = insertRootSplitPane(
      layout,
      { id: 'demo-hello', panelKind: 'ghost:hello' },
      { index: 1, fraction: 0.2 },
    );
    const before = (added.layout.content as { children: { fraction: number }[] }).children.map(
      (c) => c.fraction,
    );
    const r = transferSplitFraction(added.layout, 'root', 1, 2, 0.1);
    expect(r.applied).toBe(true);
    const after = (r.layout.content as { children: { fraction: number }[] }).children.map(
      (c) => c.fraction,
    );
    expect(after[0]).toBeCloseTo(before[0]); // chat 不动
    expect(after[1]).toBeCloseTo(before[1] - 0.1);
    expect(after[2]).toBeCloseTo(before[2] + 0.1);
    expect(after.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(validateLayout(r.layout)).toEqual({ ok: true });
  });

  it('转移导致任一侧低于 0.05 → 拒绝并返回原引用', () => {
    const layout = createDefaultLayout(); // 0.5 / 0.5
    expect(transferSplitFraction(layout, 'root', 0, 1, 0.48).applied).toBe(false);
    expect(transferSplitFraction(layout, 'root', 0, 1, 0.4).applied).toBe(true);
  });

  it('恰好夹到 0.05 下限的转移必须放行:浮点残差不得判成非法(否则松手回弹)', () => {
    // 调用方(缝把手)按下限夹取 amount 后,减回去会得到 0.04999999999999999 ——
    // 裸比较 < 0.05 会整单拒绝,拖动的整段位移作废(2026-07-29 实测右栏回弹)。
    const layout = createDefaultLayout();
    const children = (layout.content as SplitNode).children;
    children[0].fraction = 0.4589135021784424; // 用户现场树的 chat 份额
    children[1].fraction = 0.5410864978215576;
    const amount = children[0].fraction - 0.05; // 夹到下限
    expect(children[0].fraction - amount).toBeLessThan(0.05); // 浮点残差前提成立
    const r = transferSplitFraction(layout, 'root', 0, 1, amount);
    expect(r.applied).toBe(true);
    expect((r.layout.content as SplitNode).children[0].fraction).toBeCloseTo(0.05, 6);
    expect(validateLayout(r.layout)).toEqual({ ok: true });
  });

  it('非法入参(amount=0 / 同下标 / 越界 / split 不存在)全部拒绝', () => {
    const layout = createDefaultLayout();
    expect(transferSplitFraction(layout, 'root', 0, 1, 0).applied).toBe(false);
    expect(transferSplitFraction(layout, 'root', 1, 1, 0.1).applied).toBe(false);
    expect(transferSplitFraction(layout, 'root', 0, 9, 0.1).applied).toBe(false);
    expect(transferSplitFraction(layout, 'ghost', 0, 1, 0.1).applied).toBe(false);
  });
});

describe('transferSplitFractionRelay(压缩 chat 的多来源接力提交)', () => {
  /** 现场树形:chat 份额已顶 0.05 下限,右侧栏折叠着但账上还有 0.206。 */
  function userTreeWithCollapsedRsb(): Layout {
    const layout = createDefaultLayout();
    const split = layout.content as SplitNode;
    split.children = [
      { fraction: 0.206, node: { type: 'pane', id: 'right', panelKind: 'right-tabs' } },
      { fraction: 0.122, node: { type: 'pane', id: 'ghost-pr', panelKind: 'ghost:pr' } },
      { fraction: 0.05, node: { type: 'pane', id: 'chat', panelKind: 'chat-main', minWidth: 400 } },
      { fraction: 0.622, node: { type: 'pane', id: 'ghost-canvas', panelKind: 'ghost:canvas' } },
    ];
    return layout;
  }

  it('主来源够用时与两方转移等价:只动 chat 与收方', () => {
    const layout = createDefaultLayout();
    const r = transferSplitFractionRelay(layout, 'root', [0], 1, 0.1);
    expect(r.applied).toBe(true);
    const fractions = (r.layout.content as SplitNode).children.map((c) => c.fraction);
    expect(fractions[0]).toBeCloseTo(0.4);
    expect(fractions[1]).toBeCloseTo(0.6);
    expect(validateLayout(r.layout)).toEqual({ ok: true });
  });

  it('主来源(已顶 0.05)不够:差额由后面的折叠兄弟接力,三方各保下限', () => {
    const layout = userTreeWithCollapsedRsb();
    // 拖 25px(share 0.0151):chat 无账可出,全部从折叠的 right-tabs 出。
    const r = transferSplitFractionRelay(layout, 'root', [2, 0], 3, 0.0151);
    expect(r.applied).toBe(true);
    const fractions = (r.layout.content as SplitNode).children.map((c) => c.fraction);
    expect(fractions[2]).toBeCloseTo(0.05, 6); // chat 仍顶下限
    expect(fractions[0]).toBeCloseTo(0.206 - 0.0151, 6); // 折叠兄弟出账
    expect(fractions[3]).toBeCloseTo(0.622 + 0.0151, 6); // 收方全额进账
    expect(fractions.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(validateLayout(r.layout)).toEqual({ ok: true });
  });

  it('接力总额不够 → 整单拒绝并返回原引用(拖缝松手回弹的判据)', () => {
    const layout = userTreeWithCollapsedRsb();
    // chat 0(0.05 顶死)+ right-tabs 最多让 0.156,0.2 必然不够。
    const r = transferSplitFractionRelay(layout, 'root', [2, 0], 3, 0.2);
    expect(r.applied).toBe(false);
    expect(r.layout).toBe(layout);
  });

  it('非法入参(空 sources / 收方在 sources 里 / 重复下标 / amount≤0 / 越界)全部拒绝', () => {
    const layout = userTreeWithCollapsedRsb();
    expect(transferSplitFractionRelay(layout, 'root', [], 3, 0.1).applied).toBe(false);
    expect(transferSplitFractionRelay(layout, 'root', [2, 3], 3, 0.1).applied).toBe(false);
    expect(transferSplitFractionRelay(layout, 'root', [0, 0], 3, 0.1).applied).toBe(false);
    expect(transferSplitFractionRelay(layout, 'root', [2], 3, 0).applied).toBe(false);
    expect(transferSplitFractionRelay(layout, 'root', [2], 3, -0.1).applied).toBe(false);
    expect(transferSplitFractionRelay(layout, 'root', [9], 3, 0.1).applied).toBe(false);
    expect(transferSplitFractionRelay(layout, 'root', [2], 9, 0.1).applied).toBe(false);
    expect(transferSplitFractionRelay(layout, 'nope', [2], 3, 0.1).applied).toBe(false);
  });
});

describe('findSplitChildByPanelKind', () => {
  it('默认树:按 kind 找到 right-tabs 的分割位置与 fraction', () => {
    const layout = createDefaultLayout();
    const ref = findSplitChildByPanelKind(layout, 'right-tabs');
    expect(ref).toEqual({ splitId: 'root', childIndex: 1, fraction: 0.5 });
  });

  it('children 顺序交换后仍能按 kind 找到(寻址与方位无关)', () => {
    const layout = createDefaultLayout();
    (layout.content as { children: unknown[] }).children.reverse();
    const ref = findSplitChildByPanelKind(layout, 'right-tabs');
    expect(ref).toEqual({ splitId: 'root', childIndex: 0, fraction: 0.5 });
  });

  it('嵌套分割:深度优先找到里层 split 中的目标', () => {
    const layout = createDefaultLayout();
    (layout as { content: unknown }).content = {
      type: 'split',
      id: 'root',
      direction: 'row',
      children: [
        {
          fraction: 0.5,
          node: { type: 'pane', id: 'chat', panelKind: 'chat-main', minWidth: 400 },
        },
        {
          fraction: 0.5,
          node: {
            type: 'split',
            id: 'inner',
            direction: 'column',
            children: [
              { fraction: 0.6, node: { type: 'pane', id: 'right', panelKind: 'right-tabs' } },
              { fraction: 0.4, node: { type: 'pane', id: 'extra', panelKind: 'ghost:demo' } },
            ],
          },
        },
      ],
    };
    const ref = findSplitChildByPanelKind(layout, 'right-tabs');
    expect(ref).toEqual({ splitId: 'inner', childIndex: 0, fraction: 0.6 });
  });

  it('kind 不在树里 / content 是单 pane → null', () => {
    const layout = createDefaultLayout();
    expect(findSplitChildByPanelKind(layout, 'ghost:ghost')).toBeNull();
    (layout as { content: unknown }).content = {
      type: 'pane',
      id: 'chat',
      panelKind: 'chat-main',
      minWidth: 400,
    };
    expect(findSplitChildByPanelKind(layout, 'right-tabs')).toBeNull();
    // sidebar 的 session-list 不在 content 树里,按约定不被本函数寻址。
    expect(findSplitChildByPanelKind(layout, 'session-list')).toBeNull();
  });
});
