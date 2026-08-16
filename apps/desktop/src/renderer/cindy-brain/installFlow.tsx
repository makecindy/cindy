import type { TFunction } from 'i18next';
import type { ReactNode } from 'react';

import { createLogger } from '@/lib/logger';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import {
  diffInstalledGhostPermissionItems,
  ghostInstallApprovalToken,
  ghostPermissionItems,
  type GhostManifest,
  type GhostTrustInfo,
  type InstalledGhost,
} from '../../shared/ghost';
import { GhostInstallReview, GhostUpdateReview } from './GhostPermissionList';
import { ghostInstallErrorKey } from './installErrorKey';

/**
 * 装入/更新意识的统一编排:inspect(验明正身)→ Renderer 权限清单 →
 * install / update。Node 高风险条目在权限清单里如实展示
 * (2026-07-24 起不再有 Main 原生二次确认弹窗)。
 *
 * 「装意识前弹确认」是 README 定下的安全原则:确认框展示的是**意识自称的身份**
 * (名字/版本/形态/是否带面板),不是文件名 —— 文件名可以随便改,身份卡不会陪它演。
 * 设置页按钮 / 窗口拖入 / 双击 .cindy 三个入口共用本流程 —— 双击由 main 侧
 * 转交路径进来(main/cindy-brain/openFileInstall.ts,pending buffer +
 * GlobalDropImportListener 消费),确认弹窗永远是应用内这同一个。
 *
 * 确认框正文是逐项权限清单:由身份卡静态推导(ghostPermissionItems),
 * Cindy 代办按类目、工具逐个、指令/面板/可执行代码各一项,如实展示无黑话。
 *
 * 同 id 已装 → 自动转「更新」分支:确认框展示版本变化(vX → vY)+ 权限 diff
 * (只高亮新增/移除,不变项折叠计数),无"立即开启"勾选(更新延续当前唤醒
 * 状态,不偷偷点亮也不偷偷熄灯)。
 */

const installFlowLog = createLogger('ghost-install-flow');

interface InstallFlowDeps {
  t: TFunction;
  /** ui/confirm-dialog-provider 的 confirm(更新确认,无勾选)。 */
  confirm: (options: {
    title: string;
    description?: string;
    content?: ReactNode;
    maxWidth?: number;
    confirmText?: string;
    cancelText?: string;
  }) => Promise<boolean>;
  /** ui/confirm-dialog-provider 的 confirmWithCheckbox(装入确认 + "立即开启"勾选)。 */
  confirmWithCheckbox: (options: {
    title: string;
    description?: string;
    content?: ReactNode;
    maxWidth?: number;
    confirmText?: string;
    cancelText?: string;
    checkboxLabel: string;
    checkboxDefaultChecked?: boolean;
  }) => Promise<{ ok: boolean; checked: boolean }>;
  /**
   * 打开插件页内的页签面板(面板收束后 tab 型插件的唯一宿主)。只在
   * 「tab 型插件 + 勾选立即开启」时消费:插件页原地开面板,其它入口
   * 导航到 /plugins?panel=<id>。不传 = 该入口不许诺"打开"。
   */
  openPluginPanel?: (ghostId: string) => void;
}

/** 意识装入/更新确认框统一宽度:权限清单是富内容,默认 400px 折行到累。 */
const GHOST_CONFIRM_MAX_WIDTH = 520;

/** 同 id 已装清单查询(sendSync,极小)。 */
function findInstalled(id: string): InstalledGhost | null {
  try {
    const { ghosts } = window.electronAPI.ghosts.listSync();
    return ghosts.find((g) => g.manifest.id === id) ?? null;
  } catch {
    return null;
  }
}

/** 确认 + 原位更新(installed 是当前已装版本,manifest 是新文件的身份卡)。 */
async function confirmAndRunUpdate(
  lizFilePath: string,
  manifest: GhostManifest,
  trust: GhostTrustInfo,
  packageSha256: string,
  installed: InstalledGhost,
  deps: InstallFlowDeps,
): Promise<void> {
  const { t, confirm } = deps;
  // 权限 diff:只把新增/移除的权限亮给用户,不变项折叠计数。
  const diff = diffInstalledGhostPermissionItems(installed, manifest);
  const ok = await confirm({
    title: t('settings.ghosts.updateConfirm.title', { name: manifest.name }),
    description: t('settings.ghosts.updateConfirm.body', {
      from: installed.manifest.version,
      to: manifest.version,
    }),
    content: (
      <GhostUpdateReview
        trust={trust}
        diff={diff}
        manualCount={manifest.manual?.items.length ?? 0}
      />
    ),
    maxWidth: GHOST_CONFIRM_MAX_WIDTH,
    confirmText: t('settings.ghosts.updateConfirm.confirm'),
    cancelText: t('settings.ghosts.updateConfirm.cancel'),
  });
  if (!ok) return;
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
    toast.error(t(ghostInstallErrorKey(extractIpcError(err)?.code)));
  }
}

