import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Maximize2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { externalMailImageUrl, hasMailExternalImages, mailInlineDocument, safeMailDocument, validMailImageUrl } from '@cindy/maker-shared/mail-text-edit';
import { Button } from '@/components/ui/button';
import { useSidebarTargetSessionId } from '@/features/cc-agent/embeddedSessionNavigation';
import { useChatSessionFile } from './ChatSessionFileContext';
import { activateMessageUrl } from './useOpenWithMenu';
import { followMailPreviewTheme, mailPreviewLinkUrl } from './mailPreviewAppearance';
import { mailBodySerializer } from './mailBodyEditing';

export const safeMailHtml = safeMailDocument;
type PreviewProps = { value: string; images?: { cid: string; url: string }[]; disabled?: boolean; reading?: boolean; onEnlarge?: () => void; onChange?: (html: string, text: string) => void };
function PreviewFrame({ value, images = [], enlarged = false, reading = false, disabled, onChange, allowExternalImages = false }: PreviewProps & { enlarged?: boolean; allowExternalImages?: boolean }) {
  const { t } = useTranslation();
  const { sessionId } = useChatSessionFile();
  const sidebarTargetSessionId = useSidebarTargetSessionId(sessionId);
  const frame = useRef<HTMLIFrameElement>(null);
  const boundDocument = useRef<Document | undefined>(undefined);
  const stopTheme = useRef<(() => void) | undefined>(undefined);
  const bodyResize = useRef<ResizeObserver | undefined>(undefined);
  useLayoutEffect(() => () => { stopTheme.current?.(); bodyResize.current?.disconnect(); }, []);
  const model = useRef({ emitted: value, received: value, revision: 0 });
  if (model.current.received !== value) {
    if (value !== model.current.emitted) model.current = { emitted: value, received: value, revision: model.current.revision + 1 };
    else model.current.received = value;
  }
  const current = useRef({ disabled, onChange, images, reading, sidebarTargetSessionId, t });
  current.current = { disabled, onChange, images, reading, sidebarTargetSessionId, t };
  const revision = model.current.revision;
  // Keep the browsing context alive in both views. Other-view autosaves update
  // its sanitized DOM before paint rather than navigating through a blank page.
  const [html] = useState(() => mailInlineDocument(value, images, allowExternalImages));
  const ready = useRef(false);
  const serialize = useRef<ReturnType<typeof mailBodySerializer> | undefined>(undefined);
  const fit = () => {
    const el = frame.current, doc = el?.contentDocument;
    if (el && doc?.body && !enlarged) {
      el.style.height = '0px';
      const height = Math.ceil(Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight, doc.body.getBoundingClientRect().bottom)) + 12;
      el.style.height = `${Math.max(80, Math.min(reading ? Infinity : 440, height))}px`;
    }
  };
  const refresh = () => {
    const doc = frame.current?.contentDocument;
    if (!ready.current || !doc?.body) return;
    for (const el of doc.querySelectorAll<HTMLElement>('[data-cindy-mail-run]')) {
      el.removeAttribute('contenteditable');
    }
    doc.body.contentEditable = current.current.onChange && !current.current.disabled ? 'true' : 'false';
    doc.body.spellcheck = true;
    for (const el of doc.querySelectorAll<HTMLImageElement>('img[data-cindy-mail-cid]')) {
      const image = current.current.images.find(i => i.cid === el.getAttribute('data-cindy-mail-cid'));
      if (image && validMailImageUrl(image.url)) el.src = image.url;
    }
    if (allowExternalImages) for (const el of doc.querySelectorAll<HTMLImageElement>('img[data-cindy-mail-external-src]')) {
      const url = externalMailImageUrl(el.getAttribute('data-cindy-mail-external-src') || '');
      if (url && el.getAttribute('src') !== url) el.src = url;
    }
  };
  const applySource = (replaceContents = true) => {
    const doc = frame.current?.contentDocument;
    if (!ready.current || !doc?.body || !doc.head) return;
    const scroll = [doc.documentElement.scrollTop, doc.body.scrollTop];
    stopTheme.current?.();
    if (replaceContents) {
      const next = new DOMParser().parseFromString(mailInlineDocument(model.current.emitted, current.current.images, allowExternalImages), 'text/html');
      for (const [target, source] of [[doc.documentElement, next.documentElement], [doc.head, next.head], [doc.body, next.body]]) {
        for (const attr of [...target.attributes]) target.removeAttribute(attr.name);
        for (const attr of source.attributes) target.setAttribute(attr.name, attr.value);
      }
      doc.head.replaceChildren(...[...next.head.childNodes].map(node => doc.importNode(node, true)));
      doc.body.replaceChildren(...[...next.body.childNodes].map(node => doc.importNode(node, true)));
    }
    serialize.current = mailBodySerializer(doc, model.current.emitted, () => current.current.images);
    stopTheme.current = followMailPreviewTheme(doc, document, current.current.reading && !current.current.onChange);
    bodyResize.current?.disconnect();
    if (!enlarged && typeof ResizeObserver !== 'undefined') {
      bodyResize.current = new ResizeObserver(fit);
      bodyResize.current.observe(doc.body);
    }
    refresh(); fit();
    doc.documentElement.scrollTop = scroll[0]; doc.body.scrollTop = scroll[1];
  };
  useLayoutEffect(applySource, [revision, reading, Boolean(onChange)]);
  useEffect(refresh, [disabled, Boolean(onChange), JSON.stringify(images)]);
  useEffect(() => {
    if (!frame.current || typeof ResizeObserver === 'undefined') return;
    let width = -1;
    const observer = new ResizeObserver(entries => {
      const next = entries[0]?.contentRect.width;
      if (next !== width) { width = next; fit(); }
    }); observer.observe(frame.current);
    return () => observer.disconnect();
  }, [enlarged, reading]);
  // Hide only the initial load. Synchronized content never hides/remounts it.
  return <iframe ref={frame} title={t('chat.ghostCall.mailPreview')} sandbox="allow-same-origin" scrolling={reading ? 'no' : undefined}
    className="block w-full border-0" aria-busy="true"
    style={{ height: enlarged ? '100%' : 120, visibility: 'hidden', backgroundColor: 'transparent' }} srcDoc={html}
    onLoad={() => {
      const doc = frame.current?.contentDocument;
      if (!doc?.body || !doc.head) return;
      if (boundDocument.current === doc) return;
      boundDocument.current = doc;
      ready.current = true;
      applySource(mailInlineDocument(model.current.emitted, current.current.images, allowExternalImages) !== html);
      let composing = false;
      const update = () => {
        if (composing || current.current.disabled || !current.current.onChange) return;
        const next = serialize.current?.();
        if (!next) return;
        model.current.emitted = next.html;
        current.current.onChange(next.html, next.text); fit();
      };
      doc.addEventListener('compositionstart', () => { composing = true; });
      doc.addEventListener('compositionend', () => { composing = false; update(); });
      doc.addEventListener('input', update);
      const openLink = (event: MouseEvent) => {
        const link = (event.target as Element).closest('a');
        if (!link) return;
        event.preventDefault();
        const href = mailPreviewLinkUrl(link.getAttribute('href'));
        if (current.current.reading && !current.current.onChange && href) {
          void activateMessageUrl(event, current.current.sidebarTargetSessionId, href, current.current.t);
        }
      };
      doc.addEventListener('click', openLink);
      doc.addEventListener('auxclick', event => { if (event.button === 1) openLink(event); });
      doc.addEventListener('drop', event => event.preventDefault());
      doc.addEventListener('paste', event => {
        if (!current.current.onChange || current.current.disabled) return;
        event.preventDefault(); doc.execCommand('insertText', false, event.clipboardData?.getData('text/plain') || '');
      });
      doc.addEventListener('load', fit, true);
      refresh(); fit();
      // The authored document can paint before iframe load. Reveal only after
      // preview colors are adapted; autosave echoes keep this revision visible.
      frame.current!.style.visibility = 'visible';
      frame.current!.setAttribute('aria-busy', 'false');
    }} />;
}

