/**
 * 插件生命周期统一投影的跨进程类型(main / preload / renderer 共用)。
 *
 * 判定真身在 `main/cindy-brain/ghostLifecycle.ts`(纯函数);本文件只承载
 * wire 类型,避免 renderer 反向 import main 模块。字段语义见真身头注释。
 */

import type { GhostSetupAssessment } from './ghost.js';

export type GhostReadiness =
  | 'ready'
  | 'needs_setup'
  | 'needs_reauth'
  | 'degraded'
  | 'blocked'
  | 'unknown';

/** 面板运行时态(GhostRuntimeState 的 wire 镜像,勿反向扩语义)。 */
export type GhostLifecycleRuntimeState =
  | 'off'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'crashed'
  | 'fused';

export interface GhostLifecycleEntry {
  id: string;
  name: string;
  enabled: boolean;
  readiness: GhostReadiness;
  setup?: GhostSetupAssessment;
  runtimeState?: GhostLifecycleRuntimeState;
}
