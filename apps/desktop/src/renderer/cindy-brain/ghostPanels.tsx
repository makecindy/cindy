import { useEffect, useState, type ReactNode } from 'react';

import { ghostPanelKind, type GhostManifest, type InstalledGhost } from '../../shared/ghost';
import { usePanelWidth } from '../layout/paneWidths';
import { PanelChrome } from '../panels/PanelChrome';
import { registerPanelKind, unregisterPanelKind, type PanelComponentProps } from '../panels/registry';
import { GhostChipPanelBody, GhostPanelError } from './ghostPanelBody';
import { syncGhostTabRegistrations } from './ghostTabPlugins';
import { pruneGhostSettingsSnapshots } from './ghostSettingsSnapshot';
import { useGhostRuntimeState } from './runtimeStates';

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
 * 与右侧栏页签形态(position:'tab',ghostTabPlugins.tsx)共用;本模块只管
 * 停靠形态(left / right)与两个注册表的同步入口。
 */

// 兼容既有导入点(测试等):粗筛纯函数随面板体一起搬家,原路径继续可用。
export { pickGhostPanelMediaUri } from './ghostPanelBody';

/** 意识面板宿主:标准头(PanelChrome)+ 沙箱自绘面板体(崩溃时错误接管)。 */
function GhostPanel({
  manifest,
}: PanelComponentProps & { manifest: GhostManifest }): ReactNode {
  const kind = ghostPanelKind(manifest.id);
  // 宽度由引擎下发(fraction × 可用宽,缝把手可拖);兜底用清单 minWidth。
  const width = usePanelWidth(kind) ?? manifest.panel?.minWidth ?? 300;
  // 沙箱崩了 → 面板原地进入错误接管态。
  const runtimeState = useGhostRuntimeState(manifest.id);
  const broken = runtimeState === 'crashed' || runtimeState === 'fused';
  return (
    <section
      data-panel-drag-root={kind}
      // 侧边分割线由布局引擎统一绘制(LayoutRoot layout-divider),面板不自画。
      className="flex h-full shrink-0 flex-col overflow-hidden bg-[var(--panel-bg)]"
      style={{ width }}
    >
      <PanelChrome title={manifest.panel?.title ?? manifest.name} />
      {broken ? (
        <GhostPanelError manifest={manifest} state={runtimeState} />
      ) : (
        <GhostChipPanelBody manifest={manifest} />
      )}
    </section>
  );
}

/** 已注册意识面板:kind → 清单指纹(内容没变就不重注册,避免组件身份变化触发无谓重挂载)。 */
const registeredFingerprints = new Map<string, string>();

/**
 * 把注册表与"当前已装清单"对齐:新装的注册、卸下的注销、没变的不动。
 * 停用(enabled=false)的意识视同不在场 —— 面板注销、布局里 pane 隐藏休眠,
 * 重新启用时走同一条对齐路径复活(与"卸下再重装"共用 §6 规则 5 语义)。
 * position:'tab' 的面板不进本注册表,分派给右侧栏页签注册表(ghostTabPlugins);
 * 换版改 position 时,两边的差集注销各自兜住旧形态。
 */
export function syncGhostPanelRegistrations(ghosts: InstalledGhost[]): void {
  // 顺手清设置区快照缓存的孤儿(卸载的意识不该在 localStorage 留位图);
  // 本函数是"已装清单"的唯一同步点(启动 + ghosts:changed),挂这里最省。
  // 注意用全量清单(含沉睡)——沉睡只是不注册面板,快照仍然有效。
  pruneGhostSettingsSnapshots(ghosts.map((g) => g.manifest.id));
  // 页签形态与停靠形态同源同步:一次广播喂两个注册表,不各自订阅。
  syncGhostTabRegistrations(ghosts);
  const seen = new Set<string>();
  for (const { manifest, enabled } of ghosts) {
    if (!manifest.panel) continue; // 无面板的意识(未来纯工具卡)不进注册表
    if (manifest.panel.position === 'tab') continue; // 页签形态归右侧栏注册表
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
