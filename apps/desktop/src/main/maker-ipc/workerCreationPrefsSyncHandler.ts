import {
  isOrcaWorkerPermissionMode,
  type OrcaWorkerPermissionMode,
} from '../../shared/orca-worker-permission-mode.js';

interface WorkerCreationPrefsSyncDeps<TEvent> {
  assertTrustedSender: (event: TEvent) => void;
  setWorkerPermissionMode: (mode: OrcaWorkerPermissionMode) => void;
}

/**
 * Renderer → Main 的 Worker 创建偏好同步边界。
 *
 * sender guard 必须先于 payload 解析与缓存写入：即使 payload 看起来合法，未登记的
 * Renderer / WebView 也不能修改进程级 Worker 默认权限。
 */
export function createWorkerCreationPrefsSyncHandler<TEvent>(
  deps: WorkerCreationPrefsSyncDeps<TEvent>,
): (event: TEvent, payload: unknown) => void {
  return (event, payload) => {
    deps.assertTrustedSender(event);
    if (!payload || typeof payload !== 'object') return;
    const mode = (payload as { workerPermissionMode?: unknown }).workerPermissionMode;
    if (!isOrcaWorkerPermissionMode(mode)) return;
    deps.setWorkerPermissionMode(mode);
  };
}
