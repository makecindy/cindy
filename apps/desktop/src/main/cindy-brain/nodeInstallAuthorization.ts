/**
 * Node 插件安装授权 — Main 进程原生系统弹窗。
 *
 * Renderer 的权限清单负责解释插件申请了什么；真正允许本机 Node 代码进入
 * 安装目录的第二次确认必须由 Main 自己弹出，不能让被 XSS 控制的 Renderer
 * 伪造“用户已经同意”。取消只返回 false，不安装、不更新任何文件。
 */

import { BrowserWindow, dialog, type MessageBoxOptions, type WebContents } from 'electron';

import type { GhostManifest } from '../../shared/ghost.js';
import { t } from '../i18n.js';

export type NodeInstallOperation = 'install' | 'update';

/** 生成原生弹窗内容；插件名字与版本只作为纯文本展示。 */
export function buildNodeInstallDialogOptions(
  manifest: GhostManifest,
  operation: NodeInstallOperation,
): MessageBoxOptions {
  return {
    // 这是用户主动安装流程中的能力确认，不是错误或数据损坏告警。
    // 保持 Main 原生授权边界，同时避免 warning 样式制造破坏性操作的压迫感。
    type: 'none',
    title: t('settings.ghosts.installConfirm.nodeRiskTitle'),
    message: t('settings.ghosts.installConfirm.nodeRiskTitle'),
    detail: `${manifest.name} · v${manifest.version}\n\n${t(
      'settings.ghosts.installConfirm.nodeRiskDescription',
    )}`,
    buttons: [
      t('settings.ghosts.installConfirm.nodeRiskConfirm'),
      operation === 'update'
        ? t('settings.ghosts.updateConfirm.cancel')
        : t('settings.ghosts.installConfirm.nodeRiskCancel'),
    ],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
}

/**
 * Node 清单需要原生二次确认；普通浏览器沙箱插件直接通过。
 * 找不到所属 Cindy 窗口时失败关闭，绝不退化成无父窗口的宽松授权。
 */
export async function requestNodeInstallAuthorization(
  sender: WebContents,
  manifest: GhostManifest,
  operation: NodeInstallOperation,
): Promise<boolean> {
  if (!manifest.node) return true;
  const win = BrowserWindow.fromWebContents(sender);
  if (!win || win.isDestroyed()) return false;
  const { response } = await dialog.showMessageBox(
    win,
    buildNodeInstallDialogOptions(manifest, operation),
  );
  return response === 0;
}
