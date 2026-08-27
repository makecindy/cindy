/**
 * 主界面布局树(Layout Tree)—— 数据模型、校验与纯函数操作。
 *
 * 放在 shared 层的原因:renderer(渲染布局)与 main(持久化 layout.json 时校验/回退)
 * 必须使用同一套校验逻辑,避免两份实现漂移。本文件零依赖、零 IO、全部纯函数,
 * 任何操作都不原地修改输入(immutable),损坏输入永不抛异常(coerceLayout 兜底回默认)。
 *
 * 结构总览:
 *   Layout = sidebar(树外全高独立柱,会话列表) + content(递归分割树) + float(v1 恒空)
 * 核心规则:谁在分割树的外层,谁就不被里层切割;chat-main 恰好存在一个、不可关闭、不可折叠。
 */

/** 当前布局存档的 schema 版本;持久化迁移时按此判断。 */
export const LAYOUT_SCHEMA_VERSION = 1 as const;

/** 递归分割树的最大深度(含 pane 叶子层)。防止损坏/恶意存档造成递归渲染爆栈。 */
export const MAX_TREE_DEPTH = 8;

/** panelKind 字符串长度上限(防御性,存档里出现超长字符串按损坏处理)。 */
const MAX_PANEL_KIND_LENGTH = 128;

/**
 * 单个 split child 的份额下限:低于它的份额转移一律整单拒绝(不收窄),
 * 插入新面板时的初始份额也按它夹取。调用方(缝把手)应预先把 amount 夹到
 * 这条线以内 —— 拒绝会让拖动的整段位移作废,界面弹回原宽。
 */
export const MIN_SPLIT_CHILD_FRACTION = 0.05;

/**
 * 份额比较容差。夹取到下限的调用方算出的 amount 会带浮点残差
 * (`0.4589135021784424 - 0.05` 再减回去 = `0.04999999999999999`),
 * 裸比较 `< 0.05` 会把**恰好夹到边界**的合法转移判成非法 → 整单拒绝 → 松手回弹
 * (2026-07-29 Lizi 实测右栏拖到最大松手回弹的直接原因之一)。
 */
const FRACTION_TOLERANCE = 1e-9;

/** 内置面板类型。未来意识面板使用 `ghost:<id>` 前缀,不在此枚举内。 */
export const BUILTIN_PANEL_KINDS = ['session-list', 'chat-main', 'right-tabs'] as const;
export type BuiltinPanelKind = (typeof BUILTIN_PANEL_KINDS)[number];

/**
 * 面板类型标识。
 *
 * 故意保持"开放命名空间"(任意非空字符串合法),而不是封闭枚举:
 * - 未来意识面板注册为 `ghost:<id>`,类型/校验/持久化零改动;
 * - 卸载意识后存档里残留的 kind 依然是**合法树**(渲染层查注册表查不到时隐藏该
 *   pane 并回流空间,编辑模式下显示幽灵槽位)——绝不能因为"不认识"就把整棵树
 *   打回默认,否则卸载一张意识会毁掉用户全部布局;
 * - 同理,新版本新增的内置面板在旧版本上打开时也只是"隐藏",不是"重置"。
 *
 * `(string & {})` 是保留字面量自动补全的常用技巧,语义上等价于 string。
 */
export type PanelKind = BuiltinPanelKind | (string & {});

/** 叶子节点:一块面板的停靠位。 */
export type PaneNode = {
  type: 'pane';
  /** 布局内唯一 id(由调用方生成;纯函数层不产生随机值,保证可测可复现)。 */
  id: string;
  panelKind: PanelKind;
  /** 折叠态。注意:折叠是"贴边才有"的位置能力,本字段只存状态,能力判定在渲染层。 */
  collapsed?: boolean;
  /** 面板最小宽度(px)。chat-main 默认 400,见 createDefaultLayout。 */
  minWidth?: number;
};

/** 分割节点:往某个方向切一刀,children 的 fraction 为该方向上的占比。 */
export type SplitNode = {
  type: 'split';
  id: string;
  /** row = 水平排列(竖切),column = 垂直排列(横切)。 */
  direction: 'row' | 'column';
  children: { fraction: number; node: LayoutNode }[];
};

export type LayoutNode = PaneNode | SplitNode;

/** 浮层面板(WoW 式自由浮动)。v1 不启用,仅占位定型。 */
export type FloatPanel = {
  id: string;
  panelKind: PanelKind;
  x: number;
  y: number;
  width: number;
  height: number;
};

/** 全局唯一的一份布局(不随 session 变形;面板内容跟随会话,布局不跟随)。 */
export type Layout = {
  schemaVersion: typeof LAYOUT_SCHEMA_VERSION;
  /**
   * 会话列表:树外的全高独立柱,不被 content 的任何分割切到。
   * v1 只允许 edge: 'left';远期最多支持整柱镜像到最右,不可进入内容区。
   */
  sidebar: PaneNode & { edge: 'left' };
  /** 内容区 = 递归分割树。 */
  content: LayoutNode;
  /** v1 恒为空数组。 */
  float: FloatPanel[];
};

/** 校验结果。ok=false 时 reason 描述第一处违规(供日志,非用户文案)。 */
export type ValidateResult = { ok: true } | { ok: false; reason: string };

/** coerceLayout 的结果:fallback=true 表示输入不可用、已回退默认树。 */
export type CoerceResult = { layout: Layout; fallback: boolean; reason?: string };

