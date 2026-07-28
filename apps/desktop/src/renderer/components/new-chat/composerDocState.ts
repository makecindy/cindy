/**
 * composerDocState — 输入框 ProseMirror 文档级状态判定的小工具。
 *
 * atom content(mentionChip / pastedTextChip / composerQuote)在模型层没有文本投影,
 * `doc.textContent` 对「只含 chip 的文档」返回空串——任何用 textContent
 * 判空的调用点都会把带 chip 的输入框误当空(review P2:↑ 历史回填把
 * 只含折叠粘贴 chip 的草稿整段 replaceWith 覆盖,payload 静默丢失)。
 * 判空必须同时确认无 chip,这里收敛成单一实现供调用点共享。
 */
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

/** 输入框里有文本投影缺失的 atom chip 的节点类型名。 */
const ATOM_CHIP_TYPES = new Set(['mentionChip', 'pastedTextChip', 'composerQuote']);

/** 文档是否含任意 atom chip(mentionChip / pastedTextChip)。 */
export function docContainsAtomChip(doc: ProseMirrorNode): boolean {
  let found = false;
  doc.descendants((node) => {
    if (found) return false;
    if (ATOM_CHIP_TYPES.has(node.type.name)) found = true;
    return !found;
  });
  return found;
}

/** Structured list nodes carry a visible marker even when their paragraph is empty. */
export function docContainsStructuredList(doc: ProseMirrorNode): boolean {
  let found = false;
  doc.descendants((node) => {
    if (node.type.name === 'bulletList' || node.type.name === 'orderedList') {
      found = true;
      return false;
    }
    return !found;
  });
  return found;
}

/** 输入框文档是否"真空"(无文本且无 chip)——textContent 判空的 chip-aware 版。 */
export function composerDocIsEmpty(doc: ProseMirrorNode): boolean {
  return (
    !docContainsAtomChip(doc) &&
    !docContainsStructuredList(doc) &&
    doc.textContent.trim().length === 0
  );
}
