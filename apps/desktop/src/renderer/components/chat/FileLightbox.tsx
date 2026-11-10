import { usePreviewFocusReturn } from './PreviewChrome';
import { ActivePreviewCollection } from './AttachmentCollectionContext';
import { lazy, Suspense, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FocusScope } from '@radix-ui/react-focus-scope';
import { useTranslation } from 'react-i18next';
import { attachmentPreviewKind } from '@cindy/maker-shared/attachment-preview';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { FileBodyView } from '@/features/cc-agent/workdir-browse/FileBodyView';
import { useFileContent } from '@/features/cc-agent/workdir-browse/hooks/useFileContent';
import { isImagePath } from '@/features/cc-agent/workdir-browse/lib/imageExt';
import { isPdfPath } from '@/features/cc-agent/workdir-browse/lib/pdfExt';
import { isManagedFileUrl } from '@/lib/markdownTarget';
import { rewriteToRemoteMediaOrigin } from '../../../shared/remoteMediaUrl';
import { toLocalFileUrl } from '@/lib/localPathResolver';
import { fetchChatFileToCache } from '@/lib/remoteFileOpen';
import { isRemoteFileOrigin, toRemoteMediaOrigin } from '@/lib/sessionFileOrigin';
import { toast } from '@/lib/toast';
import {
  isSafetyDowngradedAttachment,
  saveChatAttachmentWithToasts,
} from '@/lib/chatAttachmentSave';
import { useChatSessionFile } from './ChatSessionFileContext';
import {
  PREVIEW_PANEL_CLASS,
  PREVIEW_PANEL_STYLE,
  PreviewHeader,
  PreviewFooter,
  PreviewScrim,
  previewCompactPanelStyle,
} from './PreviewChrome';
import { ImageLightbox } from './ImageLightbox';
import { VideoLightbox } from './VideoLightbox';

const ModelPreview = lazy(() => import('./ModelPreview').then(module => ({ default: module.ModelPreview })));