/** 树操作的结果:applied=false 时 layout 即原输入(引用相等),reason 说明原因。 */
export type LayoutOpResult = { layout: Layout; applied: boolean; reason?: string };

// ---------------------------------------------------------------------------
// 默认布局
// ---------------------------------------------------------------------------

/**
 * 默认布局 = 今天的三栏样子:sidebar(会话列表)+ 内容区一刀竖切(聊天 0.5 / 工具 0.5)。
 * 0.5/0.5 对齐 useRightSidebarResize 的既有默认(DEFAULT_FRACTION = 0.5,右栏与聊天区
 * 1:1)——B1b 起宽度由树驱动,默认值必须与用户一直看到的 50/50 一致,不能引入视觉变化。
 * 每次调用返回全新深拷贝,调用方可安全修改。
 */
export function createDefaultLayout(): Layout {
  return {
    schemaVersion: LAYOUT_SCHEMA_VERSION,
    sidebar: { type: 'pane', id: 'sessions', panelKind: 'session-list', edge: 'left' },
    content: {
      type: 'split',
      id: 'root',
      direction: 'row',
      children: [
        {
          fraction: 0.5,
          node: { type: 'pane', id: 'chat', panelKind: 'chat-main', minWidth: 400 },
        },
        { fraction: 0.5, node: { type: 'pane', id: 'right', panelKind: 'right-tabs' } },
      ],
    },
    float: [],
  };
}

// ---------------------------------------------------------------------------
// 类型守卫与遍历
// ---------------------------------------------------------------------------

export function isPaneNode(node: LayoutNode): node is PaneNode {
  return node.type === 'pane';
}

export function isSplitNode(node: LayoutNode): node is SplitNode {
  return node.type === 'split';
}

function walkContentPanes(node: LayoutNode, out: PaneNode[]): void {
  if (node.type === 'pane') {
    out.push(node);
    return;
  }
  for (const child of node.children) walkContentPanes(child.node, out);
}

/** 按 sidebar → content(深度优先) → float 的顺序返回全部 pane(float 项转为 PaneNode 视图)。 */
export function walkPanes(layout: Layout): PaneNode[] {
  const out: PaneNode[] = [layout.sidebar];
  walkContentPanes(layout.content, out);
  for (const f of layout.float) out.push({ type: 'pane', id: f.id, panelKind: f.panelKind });
  return out;
}

/**
 * 恢复内置默认布局，但保留现有意识面板的停靠槽位。
 *
 * `layout.reset` 是用户从坏布局逃生的正式入口，不能顺手把已安装或等待重装复活的
 * `ghost:*` 面板从树里删掉。意识面板统一重新停在聊天区左侧，保留相对顺序和
 * minWidth；位置、折叠态与宽度则回到一组有界默认值。
 */
export function createDefaultLayoutPreservingGhostPanels(current: Layout): Layout {
  const ghostPanes = walkPanes(current).filter((pane) => pane.panelKind.startsWith('ghost:'));
  const next = createDefaultLayout();
  if (ghostPanes.length === 0 || next.content.type !== 'split') return next;

  const root = next.content;
  const ghostTotalFraction = Math.min(0.6, ghostPanes.length * 0.2);
  const ghostFraction = ghostTotalFraction / ghostPanes.length;
  const builtinFraction = (1 - ghostTotalFraction) / root.children.length;
  for (const child of root.children) child.fraction = builtinFraction;

  const usedIds = new Set<string>(['sessions', root.id, ...root.children.map((c) => c.node.id)]);
  const ghostChildren = ghostPanes.map((pane, index) => {
    const baseId = `ghost-${pane.panelKind.slice('ghost:'.length)}`;
    let id = baseId;
    let suffix = index + 1;
    while (usedIds.has(id)) id = `${baseId}-${suffix++}`;
    usedIds.add(id);
    return {
      fraction: ghostFraction,
      node: {
        type: 'pane' as const,
        id,
        panelKind: pane.panelKind,
        ...(pane.minWidth !== undefined ? { minWidth: pane.minWidth } : {}),
      },
    };
  });
  root.children = [...ghostChildren, ...root.children];
  normalizeSplitFractions(root);
  return next;
}

/** 按 id 查找 pane(含 sidebar 与 float)。找不到返回 null。 */
export function findPaneById(layout: Layout, paneId: string): PaneNode | null {
  return walkPanes(layout).find((p) => p.id === paneId) ?? null;
}

/** 统计某 panelKind 在整份布局(含 sidebar 与 float)中的出现次数。 */
export function countPanelKind(layout: Layout, kind: PanelKind): number {
  return walkPanes(layout).filter((p) => p.panelKind === kind).length;
}

/** 某个 pane 在 content 分割树中的位置引用(用于按位置读写 fraction)。 */
export interface SplitChildRef {
  /** 所在分割节点的 id(setSplitChildFraction 的寻址键)。 */
  splitId: string;
  /** 在该分割 children 中的下标。 */
  childIndex: number;
  /** 该 child 当前的 fraction。 */
  fraction: number;
}

function findSplitChildByKindIn(node: LayoutNode, kind: PanelKind): SplitChildRef | null {
  if (node.type !== 'split') return null;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    if (child.node.type === 'pane' && child.node.panelKind === kind) {
      return { splitId: node.id, childIndex: i, fraction: child.fraction };
    }
    const nested = findSplitChildByKindIn(child.node, kind);
    if (nested) return nested;
  }
  return null;
}

