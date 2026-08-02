export interface MobilePiSessionTreeNode {
  id: string;
  role?: 'user' | 'assistant' | 'tool' | 'summary' | 'system';
  preview: string;
  label?: string;
  children: MobilePiSessionTreeNode[];
}

export interface MobilePiSessionTreeSnapshot {
  roots: MobilePiSessionTreeNode[];
  leafId: string | null;
  activePathIds: string[];
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

const MAX_TREE_DEPTH = 64;
const MAX_TREE_NODES = 2_000;

interface TreeParseBudget {
  visited: number;
  exceeded: boolean;
}

function parseNode(
  value: unknown,
  depth: number,
  budget: TreeParseBudget,
): MobilePiSessionTreeNode | null {
  // Device-link payload 可被远端构造；限制递归深度和节点总量，避免恶意/损坏树
  // 触发 JS 栈溢出或长时间占用移动端主线程。超限时拒绝整个快照，不渲染半棵树。
  if (depth > MAX_TREE_DEPTH || budget.visited >= MAX_TREE_NODES) {
    budget.exceeded = true;
    return null;
  }
  budget.visited += 1;
  const node = objectOf(value);
  if (!node || typeof node.id !== 'string' || !node.id) return null;
  const role = node.role;
  const validRole = role === 'user' || role === 'assistant' || role === 'tool'
    || role === 'summary' || role === 'system' ? role : undefined;
  const parsed: MobilePiSessionTreeNode = {
    id: node.id,
    ...(validRole ? { role: validRole } : {}),
    preview: typeof node.preview === 'string' ? node.preview : '',
    ...(typeof node.label === 'string' ? { label: node.label } : {}),
    children: [],
  };
  if (Array.isArray(node.children)) {
    for (const childValue of node.children) {
      const child = parseNode(childValue, depth + 1, budget);
      if (budget.exceeded) return null;
      if (child) parsed.children.push(child);
    }
  }
  return parsed;
}

/** Device-link 是不受信边界；移动端先收窄树形状再渲染/发送 entryId。 */
export function parseMobilePiSessionTree(value: unknown): MobilePiSessionTreeSnapshot | null {
  const snapshot = objectOf(value);
  if (!snapshot || !Array.isArray(snapshot.roots)) return null;
  const budget: TreeParseBudget = { visited: 0, exceeded: false };
  const roots: MobilePiSessionTreeNode[] = [];
  for (const rootValue of snapshot.roots) {
    const root = parseNode(rootValue, 0, budget);
    if (budget.exceeded) return null;
    if (root) roots.push(root);
  }
  return {
    roots,
    leafId: typeof snapshot.leafId === 'string' ? snapshot.leafId : null,
    activePathIds: Array.isArray(snapshot.activePathIds)
      ? snapshot.activePathIds.filter((id): id is string => typeof id === 'string')
      : [],
  };
}