/** Binary files use the same origin resolver as text, then existing read-only renderers. */
export function FileLightbox({
  filePath,
  fileName,
  triggerRef,
  onClose,
}: {
  filePath: string;
  fileName?: string;
  triggerRef?: React.RefObject<HTMLElement | null>;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const restorePreviewFocus = usePreviewFocusReturn();
  const collection = useContext(ActivePreviewCollection);
  const ctx = useChatSessionFile();
  const remote = isRemoteFileOrigin(ctx.origin) ? ctx.origin : null;
  const managed = isManagedFileUrl(filePath);
  const managedUrl = managed
    ? rewriteToRemoteMediaOrigin(filePath, toRemoteMediaOrigin(ctx.origin, ctx.workingDir))
    : null;
  const sourceUrl = managedUrl && (!remote || managedUrl !== filePath) ? managedUrl : null;
  const [local, setLocal] = useState<string | null>(remote || managed ? null : filePath);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const overlay = useRef<HTMLDivElement>(null);
  const name = fileName ?? filePath.split(/[\\/]/).pop() ?? filePath;
  const kind = attachmentPreviewKind(filePath);
  const downloadOnly = isSafetyDowngradedAttachment({ name, path: filePath });
  useEffect(() => {
    if (managed) {
      setLocal(null);
      setFailed(!sourceUrl);
      return;
    }
    if (!remote) {
      setLocal(filePath);
      return;
    }
    let cancelled = false;
    setFailed(false);
    setLocal(null);
    void fetchChatFileToCache(remote, ctx.workingDir, filePath)
      .then((result) => {
        if (!cancelled) {
          if (result.ok) setLocal(result.cachePath);
          else setFailed(true);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [remote, ctx.workingDir, filePath, retry, managed, sourceUrl]);
  const url = sourceUrl ?? (local ? toLocalFileUrl(local) : null);
  const close = useCallback(() => {
    onClose();
    triggerRef?.current?.focus({ preventScroll: true });
  }, [onClose, triggerRef]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        !document.fullscreenElement &&
        !document.querySelector('[data-radix-popper-content-wrapper]')
      ) {
        event.preventDefault();
        close();
      }
    };
    // Media viewers own their own keyboard scope.
    if (url && ['image', 'video', 'audio'].includes(kind)) return;
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [close, kind, url]);
  // 媒体走各自查看器,不读内容;其余文件在这里读一次,同时决定预览窗大小。
  const fileLocation =
    local && !['image', 'video', 'audio', 'model'].includes(kind) ? splitLocalPath(local) : null;
  const { content } = useFileContent(fileLocation?.workdir ?? '', fileLocation?.relPath ?? '');
  // Unsupported formats keep file actions even when their bytes happen to be text.
  const previewContent =
    kind === 'file' && content.kind === 'text'
      ? {
          kind: 'binary' as const,
          stat: {
            relPath: content.relPath,
            type: 'file' as const,
            size: content.size,
            mtimeMs: content.mtimeMs,
          },
        }
      : content;
  // 打不开的文件(压缩包、可执行文件等)只有文件信息和打开方式,用小窗,不占大半个窗口。
  const unrenderable =
    (managed && !['image', 'video', 'audio', 'model'].includes(kind)) ||
    (kind !== 'model' && previewContent.kind === 'binary' &&
      !isImagePath(previewContent.stat.relPath) &&
      !isPdfPath(previewContent.stat.relPath));
  if (url && kind === 'image')
    return (
      <ImageLightbox
        src={url}
        filename={name}
        onClose={close}
        sessionId={ctx.sessionId}
      />
    );
  if (url && (kind === 'video' || kind === 'audio'))
    return (
      <VideoLightbox
        src={
          kind === 'audio'
            ? url.replace('xdt-file:', 'xdt-audio:')
            : url
        }
        filename={name}
        kind={kind}
        onClose={close}
      />
    );
  return createPortal(
    <>
    <PreviewScrim onClose={close} />
    <FocusScope
      onUnmountAutoFocus={restorePreviewFocus}
      trapped
      loop
      asChild
      onMountAutoFocus={(event) => {
        event.preventDefault();
        overlay.current?.focus();
      }}
    >
      <div
        ref={overlay}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={name}
        className={`z-[9999] text-[var(--text-primary)] outline-none ${PREVIEW_PANEL_CLASS}`}
        style={unrenderable ? previewCompactPanelStyle(collection ? 64 : 0) : PREVIEW_PANEL_STYLE}
      >
        <div className={`absolute inset-0 pt-16 ${collection && kind !== 'pdf' && kind !== 'model' ? 'pb-16' : ''}`}>
          {url && kind === 'model' ? (
            <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner /></div>}>
              <ModelPreview url={url} path={sourceUrl ? undefined : (local ?? undefined)} filename={name} />
            </Suspense>
          ) : managed && sourceUrl ? (
            <div className="flex h-full items-center justify-center text-[var(--text-secondary)]">{name}</div>
          ) : fileLocation ? (
            <FileBodyView
              workdir={fileLocation.workdir}
              relPath={fileLocation.relPath}
              content={previewContent}
              sessionId={ctx.sessionId}
              allowEdit={false}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-4">
              {failed ? (
                <>
                  <span>{t('logic.errors.openFileFailed')}</span>
                  <button type="button" onClick={() => setRetry((value) => value + 1)}>
                    {t('attachmentPreview.retry')}
                  </button>
                </>
              ) : (
                <Spinner />
              )}
            </div>
          )}
        </div>
        {kind !== 'pdf' && kind !== 'model' ? <PreviewFooter collectionOnly /> : null}
        <PreviewHeader
          name={name}
          onClose={close}
          onSave={
            url
              ? () => {
                  if (downloadOnly) {
                    void saveChatAttachmentWithToasts(ctx, { name, path: filePath });
                    return;
                  }
                  void window.electronAPI
                    .saveMediaAs({ url })
                    .catch(() => toast.error(t('chat.userMessage.attachmentSaveFailed')));
                }
              : undefined
          }
          menu={
            <>
              <DropdownMenuItem
                disabled={(!local && !(managed && !remote)) || downloadOnly}
                onClick={() => {
                  if (managed && !remote) {
                    void window.electronAPI.openMediaWithDefaultApp({ url: filePath })
                      .catch(() => toast.error(t('logic.errors.openFileFailed')));
                  } else if (local) void window.electronAPI.openPath(local);
                }}
              >
                {t('attachmentPreview.open')}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={(!local && !(managed && !remote)) || downloadOnly}
                onClick={() => {
                  if (managed && !remote) void window.electronAPI.showItemInFolder({ url: filePath });
                  else if (local) void window.electronAPI.showItemInFolder({ filePath: local });
                }}
              >
                {t('chat.lightbox.openInExplorer')}
              </DropdownMenuItem>
            </>
          }
        />
      </div>
    </FocusScope>
    </>,
    document.body,
  );
}

function splitLocalPath(path: string) {
  const split = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return { workdir: split === 0 ? '/' : path.slice(0, split), relPath: path.slice(split + 1) };
}
