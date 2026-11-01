import { useEffect, useRef, useState, type ReactNode } from 'react';

import { ImageLightbox } from '@/components/chat/ImageLightbox';
import { VideoLightbox } from '@/components/chat/VideoLightbox';

/**
 * GhostMediaLightboxHost — 意识面板「点开产物大图」的主窗口承接端。
 *
 * 链路:面板里 `<a href="cindy-ghost://<id>/preview/<指纹><后缀>">` 被
 * main 的 will-navigate 闸拦下 → 过预览闸(cindy-brain/previewGate.ts:
 * 形状/焦点/限速/归属/mime)→ 推 `ghosts:preview-media` 到宿主窗口 →
 * 本组件收到主机拼装的 cindy-media:// 地址,按 kind 弹标准 lightbox:
 * 图片 ImageLightbox(缩放/标注/复制/另存),视频 VideoLightbox(播放,
 * 画廊视频卡)——与聊天里点开媒体同一套组件。
 *
 * 挂载点:MainLayout 顶层(与 PanelDragController 同级),整窗一份。
 * 模式同 MarkdownImageLightboxHost:纯监听 + 条件挂载,无自绘 UI。
 */
export function GhostMediaLightboxHost({
  sessionId,
}: {
  /** 当前活跃聊天会话 id(MainLayout 的 rightSidebarSessionId):传入后
   *  图片 lightbox 显示「发送到对话」——预览的图一键落进该会话的附件托盘。 */
  sessionId?: string;
}): ReactNode {
  const [media, setMedia] = useState<{ src: string; kind: 'image' | 'video';
    originSessionId?: string;
  } | null>(null);

  const openingSession = useRef(sessionId);
  openingSession.current = sessionId;

  useEffect(() => {
    const api = window.electronAPI?.ghosts;
    // 测试/无桥环境没有 ghosts 桥(与 ghostPanels 同口径),视同无意识在场。
    if (!api?.onPreviewMedia) return;
    return api.onPreviewMedia(({ src: next, kind }) => {
      // 触发源在 webview 里,焦点还留在 guest —— 不挪回宿主的话 Esc/方向键
      // 都进不了 lightbox。blur 掉当前焦点元素(即 webview),键盘立即归位;
      // 面板同时失焦,main 侧焦点闸顺势掐断脚本连环触发。
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
      // 旧 main(重启前)不带 kind:按图片处理,与历史行为一致。
      setMedia({ src: next, kind: kind ?? 'image', originSessionId: openingSession.current });
    });
  }, []);

  if (media == null) return null;
  if (media.kind === 'video') {
    return <VideoLightbox src={media.src} onClose={() => setMedia(null)} />;
  }
  return (
    <ImageLightbox src={media.src} onClose={() => setMedia(null)} sessionId={media.originSessionId}
    />
  );
}
