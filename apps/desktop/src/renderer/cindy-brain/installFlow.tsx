import type { TFunction } from 'i18next';
import type { ReactNode } from 'react';

import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import {
  diffGhostPermissionItems,
  ghostPermissionItems,
  type GhostManifest,
  type GhostTrustInfo,
  type InstalledGhost,
} from '../../shared/ghost';
import {
  GhostInstallReview,
  GhostPermissionDiffView,
  GhostTrustSummary,
} from './GhostPermissionList';
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
  }) => Promise<{ ok: boolean; checked: boolean }>;
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
  const diff = diffGhostPermissionItems(installed.manifest, manifest);
  const ok = await confirm({
    title: t('settings.ghosts.updateConfirm.title', { name: manifest.name }),
    description: t('settings.ghosts.updateConfirm.body', {
      from: installed.manifest.version,
      to: manifest.version,
    }),
    content: (
      <div>
        <GhostTrustSummary trust={trust} />
        <div className="mt-3">
          <GhostPermissionDiffView diff={diff} />
        </div>
      </div>
    ),
    maxWidth: GHOST_CONFIRM_MAX_WIDTH,
    confirmText: t('settings.ghosts.updateConfirm.confirm'),
    cancelText: t('settings.ghosts.updateConfirm.cancel'),
  });
  if (!ok) return;
  try {
    const { ghost } = await window.electronAPI.ghosts.update(lizFilePath, {
      expectedPackageSha256: packageSha256,
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
  // "立即开启"勾选(2026-07-09 Lizi 定案):默认不勾 = 装入即沉睡,
  // 用户显式勾选才带电。装入 ≠ 授权运行。
  const { ok, checked: enable } = await confirmWithCheckbox({
    title: t('settings.ghosts.installConfirm.title', { name: manifest.name }),
    content: (
      <GhostInstallReview
        description={manifest.description}
        meta={factsLine}
        trust={trust}
        items={ghostPermissionItems(manifest)}
      />
    ),
    maxWidth: GHOST_CONFIRM_MAX_WIDTH,
    confirmText: t('settings.ghosts.installConfirm.confirm'),
    cancelText: t('settings.ghosts.installConfirm.cancel'),
    checkboxLabel: t('settings.ghosts.installConfirm.enableNow'),
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
