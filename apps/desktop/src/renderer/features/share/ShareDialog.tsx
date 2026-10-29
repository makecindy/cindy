import { useEffect, useId, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import { Copy, Download, X } from 'lucide-react';
import { WINDOW_DRAG_STYLE, WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Tip } from '@/components/ui/tooltip';
import { copyPngBlobToClipboard, svgToPngBlob } from '@/lib/rasterizeToImage';
import { blobToDataUrl } from '@/lib/annotationBurnIn';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import type { ShareContent, ShareOptions, SharePreparation } from '../../../shared/share';

/** Manual link + image output, independent of the business and future platform SDKs. */
export function ShareDialog({
  load,
  onClose,
  restoreFocus,
  allowAttribution = false,
  confirmation,
  onPreparingChange,
  loadingLabel,
  recipientHint,
}: {
  load: (options: ShareOptions, uploadConfirmed: boolean) => Promise<SharePreparation>;
  onClose: () => void;
  restoreFocus?: () => void;
  allowAttribution?: boolean;
  confirmation?: { message: string; label: string };
  onPreparingChange?: (preparing: boolean) => void;
  loadingLabel?: string;
  recipientHint?: string;
}) {
  const { t } = useTranslation();
  const changedErrorKey = confirmation ? 'sharing.localChanged' : 'settings.ghosts.remote.changed';
  const linkId = useId();
  const attributionId = useId();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [includeAttribution, setIncludeAttribution] = useState(allowAttribution);
  const [confirmationRequired, setConfirmationRequired] = useState(false);
  const [uploadConfirmed, setUploadConfirmed] = useState(false);
  const close = () => {
    alive.current = false;
    generation.current += 1;
    onClose();
  };
  const [previewFailed, setPreviewFailed] = useState(false);
  const [content, setContent] = useState<(ShareContent & { imageUrl: string }) | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState<'link' | 'copy' | 'save' | null>(null);
  const preparing = !!confirmation && loading && !confirmationRequired && !uploadConfirmed && !content && !errorKey;
  const alive = useRef(false);
  const busyRef = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    onPreparingChange?.(preparing);
    return () => onPreparingChange?.(false);
  }, [onPreparingChange, preparing]);
  useEffect(() => {
    if (confirmationRequired && !uploadConfirmed) return;
    alive.current = true;
    const current = ++generation.current;
    setLoading(true);
    setErrorKey(null);
    busyRef.current = true;
    setBusy(null);
    void load({ includeAttribution: allowAttribution && includeAttribution }, uploadConfirmed)
      .then(async (value) => {
        if (!alive.current || generation.current !== current) return;
        if ('confirmationRequired' in value) {
          setConfirmationRequired(true);
          setLoading(false);
          busyRef.current = false;
          return;
        }
        const imageUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(value.imageSvg)}`;
        const image = new Image();
        image.src = imageUrl;
        let failed = false;
        try {
          // Keep the displayed image until its replacement is ready to paint.
          await image.decode?.();
        } catch {
          failed = true;
        }
        if (!alive.current || generation.current !== current) return;
        setContent({ ...value, imageUrl });
        setPreviewFailed(failed);
        setLoading(false);
        busyRef.current = false;
      })
      .catch((error) => {
        if (!alive.current || generation.current !== current) return;
        const code = extractIpcError(error)?.code;
        setErrorKey(
          code === 'SHARE_NOT_CONFIGURED'
            ? 'sharing.notConfigured'
            : code === 'PRECONDITION_FAILED'
              ? changedErrorKey
              : code === 'SHARE_UNAVAILABLE'
                ? 'sharing.unavailable'
                : 'sharing.loadFailed',
        );
        setLoading(false);
        busyRef.current = false;
      });
    return () => {
      alive.current = false;
      generation.current += 1;
    };
  }, [load, revision, allowAttribution, includeAttribution, confirmationRequired, uploadConfirmed, changedErrorKey]);

  const run = async (action: 'link' | 'copy' | 'save') => {
    if (!content || loading || errorKey || busyRef.current) return;
    busyRef.current = true;
    setBusy(action);
    const current = generation.current;
    const active = () => alive.current && generation.current === current;
    try {
      if (action === 'link') {
        await window.electronAPI.copyTextToClipboard({ text: content.url });
        if (active()) toast.success(t('sharing.linkCopied'));
        return;
      }
      const blob = await svgToPngBlob(content.imageSvg, { scale: 2 });
      if (!active()) return;
      if (action === 'copy') {
        await copyPngBlobToClipboard(blob);
        if (active()) toast.success(t('sharing.imageCopied'));
      } else {
        const url = await blobToDataUrl(blob);
        if (!active()) return;
        const result = await window.electronAPI.saveMediaAs({ url });
        if (active() && !result.canceled) toast.success(t('sharing.imageSaved'));
      }
    } catch {
      if (active())
        toast.error(
          t(
            action === 'link'
              ? 'sharing.copyLinkFailed'
              : action === 'save'
                ? 'sharing.saveImageFailed'
                : 'sharing.copyImageFailed',
          ),
        );
    } finally {
      if (active()) {
        busyRef.current = false;
        setBusy(null);
      }
    }
  };
  return (
    <Dialog.Root
      open={!preparing}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-[10000]" style={WINDOW_DRAG_STYLE}>
          <Dialog.Content
            ref={contentRef}
            tabIndex={-1}
            aria-describedby={undefined}
            className="modal-panel fixed inset-0 z-[10000] m-auto flex h-fit max-h-[85vh] w-[min(460px,calc(100vw-32px))] flex-col overflow-y-auto overscroll-contain p-4 text-[var(--text-primary)]"
            style={WINDOW_NO_DRAG_STYLE}
            onPointerDownOutside={(event) => event.preventDefault()}
            onInteractOutside={(event) => event.preventDefault()}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              contentRef.current?.focus();
            }}
            onCloseAutoFocus={(event) => {
              if (restoreFocus) {
                event.preventDefault();
                restoreFocus();
              }
            }}
          >
            <Dialog.Title className="pr-10 text-18 font-medium text-[var(--confirm-title)]">
              {t('sharing.title')}
            </Dialog.Title>
            <Tip text={t('sharing.close')} contentClassName="z-[10001]">
              <Button
                variant="secondary"
                tone="quiet"
                aria-label={t('sharing.close')}
                className="absolute right-3 top-3 w-8 px-0"
                onClick={close}
              >
                <X size={16} aria-hidden />
              </Button>
            </Tip>
            {allowAttribution && !confirmationRequired ? (
              <div className="mt-4 flex items-center justify-between gap-4">
                <label htmlFor={attributionId} className="text-13 text-[var(--text-secondary)]">
                  {t('sharing.includeAttribution')}
                </label>
                <Switch
                  id={attributionId}
                  checked={includeAttribution}
                  disabled={busy !== null}
                  onCheckedChange={(checked) => {
                    generation.current += 1;
                    busyRef.current = true;
                    setLoading(true);
                    setIncludeAttribution(checked);
                  }}
                />
              </div>
            ) : null}
            {confirmationRequired && confirmation ? (
              <div className="mt-5">
                <p className="text-13 leading-relaxed text-[var(--text-secondary)]">{confirmation.message}</p>
                <Button variant="cta" className="mt-4" onClick={() => {
                  setConfirmationRequired(false);
                  setUploadConfirmed(true);
                }}>{confirmation.label}</Button>
              </div>
            ) : null}
            {!confirmationRequired && errorKey ? (
              <div role="alert" className="mt-5 text-13">
                <p>{t(errorKey)}</p>
                {errorKey === 'sharing.loadFailed' ? (
                  <Button
                    variant="secondary"
                    className="mt-3"
                    onClick={() => setRevision((value) => value + 1)}
                  >
                    {t('sharing.retry')}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {!confirmationRequired && (content || !errorKey) ? (
              <>
                <div
                  aria-busy={loading || undefined}
                  className="relative mt-5 aspect-square w-full shrink-0 overflow-hidden rounded-lg border border-[var(--border-default)]"
                >
                  {content ? (
                    <img
                      className="h-full w-full"
                      width={1080}
                      height={1080}
                      decoding="sync"
                      src={content.imageUrl}
                      onError={() => setPreviewFailed(true)}
                      alt={t('sharing.imageAlt', { name: content.title })}
                    />
                  ) : (
                    <div
                      role="status"
                      className="absolute inset-0 flex items-center justify-center gap-2 text-13"
                    >
                      <Spinner size={16} />
                      {loadingLabel ?? t('sharing.loading')}
                    </div>
                  )}
                </div>
                {previewFailed ? (
                  <p role="status" className="mt-2 text-13 text-[var(--text-secondary)]">
                    {t('sharing.previewFailed')}
                  </p>
                ) : null}
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-12 text-[var(--text-secondary)]">
                    {t('sharing.imageLabel')}
                  </span>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      compact
                      disabled={!content || loading || !!errorKey || busy !== null}
                      loading={busy === 'copy'}
                      onClick={() => void run('copy')}
                    >
                      <Copy size={14} aria-hidden />
                      {t('sharing.copyImage')}
                    </Button>
                    <Button
                      variant="secondary"
                      compact
                      disabled={!content || loading || !!errorKey || busy !== null}
                      loading={busy === 'save'}
                      onClick={() => void run('save')}
                    >
                      <Download size={14} aria-hidden />
                      {t('sharing.saveImage')}
                    </Button>
                  </div>
                </div>
                <div className="mt-4 border-t border-[var(--border-default)] pt-4">
                  <label htmlFor={linkId} className="text-12 text-[var(--text-secondary)]">
                    {t('sharing.linkLabel')}
                  </label>
                  <div className="mt-2 flex items-center gap-2">
                    <Input
                      id={linkId}
                      size="sm"
                      className="min-w-0 flex-1"
                      value={content?.url ?? ''}
                      disabled={!content || loading || !!errorKey}
                      onChange={() => {}}
                      readOnly
                      onFocus={(event) => event.target.select()}
                    />
                    <Button
                      variant="cta"
                      compact
                      disabled={!content || loading || !!errorKey || busy !== null}
                      loading={busy === 'link'}
                      onClick={() => void run('link')}
                    >
                      <Copy size={14} aria-hidden />
                      {t('sharing.copyLink')}
                    </Button>
                  </div>
                </div>
                <p className="mt-3 text-12 leading-relaxed text-[var(--text-tertiary)]">
                  {recipientHint ?? t('sharing.recipientHint')}
                </p>
              </>
            ) : null}
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
