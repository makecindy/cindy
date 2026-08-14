/**
 * ChatImageView
 * ---------------------------------------------------------------------------
 * 聊天流里图片渲染的统一组件。把"用户上传图"和"agent 工具产物图"这两类
 * 视觉物收口到同一个组件,以后改样式 / 加交互(右键菜单、复制、reveal-in-folder
 * 等)只用改一处。
 *
 * variant 决定尺寸 + 边框,行为(click→ImageLightbox / error→placeholder /
 * draggable=false / hover opacity)完全一致:
 *   - 'user-attached': 用户上传到 chat 输入框的图,固定 280×180,无边框。
 *     视觉上"附件"感,不抢主区域注意力。
 *   - 'tool-output':   agent 工具产出的图(art 出图、飞书拉图等),走 Markdown
 *     内嵌图同款规则 min(100%, 50vw, 480px) × min(40vh, 420px),带 tool-card
 *     border。消息流里只是预览(点开 lightbox 看全图),不该占掉半屏。
 *
 * lightbox state 自包含——每个 instance 自己 own 一个 ImageLightbox。
 * 因为 chat 流里同一时刻只可能开一个 lightbox(它会 lock 全局 scroll),所以
 * 让每个图自己管即可,父组件不用协调多个图共用一份 lightbox state。
 *
 * 唯一例外是 UserMessage 里的"Markdown 链接 → ImageLightbox" 路径,那是从
 * 文本链接触发的,没有对应的图片组件实例,只能由 UserMessage 自己保留一份
 * lightbox state——和这里的 self-owned lightbox 共存(两者不会同时弹,因为都
 * 走 ImageLightbox 的全局 scroll lock)。
 */

