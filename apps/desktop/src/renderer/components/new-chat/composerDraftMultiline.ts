/**
 * [INPUT]: Tiptap/ProseMirror 文档节点的最小结构
 * [OUTPUT]: isMultilineDraftDoc —— 草稿是否已是多行(供发送快捷键的 multiline 挡归约)
 * [POS]: composer 发送快捷键语义的草稿形态判定,独立于 ChatInput 以便单测
 */

interface MinimalNode {
  childCount: number;
  descendants: (fn: (node: { type: { name: string }; isText: boolean }) => boolean | void) => void;
}

/**
 * A draft counts as multiline once it has more than one block node, or a hard
 * break inside the single block. An empty doc (one empty paragraph) is
 * single-line by construction.
 */
export function isMultilineDraftDoc(doc: MinimalNode): boolean {
  if (doc.childCount > 1) return true;
  let found = false;
  doc.descendants((node) => {
    if (found) return false;
    if (node.type.name === 'hardBreak') found = true;
    return !found;
  });
  return found;
}
