import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { ghostPanelKind, type GhostManifest, type InstalledGhost } from '../../shared/ghost';
import { minimizeGhostPanel, reconcileGhostPanelBubbles } from '../lib/ghostPanelBubbleState';
import { toast } from '../lib/toast';
import { usePanelMaximize } from '../layout/panelMaximize';
import { usePaneAtWindowTop, usePaneFill } from '../layout/panePlacement';
import { usePanelWidth } from '../layout/paneWidths';
import { PanelChrome } from '../panels/PanelChrome';
import {
  registerPanelKind,
  unregisterPanelKind,
  type PanelComponentProps,
} from '../panels/registry';
import { extractIpcError } from '../utils/ipcError';
import { GhostChipPanelBody, GhostPanelError } from './ghostPanelBody';
import { ghostInstallErrorKey } from './installErrorKey';
import { pruneGhostSettingsSnapshots } from './ghostSettingsSnapshot';
import { useGhostRuntimeState } from './runtimeStates';
import { getDataOwnerGeneration } from '../contexts/dataOwnerGeneration';

/**
 * 意识面板接入布局引擎。
 *
 * 数据流(布局与沙箱边界见 docs/dev-rules/architecture-invariants.md / docs/dev-rules/plugin-security-and-authoring.md):
 * - 启动:LayoutRoot 首帧前 ensureGhostPanelsRegistered() 同步拉已装清单
 *   (sendSync)→ 声明了面板的意识逐个注册进面板注册表 —— 与内置面板同帧
 *   就位,布局第一帧即完整(设计规范规则 7);
 * - 装入:main 侧装好后广播 ghosts:changed → 注册新面板 + 触发重渲;
 *   面板停靠(树里加 pane)由 main 侧随 install 完成,走 layout:changed 热更新;
 * - 卸下:广播里不见了的 kind 注销 → 布局树里它的 pane 按"未安装意识"隐藏,
 *   树数据保留,重装即原位复活(§6 规则 5 的正式生效点)。
 *
 * 面板体(webview 供片/主题注入/崩溃接管/媒体右键)在 ghostPanelBody.tsx,
 * 与插件页页签形态(position:'tab',features/plugin/GhostPagePanelHost)共用;本模块只管
 * 停靠形态(left / right)与两个注册表的同步入口。
 */

// 兼容既有导入点(测试等):粗筛纯函数随面板体一起搬家,原路径继续可用。
export { pickGhostPanelMediaUri } from './ghostPanelBody';

/**
 * 停靠面板入场动画的"启动首屏豁免窗":凡是这个时刻之后才挂载的 GhostPanel
 * (点气泡展开、独立窗合并回来、装入、启用)都播宽度展开(ghost-panel-enter,
 * 见 globals.css),不再"先占宽再出现"(2026-07-25 Lizi:出现要丝滑);
 * 启动首屏全家同帧就位,不各展各的——本模块在 LayoutRoot 首帧前装载
 * (ensureGhostPanelsRegistered 走 sendSync),首屏挂载与模块装载几乎同刻,
 * 1.5s 窗口足够宽;极端慢启动多播一次展开也无害。
 */
const PANEL_ENTER_ARMED_AT = Date.now() + 1500;
/** 最小化折叠动画时长:与 globals.css 的 ghost-panel-collapse 对齐,
 *  到点才真正提交 minimized(随后气泡侧再等 300ms 入场,接力不抢戏)。 */
const PANEL_EXIT_MS = 180;

