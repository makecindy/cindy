import type { ReactNode } from 'react';
import { Puzzle } from 'lucide-react';

import { ghostPanelKind, type GhostManifest, type InstalledGhost } from '../../shared/ghost';
import { registerTabKind, unregisterTabKind } from '../features/right-sidebar/registry';
import { pruneGhostTabPins } from '../features/right-sidebar/lib/pinnedGhostTabs';
import type { TabKindId, TabKindPlugin } from '../features/right-sidebar/types';
import { GhostPanelError } from './ghostPanelBody';
import { ghostPanelFingerprint, ghostPanelWebviewPool } from './ghostPanelWebviewPool';
import { PooledGhostPanelBody } from './pooledGhostPanelBody';
import { useGhostRuntimeState } from './runtimeStates';

/**
 * 意识面板的右侧栏页签形态(panel.position: 'tab')接入 Tab 插件注册表。
 *
 * 与顶层停靠形态(ghostPanels.tsx)的关系:
 * - 同一数据源:syncGhostPanelRegistrations 是"已装清单"的唯一同步点
 *   (启动 listSync + ghosts:changed 广播),按 position 分派到两个注册表,
 *   本模块不自建订阅;
 * - 同一面板体:webview 供片/主题注入/崩溃接管全部复用 ghostPanelBody,
 *   沙箱边界与特权面零变化(附加闸只认分区/地址,与宿主容器无关);
 * - 同一复活语义:停用/卸下 → unregisterTabKind,已开的 tab 落回 Shell 的
 *   PlaceholderBody(数据保留);重新启用 → 重注册,原 tab 原位复活。
 *
 * 页签语义对齐 review:menu.singleton = true,每 session 至多一个;
 * kind 复用 ghostPanelKind 的 `ghost:<id>`(DB kind 列无枚举约束,可直存)。
 */

/** 页签体:Shell 已提供容器与 TabBar,不再套 PanelChrome 标准头。
 *  webview 托管在 ghostPanelWebviewPool(钉住 → 跨会话保活;未钉住 → 卸载即释,
 *  语义同旧版每次挂载新建);沙箱崩 / 熔断仍走停靠形态同款错误接管。 */
function GhostTabBody({
  manifest,
  visible,
}: {
  manifest: GhostManifest;
  visible: boolean;
}): ReactNode {
  // 沙箱崩了/熔断 → 与停靠形态同款错误接管(GhostPanel broken 分支的等价物)。
  const runtimeState = useGhostRuntimeState(manifest.id);
  const broken = runtimeState === 'crashed' || runtimeState === 'fused';
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--panel-bg)]">
      {broken ? (
        <GhostPanelError manifest={manifest} state={runtimeState} />
      ) : (
        <PooledGhostPanelBody manifest={manifest} visible={visible} />
      )}
    </div>
  );
}

/** 由清单构造一份 Tab 插件契约(纯函数,方便单测直接断言 menu 形状)。 */
export function buildGhostTabPlugin(manifest: GhostManifest): TabKindPlugin {
  const kind = ghostPanelKind(manifest.id) as TabKindId;
  const label = manifest.panel?.title ?? manifest.name;
  const TabPillTitle: TabKindPlugin['TabPillTitle'] = () => <>{label}</>;
  const TabPillIcon: NonNullable<TabKindPlugin['TabPillIcon']> = () => <Puzzle size={13} />;
  // active / shellVisible → 懒物化判据:页签首次真正可见才创建面板 webview。
  const TabBody: TabKindPlugin['TabBody'] = ({ active, shellVisible }) => (
    <GhostTabBody manifest={manifest} visible={active !== false && shellVisible !== false} />
  );
  return {
    kind,
    menu: {
      kind,
      // 插件名是用户内容进不了 i18n,走 labelText 原文;labelKey 只作兜底。
      labelKey: 'rightSidebar.tabs.kinds.ghostPanel',
      labelText: label,
      icon: Puzzle,
      // 排内置项之后;「+」菜单/空态的动态分组内部按 labelText 排
      // (listGhostTabMenuMetas),order 不参与组内排序。
      order: 100,
      enabled: true,
      // 与 review 同款单例:每 session 至多一个页签,已开则切过去。
      singleton: true,
    },
    TabPillTitle,
    TabPillIcon,
    TabBody,
    defaultState: () => null,
  };
}

/** 已注册页签插件:kind → 清单指纹(与 ghostPanels 的 fingerprint 语义一致)。 */
const registeredTabFingerprints = new Map<string, string>();

/**
 * 把 Tab 注册表与"当前已装清单"对齐:启用且 position:'tab' 的注册,
 * 消失/停用/换形态的注销。由 syncGhostPanelRegistrations 每次同步时调用。
 */
export function syncGhostTabRegistrations(ghosts: InstalledGhost[]): void {
  const seen = new Set<string>();
  for (const { manifest, enabled } of ghosts) {
    if (manifest.panel?.position !== 'tab') continue;
    if (enabled === false) continue;
    const kind = ghostPanelKind(manifest.id);
    seen.add(kind);
    const fingerprint = JSON.stringify(manifest);
    if (registeredTabFingerprints.get(kind) === fingerprint) continue;
    // 原位升级换版:先注销旧注册再挂新的(registerTabKind 对重复 kind 抛错)。
    if (registeredTabFingerprints.has(kind)) unregisterTabKind(kind as TabKindId);
    registeredTabFingerprints.set(kind, fingerprint);
    registerTabKind(buildGhostTabPlugin(manifest));
  }
  for (const kind of [...registeredTabFingerprints.keys()]) {
    if (seen.has(kind)) continue;
    registeredTabFingerprints.delete(kind);
    unregisterTabKind(kind as TabKindId);
  }
  // 常驻池对齐同一份清单:停用 / 卸载 / 换形态 / 换版的面板 webview 就地释放
  // —— 沙箱生命周期纪律(沉睡、抽离必须终止)不因"钉住保活"打折。
  ghostPanelWebviewPool.sync(
    ghosts
      .filter((g) => g.enabled !== false && g.manifest.panel?.position === 'tab')
      .map((g) => ({ ghostId: g.manifest.id, fingerprint: ghostPanelFingerprint(g.manifest) })),
  );
  // 钉住偏好的孤儿清理:被卸载的插件不再占条目(停用不清 —— 重新启用时
  // 钉住状态原位复活,与页签"停用落 Placeholder、重启用复活"同语义)。
  pruneGhostTabPins(new Set(ghosts.map((g) => g.manifest.id)));
}

/** 仅测试用:清空本模块注册,保证用例间隔离。 */
export function __resetGhostTabPluginsForTest(): void {
  for (const kind of [...registeredTabFingerprints.keys()]) {
    unregisterTabKind(kind as TabKindId);
  }
  registeredTabFingerprints.clear();
}