/**
 * 在 content 分割树中深度优先查找第一个 panelKind 匹配的 pane,返回其分割位置引用。
 * 找不到(该面板不在树里 / content 是单 pane)返回 null。
 * 消费方(如右栏宽度 hook)按 kind 寻址而非按方位寻址 —— 面板换到哪一侧都能找到。
 */
export function findSplitChildByPanelKind(layout: Layout, kind: PanelKind): SplitChildRef | null {
  return findSplitChildByKindIn(layout.content, kind);
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isValidId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 128;
}

function isValidPanelKind(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_PANEL_KIND_LENGTH;
}

/** 结构性校验单个节点(形状 + 深度 + fraction),把途经的 pane 与 id 收集起来供全局不变量检查。 */
function validateNodeShape(
  node: unknown,
  depth: number,
  ids: Set<string>,
  panes: PaneNode[],
): ValidateResult {
  if (depth > MAX_TREE_DEPTH) return { ok: false, reason: `tree deeper than ${MAX_TREE_DEPTH}` };
  if (!isRecord(node)) return { ok: false, reason: 'node is not an object' };

  if (!isValidId(node.id)) return { ok: false, reason: 'node id invalid' };
  if (ids.has(node.id)) return { ok: false, reason: `duplicate node id: ${node.id}` };
  ids.add(node.id);

  if (node.type === 'pane') {
    if (!isValidPanelKind(node.panelKind)) return { ok: false, reason: 'panelKind invalid' };
    if (node.collapsed !== undefined && typeof node.collapsed !== 'boolean') {
      return { ok: false, reason: 'collapsed must be boolean' };
    }
    if (
      node.minWidth !== undefined &&
      !(Number.isFinite(node.minWidth) && (node.minWidth as number) > 0)
    ) {
      return { ok: false, reason: 'minWidth must be a positive finite number' };
    }
    panes.push(node as unknown as PaneNode);
    return { ok: true };
  }

  if (node.type === 'split') {
    if (node.direction !== 'row' && node.direction !== 'column') {
      return { ok: false, reason: 'split direction invalid' };
    }
    if (!Array.isArray(node.children) || node.children.length < 2) {
      return { ok: false, reason: 'split needs at least 2 children' };
    }
    let fractionSum = 0;
    for (const child of node.children) {
      if (!isRecord(child)) return { ok: false, reason: 'split child is not an object' };
      if (!(Number.isFinite(child.fraction) && (child.fraction as number) > 0)) {
        return { ok: false, reason: 'child fraction must be a positive finite number' };
      }
      fractionSum += child.fraction as number;
      const r = validateNodeShape(child.node, depth + 1, ids, panes);
      if (!r.ok) return r;
    }
    if (Math.abs(fractionSum - 1) > 0.01) {
      return { ok: false, reason: `split fractions must sum to ~1, got ${fractionSum}` };
    }
    return { ok: true };
  }

  return { ok: false, reason: `unknown node type: ${String((node as { type?: unknown }).type)}` };
}

/**
 * 校验整份布局。只检查**结构性不变量**,不检查 panelKind 是否"已注册"——
 * kind 存不存在是面板注册表在渲染时的事(未安装的意识面板 = 隐藏,不 = 非法树)。
 *
 * 不变量清单(与设计文档 §6 对齐):
 *  1. schemaVersion 匹配;
 *  2. sidebar 必须是 session-list 且 edge='left';
 *  3. content 中 chat-main 恰好一个,且不允许出现 session-list(它只能在树外);
 *  4. chat-main 不可折叠(collapsed 不能为 true);
 *  5. split ≥2 children、fraction 为正有限数、深度 ≤ MAX_TREE_DEPTH、id 全局唯一;
 *  6. v1 float 必须为空。
 */
export function validateLayout(input: Layout): ValidateResult {
  if (!isRecord(input)) return { ok: false, reason: 'layout is not an object' };
  if (input.schemaVersion !== LAYOUT_SCHEMA_VERSION) {
    return { ok: false, reason: `schemaVersion must be ${LAYOUT_SCHEMA_VERSION}` };
  }
  if (!Array.isArray(input.float) || input.float.length !== 0) {
    return { ok: false, reason: 'float must be an empty array in v1' };
  }

  const sidebar = input.sidebar as unknown;
  if (!isRecord(sidebar) || sidebar.type !== 'pane')
    return { ok: false, reason: 'sidebar must be a pane' };
  if (sidebar.panelKind !== 'session-list')
    return { ok: false, reason: 'sidebar must be session-list' };
  if (sidebar.edge !== 'left') return { ok: false, reason: "sidebar edge must be 'left' in v1" };
  if (!isValidId(sidebar.id)) return { ok: false, reason: 'sidebar id invalid' };

  const ids = new Set<string>([sidebar.id as string]);
  const contentPanes: PaneNode[] = [];
  const shape = validateNodeShape(input.content, 1, ids, contentPanes);
  if (!shape.ok) return shape;

  const chatMains = contentPanes.filter((p) => p.panelKind === 'chat-main');
  if (chatMains.length !== 1) {
    return {
      ok: false,
      reason: `content must contain exactly one chat-main (got ${chatMains.length})`,
    };
  }
  if (chatMains[0].collapsed === true)
    return { ok: false, reason: 'chat-main must not be collapsed' };
  if (contentPanes.some((p) => p.panelKind === 'session-list')) {
    return { ok: false, reason: 'session-list must stay outside the content tree' };
  }
  return { ok: true };
}