/** 意识面板宿主:标准头(PanelChrome)+ 沙箱自绘面板体(崩溃时错误接管)。 */
function GhostPanel({ manifest }: PanelComponentProps & { manifest: GhostManifest }): ReactNode {
  const kind = ghostPanelKind(manifest.id);
  const fillContainer = usePaneFill();
  const atWindowTop = usePaneAtWindowTop();
  // 宽度由引擎下发(fraction × 可用宽,缝把手可拖);兜底用清单 minWidth。
  const width = usePanelWidth(kind) ?? manifest.panel?.minWidth ?? 300;
  // 撑满态(引擎视图态):固定宽让位给 flex-1,树上的 fraction 账本不动。
  const maximize = usePanelMaximize();
  const isMaximized = maximize?.maximizedKind === kind;
  // 标准头系统按钮:身份卡可逐个关闭(panel.systemButtons.<键>:false);
  // 关闭 = 不把对应入参交给标准头,按钮不长出(标题条本体恒在)。
  const maximizeEnabled = manifest.panel?.systemButtons?.maximize !== false;
  const detachEnabled = manifest.panel?.systemButtons?.detach !== false;
  const minimizeEnabled = manifest.panel?.systemButtons?.minimize !== false;
  // 换版更新把按钮关掉时,若面板正撑满,自动还原 —— 否则按钮没了、态出不去。
  useEffect(() => {
    if (!maximizeEnabled && isMaximized) maximize?.toggle(kind);
  }, [maximizeEnabled, isMaximized, maximize, kind]);
  // 沙箱崩了 → 面板原地进入错误接管态。
  const runtimeState = useGhostRuntimeState(manifest.id);
  const broken = runtimeState === 'crashed' || runtimeState === 'fused';
  // 挂载即定(useState 初始化跑一次):启动首屏后出现的面板播宽度展开。
  const [enter] = useState(() => Date.now() >= PANEL_ENTER_ARMED_AT);
  // 点最小化 → 先播宽度折叠(closing),计时器到点才真正提交 minimized;
  // 减弱动效直接提交;撑满态是 flex-1(宽度动画不生效),也直接提交,
  // LayoutRoot 的可见性 effect 会顺手清撑满。
  const [closing, setClosing] = useState(false);
  const closeTimerRef = useRef(0);
  useEffect(() => () => window.clearTimeout(closeTimerRef.current), []);
  const beginMinimize = (): void => {
    if (closing) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    if (reduced || isMaximized) {
      minimizeGhostPanel(manifest.id);
      return;
    }
    setClosing(true);
    closeTimerRef.current = window.setTimeout(() => minimizeGhostPanel(manifest.id), PANEL_EXIT_MS);
  };
  // 标准头「关闭」= 二次确认后停用整个插件(setEnabled false):面板、工具、
  // 沙箱一并休眠,与插件页全局开关同一条链路(ghosts:changed 广播回来时
  // 本面板经 syncGhostPanelRegistrations 注销,无需自己收尾)。恒在,不受
  // 身份卡 systemButtons 控制——它是宿主给用户的退路,不是作者可关的能力。
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const beginClose = async (): Promise<void> => {
    const approved = await confirm({
      title: t('ghostPanel.disableConfirm.title', { name: manifest.name }),
      description: t('ghostPanel.disableConfirm.body'),
      confirmText: t('ghostPanel.disableConfirm.confirm'),
    });
    if (!approved) return;
    try {
      await window.electronAPI?.ghosts?.setEnabled(manifest.id, false);
    } catch (error) {
      toast.error(t(ghostInstallErrorKey(extractIpcError(error)?.code)));
    }
  };
  return (
    // 外层壳管布局占宽(出现/收起的宽度动画只动这层),内层 section 恒为
    // 实宽被裁切——展开像"拉开抽屉"露出成形的面板,webview 不逐帧改宽。
    <div
      className={
        isMaximized
          ? 'flex h-full min-w-0 flex-1'
          : fillContainer
            ? 'flex h-full min-h-0 min-w-0 flex-1 overflow-hidden'
            : `h-full shrink-0 overflow-hidden${enter ? ' ghost-panel-enter' : ''}${
                closing ? ' ghost-panel-exit' : ''
              }`
      }
      style={isMaximized || fillContainer ? undefined : { width }}
    >
      <section
        data-panel-drag-root={kind}
        // 侧边分割线由布局引擎统一绘制(LayoutRoot layout-divider),面板不自画。
        className={
          isMaximized || fillContainer
            ? 'flex h-full w-full min-w-0 flex-col overflow-hidden bg-[var(--panel-bg)]'
            : 'flex h-full shrink-0 flex-col overflow-hidden bg-[var(--panel-bg)]'
        }
        style={isMaximized || fillContainer ? undefined : { width }}
      >
        <PanelChrome
          title={manifest.panel?.title ?? manifest.name}
          showWindowSpacer={atWindowTop}
          panelKind={maximizeEnabled ? kind : undefined}
          onMinimize={minimizeEnabled ? beginMinimize : undefined}
          onDetach={
            detachEnabled
              ? () => void window.electronAPI?.ghostPanelWindow?.setDetached(manifest.id, true)
              : undefined
          }
          onClose={() => void beginClose()}
        />
        {broken ? (
          <GhostPanelError manifest={manifest} state={runtimeState} />
        ) : (
          <GhostChipPanelBody manifest={manifest} />
        )}
      </section>
    </div>
  );
}

