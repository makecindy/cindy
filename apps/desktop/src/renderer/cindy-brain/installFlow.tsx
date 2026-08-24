import type { TFunction } from 'i18next';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

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
import {
  GhostInstallReview,
  GhostUpdateReview,
  type GhostAgentOriginInfo,
} from './GhostPermissionList';
import { assessGhostInstallRisk, type GhostRiskAssessment } from './ghostInstallRisk';
import { ghostInstallErrorKey } from './installErrorKey';
import { isAgentForgeOrigin, type GhostInstallOrigin } from '../../shared/ghostInstallOrigin';

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
 *
 * 「安装后立即生效」勾选框已删除(2026-08 产品拍板):它是弱信号——把决定权推给
 * 用户却不给判断依据。新装一律直接生效,高危插件改由**手输插件 id** 这道强确认
 * 把关;低危插件本就该直接可用。
 *
 * **来源分级加重**:装入由 Agent 单方面发起(`ghost_forge_pack` 转交,origin =
 * agent-forge)时,确认框展示来源横幅;高危档(skill/node/凭证/agent 后台/派活)
 * 额外要求用户手输插件 id 才能确认。手动入口(拖入/双击/设置页选文件)不加横幅、
 * 不加重——亲手选文件本身就是意图表达。判据见 ghostInstallRisk.assessGhostInstallRisk。
 */

const installFlowLog = createLogger('ghost-install-flow');

interface InstallFlowDeps {
  t: TFunction;
  /**
   * ui/confirm-dialog-provider 的 confirm(装入 / 更新 / 重新确认统一走它,无勾选)。
   * requireTypedConfirmation:高危 Agent 发起时要求手输插件 id 才解锁主按钮。
   */
  confirm: (options: {
    title: string;
    description?: string;
    content?: ReactNode;
    maxWidth?: number;
    confirmText?: string;
    cancelText?: string;
    requireTypedConfirmation?: { expected: string; label: string; placeholder?: string };
  }) => Promise<boolean>;
  /**
   * 打开插件页内的页签面板(面板收束后 tab 型插件的唯一宿主)。tab 型插件装入
   * 即生效后消费:插件页原地开面板,其它入口导航到 /plugins?panel=<id>。
   * 不传 = 该入口不许诺"打开"。
   */
  openPluginPanel?: (ghostId: string) => void;
}

/**
 * Agent 发起时构造来源横幅信息(手动入口返回 undefined → 不展示横幅)。
 * hazards 只含高危标记(skill/node/凭证);中危/低危不会点亮任何 callout。
 * hazardsFrom 决定"点破哪些":新装看全量清单,更新只看本次新增项。
 * allHosts = 插件(更新后)能出网的全部域名,凭证 callout 据此列出外发对象。
 */
function agentOriginInfoFrom(
  origin: GhostInstallOrigin | undefined,
  firstInstall: boolean,
  hazardsFrom: GhostRiskAssessment,
  allHosts: string[],
): GhostAgentOriginInfo | undefined {
  if (!isAgentForgeOrigin(origin)) return undefined;
  return {
    ...(origin.sessionTitle ? { sessionTitle: origin.sessionTitle } : {}),
    ...(origin.sourceRelPath ? { sourceRelPath: origin.sourceRelPath } : {}),
    firstInstall,
    hazards: {
      skill: hazardsFrom.hazards.skill,
      node: hazardsFrom.hazards.node,
      credential: hazardsFrom.hazards.secret && allHosts.length > 0,
    },
    credentialHosts: allHosts,
  };
}

