/**
 * useRemoteMediaUrl — 远程会话媒体 URL 改写 hook(入方向)。
 * ---------------------------------------------------------------------------
 * 远程(device-link 被控)会话里的本机媒体 URL(xdt-image / xdt-video / xdt-file /
 * xdt-audio)指向的是**被控端**本地缓存,控制端本机没有这些字节,原样渲染必然 404。
 * 本 hook 在渲染前把这类 URL 改写成 `cindy-remote-media://`(由 main 的同名 handler 经
 * OSS 中转取字节,见 device-link/remoteMediaProtocol.ts)。
 *
 * deviceId 从 ChatSessionFileContext 取:provider 在 MessageStream 顶层统一订阅
 * remoteProjectsStore(origin-injection race——sessionId→deviceId 注册可能晚于远程
 * 会话首渲——在 provider 处理,deviceId 一就位 context 更新穿透 memo 触发重渲)。
 * 消费组件(ChatImageView / ChatVideoView / ChatAudioCard / ChatSoundEffectCard)
 * 全部渲染在 MessageStream 子树内;聊天流外拿到 local 默认值 → 不改写。
 *
 * 本地会话 / 未传 sessionId / 非媒体 URL → 原样返回,零行为变化。
 * 改写后的 URL 不再以 `xdt-image://` 等开头 —— 调用方据此判定的本机专属操作
 * (reveal-in-folder)不再适用;图片复制经共享字节层保留远端来源后写本机剪贴板。
 */
import { useMemo } from 'react';

import { useChatSessionFile } from '@/components/chat/ChatSessionFileContext';
import { toRemoteMediaOrigin } from '@/lib/sessionFileOrigin';
import { rewriteToRemoteMediaOrigin } from '@/../shared/remoteMediaUrl';

/**
 * 把媒体 URL 按会话归属改写(远程会话才改);sessionId 为空 → 原样。
 * device 来源:LOCAL_MEDIA_SCHEMES(xdt 系 + cindy-media)全量改写(OSS 中转
 * 都能取);ssh 来源:仅
 * workdir 内带路径的 xdt-file / xdt-audio(cache-id 型 URL 远端取不到,保持
 * 原样 → 本机缓存命中则照常显示、miss 则 onError 走缺图占位)。
 */
export function useRemoteMediaUrl(url: string, sessionId?: string): string {
  const { origin, workingDir } = useChatSessionFile();
  return useMemo(() => {
    const mediaOrigin = sessionId ? toRemoteMediaOrigin(origin, workingDir) : undefined;
    return rewriteToRemoteMediaOrigin(url, mediaOrigin);
  }, [url, sessionId, origin, workingDir]);
}
