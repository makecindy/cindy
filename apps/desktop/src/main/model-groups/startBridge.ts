/**
 * 纯 Node 的智能路由启动桥：IM / Hook / 插件等模块经此调用模型组的预览、准备、绑定与派发落盘，
 * 不在模块加载期静态拉入 desktopResolver / Electron 依赖图(避免单测与纯 Node 环境耦合)。
 * Desktop 由 sessionStart.desktop.ts 注册，Node Host 由 apps/host/src/agent/model-groups.ts 注册。
 */
import type { ModelGroupResolveRequest, ModelGroupResolveResult } from '../../shared/modelGroups.js';
import type { ModelGroupSessionStart } from './sessionStart.js';

export interface ModelGroupStartBridge {
  resolve(request: ModelGroupResolveRequest): Promise<ModelGroupResolveResult>;
  refresh?(): Promise<void>;
  prepare: ModelGroupSessionStart['prepare'];
  attach: ModelGroupSessionStart['attach'];
  dispatched: ModelGroupSessionStart['dispatched'];
}

let activeBridge: ModelGroupStartBridge | null = null;

export function registerModelGroupStartBridge(bridge: ModelGroupStartBridge | null): void {
  activeBridge = bridge;
}

export function getModelGroupStartBridge(): ModelGroupStartBridge | null {
  return activeBridge;
}
