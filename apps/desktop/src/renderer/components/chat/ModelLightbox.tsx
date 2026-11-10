import { usePreviewFocusReturn } from './PreviewChrome';
import {
  PREVIEW_PANEL_CLASS,
  PREVIEW_PANEL_STYLE,
  PreviewHeader,
  PreviewFooter,
  PreviewButton,
  PreviewScrim,
} from './PreviewChrome';
import { previewSourceName } from '@cindy/maker-shared/attachment-preview';
import { shouldShowOpenPathError } from '../../../shared/openPathResult';
/**
 * ModelLightbox
 * ---------------------------------------------------------------------------
 * Full-screen 3D model lightbox rendered via React Portal. Mirror of
 * VideoLightbox but drives `<model-viewer>` instead of `<video>`.
 *
 * Sources (discriminated union):
 *   - blob:  cindy-media GLB(意识 3D 链路产物),url 直接加载。
 *   - local: a model file already on disk (chat file-chip entry). The
 *     `xdt-file://` URL is built synchronously via toLocalFileUrl — no IPC,
 *     no poster (model-viewer shows its progress bar during parse).
 *
 * Failure semantics:
 *   - <model-viewer> load/parse failure ('error' event) → toast, lightbox
 *     stays open (poster/backdrop still visible, right-click menu still
 *     works). Without this listener a load failure looks like a frozen 2D
 *     image — the exact symptom of the 2026-06 scheme-privilege regression.
 *
 * Interaction parity with VideoLightbox:
 *   - Esc closes; click on overlay background closes; click on the model
 *     itself does NOT close (we need rotate/zoom gestures without dismissing)
 *   - Right-click → 打开模型 / 打开模型所在目录
 *   - Focus: FocusScope moves focus into the overlay on open, traps Tab
 *     inside, and returns focus to the pre-open element on unmount.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FocusScope } from '@radix-ui/react-focus-scope';
import { Box, FolderOpen, RotateCcw, Minus, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import { toLocalFileUrl } from '@/lib/localPathResolver';
import { Spinner } from '@/components/ui/spinner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/** Where the model bytes come from — decides URL building and menu actions. */
export type ModelLightboxSource =
  | {
      /** cindy-media 媒体总仓里的 GLB(意识 3D 链路产物):字节已本地落库,
       *  url 直接作为 <model-viewer src>(协议 supportFetchAPI 已开),不走
       *  任何 IPC 懒下载。 */
      kind: 'blob';
      /** cindy-media://blobs/<指纹>.glb */
      url: string;
      /** Chat thumbnail src, shown as <model-viewer poster> during parse. */
      poster?: string;
    }
  | {
      kind: 'local';
      /** Absolute path of a .glb/.gltf already on disk. (FBX is intentionally
       *  NOT previewable in-app: model-viewer is glTF-only, and a hand-rolled
       *  three.js FBX view renders Phong materials without IBL — misleadingly
       *  different from the GLB look. FBX chips reveal in Finder instead.) */
      absPath: string;
    };

interface ModelLightboxProps {
  source: ModelLightboxSource;
  onClose: () => void;
  filename?: string;
}

// `<model-viewer>`(连同 three.js,约 1 MB)只在首次打开 3D 预览时加载,不进主窗口
// 首屏。包加载后自行注册自定义元素;失败时清掉缓存,「重试」会再次调用 import()
// (浏览器是否重新读取分包取决于其模块缓存;分包缺失本身属于安装损坏)。
let modelViewerModule: Promise<unknown> | null = null;

function loadModelViewer(): Promise<unknown> {
  modelViewerModule ??= import('@google/model-viewer').catch((err: unknown) => {
    modelViewerModule = null;
    throw err;
  });
  return modelViewerModule;
}

function isModelViewerDefined(): boolean {
  return customElements.get('model-viewer') !== undefined;
}