/**
 * 把来源不可信的数据(持久化文件、IPC 入参)转成一份**必然合法**的布局。
 * 任何解析/校验失败都静默回退默认树,只带回 reason 供调用方打日志——永不抛异常。
 * 这是"存档改坏 → 重启自动复原"行为的实现基础。
 */
export function coerceLayout(raw: unknown): CoerceResult {
  if (!isRecord(raw)) {
    return { layout: createDefaultLayout(), fallback: true, reason: 'not an object' };
  }
  let cloned: Layout;
  try {
    // 深拷贝隔离外部引用;不可序列化的输入(函数、Symbol 等)会在此抛出并走回退。
    // structuredClone 本身支持循环引用,不会为此抛错;循环引用的回退由后续 validateLayout 完成。
    cloned = structuredClone(raw) as Layout;
  } catch {
    return { layout: createDefaultLayout(), fallback: true, reason: 'not cloneable' };
  }
  const v = validateLayout(cloned);
  if (!v.ok) return { layout: createDefaultLayout(), fallback: true, reason: v.reason };
  return { layout: cloned, fallback: false };
}

// ---------------------------------------------------------------------------
// 操作(immutable:全部返回新树;非法操作返回原引用 + applied:false)
// ---------------------------------------------------------------------------

/** 深拷贝 + 出口校验的公共收尾:任何操作都不可能产出非法树。 */
function finishOp(original: Layout, mutated: Layout, reason: string): LayoutOpResult {
  const v = validateLayout(mutated);
  if (!v.ok) return { layout: original, applied: false, reason: `${reason}: ${v.reason}` };
  return { layout: mutated, applied: true };
}

/**
 * 设置某个 pane 的折叠态。chat-main 不可折叠(由出口校验兜底拒绝)。
 * 注意:能否折叠(是否贴边)是渲染层的位置判定,本函数只负责状态写入的合法性。
 */
export function setPaneCollapsed(
  layout: Layout,
  paneId: string,
  collapsed: boolean,
): LayoutOpResult {
  if (!findPaneById(layout, paneId)) {
    return { layout, applied: false, reason: `pane not found: ${paneId}` };
  }
  const next = structuredClone(layout);
  for (const pane of walkPanes(next)) {
    if (pane.id === paneId) pane.collapsed = collapsed;
  }
  // sidebar 是独立字段,walkPanes 返回的正是其引用,已被上面覆盖;float 视图项不回写(v1 恒空)。
  return finishOp(layout, next, 'setPaneCollapsed rejected');
}

/**
 * 设置分割节点中某个 child 的 fraction,并对该分割的全部 children 归一化(总和=1)。
 * fraction 语义与现右栏一致:占比制,窗口缩放时两侧按比例变化。
 */
export function setSplitChildFraction(
  layout: Layout,
  splitId: string,
  childIndex: number,
  fraction: number,
): LayoutOpResult {
  if (!(Number.isFinite(fraction) && fraction > 0 && fraction < 1)) {
    return { layout, applied: false, reason: 'fraction must be between 0 and 1 (exclusive)' };
  }
  if (!Number.isInteger(childIndex)) {
    return { layout, applied: false, reason: `child index must be an integer: ${childIndex}` };
  }
  const next = structuredClone(layout);
  const split = findSplitById(next.content, splitId);
  if (!split) return { layout, applied: false, reason: `split not found: ${splitId}` };
  if (childIndex < 0 || childIndex >= split.children.length) {
    return { layout, applied: false, reason: `child index out of range: ${childIndex}` };
  }
  // Assign the exact requested fraction and redistribute the remainder among siblings
  const siblings = split.children;
  const siblingSum = siblings.reduce((acc, c, i) => acc + (i === childIndex ? 0 : c.fraction), 0);
  siblings[childIndex].fraction = fraction;
  const remainder = 1 - fraction;
  for (let i = 0; i < siblings.length; i++) {
    if (i === childIndex) continue;
    siblings[i].fraction =
      siblingSum > 0
        ? (siblings[i].fraction / siblingSum) * remainder
        : remainder / (siblings.length - 1);
  }
  normalizeSplitFractions(split);
  return finishOp(layout, next, 'setSplitChildFraction rejected');
}

/**
 * 往 content 根分割插入一个新 pane —— "加装面板"的底层操作。
 * - content 必须是分割(默认树满足;单 pane content 暂不支持);
 * - 新 child 分走 fraction 份额(夹取到 [0.05, 0.8]),已有 children 等比让出,总和保持 1;
 * - index 越界自动夹取(默认追加到最右);
 * - id 重复 / 其它不变量破坏由出口校验兜底拒绝(返回原树,不半途落地)。
 */
export function insertRootSplitPane(
  layout: Layout,
  pane: { id: string; panelKind: PanelKind; minWidth?: number },
  opts: { index?: number; fraction?: number } = {},
): LayoutOpResult {
  if (layout.content.type !== 'split') {
    return { layout, applied: false, reason: 'content is not a split' };
  }
  const fraction = Math.min(0.8, Math.max(MIN_SPLIT_CHILD_FRACTION, opts.fraction ?? 0.2));
  const next = structuredClone(layout);
  const split = next.content as SplitNode;
  const index = Math.min(split.children.length, Math.max(0, opts.index ?? split.children.length));
  for (const child of split.children) child.fraction *= 1 - fraction;
  const node: PaneNode = { type: 'pane', id: pane.id, panelKind: pane.panelKind };
  if (pane.minWidth !== undefined) node.minWidth = pane.minWidth;
  split.children.splice(index, 0, { fraction, node });
  normalizeSplitFractions(split);
  return finishOp(layout, next, 'insertRootSplitPane rejected');
}