/** 高危 Agent 发起时的「手输插件 id」闸参数(否则 undefined = 不加重)。 */
function typedIdConfirmation(
  t: TFunction,
  ghostId: string,
  required: boolean,
): { expected: string; label: string; placeholder?: string } | undefined {
  if (!required) return undefined;
  return {
    expected: ghostId,
    label: t('settings.ghosts.installConfirm.typedIdLabel', { id: ghostId }),
    placeholder: ghostId,
  };
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
  origin?: GhostInstallOrigin,
  packTicket?: string,
): Promise<void> {
  const { t, confirm } = deps;
  // 权限 diff:只把新增/移除的权限亮给用户,不变项折叠计数。
  const diff = diffInstalledGhostPermissionItems(installed, manifest);
  // Agent 发起的更新:新增项含高危/中危能力(tier !== 'low')即要求手输 id ——
  // 堵"注入者篡改作者正在开发的同 id 插件、借版本升级夹带权限"。横幅点破的
  // hazard 只看本次新增项(hazardsFrom = 新增),但凭证外发域名列出更新后的全量。
  const addedRisk = assessGhostInstallRisk(diff.added);
  const allHosts = assessGhostInstallRisk(ghostPermissionItems(manifest)).networkHosts;
  const agentOrigin = agentOriginInfoFrom(origin, false, addedRisk, allHosts);
  const escalate = isAgentForgeOrigin(origin) && addedRisk.tier !== 'low';
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
        agentOrigin={agentOrigin}
      />
    ),
    maxWidth: GHOST_CONFIRM_MAX_WIDTH,
    confirmText: t('settings.ghosts.updateConfirm.confirm'),
    cancelText: t('settings.ghosts.updateConfirm.cancel'),
    requireTypedConfirmation: typedIdConfirmation(t, manifest.id, escalate),
  });
  if (!ok) {
    if (packTicket) await window.electronAPI.ghosts.abandonPackTicket(packTicket);
    return;
  }
  try {
    const { ghost } = await window.electronAPI.ghosts.update(lizFilePath, {
      expectedPackageSha256: packageSha256,
      expectedInstalledApproval: ghostInstallApprovalToken(installed.approval),
      ...(packTicket ? { packTicket } : {}),
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
  /**
   * 主机侧填写的来源;缺省 = 手动(拖入/双击/设置页选文件),不加横幅、不加重。
   * agent-forge = Agent 单方面发起,展示来源横幅;高危档追加手输 id 闸。
   */
  origin?: GhostInstallOrigin,
): Promise<void> {
  const { t, confirm } = deps;

  // 1) 只验不装,拿身份卡;坏文件在这一步就被拒,不会弹确认。
  let manifest: GhostManifest;
  let trust: GhostTrustInfo;
  let packageSha256: string;
  let packTicket: string | undefined;
  try {
    const inspected = await window.electronAPI.ghosts.inspect(lizFilePath);
    manifest = inspected.manifest;
    trust = inspected.trust;
    packageSha256 = inspected.packageSha256;
    packTicket = inspected.packTicket;
  } catch (err) {
    toast.error(t(ghostInstallErrorKey(extractIpcError(err)?.code)));
    return;
  }

  // 1.5) 同 id 已装 → 转更新分支(拖入/双击/装入按钮选到新版包时不再报
  // "已经注入",直接给换版确认)。origin 透传:Agent 发起的更新也要能加重。
  const installed = findInstalled(manifest.id);
  if (installed) {
    await confirmAndRunUpdate(
      lizFilePath,
      manifest,
      trust,
      packageSha256,
      installed,
      deps,
      origin,
      packTicket,
    );
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
  // 新装一律直接生效(2026-08 拍板删「立即开启」勾选):高危靠手输 id 把关,低危
  // 本该直接可用。tab 型插件(panel.position:'tab')在入口能开面板时,生效后原地
  // 打开插件页面板;入口给不出面板宿主就不许诺"打开"。
  const willOpenPanel = manifest.panel?.position === 'tab' && deps.openPluginPanel !== undefined;
  // library 槽(持久作品库):装入确认里提供「存储位置」行——默认预选系统
  // 管理位置(不点更改 = 零额外步骤),点「更改…」由宿主弹原生选择器并做
  // 候选校验;装入成功后才落 binding(取消装入不留孤儿 binding)。
  const libraryChoice: { candidate: string | null; warnings: string[] } = {
    candidate: null,
    warnings: [],
  };
  const librarySlots = manifest.slots.includes('library');
  const items = ghostPermissionItems(manifest);
  const risk = assessGhostInstallRisk(items);
  // 新装是该 id 首次安装(installed 已在上面判空);Agent 发起才构造横幅。
  const agentOrigin = agentOriginInfoFrom(origin, true, risk, risk.networkHosts);
  // 高危 + Agent 发起 → 手输插件 id 才能确认(每个新插件 id 一生只打一次:
  // 第二次起走更新分支,权限没变只显示小框)。
  const requireTypedId = isAgentForgeOrigin(origin) && risk.tier === 'high';
  const ok = await confirm({
    title: t('settings.ghosts.installConfirm.title', { name: manifest.name }),
    content: (
      <GhostInstallReview
        description={manifest.description}
        meta={factsLine}
        trust={trust}
        items={items}
        manualCount={manifest.manual?.items.length ?? 0}
        extra={
          librarySlots ? (
            <LibraryInstallLocationRow ghostId={manifest.id} choice={libraryChoice} />
          ) : undefined
        }
        agentOrigin={agentOrigin}
      />
    ),
    maxWidth: GHOST_CONFIRM_MAX_WIDTH,
    confirmText: t('settings.ghosts.installConfirm.confirm'),
    cancelText: t('settings.ghosts.installConfirm.cancel'),
    requireTypedConfirmation: typedIdConfirmation(t, manifest.id, requireTypedId),
  });
  if (!ok) {
    if (packTicket) await window.electronAPI.ghosts.abandonPackTicket(packTicket);
    return;
  }

  // 2.5) 用户在确认框里选了自定义位置 → **装入前**先落 binding(keyed by
  // ghostId,与安装顺序无关):否则「立即开启」的常驻插件会在 install 返回
  // 前被拉起、以默认根开库(review:spawn 早于 bind)。装入失败会留一份无
  // 数据的 binding,行为等价「记住位置」,下次装同 id 直接用上。
  if (librarySlots && libraryChoice.candidate) {
    const bound = await window.electronAPI.ghosts.libraryBind(manifest.id, libraryChoice.candidate);
    if (!bound.ok) {
      toast.error(`${t('settings.ghosts.library.bindAfterInstallFailed')}:${bound.message ?? ''}`);
    } else if (bound.warnings && bound.warnings.length > 0) {
      toast.warning(t('settings.ghosts.library.cloudWarningToast'));
    }
  }

  // 3) 真装(main 侧同一主体:来源校验 + 落盘 + 停靠)。Node 高风险提示
  // 已在上面的权限清单里如实展示,不再有 Main 原生二次确认。装入即生效。
  try {
    const { ghost } = await window.electronAPI.ghosts.install(lizFilePath, {
      enable: true,
      expectedPackageSha256: packageSha256,
      ...(packTicket ? { packTicket } : {}),
    });
    toast.success(t('settings.ghosts.toast.installed', { name: ghost.manifest.name }));
    if (willOpenPanel) {
      // 进入插件页并打开该插件的页签面板。
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
export async function reapproveInstalledGhost(
  ghostId: string,
  deps: InstallFlowDeps,
): Promise<void> {
  const { t, confirm } = deps;
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
  // 「保持之前启用状态」不再做成勾选框(勾选框是弱信号)——它本质是"保持现状"
  // 而非"让用户选":之前主动停用的插件,恢复权限后不该被顺手点亮。改成一句如实
  // 说明(保持启用 / 保持沉睡),启用值直接取升级前偏好。
  const enable = previouslyEnabled;
  const ok = await confirm({
    title: t('settings.ghosts.reapproveConfirm.title', { name: manifest.name }),
    description: t('settings.ghosts.reapproveConfirm.body'),
    content: (
      <GhostInstallReview
        description={manifest.description}
        meta={factsLine}
        trust={trust}
        items={ghostPermissionItems(manifest)}
        enableNotice={t(
          previouslyEnabled
            ? 'settings.ghosts.reapproveConfirm.enableNoticeEnabled'
            : 'settings.ghosts.reapproveConfirm.enableNoticeAsleep',
        )}
      />
    ),
    maxWidth: GHOST_CONFIRM_MAX_WIDTH,
    confirmText: t('settings.ghosts.reapproveConfirm.confirm'),
    cancelText: t('settings.ghosts.installConfirm.cancel'),
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
  let packTicket: string | undefined;
  try {
    const inspected = await window.electronAPI.ghosts.inspect(picked.filePath);
    manifest = inspected.manifest;
    trust = inspected.trust;
    packageSha256 = inspected.packageSha256;
    packTicket = inspected.packTicket;
  } catch (err) {
    toast.error(t(ghostInstallErrorKey(extractIpcError(err)?.code)));
    return;
  }
  if (manifest.id !== expectedId) {
    if (packTicket) await window.electronAPI.ghosts.abandonPackTicket(packTicket);
    toast.error(
      t('settings.ghosts.errors.updateIdMismatch', { id: manifest.id, expected: expectedId }),
    );
    return;
  }
  const installed = findInstalled(expectedId);
  if (!installed) {
    if (packTicket) await window.electronAPI.ghosts.abandonPackTicket(packTicket);
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
    undefined,
    packTicket,
  );
}

/**
 * 装入确认框里的「存储位置」行(library 槽专用):默认预选系统管理位置,
 * 点「更改…」由宿主弹原生选择器(插件无权发起)并做候选校验(可写探针/
 * 受管根排斥/网络盘拒/云盘警告)。选择结果写回外层 choice 对象(ReactNode
 * content 与外层 async 流程之间的通信桥),装入成功后才落 binding。
 */
function LibraryInstallLocationRow({
  ghostId,
  choice,
}: {
  ghostId: string;
  choice: { candidate: string | null; warnings: string[] };
}): ReactNode {
  const { t } = useTranslation();
  const [candidate, setCandidate] = useState<string | null>(choice.candidate);
  const [warnings, setWarnings] = useState<string[]>(choice.warnings);
  const pick = async () => {
    const picked = await window.electronAPI.ghosts.libraryPickLocation(ghostId);
    if (!picked.ok) {
      if (!picked.cancelled) {
        toast.error(picked.message ?? t('settings.ghosts.library.pickFailed'));
      }
      return;
    }
    choice.candidate = picked.candidate ?? null;
    choice.warnings = picked.warnings ?? [];
    setCandidate(choice.candidate);
    setWarnings(choice.warnings);
  };
  return (
    <div className="rounded-xl border border-[var(--border-default)] bg-[var(--surface)] p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-13 font-medium leading-5 text-[var(--text-primary)]">
            {t('settings.ghosts.library.installLocationLabel')}
          </p>
          <p className="mt-0.5 break-all text-12 leading-[1.5] text-[var(--text-secondary)]">
            {candidate
              ? `${t('settings.ghosts.library.installLocationPickedPrefix')} ${candidate}`
              : t('settings.ghosts.library.installLocationDefault')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void pick()}
          className="shrink-0 rounded-lg text-13 font-medium text-[var(--accent)] transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        >
          {t('settings.ghosts.library.installLocationChange')}
        </button>
      </div>
      {warnings.map((warning) => (
        <p key={warning} className="mt-2 text-12 leading-[1.5] text-[var(--warning-fg)]">
          {warning}
        </p>
      ))}
    </div>
  );
}
