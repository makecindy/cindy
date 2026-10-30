import { shouldShowOpenPathError } from '../../../shared/openPathResult';
/**
 * ModelLightbox
 * ---------------------------------------------------------------------------
 * Full-screen 3D model lightbox rendered via React Portal. Mirror of
 * VideoLightbox but hosts the `mivo-model-viewer` SDK (Three.js) instead of
 * `<video>`, so it can show every format the SDK handles (GLB / glTF / OBJ / FBX /
 * STL / PLY / DAE / 3MF / 3DS) with the SDK's own info panel, texture modes,
 * preset views and projection switch.
 *
 * Sources (discriminated union):
 *   - blob:  cindy-media GLB (managed vault). Bytes are `fetch()`ed over the
 *     `cindy-media://` protocol.
 *   - local: a model file on disk (chat file chip / Markdown link). The renderer
 *     cannot `fetch` `xdt-file://` (CSP connect-src excludes it on purpose), so the
 *     bytes come from the main process via `readModelFileBytes` (≤128MB, model
 *     extensions only). Both paths end in a `Blob` + a file name with an extension,
 *     which is how the SDK picks the loader.
 *
 * Failure semantics:
 *   - Read / parse failure → toast, lightbox stays open (poster/backdrop still
 *     visible, right-click menu still works). Without that a failure looks like a
 *     frozen 2D image.
 *   - The SDK is dynamically imported (≈600KB), so the first open shows a spinner.
 *
 * Interaction parity with VideoLightbox:
 *   - Esc closes; click on overlay background closes; click on the model
 *     itself does NOT close (we need rotate/zoom gestures without dismissing)
 *   - Right-click → 打开模型 / 打开模型所在目录
 *   - Focus: FocusScope moves focus into the overlay on open, traps Tab
 *     inside, and returns focus to the pre-open element on unmount.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FocusScope } from '@radix-ui/react-focus-scope';
import { Box, FolderOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ModelViewerInstance } from 'mivo-model-viewer';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import { loadModelViewerSdk } from '@/lib/model3d/modelViewerSdk';
import {
  Model3DTooLargeError,
  readModel3DBlob,
  type ModelBlob,
} from '@/lib/model3d/readModel3DBlob';
import { Spinner } from '@/components/ui/spinner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/** Where the model bytes come from — decides how bytes are read and which menu actions apply. */
export type ModelLightboxSource =
  | {
      /** cindy-media 媒体总仓里的 GLB:字节已本地落库,经 cindy-media:// 协议 fetch。 */
      kind: 'blob';
      /** cindy-media://blobs/<指纹>.glb */
      url: string;
      /** Chat thumbnail src, shown behind the viewer while the SDK loads and parses. */
      poster?: string;
    }
  | {
      kind: 'local';
      /** Absolute path of a model file already on disk (any recognised 3D format). */
      absPath: string;
    };

interface ModelLightboxProps {
  source: ModelLightboxSource;
  onClose: () => void;
}