/**
 * 从 content 根分割移除第一个匹配 panelKind 的 pane —— "卸载面板"的底层操作。
 * 剩余 children 份额归一。拒绝:目标不存在 / 移除后 children < 2(根分割至少
 * 两块;收缩成单 pane 暂不支持)/ 移除 chat-main(出口校验兜底)。
 */
export function removeRootSplitPaneByKind(layout: Layout, kind: PanelKind): LayoutOpResult {
  if (layout.content.type !== 'split') {
    return { layout, applied: false, reason: 'content is not a split' };
  }
  const idx = layout.content.children.findIndex(
    (c) => c.node.type === 'pane' && c.node.panelKind === kind,
  );
  if (idx < 0) return { layout, applied: false, reason: `pane kind not found: ${kind}` };
  if (layout.content.children.length <= 2) {
    return { layout, applied: false, reason: 'root split needs at least 2 children' };
  }
  const next = structuredClone(layout);
  const split = next.content as SplitNode;
  split.children.splice(idx, 1);
  normalizeSplitFractions(split);
  return finishOp(layout, next, 'removeRootSplitPaneByKind rejected');
}

/**
 * 交换 content 根分割中两个 panelKind 所在 child 的位置(N 面板拖拽换位的
 * 提交操作)。kind 可以是根 pane，也可以位于根级插件 column 内；后者交换整列，
 * 避免把内置面板塞进 ghost-only column。child 整体交换，fraction 随区域走。
 */
export function swapRootSplitChildrenByKind(
  layout: Layout,
  kindA: PanelKind,
  kindB: PanelKind,
): LayoutOpResult {
  if (layout.content.type !== 'split') {
    return { layout, applied: false, reason: 'content is not a split' };
  }
  const a = rootChildIndexContainingKind(layout, kindA);
  const b = rootChildIndexContainingKind(layout, kindB);
  if (a < 0 || b < 0)
    return { layout, applied: false, reason: `pane kind not found: ${a < 0 ? kindA : kindB}` };
  if (a === b) return { layout, applied: false, reason: 'cannot swap within the same root child' };
  const next = structuredClone(layout);
  const split = next.content as SplitNode;
  [split.children[a], split.children[b]] = [split.children[b], split.children[a]];
  return finishOp(layout, next, 'swapRootSplitChildrenByKind rejected');
}

/** 插件面板二维停靠只使用一层纵向分组，避免把主界面演化成任意深度的自由网格。 */
interface RootGhostPaneLocation {
  rootIndex: number;
  columnIndex: number | null;
}

function isGhostPanelKind(kind: PanelKind): boolean {
  return kind.startsWith('ghost:');
}

function findRootGhostPaneLocation(layout: Layout, kind: PanelKind): RootGhostPaneLocation | null {
  if (layout.content.type !== 'split' || layout.content.direction !== 'row') return null;
  for (let rootIndex = 0; rootIndex < layout.content.children.length; rootIndex++) {
    const node = layout.content.children[rootIndex].node;
    if (node.type === 'pane' && node.panelKind === kind) {
      return { rootIndex, columnIndex: null };
    }
    if (node.type !== 'split' || node.direction !== 'column') continue;
    const columnIndex = node.children.findIndex(
      (child) => child.node.type === 'pane' && child.node.panelKind === kind,
    );
    if (columnIndex >= 0) return { rootIndex, columnIndex };
  }
  return null;
}

function rootChildIndexContainingKind(layout: Layout, kind: PanelKind): number {
  if (layout.content.type !== 'split' || layout.content.direction !== 'row') return -1;
  const contains = (node: LayoutNode): boolean => {
    if (node.type === 'pane') return node.panelKind === kind;
    return node.children.some((child) => contains(child.node));
  };
  return layout.content.children.findIndex((child) => contains(child.node));
}

function collectLayoutNodeIds(node: LayoutNode, ids: Set<string>): void {
  ids.add(node.id);
  if (node.type === 'split') {
    for (const child of node.children) collectLayoutNodeIds(child.node, ids);
  }
}

function nextGridSplitId(layout: Layout, targetId: string): string {
  const ids = new Set<string>([layout.sidebar.id]);
  collectLayoutNodeIds(layout.content, ids);
  const base = `grid-${targetId}`.slice(0, 120);
  if (!ids.has(base)) return base;
  for (let suffix = 2; suffix < 10_000; suffix++) {
    const candidate = `${base.slice(0, 127 - String(suffix).length)}-${suffix}`;
    if (!ids.has(candidate)) return candidate;
  }
  return `grid-${targetId.slice(0, 110)}-fallback`;
}

function removeGhostPaneFromColumn(
  root: SplitNode,
  location: RootGhostPaneLocation,
): PaneNode | null {
  if (location.columnIndex === null) return null;
  const rootChild = root.children[location.rootIndex];
  if (!rootChild || rootChild.node.type !== 'split' || rootChild.node.direction !== 'column') {
    return null;
  }
  const [removed] = rootChild.node.children.splice(location.columnIndex, 1);
  if (!removed || removed.node.type !== 'pane') return null;
  if (rootChild.node.children.length === 1) {
    rootChild.node = rootChild.node.children[0].node;
  } else {
    normalizeSplitFractions(rootChild.node);
  }
  return removed.node;
}

/**
 * 把一个插件面板停靠到另一个插件面板的上方/下方。
 *
 * 根布局始终保持横向；纵向 grid 只存在于根 child 的一层 column split 中，且只包含
 * `ghost:*` pane。两个根级插件合并时，目标列继承双方宽度份额之和，画面不会突然变窄。
 */