export function MailHtmlPreview(props: PreviewProps) {
  const [open, setOpen] = useState(false);
  const [externalImages, setExternalImages] = useState({ source: props.value, allowed: false });
  if (externalImages.source !== props.value) setExternalImages({ source: props.value, allowed: false });
  const hasExternalImages = useMemo(() => props.reading && !props.onChange && hasMailExternalImages(props.value), [props.reading, props.onChange, props.value]);
  const allowExternalImages = Boolean(hasExternalImages && externalImages.source === props.value && externalImages.allowed);
  const { t } = useTranslation();
  if (props.reading) return <>
    {hasExternalImages && !allowExternalImages && <div className="mb-3">
      <Button variant="secondary" size="sm" onClick={() => setExternalImages({ source: props.value, allowed: true })}>{t('mailReader.showExternalImages')}</Button>
    </div>}
    {/* A fresh document is required: removing a CSP meta cannot relax its policy. */}
    <PreviewFrame key={String(allowExternalImages)} {...props} allowExternalImages={allowExternalImages} />
  </>;
  return <div className="w-full min-w-0 py-2">
    <div className="mb-1 flex justify-end gap-2">
      <button type="button" title={t('chat.ghostCall.mailEnlarge')} aria-label={t('chat.ghostCall.mailEnlarge')}
        className="rounded p-1 text-muted-foreground hover:bg-[var(--surface-hover)]" onClick={props.onEnlarge ?? (() => setOpen(true))}><Maximize2 className="h-3.5 w-3.5" /></button>
    </div>
    <PreviewFrame {...props} />
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-50" />
        <Dialog.Content aria-describedby={undefined} onPointerDownOutside={event => event.preventDefault()} className="modal-panel fixed left-1/2 top-1/2 z-50 flex h-[85vh] w-[min(960px,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col p-4">
          <div className="mb-3 flex items-center justify-between">
            <Dialog.Title className="text-sm font-medium">{t('chat.ghostCall.mailPreview')}</Dialog.Title>
            <Dialog.Close aria-label={t('chat.lightbox.close')} className="rounded p-1 text-muted-foreground hover:bg-[var(--surface-hover)]"><X className="h-4 w-4" /></Dialog.Close>
          </div>
          <div className="min-h-0 flex-1"><PreviewFrame {...props} enlarged /></div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </div>;
}