/** 已注册意识面板:kind → 清单指纹(内容没变就不重注册,避免组件身份变化触发无谓重挂载)。 */
const registeredFingerprints = new Map<string, string>();

/**
 * 把注册表与"当前已装清单"对齐:新装的注册、卸下的注销、没变的不动。
 * 停用(enabled=false)的意识视同不在场 —— 面板注销、布局里 pane 隐藏休眠,
 * 重新启用时走同一条对齐路径复活(与"卸下再重装"共用 §6 规则 5 语义)。
 * position:'tab' 的面板不进任何常驻注册表(面板收束,2026-08):由插件页
 * 独占承载(features/plugin/GhostPagePanelHost),离开插件页即卸载。
 */
export function syncGhostPanelRegistrations(ghosts: InstalledGhost[]): void {
  // 顺手清设置区快照缓存的孤儿(卸载的意识不该在 localStorage 留位图);
  // 本函数是"已装清单"的唯一同步点(启动 + ghosts:changed),挂这里最省。
  // 注意用全量清单(含沉睡)——沉睡只是不注册面板,快照仍然有效。
  pruneGhostSettingsSnapshots(
    getDataOwnerGeneration().dataOwnerId,
    ghosts.map((g) => g.manifest.id),
  );
  // 气泡状态对齐(与快照 prune 不同:停用/失格的要强制还原,不只清卸载)——
  // 气泡是"面板不可见 + 唯一恢复入口",失格后必须回停靠,不留死角。
  reconcileGhostPanelBubbles(ghosts);
  const seen = new Set<string>();
  for (const { manifest, enabled } of ghosts) {
    if (!manifest.panel) continue; // 无面板的意识(未来纯工具卡)不进注册表
    if (manifest.panel.position === 'tab') continue; // 页签形态由插件页承载(面板收束)
    if (enabled === false) continue; // 停用 = 休眠,不注册(注销走下方 seen 差集)
    const kind = ghostPanelKind(manifest.id);
    seen.add(kind);
    const fingerprint = JSON.stringify(manifest);
    if (registeredFingerprints.get(kind) === fingerprint) continue;
    registeredFingerprints.set(kind, fingerprint);
    const Component = (props: PanelComponentProps): ReactNode => (
      <GhostPanel {...props} manifest={manifest} />
    );
    registerPanelKind({ kind, Component, collapseMemory: 'global' });
  }
  for (const kind of [...registeredFingerprints.keys()]) {
    if (seen.has(kind)) continue;
    registeredFingerprints.delete(kind);
    unregisterPanelKind(kind);
  }
}

let initialSynced = false;

/**
 * 首帧前的一次性同步注册(幂等)。由 LayoutRoot 在渲染体内调用 —— 必须发生在
 * 引擎第一次查注册表之前,意识面板才能与内置面板同帧出现(规则 7 无跳变)。
 */
export function ensureGhostPanelsRegistered(): void {
  if (initialSynced) return;
  initialSynced = true;
  // 测试/无桥环境(如 LayoutRoot 单测只 stub 了 layout)没有 ghosts 桥:
  // 视同"没装任何意识",不是错误。
  const api = window.electronAPI?.ghosts;
  if (!api) return;
  syncGhostPanelRegistrations(api.listSync().ghosts);
}

/**
 * 订阅装/卸广播:同步注册表 + 触发一次重渲(卸下不改布局树,没有 layout:changed
 * 可搭,必须自己 bump 才能让引擎重新按注册表过滤在场面板)。
 * 返回同步版本号 —— 注册表是模块级 Map,不在 React 数据流里,依赖"注册表
 * 内容"的 effect(如 LayoutRoot 布局自愈)把版本号放进 deps 才能感知变化。
 */
export function useGhostPanelsSync(): number {
  const [version, bump] = useState(0);
  useEffect(() => {
    const api = window.electronAPI?.ghosts;
    if (!api) return;
    return api.onChanged(({ ghosts }) => {
      syncGhostPanelRegistrations(ghosts);
      bump((v) => v + 1);
    });
  }, []);
  return version;
}

/** 仅测试用:允许用例重复走首帧注册路径。 */
export function __resetGhostPanelsForTest(): void {
  initialSynced = false;
  registeredFingerprints.clear();
}