export async function confirmAndInstallGhost(
  lizFilePath: string,
  deps: InstallFlowDeps,
): Promise<void> {
  const { t, confirmWithCheckbox } = deps;

  // 1) 只验不装,拿身份卡;坏文件在这一步就被拒,不会弹确认。
  let manifest: GhostManifest;
  let trust: GhostTrustInfo;
  let packageSha256: string;
  try {
    const inspected = await window.electronAPI.ghosts.inspect(lizFilePath);
    manifest = inspected.manifest;
    trust = inspected.trust;
    packageSha256 = inspected.packageSha256;
  } catch (err) {
    toast.error(t(ghostInstallErrorKey(extractIpcError(err)?.code)));
    return;
  }

  // 1.5) 同 id 已装 → 转更新分支(拖入/双击/装入按钮选到新版包时不再报
  // "已经注入",直接给换版确认)。
  const installed = findInstalled(manifest.id);
  if (installed) {
    await confirmAndRunUpdate(lizFilePath, manifest, trust, packageSha256, installed, deps);
    return;
  }

  // 2) 确认弹窗:自我介绍、作者/版本、权限清单分层展示。
  // 作者自由填写的工具长说明默认折叠;敏感权限仍直接展示。详情区限高滚动,
  // 不再让内容把整个弹窗撑出屏幕。
  // 身份卡自称的作者也如实展示(有才显示,避免"作者 ·"空段)。
  const factsLine = manifest.author
    ? t('settings.ghosts.installConfirm.metaWithAuthor', {
        author: manifest.author,
        version: manifest.version,
      })
    : t('settings.ghosts.installConfirm.meta', { version: manifest.version });
  // "立即开启"勾选(2026-07-25 Lizi 定案,改自 2026-07-09 的默认不勾):
  // 默认勾选 = 装入即带电;用户显式取消勾选才装成沉睡。确认弹窗本身
  // 仍是授权边界 —— 权限清单如实展示,点"装入"即同意运行。
  // tab 型插件(panel.position:'tab')在入口能打开插件页面板时,勾选语义
  // 升级为「立即开启并打开面板」——面板收束后页签面板只住在插件页,
  // 不再创建右侧栏 ghost 页签;入口给不出面板宿主就不许诺"打开"。
  const willOpenPanel = manifest.panel?.position === 'tab' && deps.openPluginPanel !== undefined;
  const { ok, checked: enable } = await confirmWithCheckbox({
    title: t('settings.ghosts.installConfirm.title', { name: manifest.name }),
    content: (
      <GhostInstallReview
        description={manifest.description}
        meta={factsLine}
        trust={trust}
        items={ghostPermissionItems(manifest)}
        manualCount={manifest.manual?.items.length ?? 0}
      />
    ),
    maxWidth: GHOST_CONFIRM_MAX_WIDTH,
    confirmText: t('settings.ghosts.installConfirm.confirm'),
    cancelText: t('settings.ghosts.installConfirm.cancel'),
    checkboxLabel: t(
      willOpenPanel
        ? 'settings.ghosts.installConfirm.enableNowOpenPanel'
        : 'settings.ghosts.installConfirm.enableNow',
    ),
    checkboxDefaultChecked: true,
  });
  if (!ok) return;

  // 3) 真装(main 侧同一主体:来源校验 + 落盘 + 停靠)。Node 高风险提示
  // 已在上面的权限清单里如实展示,不再有 Main 原生二次确认。
  try {
    const { ghost } = await window.electronAPI.ghosts.install(lizFilePath, {
      enable,
      expectedPackageSha256: packageSha256,
    });
    toast.success(
      enable
        ? t('settings.ghosts.toast.installed', { name: ghost.manifest.name })
        : t('settings.ghosts.toast.installedAsleep', { name: ghost.manifest.name }),
    );
    if (enable && willOpenPanel) {
      // 兑现勾选文案:进入插件页并打开该插件的页签面板。
      deps.openPluginPanel?.(ghost.manifest.id);
    }
  } catch (err) {
    toast.error(t(ghostInstallErrorKey(extractIpcError(err)?.code)));
  }
}