export function stackGhostPaneByKind(
  layout: Layout,
  sourceKind: PanelKind,
  targetKind: PanelKind,
  placement: 'before' | 'after',
): LayoutOpResult {
  if (!isGhostPanelKind(sourceKind) || !isGhostPanelKind(targetKind)) {
    return { layout, applied: false, reason: 'vertical grid only supports ghost panels' };
  }
  if (sourceKind === targetKind) {
    return { layout, applied: false, reason: 'cannot stack a pane with itself' };
  }
  if (layout.content.type !== 'split' || layout.content.direction !== 'row') {
    return { layout, applied: false, reason: 'content root must be a row split' };
  }
  const source = findRootGhostPaneLocation(layout, sourceKind);
  const target = findRootGhostPaneLocation(layout, targetKind);
  if (!source || !target) {
    return {
      layout,
      applied: false,
      reason: `ghost pane not found: ${!source ? sourceKind : targetKind}`,
    };
  }

  const next = structuredClone(layout);
  const root = next.content as SplitNode;

  // 同一列内只做顺序调整，份额随面板走。
  if (
    source.rootIndex === target.rootIndex &&
    source.columnIndex !== null &&
    target.columnIndex !== null
  ) {
    const column = root.children[source.rootIndex].node;
    if (column.type !== 'split' || column.direction !== 'column') return { layout, applied: false };
    const [sourceChild] = column.children.splice(source.columnIndex, 1);
    const targetIndex = column.children.findIndex(
      (child) => child.node.type === 'pane' && child.node.panelKind === targetKind,
    );
    if (!sourceChild || targetIndex < 0) return { layout, applied: false };
    column.children.splice(placement === 'before' ? targetIndex : targetIndex + 1, 0, sourceChild);
    return finishOp(layout, next, 'stackGhostPaneByKind reorder rejected');
  }

  let sourceNode: PaneNode | null = null;
  let transferredRootFraction = 0;
  if (source.columnIndex === null) {
    const [sourceRootChild] = root.children.splice(source.rootIndex, 1);
    if (!sourceRootChild || sourceRootChild.node.type !== 'pane') return { layout, applied: false };
    sourceNode = sourceRootChild.node;
    transferredRootFraction = sourceRootChild.fraction;
  } else {
    sourceNode = removeGhostPaneFromColumn(root, source);
  }
  if (!sourceNode) return { layout, applied: false, reason: `ghost pane not found: ${sourceKind}` };

  // source 移除后目标 rootIndex 可能左移，重新寻址。
  const targetAfterRemoval = findRootGhostPaneLocation(next, targetKind);
  if (!targetAfterRemoval)
    return { layout, applied: false, reason: `ghost pane not found: ${targetKind}` };
  const targetRootChild = root.children[targetAfterRemoval.rootIndex];
  targetRootChild.fraction += transferredRootFraction;

  if (targetAfterRemoval.columnIndex === null) {
    if (targetRootChild.node.type !== 'pane') return { layout, applied: false };
    const targetNode = targetRootChild.node;
    targetRootChild.node = {
      type: 'split',
      id: nextGridSplitId(next, targetNode.id),
      direction: 'column',
      children:
        placement === 'before'
          ? [
              { fraction: 0.5, node: sourceNode },
              { fraction: 0.5, node: targetNode },
            ]
          : [
              { fraction: 0.5, node: targetNode },
              { fraction: 0.5, node: sourceNode },
            ],
    };
  } else {
    const column = targetRootChild.node;
    if (column.type !== 'split' || column.direction !== 'column') return { layout, applied: false };
    const targetIndex = targetAfterRemoval.columnIndex;
    const targetChild = column.children[targetIndex];
    const half = targetChild.fraction / 2;
    targetChild.fraction = half;
    column.children.splice(placement === 'before' ? targetIndex : targetIndex + 1, 0, {
      fraction: half,
      node: sourceNode,
    });
    normalizeSplitFractions(column);
  }

  normalizeSplitFractions(root);
  return finishOp(layout, next, 'stackGhostPaneByKind rejected');
}

/**
 * 把插件面板从纵向列中抽出（或移动现有根 pane），停到某个根级区域左/右侧。
 * 从 column 抽出时按它在列中的高度份额拆分外层列宽；两块 50/50 的列可因此恢复为
 * 合并前近似相同的两列宽度。
 */
