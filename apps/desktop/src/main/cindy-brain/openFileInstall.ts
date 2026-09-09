import fs from 'node:fs';

import { BrowserWindow } from 'electron';

import { createLogger } from '../logger.js';

/**
 * 双击 .cindy 文件的转交通道。
 *
 * 主进程**不在这里装**:三个装入入口(设置页 / 拖入 / 双击)统一走
 * renderer 的同一套一键编排(installFlow:inspect 验明正身 → install)，
 * 双击只负责把文件路径递进去。
 *
 * 转交模型(对齐 deepLink 的 pending buffer 成熟套路):
 * - 收到路径 → 存入 pending(仅保留最新一条;双击语义上就是"装这一个")
 *   → 广播信号 ghosts:install-requested;
 * - renderer(GlobalDropImportListener)在信号或自身挂载时调
 *   ghosts:take-pending-install 原子取走并消费 —— 冷启动双击时
 *   renderer 尚未挂载,pending 缓冲天然覆盖,不丢意图、不重复消费。
 *
 * 入口(与 deepLink / open-folder 的结构对齐):
 * - Windows 冷启动:文件路径在 process.argv(bootstrap 扫描);
 * - Windows 已运行:单例锁转 second-instance,路径在其 argv;
 * - macOS:Finder 经 CFBundleDocumentTypes 关联走 open-file 事件。
 */

const log = createLogger('ghosts:open-file');

let pendingCindyInstall: string | null = null;

/** renderer 原子取走待装路径(取即清空;无则 null)。IPC handler 消费。 */
export function takePendingCindyInstall(): string | null {
  const path = pendingCindyInstall;
  pendingCindyInstall = null;
  return path;
}

export async function handleIncomingCindyFile(filePath: string, source: string): Promise<void> {
  log.info('incoming .cindy file', { filePath, source });
  try {
    if (!(await fs.promises.stat(filePath)).isFile()) return;
  } catch {
    return; // 路径不存在 / 不可读 → 静默忽略(与 open-folder 的容错口径一致)
  }
  pendingCindyInstall = filePath;
  // 已运行的窗口立即收到信号;冷启动时没有窗口,renderer 挂载后主动来取。
  BrowserWindow.getAllWindows().forEach((window) => {
    if (window.isDestroyed()) return;
    window.webContents.send('ghosts:install-requested');
  });
}