/**
 * 「重新确认权限」的本地包路线:**从已装目录**读出全量权限清单 → 确认 → 开 receipt。
 * 不用用户翻出原始 `.cindy` 文件(#1243 验收:本地包不存在不可恢复状态)。
 *
 * 授权边界仍是这张确认卡:无批准基线,权限**全量**按新增项展示(GhostInstallReview),
 * 与"重新选包"路线看到的是同一张卡,差别只是字节从安装目录读。清单字节以
 * manifestSha256 绑定到 confirm(确认间隙 ghost.json 被换 → main 拒 state-changed)。
 *
 * 安装目录读不出/清单不合法时回退到「重新选包」路线 —— 目录坏了才需要用户找文件,
 * 目录完好时一次点击即恢复。
 */
export async function reapproveInstalledGhost(ghostId: string, deps: InstallFlowDeps): Promise<void> {
  const { t, confirmWithCheckbox } = deps;
  const installed = findInstalled(ghostId);
  if (!installed) {
    toast.error(t('settings.ghosts.errors.generic'));
    return;
  }
  let manifest: GhostManifest;
  let trust: GhostTrustInfo;
  let manifestSha256: string;
  let approvalProjectionSha256: string;
  let previouslyEnabled: boolean;
  let inspectTicket: string;
  try {
    const inspected = await window.electronAPI.ghosts.reapproveInspect(ghostId);
    manifest = inspected.manifest;
    trust = inspected.trust;
    manifestSha256 = inspected.manifestSha256;
    approvalProjectionSha256 = inspected.approvalProjectionSha256;
    previouslyEnabled = inspected.previouslyEnabled;
    inspectTicket = inspected.inspectTicket;
  } catch (err) {
    // 安装目录读不出清单 = 只剩"重新选包"一条路;如实降级,不吞掉恢复机会。
    installFlowLog.warn('reapprove-inspect failed; falling back to file picker', {
      ghostId,
      err,
    });
    await pickAndUpdateGhost(ghostId, deps);
    return;
  }
  const factsLine = manifest.author
    ? t('settings.ghosts.installConfirm.metaWithAuthor', {
        author: manifest.author,
        version: manifest.version,
      })
    : t('settings.ghosts.installConfirm.meta', { version: manifest.version });
  const { ok, checked: enable } = await confirmWithCheckbox({
    title: t('settings.ghosts.reapproveConfirm.title', { name: manifest.name }),
    description: t('settings.ghosts.reapproveConfirm.body'),
    content: (
      <GhostInstallReview
        description={manifest.description}
        meta={factsLine}
        trust={trust}
        items={ghostPermissionItems(manifest)}
      />
    ),
    maxWidth: GHOST_CONFIRM_MAX_WIDTH,
    confirmText: t('settings.ghosts.reapproveConfirm.confirm'),
    cancelText: t('settings.ghosts.installConfirm.cancel'),
    checkboxLabel: t('settings.ghosts.installConfirm.enableNow'),
    // 默认值取用户升级前的启停偏好(.disabled 镜像):恢复权限 ≠ 替用户把停用的
    // 插件重新点亮。
    checkboxDefaultChecked: previouslyEnabled,
  });
  if (!ok) return;
  try {
    const { ghost } = await window.electronAPI.ghosts.reapproveInstalled(ghostId, {
      enable,
      expectedManifestSha256: manifestSha256,
      expectedApprovalProjectionSha256: approvalProjectionSha256,
      expectedInstalledApproval: ghostInstallApprovalToken(installed.approval),
      inspectTicket,
    });
    toast.success(t('settings.ghosts.toast.reapproved', { name: ghost.manifest.name }));
  } catch (err) {
    toast.error(t(ghostInstallErrorKey(extractIpcError(err)?.code)));
  }
}

/**
 * 单意识详情页的「更新版本…」:选文件 → 验身 → 必须与当前意识同 id
 * (选错别的意识的包直接拒,不做"顺手装成新意识"的隐式行为)→ 确认 → 更新。
 */
export async function pickAndUpdateGhost(expectedId: string, deps: InstallFlowDeps): Promise<void> {
  const { t } = deps;
  const picked = await window.electronAPI.ghosts.pickFile().catch(() => null);
  if (!picked || 'canceled' in picked) return;

  let manifest: GhostManifest;
  let trust: GhostTrustInfo;
  let packageSha256: string;
  try {
    const inspected = await window.electronAPI.ghosts.inspect(picked.filePath);
    manifest = inspected.manifest;
    trust = inspected.trust;
    packageSha256 = inspected.packageSha256;
  } catch (err) {
    toast.error(t(ghostInstallErrorKey(extractIpcError(err)?.code)));
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
  await confirmAndRunUpdate(
    picked.filePath,
    manifest,
    trust,
    packageSha256,
    installed,
    deps,
  );
}
