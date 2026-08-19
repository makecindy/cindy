/**
 * useBotArtifactOpen —— 「打开交付物」的唯一实现,对话里的交付物卡与右栏交付物
 * 仓库共用一份。
 *
 * 打开策略沿用聊天里既有的文件打开口径(GeneratedFilesCard / 正文文件链接):
 *   - 图片 → 应用内 ImageLightbox(远程会话经 origin 改写走 cindy-remote-media);
 *   - 文本 / 代码 / markdown → 应用内 TextLightbox;
 *   - 其余(xlsx / pdf / pptx …) → 交系统默认应用,远程会话先取回缓存副本。
 * 协议引用类交付物(cindy-media:// / xdt-*://)没有可暴露的本机路径,图片直接进
 * Lightbox,其余交主进程按托管地址用默认应用打开。
 *
 * `remoteFileOpen` / `filePreview` 走**动态 import**:它们在模块加载期就会拉起
 * renderer i18n 初始化,而这个 hook 会被内联在消息流的协作卡里 —— 静态引入等于把
 * 整条 i18n 初始化链挂到聊天首屏的模块图上。用户点「打开」那一刻再加载就够了。
 */

import { Suspense, lazy, useCallback, useMemo, useState, type ReactNode } from 'react';

import { useChatSessionFile } from '@/components/chat/ChatSessionFileContext';
import { toLocalFileUrl } from '@/lib/localPathResolver';
import { isRemoteFileOrigin, toRemoteMediaOrigin } from '@/lib/sessionFileOrigin';
import { rewriteToRemoteMediaOrigin } from '../../../shared/remoteMediaUrl';
import type { BotArtifactItem } from '../../../shared/botArtifact';

// Lightbox 只在用户真的点开时才需要。TextLightbox 静态引入会把 remoteFileOpen →
// renderer i18n 初始化拉进消息流首屏的模块图(协作卡内联着这个 hook),lazy 之后
// 那条链只在打开动作发生时才加载。
const ImageLightbox = lazy(() =>
  import('@/components/chat/ImageLightbox').then((m) => ({ default: m.ImageLightbox })),
);
const TextLightbox = lazy(() =>
  import('@/components/chat/TextLightbox').then((m) => ({ default: m.TextLightbox })),
);

export interface BotArtifactOpener {
  openArtifact: (item: BotArtifactItem) => Promise<void>;
  /** 挂在调用方任意位置的 lightbox 宿主节点。 */
  artifactLightboxes: ReactNode;
}

export function useBotArtifactOpen(): BotArtifactOpener {
  const fileCtx = useChatSessionFile();
  const remoteOrigin = isRemoteFileOrigin(fileCtx.origin) ? fileCtx.origin : null;
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [textTarget, setTextTarget] = useState<{ path: string; name: string } | null>(null);

  const openArtifact = useCallback(
    async (item: BotArtifactItem): Promise<void> => {
      if (item.ref) {
        if (item.category === 'image') {
          setImageSrc(
            rewriteToRemoteMediaOrigin(
              item.ref,
              toRemoteMediaOrigin(fileCtx.origin, fileCtx.workingDir),
            ),
          );
          return;
        }
        /*
          协议引用类交付物交主进程按托管地址打开。这里**必须**接住失败:
          openMediaWithDefaultApp 在几种日常情况下会 throw ——
            - xdt-video:// / xdt-audio:// 等 classifyLightboxMediaUrl 不认的方案;
            - xdt-file:// 指向非图片扩展名(交付的 pdf / xlsx / pptx 就是这一类);
            - cindy-media:// 的 blob 已被回收(NOT_FOUND「文件不存在」)。
          调用方全部是 `void openArtifact(...)`,renderer 又没有全局
          unhandledrejection 兜底 —— 不接的话用户点「打开」就是**什么都不发生、
          也没有任何提示**。与 item.path 分支(filePreview 内部 toast)对齐:
          失败一律出 toast,不让按钮变成哑巴。
        */
        try {
          await window.electronAPI.openMediaWithDefaultApp({ url: item.ref });
        } catch (error) {
          // 与 filePreview.shouldOpenTextLightbox 的失败口径一致:优先说人话的
          // 具体原因(如「文件不存在」),拿不到再退到通用兜底文案。
          const [{ toast }, { i18n }] = await Promise.all([
            import('@/lib/toast'),
            import('@/i18n'),
          ]);
          const detail = error instanceof Error ? error.message : '';
          toast.error(detail || i18n.t('logic.errors.openFileFailed'));
        }
        return;
      }
      const absPath = item.path;
      if (!absPath) return;
      if (item.category === 'image') {
        const localUrl = toLocalFileUrl(absPath);
        if (!remoteOrigin) {
          setImageSrc(localUrl);
          return;
        }
        const rewritten = rewriteToRemoteMediaOrigin(
          localUrl,
          toRemoteMediaOrigin(fileCtx.origin, fileCtx.workingDir),
        );
        if (rewritten !== localUrl) {
          setImageSrc(rewritten);
          return;
        }
        const { fetchChatFileWithToasts } = await import('@/lib/remoteFileOpen');
        const cachePath = await fetchChatFileWithToasts(
          remoteOrigin,
          fileCtx.workingDir,
          absPath,
        );
        if (cachePath) setImageSrc(toLocalFileUrl(cachePath));
        return;
      }
      // 非图片:文本类进 TextLightbox,其余由 shouldOpenTextLightboxForOrigin
      // 内部交系统默认应用(含失败 toast 与远程取回)。
      const { shouldOpenTextLightboxForOrigin } = await import('@/lib/filePreview');
      if (!(await shouldOpenTextLightboxForOrigin(fileCtx, absPath))) return;
      setTextTarget({ path: absPath, name: item.name });
    },
    [fileCtx, remoteOrigin],
  );

  const artifactLightboxes = useMemo(
    () =>
      imageSrc === null && textTarget === null ? null : (
        <Suspense fallback={null}>
          {imageSrc ? <ImageLightbox src={imageSrc} onClose={() => setImageSrc(null)} /> : null}
          {textTarget ? (
            <TextLightbox
              filePath={textTarget.path}
              fileName={textTarget.name}
              onClose={() => setTextTarget(null)}
            />
          ) : null}
        </Suspense>
      ),
    [imageSrc, textTarget],
  );

  return { openArtifact, artifactLightboxes };
}