export function moveGhostPaneToRootByKind(
  layout: Layout,
  sourceKind: PanelKind,
  targetKind: PanelKind,
  placement: 'before' | 'after',
): LayoutOpResult {
  if (!isGhostPanelKind(sourceKind)) {
    return { layout, applied: false, reason: 'only ghost panels can leave a grid column' };
  }
  if (sourceKind === targetKind) {
    return { layout, applied: false, reason: 'cannot move a pane relative to itself' };
  }
  if (layout.content.type !== 'split' || layout.content.direction !== 'row') {
    return { layout, applied: false, reason: 'content root must be a row split' };
  }
  const source = findRootGhostPaneLocation(layout, sourceKind);
  if (!source) return { layout, applied: false, reason: `ghost pane not found: ${sourceKind}` };
  if (rootChildIndexContainingKind(layout, targetKind) < 0) {
    return { layout, applied: false, reason: `target pane not found: ${targetKind}` };
  }

  const next = structuredClone(layout);
  const root = next.content as SplitNode;
  let sourceRootChild: { fraction: number; node: LayoutNode } | null = null;

  if (source.columnIndex === null) {
    [sourceRootChild] = root.children.splice(source.rootIndex, 1);
  } else {
    const rootChild = root.children[source.rootIndex];
    if (rootChild.node.type !== 'split' || rootChild.node.direction !== 'column') {
      return { layout, applied: false };
    }
    const sourceColumnChild = rootChild.node.children[source.columnIndex];
    if (!sourceColumnChild || sourceColumnChild.node.type !== 'pane')
      return { layout, applied: false };
    const ideal = rootChild.fraction * sourceColumnChild.fraction;
    const maxTransfer = rootChild.fraction - MIN_SPLIT_CHILD_FRACTION;
    if (maxTransfer < MIN_SPLIT_CHILD_FRACTION) {
      return { layout, applied: false, reason: 'grid column is too narrow to split' };
    }
    const extractedFraction = Math.min(maxTransfer, Math.max(MIN_SPLIT_CHILD_FRACTION, ideal));
    const sourceNode = removeGhostPaneFromColumn(root, source);
    if (!sourceNode) return { layout, applied: false };
    rootChild.fraction -= extractedFraction;
    sourceRootChild = { fraction: extractedFraction, node: sourceNode };
  }
  if (!sourceRootChild) return { layout, applied: false };

  const targetRootIndex = rootChildIndexContainingKind(next, targetKind);
  if (targetRootIndex < 0)
    return { layout, applied: false, reason: `target pane not found: ${targetKind}` };
  root.children.splice(
    placement === 'before' ? targetRootIndex : targetRootIndex + 1,
    0,
    sourceRootChild,
  );
  normalizeSplitFractions(root);
  return finishOp(layout, next, 'moveGhostPaneToRootByKind rejected');
}

function findPanePath(node: LayoutNode, kind: PanelKind, path: number[] = []): number[] | null {
  if (node.type === 'pane') return node.panelKind === kind ? path : null;
  for (let index = 0; index < node.children.length; index++) {
    const found = findPanePath(node.children[index].node, kind, [...path, index]);
    if (found) return found;
  }
  return null;
}

function nodeAtPath(root: LayoutNode, path: number[]): LayoutNode | null {
  let node = root;
  for (const index of path) {
    if (node.type !== 'split' || !node.children[index]) return null;
    node = node.children[index].node;
  }
  return node;
}

function setNodeAtPath(root: LayoutNode, path: number[], value: LayoutNode): LayoutNode | null {
  if (path.length === 0) return value;
  let node = root;
  for (let depth = 0; depth < path.length - 1; depth++) {
    if (node.type !== 'split' || !node.children[path[depth]]) return null;
    node = node.children[path[depth]].node;
  }
  const index = path[path.length - 1];
  if (node.type !== 'split' || !node.children[index]) return null;
  node.children[index].node = value;
  return root;
}

/** 交换任意两个 pane 的停靠槽位；份额属于槽位，不随面板移动。 */
export function swapPanesByKind(
  layout: Layout,
  kindA: PanelKind,
  kindB: PanelKind,
): LayoutOpResult {
  if (kindA === kindB) return { layout, applied: false, reason: 'cannot swap a pane with itself' };
  const rootA = rootChildIndexContainingKind(layout, kindA);
  const rootB = rootChildIndexContainingKind(layout, kindB);
  const aIsRootPane =
    layout.content.type === 'split' &&
    rootA >= 0 &&
    layout.content.children[rootA].node.type === 'pane';
  const bIsRootPane =
    layout.content.type === 'split' &&
    rootB >= 0 &&
    layout.content.children[rootB].node.type === 'pane';
  if ((!aIsRootPane || !bIsRootPane) && (!isGhostPanelKind(kindA) || !isGhostPanelKind(kindB))) {
    return {
      layout,
      applied: false,
      reason: 'built-in panes cannot enter a ghost grid column',
    };
  }
  const pathA = findPanePath(layout.content, kindA);
  const pathB = findPanePath(layout.content, kindB);
  if (!pathA || !pathB) {
    return { layout, applied: false, reason: `pane kind not found: ${!pathA ? kindA : kindB}` };
  }
  const next = structuredClone(layout);
  const nodeA = nodeAtPath(next.content, pathA);
  const nodeB = nodeAtPath(next.content, pathB);
  if (!nodeA || !nodeB || nodeA.type !== 'pane' || nodeB.type !== 'pane') {
    return { layout, applied: false };
  }
  const cloneA = structuredClone(nodeA);
  const cloneB = structuredClone(nodeB);
  const withA = setNodeAtPath(next.content, pathA, cloneB);
  if (!withA) return { layout, applied: false };
  next.content = withA;
  const withB = setNodeAtPath(next.content, pathB, cloneA);
  if (!withB) return { layout, applied: false };
  next.content = withB;
  return finishOp(layout, next, 'swapPanesByKind rejected');
}

/**
 * 在分割内把 amount 份额从 fromIndex child 转移给 toIndex child(引擎分割线
 * 拖宽的提交操作 —— 只动缝两侧的邻居,其余 children 份额不受影响;与
 * setSplitChildFraction 的"全体按比例重分"语义不同)。
 * 双方转移后都必须仍 ≥ MIN_SPLIT_CHILD_FRACTION,否则拒绝(调用方应预先按像素
 * 下限夹取 amount);恰好夹到边界的转移**必须放行**,判定带浮点容差。
 */
