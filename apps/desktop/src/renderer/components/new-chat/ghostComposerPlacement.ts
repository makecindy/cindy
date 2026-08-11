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
import { Fragment, type Node as PMNode } from '@tiptap/pm/model';

import type { InstalledGhost } from '../../../shared/ghost';
import { findGhostCommandMatch } from './GhostCommandDecoration';
import type { MentionChipAttrs } from './MentionChipNode';

export const IOS_SIMULATOR_HOST_CAPABILITY = 'ios-simulator' as const;
export type ComposerHostCapability = typeof IOS_SIMULATOR_HOST_CAPABILITY;

export interface HostCapabilityChipMatch {
  from: number;
  to: number;
  attrs: MentionChipAttrs;
}

export function hostCapabilityForGhost(ghost: InstalledGhost): ComposerHostCapability | null {
  return ghost.manifest.slots.includes(IOS_SIMULATOR_HOST_CAPABILITY)
    ? IOS_SIMULATOR_HOST_CAPABILITY
    : null;
}

/**
 * Find a Host capability atom only when it is the first non-whitespace
 * composer content. This mirrors the message-start contract used by Plugin
 * commands and keeps replacement deterministic across empty paragraphs.
 */
export function findHostCapabilityChipMatch(doc: PMNode): HostCapabilityChipMatch | null {
  let paragraphPosition = 0;
  for (let paragraphIndex = 0; paragraphIndex < doc.childCount; paragraphIndex += 1) {
    const paragraph = doc.child(paragraphIndex);
    if (paragraph.type.name !== 'paragraph') return null;
    let childPosition = paragraphPosition + 1;
    for (let childIndex = 0; childIndex < paragraph.childCount; childIndex += 1) {
      const child = paragraph.child(childIndex);
      if (child.isText) {
        if (/\S/u.test(child.text ?? '')) return null;
      } else if (child.type.name === 'mentionChip') {
        const attrs = child.attrs as MentionChipAttrs;
        return attrs.kind === 'plugin-capability'
          ? { from: childPosition, to: childPosition + child.nodeSize, attrs }
          : null;
      } else if (child.type.name !== 'hardBreak') {
        return null;
      }
      childPosition += child.nodeSize;
    }
    paragraphPosition += paragraph.nodeSize;
  }
  return null;
}

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
  const capabilityMatch = findHostCapabilityChipMatch(doc);
  const match = capabilityMatch
    ? null
    : findGhostCommandMatch(doc, [...installedRoster], { includeDisabled: true });
  const transaction = editor.state.tr;

  if (capabilityMatch) {
    const nextCharacter =
      capabilityMatch.to < doc.content.size
        ? doc.textBetween(
            capabilityMatch.to,
            Math.min(capabilityMatch.to + 1, doc.content.size),
            '\n',
            '\n',
          )
        : '';
    transaction.insertText(
      `$${command}${nextCharacter && /\s/u.test(nextCharacter) ? '' : ' '}`,
      capabilityMatch.from,
      capabilityMatch.to,
    );
  } else if (match) {
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
      transaction.insert(0, paragraphType.create(null, editor.state.schema.text(`$${command} `)));
    }
  }

  editor.view.dispatch(transaction);
  focusComposerEndNextFrame(editor);
  return true;
}

/**
 * Place a Host-owned capability as an atomic Plugin chip. Its document attrs
 * contain identity only; serialization maps the capability to a Host-owned
 * prompt and never routes through `expandGhostCommand` / `ghost_call`.
 */
export function placeHostCapabilityAtComposerStart(
  editor: Editor,
  ghost: InstalledGhost,
  installedRoster: readonly InstalledGhost[],
): boolean {
  const capability = hostCapabilityForGhost(ghost);
  if (!capability || editor.isDestroyed || !editor.isEditable) return false;

  const attrs: MentionChipAttrs = {
    kind: 'plugin-capability',
    // Host capabilities have no `$command`; use the localized Plugin name for
    // presentation while keeping the stable id in `pluginId` for routing.
    label: ghost.manifest.name,
    path: capability,
    pluginId: ghost.manifest.id,
    sourceLabel: ghost.manifest.name,
  };
  const node = editor.state.schema.nodes.mentionChip.create(attrs);
  const { doc } = editor.state;
  const capabilityMatch = findHostCapabilityChipMatch(doc);
  const commandMatch = capabilityMatch
    ? null
    : findGhostCommandMatch(doc, [...installedRoster], { includeDisabled: true });
  const match = capabilityMatch ?? commandMatch;
  const transaction = editor.state.tr;

  if (match) {
    const nextCharacter =
      match.to < doc.content.size
        ? doc.textBetween(match.to, Math.min(match.to + 1, doc.content.size), '\n', '\n')
        : '';
    const replacement =
      nextCharacter && /\s/u.test(nextCharacter)
        ? Fragment.from(node)
        : Fragment.fromArray([node, editor.state.schema.text(' ')]);
    transaction.replaceWith(match.from, match.to, replacement);
  } else {
    const content = Fragment.fromArray([node, editor.state.schema.text(' ')]);
    const firstBlock = doc.firstChild;
    if (firstBlock?.isTextblock) {
      transaction.insert(1, content);
    } else {
      const paragraphType = editor.state.schema.nodes.paragraph;
      if (!paragraphType) return false;
      transaction.insert(0, paragraphType.create(null, content));
    }
  }

  editor.view.dispatch(transaction);
  focusComposerEndNextFrame(editor);
  return true;
}
