import type { ComponentType } from 'react';

import type { PanelKind } from '../../shared/layoutTree';

/**
 * 面板注册表 —— 布局引擎与"面板是谁"之间的唯一解耦点。
 *
 * 布局引擎(LayoutRoot/SplitView/PaneView)只做一件事:拿树节点的
 * panelKind 来这里查组件;查得到就渲染,查不到就把该 pane 整体隐藏、空间回流
 * (未安装意识的存档残留 = 平时不可见,树数据保留)。引擎对"面板是谁"零感知,
 * 未来意识面板接入 = 往本注册表多一条记录,引擎不改。
 *
 * 与 right-sidebar 的 TabKindPlugin registry 的关系:那是"右栏容器内部的 tab
 * 插件"(将来整体作为工具箱意识的内部实现),本注册表是**顶层 pane 级**面板;
 * 两层各管一层,顶层布局只消费本层。
 */

/** 所有面板组件的统一入参 —— 引擎只认识这一个形状,不为任何 kind 特化。 */
export interface PanelComponentProps {
  /** 布局树里本面板所在 pane 的节点 id。 */
  paneId: string;
}

/**
 * 折叠记忆作用域(B2a,Lizi 2026-07-07 决策:两种都支持,由面板自己声明,引擎统一执行):
 * - 'global':全局一份,持久化真身是布局树 pane.collapsed(如会话列表);
 * - 'per-session':跟会话走,引擎在会话层分桶存(如工具面板:切会话各记各的开关);
 * - 'none':没有折叠能力(chat-main:必须始终可见)。
 */
export type CollapseMemory = 'global' | 'per-session' | 'none';

export interface PanelDefinition {
  kind: PanelKind;
  Component: ComponentType<PanelComponentProps>;
  /** 折叠记忆作用域声明;读写统一走 renderer/layout/collapsePrefs.ts,不许绕开自存。 */
  collapseMemory: CollapseMemory;
}

const registry = new Map<string, PanelDefinition>();
/**
 * 「停放」中的 kind:仍在注册表里、pane 保持挂载,但引擎不给它布局空间(容器 0 宽 / 0 高、
 * aria-hidden、不画分割线、不参与份额账本)。边页签组在路由离开聊天页时使用 —— 直接注销
 * 会把 pane 卸掉,webview 宿主随之销毁,回来整页重载(#8081)。
 */
const parked = new Set<string>();
/**
 * 注册表版本与订阅:页签组 pane 的 kind 随「组里有没有页签」动态注册 / 注销
 * (features/right-sidebar/tabGroupPanes.ts),布局引擎靠订阅感知在场面板变化,
 * 不再只依赖插件装卸广播。
 */
let version = 0;
const subscribers = new Set<() => void>();

function bump(): void {
  version += 1;
  for (const cb of [...subscribers]) cb();
}

/**
 * 注册一种面板。重复注册同 kind 采取"覆盖 + dev 告警"而非抛错 —— 注册走
 * side-effect 调用,Vite HMR 会让注册代码重跑,抛错会把热更新炸成白屏。
 */
export function registerPanelKind(definition: PanelDefinition): void {
  if (registry.has(definition.kind) && import.meta.env.DEV) {
    // eslint-disable-next-line no-console -- dev-only HMR 重复注册提示,生产不可达
    console.warn(`[panels] duplicate registration overwrites kind: ${definition.kind}`);
  }
  registry.set(definition.kind, definition);
  bump();
}

/**
 * 注销一种面板(卸下意识时调用)。布局树里残留的同 kind pane 自此按
 * "未安装意识"隐藏 —— 树数据保留,重装即原位复活。幂等。
 */
export function unregisterPanelKind(kind: PanelKind): void {
  const wasParked = parked.delete(kind);
  if (registry.delete(kind) || wasParked) bump();
}

/** 停放 / 解除停放一种已注册面板(见 `parked`);状态没变不通知。注销时一并清除。 */
export function setPanelKindParked(kind: PanelKind, isParked: boolean): void {
  if (isParked === parked.has(kind)) return;
  if (isParked) parked.add(kind);
  else parked.delete(kind);
  bump();
}

/** 该 kind 是否处于停放态(未注册的 kind 恒为 false)。 */
export function isPanelKindParked(kind: PanelKind): boolean {
  return parked.has(kind) && registry.has(kind);
}

/** 注册表变更订阅(注册 / 注销都会通知);返回退订函数。 */
export function subscribePanelRegistry(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/** 单调递增的注册表版本:放进 memo / effect deps 即可感知在场面板变化。 */
export function getPanelRegistryVersion(): number {
  return version;
}

/** 查面板定义;未注册(如未安装的意识)返回 null,由调用方决定隐藏策略。 */
export function getPanelKind(kind: PanelKind): PanelDefinition | null {
  return registry.get(kind) ?? null;
}

export function hasPanelKind(kind: PanelKind): boolean {
  return registry.has(kind);
}

/** 已注册 kind 列表(诊断 / 测试用)。 */
export function listPanelKinds(): string[] {
  return [...registry.keys()];
}

/** 仅测试用:清空注册表,保证用例间隔离。 */
export function __resetPanelRegistryForTest(): void {
  registry.clear();
  parked.clear();
  subscribers.clear();
  version = 0;
}