import { useState } from 'react';
import { Box, Copy, FolderOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/lib/toast';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { extractIpcError } from '@/utils/ipcError';
import { ImageLightbox } from './ImageLightbox';
import { ModelLightbox } from './ModelLightbox';
import { ImageMissingPlaceholder } from './ImageMissingPlaceholder';
import { useRemoteMediaUrl } from '@/hooks/useRemoteMediaUrl';
import { useRemoteMediaErrorRetry } from '@/hooks/useRemoteMediaErrorRetry';
import type { ToolMediaModelFile } from './AgentActionRow';

export type ChatImageVariant = 'user-attached' | 'tool-output';

interface ChatImageViewProps {
  src: string;
  filename: string;
  variant: ChatImageVariant;
  /**
   * 当这张图是一个 3D 模型任务的预览缩略图时,把对应模型文件的元数据传过来。
   * 设置后点击路由到 ModelLightbox(3D 查看器),右键菜单从默认的"复制图片 /
   * 打开图片所在目录"换成"打开模型 / 打开模型所在目录" — 操作的是模型文件
   * 本体(mivo fileId 懒下载 / cindy-media 总仓 GLB),不是预览图本身。
   * undefined 时菜单/行为完全不变,跟未引入这个 prop 之前等价。
   */
  modelFile?: ToolMediaModelFile;
  /**
   * 所在会话 id。远程(device-link)会话里图片字节在被控端,需把 src 改写成
   * cindy-remote-media:// 经 OSS 中转取;本地会话 / 不传 → 原样渲染。
   */
  sessionId?: string;
  /**
   * 非破坏性标注(历史带标注图):未烧录原图 url + 持久化矢量笔迹。两者齐备
   * 时,点击打开 lightbox 展示"原图 + 可编辑笔迹"(单张,可撤销旧笔迹后
   * 重新发送),而不是死的烧录位图。仅本地会话生效(远程媒体不改写此 url)。
   */
  annotationSourceUrl?: string;
  annotationStrokes?: Array<{ points: Array<{ x: number; y: number }> }>;
}

/** 各 variant 的尺寸/边框/className 规范集中在这里,以后调样式只用动这一处。 */
const VARIANT_STYLES: Record<
  ChatImageVariant,
  {
    style: React.CSSProperties;
    className: string;
  }
> = {
  'user-attached': {
    // F-MSG-IMG: 用户上传图固定 280×180——附件感,不抢主区域。
    style: { maxWidth: 280, maxHeight: 180 },
    className: 'rounded-[12px] object-contain cursor-pointer hover:opacity-90 transition-opacity',
  },
  'tool-output': {
    // 沿用 MarkdownRenderer 内嵌图规则,与飞书 doc 内嵌图、其他 agent 出图保持一致。
    // self-start: MessageStream 的 tool_media 包裹层是 flex-col(默认 stretch),
    // 竖图会被拉宽到 480px 后 object-contain 两侧留白(视觉上"图外黑边")——
    // 按自身宽高比渲染,maxWidth/maxHeight 仍然封顶。
    // maxWidth 三档:100% 相对消息列(右侧栏等把列压窄时跟随列宽缩,防溢出)、
    // 50vw 小窗口兜底、480px 大窗口封顶;50vw/40vh 都相对整个窗口,列宽约束
    // 只能靠 100% 这档提供。
    // maxHeight 双档:40vh 防竖图占掉半屏消息流、420px 防大显示器上跟着屏幕
    // 变大——消息流里只是预览,看细节走 lightbox 全屏。
    style: { maxWidth: 'min(100%, 50vw, 480px)', maxHeight: 'min(40vh, 420px)', height: 'auto' },
    className:
      'self-start rounded-[12px] border border-[var(--msg-tool-card-border)] object-contain cursor-pointer hover:opacity-90 transition-opacity',
  },
};

export function ChatImageView({
  src,
  filename,
  variant,
  modelFile,
  sessionId,
  annotationSourceUrl,
  annotationStrokes,
}: ChatImageViewProps) {
  const { t } = useTranslation();
  // 远程会话改写到 cindy-remote-media://;本地会话原样。下游一律用 displaySrc(渲染 +
  // gallery + lightbox + 本机操作判定),远程媒体的 reveal/copy 自然失效。
  const displaySrc = useRemoteMediaUrl(src, sessionId);
  // 'image' = 2D 预览图 lightbox; 'model' = `<model-viewer>` 3D lightbox。
  // 同一个 state 槽位避免两种 lightbox 同时出现 (且统一受 scroll-lock 影响)。
  const [lightboxOpen, setLightboxOpen] = useState<'image' | 'model' | null>(null);
  // 错误态 + 远程媒体失败自愈(退避重取,覆盖被控端物化竞态窗口)收口在
  // hook 里;本机 scheme 的失败不重试,行为与从前一致。
  const { errored, onLoadError } = useRemoteMediaErrorRetry(displaySrc);
  // Right-click → 复制图片 / 打开图片所在目录. Mirrors MarkdownRenderer.LightboxImage
  // and ImageLightbox so user-attached 图和 assistant tool-output 图右键交互一致。
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  // 模型菜单项里某一项正在执行(下载 + open/reveal)时禁用整组菜单 — 模型
  // 第一次打开时需要从 mivo 拉文件,可能要 1-3 秒,菜单瞬时关闭看上去像
  // 没响应。pending 状态显示 spinner + 抑制重复点击。
  const [modelPending, setModelPending] = useState<'open' | 'reveal' | null>(null);

  if (errored) {
    return <ImageMissingPlaceholder filename={filename} />;
  }

  const { style, className } = VARIANT_STYLES[variant];

  // 只有缓存到本地 (xdt-image://) 的图才能 reveal/copy 原图。
  // base64 fallback (data:) 没有对应文件,菜单整段不渲染。
  // 但 modelFile 路径不依赖本地缓存的预览图 — fileId 直接打到 mivo 后端拉
  // 模型,所以只要有 modelFile 菜单就可用。
  const canRevealInFolder =
    displaySrc.startsWith('xdt-image://') || displaySrc.startsWith('cindy-media://');
  const showMenu = modelFile !== undefined || canRevealInFolder;

  async function handleCopyImage(): Promise<void> {
    const res = await window.electronAPI.copyMediaToClipboard({ url: displaySrc });
    if (res.success) {
      toast.success(t('chat.media.imageCopied'));
    } else {
      toast.error(res.error ?? t('chat.media.copyFailed'));
    }
    setMenuPos(null);
  }

  async function handleRevealInFolder(): Promise<void> {
    const res = await window.electronAPI.showItemInFolder({ url: displaySrc });
    if (!res.success) {
      toast.error(res.error ?? t('chat.media.openFolderFailed'));
    }
    setMenuPos(null);
  }

  async function handleModelAction(action: 'open' | 'reveal'): Promise<void> {
    if (!modelFile || modelPending) return;
    setModelPending(action);
    try {
      // 意识链路:GLB 已在媒体总仓,按 URL 解析本机文件即可,不依赖宿主
      // mivo key。open 的 IPC 失败以 throwIpcError 编码抛出,由 catch 统一 toast。
      if (action === 'open') {
        await window.electronAPI.openMediaWithDefaultApp({ url: modelFile.url });
      } else {
        const res = await window.electronAPI.showItemInFolder({ url: modelFile.url });
        if (!res.success) {
          toast.error(res.error ?? t('chat.media.openFolderFailed'));
        }
      }
    } catch (err) {
      // openMediaWithDefaultApp 走 throwIpcError 编码([CODE] message),按
      // 规则 13 用 extractIpcError 解码后展示;非 IPC 错误回退 i18n 兜底文案。
      toast.error(
        extractIpcError(err)?.message ??
          (action === 'open'
            ? t('chat.media.openModelFailed', 'Failed to open model')
            : t('chat.media.openFolderFailed')),
      );
    } finally {
      setModelPending(null);
      setMenuPos(null);
    }
  }

  return (
    <>
      <img
        src={displaySrc}
        alt={filename}
        style={style}
        className={cn(className)}
        draggable={false}
        // 会话内翻图的数据源:lightbox 打开后会扫描所有带此属性的图,按 DOM
        // 顺序拼成可左右翻页的列表。见 ImageLightbox.collectGallery。
        data-gallery-src={displaySrc}
        // 3D 模型预览图 → 弹 ModelLightbox 直接渲真模型;普通图 → 走 ImageLightbox。
        // model-viewer 只原生支持 glTF/GLB,非此两者退回 2D 预览,
        // 用户仍可右键 "打开模型" 用系统程序打开。
        onClick={(e) => {
          const next =
            modelFile && ['GLB', 'GLTF'].includes(modelFile.format.toUpperCase())
              ? 'model'
              : 'image';
          // 打 image lightbox 前,在被点的这张图上做个临时标记,让 lightbox
          // 精确定位到用户点的这张(而不是按 src 搜到的第一张)。model 路径
          // 不进 gallery,不标记。
          if (next === 'image') e.currentTarget.dataset.galleryActive = '1';
          setLightboxOpen(next);
        }}
        onContextMenu={(e) => {
          if (!showMenu) return;
          e.preventDefault();
          e.stopPropagation();
          setMenuPos({ x: e.clientX, y: e.clientY });
        }}
        onError={onLoadError}
      />
      {showMenu ? (
        <DropdownMenu
          open={menuPos !== null}
          onOpenChange={(open) => {
            // 下载/打开 in-flight 时不允许外部关闭菜单,避免用户以为没生效。
            if (!open && modelPending) return;
            if (!open) setMenuPos(null);
          }}
        >
          <DropdownMenuTrigger asChild>
            <span
              aria-hidden
              data-fixed-menu-anchor
              style={{
                position: 'fixed',
                left: menuPos?.x ?? 0,
                top: menuPos?.y ?? 0,
                width: 0,
                height: 0,
                pointerEvents: 'none',
              }}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" sideOffset={2}>
            {modelFile ? (
              <>
                <DropdownMenuItem
                  disabled={modelPending !== null}
                  onSelect={(e) => {
                    // 阻止 Radix 默认的 close-on-select,等下载完成再关菜单。
                    e.preventDefault();
                    void handleModelAction('open');
                  }}
                >
                  {modelPending === 'open' ? (
                    <Spinner size={16} className="mr-2" />
                  ) : (
                    <Box className="mr-2 h-4 w-4" />
                  )}
                  {t('chat.media.openModel', 'Open model')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={modelPending !== null}
                  onSelect={(e) => {
                    e.preventDefault();
                    void handleModelAction('reveal');
                  }}
                >
                  {modelPending === 'reveal' ? (
                    <Spinner size={16} className="mr-2" />
                  ) : (
                    <FolderOpen className="mr-2 h-4 w-4" />
                  )}
                  {t('chat.media.revealModel', 'Reveal model in folder')}
                </DropdownMenuItem>
              </>
            ) : (
              <>
                <DropdownMenuItem onClick={handleCopyImage}>
                  <Copy className="mr-2 h-4 w-4" />
                  {t('chat.media.copyImage')}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleRevealInFolder}>
                  <FolderOpen className="mr-2 h-4 w-4" />
                  {t('chat.media.revealImage')}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {lightboxOpen === 'image' &&
        (annotationSourceUrl && annotationStrokes?.length && displaySrc === src ? (
          // 历史带标注图的再编辑视图:打开未烧录原图 + 持久化笔迹(可撤销/
          // 续画,出口是"发送到对话"生成新消息)。displaySrc !== src 说明是
          // 远程会话改写,原图在被控端拿不到,退回普通烧录图预览。
          // 单张展示:gallery 按烧录图 src 定位,换成原图后无法匹配。
          <ImageLightbox
            src={annotationSourceUrl}
            initialStrokes={annotationStrokes}
            onClose={() => setLightboxOpen(null)}
          />
        ) : (
          <ImageLightbox src={displaySrc} enableGallery onClose={() => setLightboxOpen(null)} />
        ))}
      {lightboxOpen === 'model' && modelFile && (
        <ModelLightbox
          source={{ kind: 'blob', url: modelFile.url, poster: displaySrc }}
          onClose={() => setLightboxOpen(null)}
        />
      )}
    </>
  );
}
