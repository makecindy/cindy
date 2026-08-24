import fs from 'node:fs';

import { BrowserWindow } from 'electron';

import { createLogger } from '../logger.js';
import {
  MANUAL_GHOST_INSTALL_ORIGIN,
  type GhostInstallOrigin,
} from '../../shared/ghostInstallOrigin.js';

/**
 * 双击 .cindy 文件的转交通道。
 *
 * 主进程**不在这里装、也不在这里弹窗**:三个装入入口(设置页 / 拖入 / 双击)
 * 统一走 renderer 的同一套编排(installFlow:inspect 验明正身 → 应用内确认
 * 弹窗 → install),双击只是把文件路径递进去 —— 用户看到的确认框永远是同
 * 一个。
 *
 * 转交模型(对齐 deepLink 的 pending buffer 成熟套路):
 * - 收到路径与来源 → 一起存入 pending(仅保留最新一条;双击语义上就是"装这一个")
 *   → 广播信号 ghosts:install-requested(**纯通知,不带事实**);
 * - renderer(GlobalDropImportListener)在信号或自身挂载时调
 *   ghosts:take-pending-install 原子取走并消费 —— 冷启动双击时
 *   renderer 尚未挂载,pending 缓冲天然覆盖,不丢意图、不重复消费。
 *
 * **来源标记(origin)**:装入确认框要区分"用户亲手发起"和"Agent 单方面发起"
 * (`ghost_forge_pack` 转交)。来源是主机侧结论,绝不能走 agent 可控通道 ——
 * 它由本模块填写,agent 只能触发转交、碰不到这个值。
 *
 * **origin 必须与路径同存同取,不能只挂在广播 payload 上。** 广播是易失通道:
 * macOS 关窗后应用不退出,scheduler 拉起的 agent 照样能调 `ghost_forge_pack`,
 * 此时没有任何窗口接收广播,而路径仍在缓冲里等着 renderer 挂载后自取 ——
 * 若 origin 只在 payload 里,这一取就把它丢了,Agent 发起的装入会被显示成手动,
 * 来源横幅与手输 id 全部失效。**丢失方向恰好是最危险的那个**,所以两者绑在一起。
 *
 * 入口(与 deepLink / open-folder 的结构对齐):
 * - Windows 冷启动:文件路径在 process.argv(bootstrap 扫描);
 * - Windows 已运行:单例锁转 second-instance,路径在其 argv;
 * - macOS:Finder 经 CFBundleDocumentTypes 关联走 open-file 事件;
 * - Agent:`ghost_forge_pack` 打包成功后经本通道转交(source='ghost-forge',
 *   带 agent-forge origin)。
 */

const log = createLogger('ghosts:open-file');

let pendingCindyInstall: { filePath: string; origin: GhostInstallOrigin } | null = null;

/**
 * renderer 原子取走待装路径与来源(取即清空;无则 null)。IPC handler 消费。
 *
 * 来源与路径**必须一起存、一起取**:两者存在不同强度的通道里就会丢。
 * 反例(已修):把 origin 只挂在 `ghosts:install-requested` 广播 payload 上时,
 * macOS 关窗后应用不退出,scheduler 拉起的 agent 照样能调 `ghost_forge_pack`——
 * 此刻 `getAllWindows()` 为空,广播无人接收,路径仍留在缓冲里;用户之后开窗,
 * renderer 挂载自取,origin 已经丢了 → Agent 发起的装入被显示成手动,
 * 红色来源横幅与手输 id 全部失效。**恰好是最危险的丢失方向。**
 */
export function takePendingCindyInstall(): { filePath: string; origin: GhostInstallOrigin } | null {
  const pending = pendingCindyInstall;
  pendingCindyInstall = null;
  return pending;
}

export async function handleIncomingCindyFile(
  filePath: string,
  source: string,
  /**
   * 主机侧填写的来源标记;缺省 = 手动入口(双击 / open-file)。只有 forge 转交
   * 路径会传 agent-forge origin。绝不接受来自 agent 或 renderer 的值。
   */
  origin: GhostInstallOrigin = MANUAL_GHOST_INSTALL_ORIGIN,
): Promise<void> {
  log.info('incoming .cindy file', { filePath, source, originKind: origin.kind });
  try {
    if (!(await fs.promises.stat(filePath)).isFile()) return;
  } catch {
    return; // 路径不存在 / 不可读 → 静默忽略(与 open-folder 的容错口径一致)
  }
  pendingCindyInstall = { filePath, origin };
  // 广播只是"来取货"的通知,不携带任何事实:唯一真相是上面那个缓冲,
  // renderer 一律经 ghosts:take-pending-install 取路径与来源。没有窗口时
  // (冷启动 / macOS 关窗后应用仍在跑)广播丢掉也不影响正确性。
  BrowserWindow.getAllWindows().forEach((window) => {
    if (window.isDestroyed()) return;
    window.webContents.send('ghosts:install-requested');
  });
}
