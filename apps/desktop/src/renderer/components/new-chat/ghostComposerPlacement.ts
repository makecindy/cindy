/**
 * Shared placement for choosing an installed Plugin from composer UI.
 *
 * The runtime recognizes Ghost commands only at the start of the message, so
 * selection prepends (or replaces) that command while preserving all existing
 * rich editor content. Focus is restored on the next frame after popovers
 * finish closing, with the caret at the final editable position.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import type { Editor } from '@tiptap/core';

import type { InstalledGhost } from '../../../shared/ghost';
import { findGhostCommandMatch } from './GhostCommandDecoration';

/** Match popover selection timing: close first, then focus the final editable position. */
export function focusComposerEndNextFrame(editor: Editor): void {
  window.requestAnimationFrame(() => {
    if (!editor.isDestroyed && editor.isEditable) editor.commands.focus('end');
  });
}

export function placeGhostAtComposerStart(
  editor: Editor,
  ghost: InstalledGhost,
  installedRoster: readonly InstalledGhost[],
): boolean {
  const command = ghost.manifest.command;
  if (!command || editor.isDestroyed || !editor.isEditable) return false;

  const { doc } = editor.state;
  // 替换识别看完整已安装命令集：旧 Plugin 即使已停用或被当前
  // 工作目录禁用，它在草稿头的 `$old` 仍应被新选择替换。能否发送
  // 仍由可用 roster / 发送期闸门单独决定。
  const match = findGhostCommandMatch(doc, [...installedRoster], { includeDisabled: true });
  const transaction = editor.state.tr;

  if (match) {
    const nextCharacter =
      match.to < doc.content.size
        ? doc.textBetween(match.to, Math.min(match.to + 1, doc.content.size), '\n', '\n')
        : '';
    transaction.insertText(
      `$${command}${nextCharacter && /\s/u.test(nextCharacter) ? '' : ' '}`,
      match.from,
      match.to,
    );
  } else {
    const firstBlock = doc.firstChild;
    if (firstBlock?.isTextblock) {
      transaction.insertText(`$${command} `, 1);
    } else {
      const paragraphType = editor.state.schema.nodes.paragraph;
      if (!paragraphType) return false;
      transaction.insert(
        0,
        paragraphType.create(null, editor.state.schema.text(`$${command} `)),
      );
    }
  }

  editor.view.dispatch(transaction);
  focusComposerEndNextFrame(editor);
  return true;
}
