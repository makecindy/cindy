import { usePreviewFocusReturn } from './PreviewChrome';
import { ActivePreviewCollection } from './AttachmentCollectionContext';
import { useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { FocusScope } from '@radix-ui/react-focus-scope';
import { useTranslation } from 'react-i18next';
import { attachmentPreviewKind } from '@cindy/maker-shared/attachment-preview';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { FileTypeTile } from '@/components/ui/file-type-tile';
import {
  canOpenSystemPreview,
  openSystemPreview,
  OpenInSystemActions,
  revealFileInFolder,
} from '@/features/cc-agent/workdir-browse/OpenInSystemActions';
import { formatBytes } from '@/features/cc-agent/workdir-browse/lib/fileMeta';
import { FileBodyView } from '@/features/cc-agent/workdir-browse/FileBodyView';
import { useFileContent, type FileContent } from '@/features/cc-agent/workdir-browse/hooks/useFileContent';
import { isImagePath } from '@/features/cc-agent/workdir-browse/lib/imageExt';
import { isPdfPath } from '@/features/cc-agent/workdir-browse/lib/pdfExt';
import { toLocalFileUrl } from '@/lib/localPathResolver';
import { fetchChatFileToCache } from '@/lib/remoteFileOpen';
import { isRemoteFileOrigin } from '@/lib/sessionFileOrigin';
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
import { ModelLightbox } from './ModelLightbox';

/** Binary files use the same origin resolver as text, then existing read-only renderers. */
export function FileLightbox({
  filePath,
  fileName,
  triggerRef,
  onClose,
  changedBadge,
  refreshToken = 0,
  onRefreshed,
}: {
  filePath: string;
  fileName?: string;
  triggerRef?: React.RefObject<HTMLElement | null>;
  onClose(): void;
  /** 「文件已变更」提示(issue #12851),渲染在预览窗右上角。 */
  changedBadge?: ReactNode;
  /** 递增即重新读一次内容。 */
  refreshToken?: number;
  /**
   * 刷新结果回报:真的换成了最新内容时回调 true;只拿到历史副本(远端不可达)或读取
   * 失败时回调 false —— 调用方据此决定要不要收起「文件已变更」提示(issue #12851)。
   */
  onRefreshed?: (fresh: boolean) => void;
}) {
  const { t } = useTranslation();
  const restorePreviewFocus = usePreviewFocusReturn();
  const collection = useContext(ActivePreviewCollection);
  const ctx = useChatSessionFile();
  const remote = isRemoteFileOrigin(ctx.origin) ? ctx.origin : null;
  const [local, setLocal] = useState<string | null>(remote ? null : filePath);
  const [failed, setFailed] = useState(false);
  // 面板里显示的不是最新版:远端不可达 / 取回失败,只剩上次取回的副本。
  const [copyStale, setCopyStale] = useState(false);
  const [retry, setRetry] = useState(0);
  const overlay = useRef<HTMLDivElement>(null);
  const name = fileName ?? filePath.split(/[\\/]/).pop() ?? filePath;
  const kind = attachmentPreviewKind(filePath);
  const downloadOnly = isSafetyDowngradedAttachment({ name, path: filePath });
  // 远程来源:预览读的是取回后的本地副本,刷新必须先重新取回,再读新的副本。
  const rereadLocal = useRef<(() => void) | null>(null);
  // onRefreshed 用 ref 往下传:调用方给的是内联函数时不会把取回流程重跑一遍。
  const onRefreshedRef = useRef(onRefreshed);
  onRefreshedRef.current = onRefreshed;
  // 刷新前的内容:等它换新之后再回报这次刷新的结果(issue #12851)。
  const pendingRefresh = useRef<FileContent | null>(null);
  const contentRef = useRef<FileContent | null>(null);
  const reportRefresh = useCallback((fresh: boolean) => {
    if (refreshToken > 0) onRefreshedRef.current?.(fresh);
  }, [refreshToken]);
  useEffect(() => {
    if (!remote) {
      setLocal(filePath);
      return;
    }
    let cancelled = false;
    setFailed(false);
    // 刷新时保留旧副本,避免面板闪一帧空白;首次进入才回到加载态。
    if (refreshToken === 0) setLocal(null);
    void fetchChatFileToCache(remote, ctx.workingDir, filePath)
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          // 取回失败:手上还是旧副本,这次刷新不算成功 —— 提示留着,用户能再点一次。
          setFailed(true);
          setCopyStale(true);
          reportRefresh(false);
          return;
        }
        // stale = 远端不可达,只有历史副本:不是最新内容,提示同样留着。
        setCopyStale(result.stale);
        setLocal(result.cachePath);
        // 取回完成后再读一次:不重读的话,面板还是旧副本的内容。
        if (refreshToken > 0) {
          pendingRefresh.current = contentRef.current;
          rereadLocal.current?.();
        }
      })
      .catch(() => {
        if (cancelled) return;
        setFailed(true);
        setCopyStale(true);
        reportRefresh(false);
      });
    return () => {
      cancelled = true;
    };
  }, [remote, ctx.workingDir, filePath, retry, refreshToken, reportRefresh]);
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
    if (local && ['image', 'video', 'audio', 'model'].includes(kind)) return;
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [close, kind, local]);
  // 媒体走各自查看器,不读内容;其余文件在这里读一次,同时决定预览窗大小。
  const fileLocation =
    local && !['image', 'video', 'audio', 'model'].includes(kind) ? splitLocalPath(local) : null;
  const { content, refresh } = useFileContent(fileLocation?.workdir ?? '', fileLocation?.relPath ?? '');
  contentRef.current = content;
  useEffect(() => {
    rereadLocal.current = refresh;
  }, [refresh]);
  // 「文件已变更」提示被点掉后重新读一次内容(issue #12851)。
  // 本地来源直接重读磁盘;远程来源由上面的取回流程在取回完成后重读 —— 边下载边读
  // 会读到写了一半的副本。
  useEffect(() => {
    if (refreshToken === 0 || remote) return;
    pendingRefresh.current = contentRef.current;
    refresh();
  }, [refreshToken, refresh, remote]);
  // 内容换新之后再回报这次刷新:读到文件才算成功,远端还得看副本是不是最新。
  useEffect(() => {
    const before = pendingRefresh.current;
    if (!before || content === before) return;
    if (content.kind === 'loading') return;
    pendingRefresh.current = null;
    reportRefresh(content.kind !== 'error' && !copyStale);
  }, [content, copyStale, reportRefresh]);
  // 打不开的文件(压缩包、可执行文件等)只有文件信息和打开方式,用小窗,不占大半个窗口。
  const unrenderable =
    content.kind === 'binary' &&
    !isImagePath(content.stat.relPath) &&
    !isPdfPath(content.stat.relPath);
  if (local && kind === 'image')
    return (
      <ImageLightbox
        src={toLocalFileUrl(local)}
        filename={name}
        onClose={close}
        sessionId={ctx.sessionId}
      />
    );
  if (local && (kind === 'video' || kind === 'audio'))
    return (
      <VideoLightbox
        src={
          kind === 'audio'
            ? toLocalFileUrl(local).replace('xdt-file:', 'xdt-audio:')
            : toLocalFileUrl(local)
        }
        filename={name}
        kind={kind}
        onClose={close}
      />
    );
  if (local && kind === 'model')
    return (
      <ModelLightbox filename={name} source={{ kind: 'local', absPath: local }} onClose={close} />
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
        className={`z-fullscreen text-[var(--text-primary)] outline-none ${PREVIEW_PANEL_CLASS}`}
        style={unrenderable ? previewCompactPanelStyle(collection ? 64 : 0) : PREVIEW_PANEL_STYLE}
      >
        <div className={`absolute inset-0 pt-16 ${collection && kind !== 'pdf' ? 'pb-16' : ''}`}>
          {unrenderable ? (
            <div className="flex h-full flex-col items-center justify-center gap-5 overflow-y-auto px-6 py-4 text-center">
              <div className="flex flex-col items-center gap-3">
                <FileTypeTile name={name} />
                <div className="flex flex-col gap-1">
                  <p className="text-13 text-[var(--text-secondary)]">
                    {t('ccAgent.workdirBrowse.unrenderable.notSupported')}
                  </p>
                  <p className="text-12 text-[var(--text-tertiary)]">{formatBytes(content.stat.size)}</p>
                </div>
              </div>
              {local && !downloadOnly && <OpenInSystemActions absPath={local} primaryOnly />}
            </div>
          ) : fileLocation ? (
            <FileBodyView
              workdir={fileLocation.workdir}
              relPath={fileLocation.relPath}
              content={content}
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
        {kind !== 'pdf' ? <PreviewFooter collectionOnly /> : null}
        <PreviewHeader
          name={name}
          onClose={close}
          actions={changedBadge}
          detail={copyStale && local ? t('chat.remoteFile.staleBadge') : null}
          onSave={
            local
              ? () => {
                  if (downloadOnly) {
                    void saveChatAttachmentWithToasts(ctx, { name, path: filePath });
                    return;
                  }
                  void window.electronAPI
                    .saveMediaAs({ url: toLocalFileUrl(local) })
                    .catch(() => toast.error(t('chat.userMessage.attachmentSaveFailed')));
                }
              : undefined
          }
          menu={
            <>
              {!unrenderable && (
                <DropdownMenuItem
                  disabled={!local || downloadOnly}
                  onClick={() => {
                    if (local) void window.electronAPI.openPath(local);
                  }}
                >
                  {t('attachmentPreview.open')}
                </DropdownMenuItem>
              )}
              {unrenderable && local && !downloadOnly && canOpenSystemPreview() && (
                <DropdownMenuItem onClick={() => void openSystemPreview(local, t('ccAgent.common.openFailed'))}>
                  {t('ccAgent.workdirBrowse.systemPreview')}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                disabled={!local || downloadOnly}
                onClick={() => {
                  if (local) void revealFileInFolder(local, t);
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
