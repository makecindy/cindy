import type { TFunction } from 'i18next';

import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import {
  ghostInstallApprovalToken,
  type GhostManifest,
  type InstalledGhost,
} from '../../shared/ghost';
import { ghostInstallErrorKey } from './installErrorKey';

/**
 * 本地 .cindy 的统一一键安装／更新编排：inspect 验证真实包后直接交给 Main
 * 落位。文件选择、拖入和双击都是用户明确安装动作，不再追加插件权限确认层。
 * 同 id 已安装时转为原位更新；更新继续由 Main 延续当前启用状态。
 */

interface InstallFlowDeps {
  t: TFunction;
  /**
   * 打开插件页内的页签面板(面板收束后 tab 型插件的唯一宿主)。只在
   * 「tab 型插件安装后」消费:插件页原地开面板,其它入口
   * 导航到 /plugins?panel=<id>。不传 = 该入口不许诺"打开"。
   */
  openPluginPanel?: (ghostId: string) => void;
}

/** 安装事务失败统一走 toast。 */
async function showInstallError(error: unknown, deps: InstallFlowDeps): Promise<void> {
  const code = extractIpcError(error)?.code;
  toast.error(deps.t(ghostInstallErrorKey(code)));
}

/** 同 id 已装清单查询(sendSync,极小)。 */
function findInstalled(id: string): InstalledGhost | null {
  try {
    const { ghosts } = window.electronAPI.ghosts.listSync();
    return ghosts.find((g) => g.manifest.id === id) ?? null;
  } catch {
    return null;
  }
}

/** 原位更新；Main 负责校验包摘要并延续启用状态。 */
async function runUpdate(
  lizFilePath: string,
  packageSha256: string,
  installed: InstalledGhost,
  deps: InstallFlowDeps,
): Promise<void> {
  const { t } = deps;
  try {
    const { ghost } = await window.electronAPI.ghosts.update(lizFilePath, {
      expectedPackageSha256: packageSha256,
      expectedInstalledApproval: ghostInstallApprovalToken(installed.approval),
    });
    toast.success(
      t('settings.ghosts.toast.updated', {
        name: ghost.manifest.name,
        version: ghost.manifest.version,
      }),
    );
  } catch (err) {
    await showInstallError(err, deps);
  }
}

export async function installGhostFromFile(
  lizFilePath: string,
  deps: InstallFlowDeps,
): Promise<void> {
  const { t } = deps;

  // 1) 只验不装,拿身份卡;坏文件在这一步就被拒,不会产生安装副作用。
  let manifest: GhostManifest;
  let packageSha256: string;
  try {
    const inspected = await window.electronAPI.ghosts.inspect(lizFilePath);
    manifest = inspected.manifest;
    packageSha256 = inspected.packageSha256;
  } catch (err) {
    await showInstallError(err, deps);
    return;
  }

  // 1.5) 同 id 已装 → 转更新分支(拖入/双击/装入按钮选到新版包时不再报
  // "已经注入",直接原位更新)。
  const installed = findInstalled(manifest.id);
  if (installed) {
    await runUpdate(lizFilePath, packageSha256, installed, deps);
    return;
  }

  // 安装动作本身已经由用户通过文件选择／拖入／双击明确发起。安装后默认启用；
  // tab 型插件在入口能提供页面板宿主时直接打开。
  const willOpenPanel = manifest.panel?.position === 'tab' && deps.openPluginPanel !== undefined;
  try {
    const { ghost } = await window.electronAPI.ghosts.install(lizFilePath, {
      enable: true,
      expectedPackageSha256: packageSha256,
    });
    toast.success(t('settings.ghosts.toast.installed', { name: ghost.manifest.name }));
    if (willOpenPanel) {
      deps.openPluginPanel?.(ghost.manifest.id);
    }
  } catch (err) {
    await showInstallError(err, deps);
  }
}

/**
 * 单意识详情页的「更新版本…」:选文件 → 验身 → 必须与当前意识同 id
 * (选错别的意识的包直接拒,不做"顺手装成新意识"的隐式行为)→ 更新。
 */
export async function pickAndUpdateGhost(expectedId: string, deps: InstallFlowDeps): Promise<void> {
  const { t } = deps;
  const picked = await window.electronAPI.ghosts.pickFile().catch(() => null);
  if (!picked || 'canceled' in picked) return;

  let manifest: GhostManifest;
  let packageSha256: string;
  try {
    const inspected = await window.electronAPI.ghosts.inspect(picked.filePath);
    manifest = inspected.manifest;
    packageSha256 = inspected.packageSha256;
  } catch (err) {
    await showInstallError(err, deps);
    return;
  }
  if (manifest.id !== expectedId) {
    toast.error(
      t('settings.ghosts.errors.updateIdMismatch', { id: manifest.id, expected: expectedId }),
    );
    return;
  }
  const installed = findInstalled(expectedId);
  if (!installed) {
    // 详情页开着的意识刚被别处抽离——极端竞态,按通用错误提示。
    toast.error(t('settings.ghosts.errors.generic'));
    return;
  }
  await runUpdate(picked.filePath, packageSha256, installed, deps);
}
