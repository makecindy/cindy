/**
 * 辅助模型与 Subagent 智能路由解析的桌面装配(纯 Node 核心见 auxiliaryRouteRefsCore.ts)。
 * 通过纯 Node 启动桥 getModelGroupStartBridge 调用选路，既无动态 import(architecture-invariants §2)，
 * 也不把 desktopResolver / quota-overview / maker-host 依赖图拉进 runtime-configs 与 oneShotCandidates。
 */
import { getModelGroupStartBridge } from '../model-groups/startBridge.js';
import { buildAuxiliaryRouteOptions, createAuxiliaryRouteRefs } from './auxiliaryRouteRefsCore.js';

const desktopAuxiliaryRouteRefs = createAuxiliaryRouteRefs({
  resolveLocalRoute: (request) => {
    const bridge = getModelGroupStartBridge();
    if (!bridge) return Promise.resolve({ outcome: 'missing', groupName: '', trace: [] });
    return bridge.resolve(request);
  },
});

export const localRouteCandidatesInPickOrder = desktopAuxiliaryRouteRefs.localRouteCandidatesInPickOrder;
export const expandAuxiliaryRouteRef = desktopAuxiliaryRouteRefs.expandAuxiliaryRouteRef;
export { buildAuxiliaryRouteOptions };