export function ModelLightbox({ source, onClose, filename }: ModelLightboxProps) {
  const restorePreviewFocus = usePreviewFocusReturn();
  const { t } = useTranslation();
  const [isVisible, setIsVisible] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  // 元素注册前不渲染 <model-viewer>,属性始终按已定义元素的方式写入。
  const [viewerReady, setViewerReady] = useState(isModelViewerDefined);
  const isClosingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const lastMenuCloseAt = useRef(0);
  // blob: cindy-media URL is directly loadable — no IPC.
  // local: built synchronously — the file is already on disk.
  const [modelUrl] = useState<string | null>(
    source.kind === 'local' ? toLocalFileUrl(source.absPath) : source.url,
  );
  const modelViewerRef = useRef<HTMLElement | null>(null);
  // FocusScope 挂载焦点的落点:overlay 根(tabIndex=-1 由 FocusScope 合入)。
  const overlayRef = useRef<HTMLDivElement | null>(null);
  // "open" / "reveal" 正在执行时禁用菜单, 避免重复点击。Mirror ChatImageView。
  const [modelPending, setModelPending] = useState<'open' | 'reveal' | null>(null);

  const zoomModel = (factor: number) => {
    const viewer = modelViewerRef.current as
      (HTMLElement & { getCameraOrbit?(): { theta: number; phi: number; radius: number } }) | null;
    const orbit = viewer?.getCameraOrbit?.();
    if (orbit)
      viewer!.setAttribute(
        'camera-orbit',
        `${orbit.theta}rad ${orbit.phi}rad ${orbit.radius * factor}m`,
      );
  };

  const poster = source.kind === 'blob' ? source.poster : undefined;

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const handleClose = useCallback(() => {
    if (isClosingRef.current) return;
    isClosingRef.current = true;
    // Esc 是键盘事件,会把 Chromium 切到键盘焦点模式 —— model-viewer shadow
    // DOM 里的 .userInput 交互层(自带 outline-width:1px,light DOM 的全局
    // outline:none 穿不进 shadow)会在 200ms 淡出期间闪出默认焦点框。开始
    // 淡出前先把焦点 blur 掉,框就不会被画出来。
    (document.activeElement as HTMLElement | null)?.blur?.();
    setIsVisible(false);
    setTimeout(() => onCloseRef.current(), 200);
  }, []);

  // Fade in
  useEffect(() => {
    const raf = requestAnimationFrame(() => setIsVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // Esc key — same gesture-suppression dance as Image/Video Lightbox so a
  // recently-closed context menu doesn't also dismiss the lightbox.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.key !== 'Escape' || document.fullscreenElement) return;
      if (performance.now() - lastMenuCloseAt.current < 150) return;
      handleClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [handleClose]);

  // Scroll lock
  useEffect(() => {
    const container = document.querySelector(
      '[data-scroll-container]',
    ) as HTMLElement | null;
    if (container) container.style.overflowY = 'hidden';
    return () => {
      if (container) container.style.overflowY = '';
    };
  }, []);

  // <model-viewer> 加载/解析失败只派发 'error' 事件,UI 会一直停留在 poster
  // 上——不监听就是"看起来像一张拖不动的静态图"的静默失败(历史上协议特权
  // 丢失导致 fetch 被拒时正是这个表现)。失败时保留 lightbox(poster 仍可
  // 看、右键"打开模型"仍可用),toast 告知即可,不自动关闭。
  // 用 layout effect 在元素挂上的同一次提交里绑定:查看器代码异步就绪后,元素是在
  // 非交互的更新里插入的,普通 effect 可能晚于绘制才执行,很快失败的加载(如 fetch
  // 被拒)会在绑定前就派发 'error'。
  useLayoutEffect(() => {
    const el = modelViewerRef.current;
    if (!el) return;
    const onError = () => {
      setFailed(true);
    };
    el.addEventListener('error', onError);
    return () => el.removeEventListener('error', onError);
  }, [retry, viewerReady]);

  // 查看器代码本身加载失败(例如分包文件缺失)同样走失败提示,而不是一直转圈;
  // 「重试」递增 retry 后重新加载。
  useEffect(() => {
    if (viewerReady) return;
    let cancelled = false;
    loadModelViewer().then(
      () => {
        if (!cancelled) setViewerReady(true);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [viewerReady, retry]);

  async function handleModelAction(action: 'open' | 'reveal'): Promise<void> {
    if (modelPending) return;
    setModelPending(action);
    try {
      if (source.kind === 'blob') {
        // 媒体总仓 GLB:按 URL 解析本机文件。open 走系统默认应用(IPC 失败
        // 以 throwIpcError 编码抛出,由外层 catch 统一 toast),reveal 走
        // 文件管理器定位。
        if (action === 'open') {
          await window.electronAPI.openMediaWithDefaultApp({ url: source.url });
        } else {
          const res = await window.electronAPI.showItemInFolder({ url: source.url });
          if (!res.success) {
            toast.error(res.error ?? t('chat.media.openFolderFailed'));
          }
        }
      } else {
        const res =
          action === 'open'
            ? await window.electronAPI.openPath(source.absPath)
            : await window.electronAPI.showItemInFolder({ filePath: source.absPath });
        if (shouldShowOpenPathError(res)) {
          toast.error(
            res.error ??
              (action === 'open'
                ? t('chat.media.openModelFailed', 'Failed to open model')
                : t('chat.media.openFolderFailed')),
          );
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

  const overlay = (
    // FocusScope(trapped+loop):键盘打开后焦点进入弹窗并圈禁,Tab 不穿过被
    // 遮挡的聊天控件。挂载焦点给 overlay 根(全局 outline:none 不闪全屏焦
    // 点框),Tab 下一站是 backdrop 关闭按钮;卸载时 FocusScope 默认把焦点
    // 还给打开前的元素(ChatImageView 键盘路径 = 预览触发器)。handleClose
    // 里既有的 blur 仍保留——点进模型后 model-viewer shadow DOM 的焦点框
    // 要在淡出前先灭掉。
    <>
    <PreviewScrim
      onClose={() => {
        if (performance.now() - lastMenuCloseAt.current < 150) return;
        handleClose();
      }}
    />
    <FocusScope
      onUnmountAutoFocus={restorePreviewFocus}
      asChild
      trapped
      loop
      onMountAutoFocus={(event) => {
        event.preventDefault();
        overlayRef.current?.focus();
      }}
    >
    <div
      ref={overlayRef}
      data-lightbox-layer
      className={PREVIEW_PANEL_CLASS}
      style={{
        ...PREVIEW_PANEL_STYLE,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'opacity 200ms ease',
        opacity: isVisible ? 1 : 0,
        cursor: 'default',
      }}
    >
      <button
        type="button"
          tabIndex={-1}
          aria-hidden="true"
          style={{
          position: 'absolute',
          inset: 0,
          border: 0,
          padding: 0,
          background: 'transparent',
          cursor: 'default',
        }}
        onClick={() => {
          if (performance.now() - lastMenuCloseAt.current < 150) return;
          handleClose();
        }}
      />
        <PreviewHeader
          name={
            filename ??
            previewSourceName(
              source.kind === 'local' ? source.absPath : source.url,
              t('chat.media.modelPreviewAlt'),
            )
          }
          onClose={handleClose}
          onSave={() => {
            void window.electronAPI
              .saveMediaAs({
                url: source.kind === 'local' ? toLocalFileUrl(source.absPath) : source.url,
              })
              .catch(() => toast.error(t('chat.media.saveFailed')));
          }}
          onMenuClose={() => {
            lastMenuCloseAt.current = performance.now();
          }}
          menu={
            <>
              <DropdownMenuItem
                disabled={modelPending !== null}
                onClick={() => void handleModelAction('open')}
              >
                <Box className="mr-2 h-4 w-4" />
                {t('chat.media.openModel')}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={modelPending !== null}
                onClick={() => void handleModelAction('reveal')}
              >
                <FolderOpen className="mr-2 h-4 w-4" />
                {t('chat.media.revealModel')}
              </DropdownMenuItem>
            </>
          }
        />
        {/* The model-viewer takes a fixed viewport-relative box so it has a
          stable canvas size to render into. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: right-click opens a pointer context menu for the model canvas. */}
      <div
        style={{
          width: 'min(calc(var(--preview-width) - 80px), 1024px)',
          height: 'calc(var(--preview-height) - 160px)',
          position: 'relative',
          zIndex: 1,
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuPos({ x: e.clientX, y: e.clientY });
      }}
      >
        {viewerReady ? (
        <model-viewer
            key={retry}
            ref={modelViewerRef}
          // src is omitted until the lazy download resolves — model-viewer
          // shows the poster (chat thumbnail) until then. Once src lands,
          // it fetches via xdt-model:// (mivo) or xdt-file:// (local) and
          // renders.
          {...(modelUrl ? { src: modelUrl } : {})}
          {...(poster ? { poster } : {})}
          alt={t('chat.media.modelPreviewAlt')}
          // 带内嵌动画的 GLB(如 mivo animate_3d_model 绑定动作的产物)自动
          // 播放第一条动画轨;静态模型无动画轨时该属性为 no-op。
          autoplay
          camera-controls
          interaction-prompt="none"
          shadow-intensity={0.8}
          exposure={1}
          loading="eager"
          reveal="auto"
          style={{
            width: '100%',
            height: '100%',
            backgroundColor: 'transparent',
          }}
        />
        ) : null}
        {/* Small loading hint while the viewer code or the model URL is not ready.
            model-viewer's built-in progress bar takes over once it renders with src. */}
        {modelUrl === null || (!viewerReady && !failed) ? (
          <div
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              color: 'rgba(255,255,255,0.85)',
              pointerEvents: 'none',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 13,
            }}
          >
            <Spinner size={16} />
            <span>{t('chat.media.modelLoading', '正在加载 3D 模型…')}</span>
          </div>
        ) : null}
      </div>

        {failed ? (
          <div className="absolute inset-x-0 top-20 z-10 flex items-center justify-center gap-3 bg-[var(--surface)] p-3 text-sm">
            <span>{t('chat.media.modelLoadFailed')}</span>
            <button
              type="button"
              onClick={() => {
                setFailed(false);
                setRetry((value) => value + 1);
              }}
            >
              {t('attachmentPreview.retry')}
            </button>
          </div>
        ) : null}
        <PreviewFooter>
          <PreviewButton label={t('attachmentPreview.zoomOut')} onClick={() => zoomModel(1.25)}>
            <Minus className="h-4 w-4" />
          </PreviewButton>
          <PreviewButton
            label={t('attachmentPreview.reset')}
            onClick={() => {
              const viewer = modelViewerRef.current;
              if (!viewer) return;
              viewer.setAttribute('camera-orbit', '0deg 75deg auto');
              viewer.setAttribute('camera-target', 'auto auto auto');
              viewer.setAttribute('field-of-view', 'auto');
            }}
          >
            <RotateCcw className="h-4 w-4" />
          </PreviewButton>
          <PreviewButton label={t('attachmentPreview.zoomIn')} onClick={() => zoomModel(0.8)}>
            <Plus className="h-4 w-4" />
          </PreviewButton>
        </PreviewFooter>

      <DropdownMenu
        open={menuPos !== null}
        onOpenChange={(open) => {
          if (!open && modelPending) return;
          if (!open) {
            setMenuPos(null);
            lastMenuCloseAt.current = performance.now();
          }
        }}
      >
        <DropdownMenuTrigger asChild>
          <span
            aria-hidden
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
        <DropdownMenuContent align="start" sideOffset={2} className="z-[10000]">
          <DropdownMenuItem
            disabled={modelPending !== null}
            onSelect={(e) => {
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
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    </FocusScope>
    </>
  );

  return createPortal(overlay, document.body);
}