export function transferSplitFraction(
  layout: Layout,
  splitId: string,
  fromIndex: number,
  toIndex: number,
  amount: number,
): LayoutOpResult {
  if (!(Number.isFinite(amount) && amount !== 0)) {
    return { layout, applied: false, reason: 'amount must be a non-zero finite number' };
  }
  if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex) || fromIndex === toIndex) {
    return { layout, applied: false, reason: 'invalid child indices' };
  }
  const next = structuredClone(layout);
  const split = findSplitById(next.content, splitId);
  if (!split) return { layout, applied: false, reason: `split not found: ${splitId}` };
  if (
    fromIndex < 0 ||
    fromIndex >= split.children.length ||
    toIndex < 0 ||
    toIndex >= split.children.length
  ) {
    return { layout, applied: false, reason: 'child index out of range' };
  }
  const from = split.children[fromIndex];
  const to = split.children[toIndex];
  // 容差:夹到下限的合法转移不能被浮点残差判死(见 FRACTION_TOLERANCE)。
  const floor = MIN_SPLIT_CHILD_FRACTION - FRACTION_TOLERANCE;
  if (from.fraction - amount < floor || to.fraction + amount < floor) {
    return {
      layout,
      applied: false,
      reason: `transfer would shrink a child below ${MIN_SPLIT_CHILD_FRACTION}`,
    };
  }
  from.fraction -= amount;
  to.fraction += amount;
  normalizeSplitFractions(split);
  return finishOp(layout, next, 'transferSplitFraction rejected');
}

/**
 * 多来源接力的份额转移:amount 全额从 sources(按下标顺序)转移到 toIndex,每个
 * 来源各自保住 MIN_SPLIT_CHILD_FRACTION 下限 —— 前一个扣到下限后,剩余差额由
 * 后面的继续接;接力走完仍有缺口则整单拒绝(返回原树)。
 *
 * 为什么需要(2026-08-17 实测):压缩 chat 的拖缝松手要把**像素口径**的增量写回
 * 账本,但 chat 的画面宽(flex 吸收折叠邻居让出的空间)可以远大于自己的树份额,
 * 两方转移会被 0.05 账本地板整单拒绝 —— chat 树份额被拖到 0.05 后那条缝彻底
 * 冻住,压不到 400px 产品下限。差额改由"渲染宽为 0 却占着账"的折叠兄弟接力出账
 * (画面上那块本就被弹性 chat 吸收),账本与画面重新对齐。调用方(LayoutRoot)
 * 按"实测宽为 0"挑来源;本函数只管写树合法,不理解折叠语义。
 */
export function transferSplitFractionRelay(
  layout: Layout,
  splitId: string,
  sources: number[],
  toIndex: number,
  amount: number,
): LayoutOpResult {
  if (!(Number.isFinite(amount) && amount > 0)) {
    return { layout, applied: false, reason: 'amount must be a positive finite number' };
  }
  if (!Array.isArray(sources) || sources.length === 0) {
    return { layout, applied: false, reason: 'sources must be a non-empty array' };
  }
  if (!Number.isInteger(toIndex)) {
    return { layout, applied: false, reason: `toIndex must be an integer: ${toIndex}` };
  }
  const seen = new Set<number>();
  for (const index of sources) {
    if (!Number.isInteger(index)) {
      return { layout, applied: false, reason: `source index must be an integer: ${index}` };
    }
    if (index === toIndex) {
      return { layout, applied: false, reason: 'toIndex must not appear in sources' };
    }
    if (seen.has(index)) {
      return { layout, applied: false, reason: `duplicate source index: ${index}` };
    }
    seen.add(index);
  }
  const next = structuredClone(layout);
  const split = findSplitById(next.content, splitId);
  if (!split) return { layout, applied: false, reason: `split not found: ${splitId}` };
  const bounds = split.children.length;
  if (toIndex < 0 || toIndex >= bounds || sources.some((index) => index < 0 || index >= bounds)) {
    return { layout, applied: false, reason: 'child index out of range' };
  }
  // 容差与两方转移同款:夹到下限的合法接力不能被浮点残差判死。
  const floor = MIN_SPLIT_CHILD_FRACTION - FRACTION_TOLERANCE;
  let remaining = amount;
  for (const index of sources) {
    if (remaining <= FRACTION_TOLERANCE) break;
    const child = split.children[index];
    const take = Math.min(remaining, child.fraction - floor);
    if (take <= 0) continue;
    child.fraction -= take;
    remaining -= take;
  }
  if (remaining > FRACTION_TOLERANCE) {
    return {
      layout,
      applied: false,
      reason: `sources cannot cover the transfer, short by ${remaining}`,
    };
  }
  split.children[toIndex].fraction += amount - remaining;
  normalizeSplitFractions(split);
  return finishOp(layout, next, 'transferSplitFractionRelay rejected');
}

function findSplitById(node: LayoutNode, splitId: string): SplitNode | null {
  if (node.type !== 'split') return null;
  if (node.id === splitId) return node;
  for (const child of node.children) {
    const found = findSplitById(child.node, splitId);
    if (found) return found;
  }
  return null;
}

/** 将一个分割节点 children 的 fraction 原地归一化为总和 1(仅内部使用,外部入口皆 immutable)。 */
function normalizeSplitFractions(split: SplitNode): void {
  const sum = split.children.reduce((acc, c) => acc + c.fraction, 0);
  if (!(Number.isFinite(sum) && sum > 0)) return;
  for (const child of split.children) child.fraction = child.fraction / sum;
}
