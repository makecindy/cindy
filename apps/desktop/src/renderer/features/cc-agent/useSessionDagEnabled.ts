/**
 * useSessionDagEnabled — 会话 DAG 画布与列表折叠的启用判定。
 *
 * 插件仅充当启用标记：本地安装实例（namespace 'local'）的 id 'session-dag'
 * 已安装且启用即可，无需读取任何设置项，也不向插件授予任何权限或数据。
 * 画布与原生聊天均在宿主侧渲染，插件沙箱不碰会话数据；停用即恢复原布局。
 */
import { useMemo } from 'react';
import { useInstalledGhosts } from '@/cindy-brain/useInstalledGhosts';

const SESSION_DAG_GHOST_ID = 'session-dag';

export function useSessionDagEnabled(): boolean {
  const ghosts = useInstalledGhosts();
  return useMemo(
    () => ghosts.some((g) => g.namespace === 'local' && g.enabled
      && g.manifest.id === SESSION_DAG_GHOST_ID
      && g.approval.state === 'approved'),
    [ghosts],
  );
}
