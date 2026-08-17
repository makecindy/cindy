/**
 * [INPUT]: Tiptap/ProseMirror 文档节点的最小结构
 * [OUTPUT]: isMultilineDraftDoc —— 草稿是否已是多行(供发送快捷键的 multiline 挡归约)
 * [POS]: composer 发送快捷键语义的草稿形态判定,独立于 ChatInput 以便单测
 *
 * 判据对齐序列化语义:凡是发送后消息文本会跨行的草稿都算多行——
 * 多个顶层块、多个 textblock(结构化列表的每个 listItem 各有一个)、
 * hardBreak,以及把换行折叠进 attrs.text 的原子节点(pastedTextChip 等)。
 */

interface MinimalNodeInfo {
  type: { name: string };
  isText: boolean;
  isTextblock: boolean;
  attrs: Record<string, unknown>;
}

interface MinimalDoc {
  childCount: number;
  descendants: (fn: (node: MinimalNodeInfo) => boolean | void) => void;
}

export function isMultilineDraftDoc(doc: MinimalDoc): boolean {
  if (doc.childCount > 1) return true;
  let textblocks = 0;
  let multiline = false;
  doc.descendants((node) => {
    if (multiline) return false;
    if (node.type.name === 'hardBreak') {
      multiline = true;
      return false;
    }
    if (node.isTextblock) {
      // 第二个 textblock 意味着序列化必然换行(如列表的第二个 listItem)。
      // 不剪枝:textblock 内部还可能藏着 hardBreak 或折叠粘贴 chip。
      textblocks += 1;
      if (textblocks > 1) {
        multiline = true;
        return false;
      }
      return true;
    }
    if (!node.isText) {
      const text = node.attrs['text'];
      if (typeof text === 'string' && text.includes('\n')) {
        multiline = true;
        return false;
      }
    }
    return true;
  });
  return multiline;
}
