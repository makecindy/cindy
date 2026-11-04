/**
 * 代输入 scan-to-sign-in on a computer: the QR code on the target window,
 * large enough to scan with a phone held up to this screen. The code arrives
 * with the sealed picture of the current revision (never in the snapshot) and
 * lives only in this component, which the dialog mounts once per revision; a
 * refreshed code is a new revision. A click on the code clicks the same spot
 * on the code in the window (for example "click to refresh" on an expired one).
 */

import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { Copy, ExternalLink, ImageDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  inputHandoffPresentation,
  inputHandoffQrLink,
  type InputHandoffPicture,
  type InputHandoffSnapshot,
} from '@cindy/device-link';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { openInputHandoffPicture, type InputHandoffPictureSession } from '@/lib/makerTransport';

export interface InputHandoffQrStepProps {
  sessionId: string;
  snapshot: InputHandoffSnapshot;
  busy: boolean;
  inputBlocked: boolean;
  onError: (message: string | null) => void;
}

/** The code's pixels as PNG for the clipboard (the clipboard takes PNG images only). */
async function pngOf(img: HTMLImageElement): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('NO_CANVAS');
  context.drawImage(img, 0, 0);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('NO_IMAGE'))), 'image/png'),
  );
}

export function InputHandoffQrStep({ sessionId, snapshot, busy, inputBlocked, onError }: InputHandoffQrStepProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<'loading' | 'shown' | 'sending' | 'failed'>('loading');
  const [picture, setPicture] = useState<InputHandoffPicture | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const opened = useRef<InputHandoffPictureSession | null>(null);
  const alive = useRef(true);
  const image = useRef<HTMLImageElement>(null);

  const load = useCallback(async () => {
    setState('loading');
    onError(null);
    try {
      const session = await openInputHandoffPicture(sessionId, inputHandoffPresentation(snapshot));
      // Closed while it loaded: end the exchange instead of leaving it open on the computer.
      if (!alive.current || !session.picture.qr) {
        session.close();
        setState('failed');
        return;
      }
      opened.current = session;
      setPicture(session.picture);
      setState('shown');
    } catch {
      setState('failed');
    }
  }, [onError, sessionId, snapshot]);

  useEffect(() => {
    alive.current = true;
    if (!inputBlocked) void load();
    return () => {
      alive.current = false;
      opened.current?.close();
      opened.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mounted once per revision by the dialog
  }, []);

  const tap = async (event: MouseEvent<HTMLButtonElement>) => {
    const session = opened.current;
    const rect = image.current?.getBoundingClientRect();
    // An agent's screenshot is not a window: there is nothing on screen to tap.
    if (snapshot.agentPicture || !session || !rect || rect.width <= 0 || rect.height <= 0 || state !== 'shown') return;
    opened.current = null;
    setState('sending');
    const clamp = (n: number) => Math.min(1, Math.max(0, n));
    try {
      const result = await session.answer({
        expectedRevision: snapshot.revision,
        values: {},
        action: {
          kind: 'tap',
          x: clamp((event.clientX - rect.left) / rect.width),
          y: clamp((event.clientY - rect.top) / rect.height),
        },
      });
      if (!result.accepted) retry(t('inputHandoff.error.stale'));
    } catch {
      retry(t('inputHandoff.error.submit'));
    }
  };

  // Each exchange answers once: after a failed tap, open a fresh one so the code works again.
  function retry(message: string) {
    if (!alive.current) return;
    void load();
    onError(message);
  }

  const qr = picture?.qr ?? null;
  const link = qr ? inputHandoffQrLink(qr) : null;
  // This computer opens web links only; an app link (weixin://…) is for the phone that scans the code.
  const openable = link?.web ? link : null;
  const copyText = () => {
    if (!qr) return;
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(qr.text))
      .then(() => setNotice(t('inputHandoff.qr.copied')))
      .catch(() => setNotice(t('inputHandoff.qr.copyFailed')));
  };
  const copyImage = () => {
    const img = image.current;
    if (!img) return;
    void pngOf(img)
      .then((blob) => navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]))
      .then(() => setNotice(t('inputHandoff.qr.imageCopied')))
      .catch(() => setNotice(t('inputHandoff.qr.copyFailed')));
  };
  const open = () => {
    if (!openable) return;
    void window.electronAPI
      .openExternal(openable.url)
      .then((result) => setNotice(result.success ? null : t('inputHandoff.qr.openFailed')))
      .catch(() => setNotice(t('inputHandoff.qr.openFailed')));
  };

  const src = picture ? `data:${picture.mime};base64,${picture.data}` : null;
  const disabled = busy || inputBlocked || state !== 'shown';
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex size-[240px] items-center justify-center overflow-hidden rounded-[12px] border border-[var(--border-default)] bg-[var(--surface-elevated)]">
        {src && (state === 'shown' || state === 'sending') ? (
          <button
            type="button"
            className="block size-full disabled:opacity-60"
            disabled={disabled}
            aria-label={t('inputHandoff.qr.alt')}
            data-testid="input-handoff-qr-code"
            onClick={(event) => void tap(event)}
          >
            <img
              ref={image}
              src={src}
              alt={t('inputHandoff.qr.alt')}
              draggable={false}
              className="block size-full select-none object-contain"
            />
          </button>
        ) : state === 'failed' ? (
          <button
            type="button"
            className="px-4 text-center text-13 text-[var(--text-secondary)]"
            disabled={busy || inputBlocked}
            onClick={() => void load()}
          >
            {t('inputHandoff.qr.failed')}
          </button>
        ) : (
          <p className="flex flex-col items-center gap-2 text-12 text-[var(--text-tertiary)]" role="status">
            <Spinner size={16} />
            {t('inputHandoff.qr.loading')}
          </p>
        )}
      </div>
      {/* An agent's screenshot does not continue by itself; the dialog header says to hand back. */}
      {!snapshot.agentPicture && (
        <p className="max-w-[360px] text-center text-12 leading-relaxed text-[var(--text-secondary)]">
          {t(openable ? 'inputHandoff.qr.hintLink' : 'inputHandoff.qr.hint')}
        </p>
      )}
      {/* Opening the link here comes first: many codes open an app straight from the browser. */}
      {openable && (
        <Button type="button" size="lg" variant="cta" palette="confirmation" className="w-full" disabled={disabled} onClick={open}>
          <ExternalLink size={14} aria-hidden />
          {t('inputHandoff.qr.open', { site: openable.site })}
        </Button>
      )}
      <div className="flex flex-wrap justify-center gap-2">
        <Button type="button" size="sm" variant="secondary" disabled={disabled} onClick={copyImage}>
          <ImageDown size={13} aria-hidden />
          {t('inputHandoff.qr.copyImage')}
        </Button>
        <Button type="button" size="sm" variant="secondary" disabled={disabled || !qr} onClick={copyText}>
          <Copy size={13} aria-hidden />
          {t(link ? 'inputHandoff.qr.copyLink' : 'inputHandoff.qr.copyText')}
        </Button>
      </div>
      {notice && (
        <p role="status" className="text-center text-12 text-[var(--text-secondary)]">
          {notice}
        </p>
      )}
    </div>
  );
}