export function ModelLightbox({ source, onClose }: ModelLightboxProps) {
  const { t, i18n } = useTranslation();
  const [isVisible, setIsVisible] = useState(false);
  const isClosingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const lastMenuCloseAt = useRef(0);
  // SDK 容器:viewer 在首次渲染后异步创建,挂在这个 div 里。
  const viewerHostRef = useRef<HTMLDivElement | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  // 只用首次传入的 source 加载;弹窗生命周期内 source 不会变。
  const sourceRef = useRef(source);
  // FocusScope 挂载焦点的落点:overlay 根(tabIndex=-1 由 FocusScope 合入)。
  const overlayRef = useRef<HTMLDivElement | null>(null);
  // "open" / "reveal" 正在执行时禁用菜单, 避免重复点击。Mirror ChatImageView。
  const [modelPending, setModelPending] = useState<'open' | 'reveal' | null>(null);

  const poster = source.kind === 'blob' ? source.poster : undefined;

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const handleClose = useCallback(() => {
    if (isClosingRef.current) return;
    isClosingRef.current = true;
    // Esc 是键盘事件,会把 Chromium 切到键盘焦点模式 —— 查看器内部可聚焦控件会在
    // 200ms 淡出期间闪出默认焦点框。开始淡出前先把焦点 blur 掉,框就不会被画出来。
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
      if (e.key !== 'Escape') return;
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

  // 加载:SDK(动态 import)与模型字节并行取,取到后创建 viewer 并 load。
  // 失败只 toast,不关闭弹窗——poster 仍可看、右键"打开模型"仍可用;否则失败会
  // 表现成"一张拖不动的静态图"的静默失败。卸载时取消在途读取并 dispose viewer。
  const locale = i18n.language?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
  useEffect(() => {
    const host = viewerHostRef.current;
    if (!host) return;
    let cancelled = false;
    let viewer: ModelViewerInstance | null = null;
    let model: ModelBlob | null = null;
    const controller = new AbortController();
    const releaseModel = () => {
      const current = model;
      model = null;
      current?.dispose();
    };
    const fail = (error: unknown) => {
      if (cancelled) return;
      setLoadState('error');
      toast.error(
        error instanceof Model3DTooLargeError
          ? t('chat.media.modelTooLarge', 'This 3D model is too large to preview')
          : t('chat.media.modelLoadFailed', 'Failed to load 3D model'),
      );
    };
    void (async () => {
      const modelPromise = readModel3DBlob(sourceRef.current, { signal: controller.signal }).then(
        (loadedModel) => {
          // 读取可能晚于 SDK 失败或弹窗卸载完成。完成时立即接管所有权，避免
          // Promise.all 已拒绝后这个返回值失去唯一清理入口。
          if (cancelled || controller.signal.aborted) {
            loadedModel.dispose();
            return loadedModel;
          }
          model = loadedModel;
          return loadedModel;
        },
      );
      try {
        const [sdk, loadedModel] = await Promise.all([loadModelViewerSdk(), modelPromise]);
        if (cancelled || controller.signal.aborted) return;
        viewer = sdk.createModelViewer(host, {
          locale,
          // 颜色全部取 lightbox 工具栏那一族 token(图片预览浮在遮罩上的控件用的同一套,
          // 明暗两种模式取值相同:面板与控件用白 10% 的浅底,叠在黑色遮罩上比纯黑底更通透,
          // 面板上的控件再叠一层形成层次;白 20% 描边、白色前景),不在这里写字面量。
          // 次要文字 / 悬停 / 分隔线的浅色由前景色按透明度派生;强调色也用前景白,
          // 选中态靠白色描边与文字表达,不引入额外的强调色。viewport 背景透明,
          // 让弹窗自己的 --overlay-lightbox 遮罩透出来。导入 / 导出 / 全景是宿主不需要
          // 的入口(模型来源由聊天决定),关掉避免出现无意义的按钮。
          theme: {
            primary: 'var(--lightbox-toolbar-fg-hover)',
            text: 'var(--lightbox-toolbar-fg-hover)',
            panelBg: 'var(--lightbox-toolbar-hover-bg)',
            controlBg: 'var(--lightbox-toolbar-hover-bg)',
            border: 'var(--lightbox-toolbar-border)',
            background: 'transparent',
            // 视角 / 投影图标是自带紫色细节的双色图,变量改不了色;选中态也用纯白,与前景色一致
            monochromeIcons: true,
          },
          // loadingOverlay 关掉:加载态由下面这一个居中的 spinner 统一承担(覆盖 SDK 动态导入 +
          // 读字节 + 解析全过程),避免库自带的加载层叠成两个 loading。
          ui: {
            import: false,
            export: false,
            panorama: false,
            emptyHint: false,
            loadingOverlay: false,
          },
          onLoadError: fail,
        });
        await viewer.load(loadedModel.blob, { fileName: loadedModel.fileName });
        releaseModel();
        if (!cancelled) setLoadState('ready');
      } catch (error) {
        if (cancelled) return;
        controller.abort();
        fail(error);
      } finally {
        releaseModel();
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
      releaseModel();
      viewer?.dispose();
      viewer = null;
    };
    // 弹窗内 source / locale 不变;locale 变化不值得重建 viewer。
  }, []);

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
    // 里既有的 blur 仍保留——点进模型后 SDK 内部控件的焦点框要在淡出前先灭掉。
    <FocusScope
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
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'var(--overlay-lightbox)',
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
        aria-label={t('chat.lightbox.close')}
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
      {/* The viewer takes a fixed viewport-relative box so it has a stable canvas
          size to render into. The SDK mounts its own canvas + panels into the
          host div; the poster (chat thumbnail) shows behind it until the first
          model is ready. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: right-click opens a pointer context menu for the model canvas. */}
      <div
        style={{
          // 查看器的侧栏按容器高度自适应(库的紧凑档位),这里只需给足空间、保留点击
          // 遮罩关闭的边缘。
          width: 'min(94vw, 1280px)',
          height: 'min(92vh, 860px)',
          position: 'relative',
          zIndex: 1,
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuPos({ x: e.clientX, y: e.clientY });
        }}
      >
        {poster && loadState !== 'ready' ? (
          <img
            src={poster}
            alt={t('chat.media.modelPreviewAlt')}
            draggable={false}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              pointerEvents: 'none',
            }}
          />
        ) : null}
        <div ref={viewerHostRef} data-model3d-viewer style={{ position: 'absolute', inset: 0 }} />
        {loadState === 'loading' ? (
          <div
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              color: 'var(--lightbox-toolbar-fg)',
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
  );

  return createPortal(overlay, document.body);
}
