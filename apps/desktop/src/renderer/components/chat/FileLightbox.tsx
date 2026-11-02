import { usePreviewFocusReturn } from './PreviewChrome';
import { ActivePreviewCollection } from './AttachmentCollectionContext';
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FocusScope } from '@radix-ui/react-focus-scope';
import { useTranslation } from 'react-i18next';
import { attachmentPreviewKind } from '@cindy/maker-shared/attachment-preview';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { FileBodyView } from '@/features/cc-agent/workdir-browse/FileBodyView';
import { useFileContent } from '@/features/cc-agent/workdir-browse/hooks/useFileContent';
import { toLocalFileUrl } from '@/lib/localPathResolver';
import { fetchChatFileToCache } from '@/lib/remoteFileOpen';
import { isRemoteFileOrigin } from '@/lib/sessionFileOrigin';
import { toast } from '@/lib/toast';
import {
  isSafetyDowngradedAttachment,
  saveChatAttachmentWithToasts,
} from '@/lib/chatAttachmentSave';
import { useChatSessionFile } from './ChatSessionFileContext';
import { PreviewHeader, PreviewFooter } from './PreviewChrome';
import { ImageLightbox } from './ImageLightbox';
import { VideoLightbox } from './VideoLightbox';
import { ModelLightbox } from './ModelLightbox';

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
  const [local, setLocal] = useState<string | null>(remote ? null : filePath);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const overlay = useRef<HTMLDivElement>(null);
  const name = fileName ?? filePath.split(/[\\/]/).pop() ?? filePath;
  const kind = attachmentPreviewKind(filePath);
  const downloadOnly = isSafetyDowngradedAttachment({ name, path: filePath });
  useEffect(() => {
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
  }, [remote, ctx.workingDir, filePath, retry]);
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
        className="fixed inset-0 z-[9999] bg-[var(--surface)] text-[var(--text-primary)] outline-none"
      >
        <div className={`absolute inset-0 pt-16 ${collection && kind !== 'pdf' ? 'pb-16' : ''}`}>
          {local ? (
            <LocalFileBody path={local} sessionId={ctx.sessionId} />
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
              <DropdownMenuItem
                disabled={!local || downloadOnly}
                onClick={() => {
                  if (local) void window.electronAPI.openPath(local);
                }}
              >
                {t('attachmentPreview.open')}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!local || downloadOnly}
                onClick={() => {
                  if (local) void window.electronAPI.showItemInFolder({ filePath: local });
                }}
              >
                {t('chat.lightbox.openInExplorer')}
              </DropdownMenuItem>
            </>
          }
        />
      </div>
    </FocusScope>,
    document.body,
  );
}

function LocalFileBody({ path, sessionId }: { path: string; sessionId?: string }) {
  const split = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const workdir = split === 0 ? '/' : path.slice(0, split);
  const relPath = path.slice(split + 1);
  const { content } = useFileContent(workdir, relPath);
  return (
    <FileBodyView
      workdir={workdir}
      relPath={relPath}
      content={content}
      sessionId={sessionId}
      allowEdit={false}
    />
  );
}
