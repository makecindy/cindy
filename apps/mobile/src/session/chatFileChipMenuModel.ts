/**
 * chatFileChipMenuModel — 聊天文件 chip 长按菜单的纯模型(可单测)。
 * 行清单按目标类型给出:文件与目录的动作集不同(目录没有预览/分享,
 * 「打开」直接就是文件浏览器定位),渲染层只按 key 映射图标与回调。
 */

import { i18n } from '@/i18n';
import type { ChatFilePathTarget } from '@/session/chatFilePathContext';
import { pathDisplayName } from '@/session/chatPathCandidate';

export type ChatFileChipMenuActionKey =
  | 'open'
  | 'revealInBrowser'
  | 'sendToSession'
  | 'copyPath'
  | 'share';

export interface ChatFileChipMenuRow {
  key: ChatFileChipMenuActionKey;
  label: string;
}

/** 面板标题:路径 basename(与文件浏览器长按菜单的对象名口径一致)。
 *  workdir 外目标(relPath 为 null)取 absPath 的最后一段,兼容 Windows 反斜杠。 */
export function chatFileChipMenuTitle(target: ChatFilePathTarget): string {
  const source = target.relPath ?? target.absPath;
  return pathDisplayName(source) || source;
}

/**
 * 动作行清单。文案对齐文件浏览器长按菜单(快速预览 / 发送到会话 / 复制路径 /
 * 导出 / 分享),避免同一 app 里两套叫法;「在文件浏览器中查看」是聊天 chip
 * 特有动作(对齐桌面右键「打开文件所在目录」语义:定位到父目录)。
 * workdir 外文件(relPath 为 null)没有「在文件浏览器中查看」——文件浏览器
 * 以 workdir 为根,定位不到外部路径;其余动作走 absPath 通道照常可用。
 */
export function chatFileChipMenuRows(target: ChatFilePathTarget): ChatFileChipMenuRow[] {
  if (target.kind === 'directory') {
    return [
      { key: 'open', label: i18n.t('composer.attachments.fileMenu.openBrowser') },
      { key: 'sendToSession', label: i18n.t('composer.attachments.fileMenu.sendToSession') },
      { key: 'copyPath', label: i18n.t('composer.attachments.fileMenu.copyPath') },
    ];
  }
  return [
    { key: 'open', label: i18n.t('composer.attachments.fileMenu.quickPreview') },
    ...(target.relPath !== null
      ? [{ key: 'revealInBrowser', label: i18n.t('composer.attachments.fileMenu.revealInBrowser') } as const]
      : []),
    { key: 'sendToSession', label: i18n.t('composer.attachments.fileMenu.sendToSession') },
    { key: 'copyPath', label: i18n.t('composer.attachments.fileMenu.copyPath') },
    { key: 'share', label: i18n.t('composer.attachments.fileMenu.share') },
  ];
}
