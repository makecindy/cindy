import { useLayoutEffect, useRef, useState } from 'react';
import { Input, Textarea, type TextareaProps } from '@/components/ui/input';
import {
  GHOST_CARD_FORM_MAX_VALUE,
  mergeGhostCardFormValues,
  visibleMailAttachments,
  removeMailAttachment,
  canInsertMailImage,
  insertMailImage,
  mailPreviewImages,
  type GhostCardFormField,
} from '@cindy/maker-shared/ghost-card-form';
import { GhostCardRecipients } from './GhostCardRecipients';
import { MailHtmlPreview } from './MailHtmlPreview';
import { Maximize2, Paperclip, X } from 'lucide-react';
import { FileTypeIcon } from '@/components/ui/file-type-icon';
import { formatByteSize } from '@cindy/maker-shared/file-preview';
import { ImageLightbox } from './ImageLightbox';
import { useTranslation } from 'react-i18next';

/** Native card editor; autosaves never replace newer local edits. */
export function GhostCardForm({
  fields,
  disabled,
  readOnly = false,
  onChange,
  onAttach,
  images,
  expanded = false,
  onEnlarge,
}: {
  fields: GhostCardFormField[];
  disabled: boolean;
  readOnly?: boolean;
  onChange: (values: Record<string, string>) => void;
  onAttach?: (inline: boolean) => void;
  images?: { cid: string; url: string }[];
  expanded?: boolean;
  onEnlarge?: () => void;
}) {
  const { t } = useTranslation();
  const incoming = Object.fromEntries(fields.map((field) => [field.name, field.value]));
  const [base, setBase] = useState(incoming);
  const [values, setValues] = useState(incoming);
  const [preview, setPreview] = useState<string>();
  if (JSON.stringify(base) !== JSON.stringify(incoming)) {
    setBase(incoming);
    setValues(mergeGhostCardFormValues(values, base, incoming));
  }
  const change = (name: string, value: string) => {
    const next = { ...values, [name]: value };
    setValues(next);
    onChange(next);
  };
  return (
    <div className="flex flex-wrap gap-x-2 p-3">
      {fields.map((field) => {
        if (field.kind === 'hidden') return null;
        if (field.kind === 'mail-html')
          return (
            <MailHtmlPreview
              key={field.name}
              value={values[field.name]}
              images={mailPreviewImages(values, images)}
              disabled={disabled}
              reading={expanded}
              onEnlarge={onEnlarge}
              onChange={
                readOnly
                  ? undefined
                  : (html, text) => {
                      const plain = field.name === 'quoteHtml' ? 'quote' : 'body';
                      const next = {
                        ...values,
                        [field.name]: html,
                        ...(plain in values ? { [plain]: text } : {}),
                      };
                      setValues(next);
                      onChange(next);
                    }
              }
            />
          );
        if (field.kind === 'mail-attachments') {
          const files = visibleMailAttachments(values, field.name);
          if (!files.length && (readOnly || !onAttach)) return null;
          return (
            <div key={field.name} className="flex w-full items-start gap-2 py-2">
              {!readOnly && onAttach && (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onAttach(false)}
                  aria-label={t('chat.ghostCall.mailAttach')}
                  title={t('chat.ghostCall.mailAttach')}
                  className={
                    (files.length ? 'mt-3 ' : '') +
                    'shrink-0 rounded p-1 text-muted-foreground hover:bg-[var(--surface-hover)] disabled:opacity-40'
                  }
                >
                  <Paperclip className="h-4 w-4" />
                </button>
              )}
              <div className="flex min-w-0 flex-1 flex-wrap gap-2">
                {files.map((file) => (
                  <div
                    key={file.key}
                    className="inline-flex max-w-full items-center gap-1 rounded-lg border border-border bg-[var(--surface)] text-12"
                  >
                    <button
                      type="button"
                      disabled={!file.previewUrl}
                      onClick={() => setPreview(file.previewUrl)}
                      title={file.filename}
                      className="flex min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-left enabled:hover:bg-[var(--surface-hover)]"
                    >
                      {file.previewUrl ? (
                        <img
                          src={file.previewUrl}
                          alt=""
                          className="h-9 w-9 shrink-0 rounded object-cover"
                        />
                      ) : (
                        <FileTypeIcon name={file.filename} mimeType={file.mimeType} size={20} />
                      )}
                      <span className="min-w-0">
                        <span className="block truncate">{file.filename}</span>
                        <span className="block text-muted-foreground">
                          {file.filename.split('.').pop()?.toUpperCase()}
                          {file.bytes !== undefined ? ' · ' + formatByteSize(file.bytes) : ''}
                        </span>
                      </span>
                    </button>
                    {!readOnly && canInsertMailImage(values, file) && (
                      <button
                        type="button"
                        disabled={disabled}
                        className="shrink-0 rounded px-2 py-2 text-muted-foreground hover:bg-[var(--surface-hover)] disabled:opacity-40"
                        onClick={() => {
                          const next = insertMailImage(values, field.name, file.key);
                          setValues(next);
                          onChange(next);
                        }}
                      >
                        {t('chat.ghostCall.mailInsertImage')}
                      </button>
                    )}
                    {!readOnly && (
                      <button
                        type="button"
                        disabled={disabled}
                        className="mr-1 rounded p-2 text-muted-foreground hover:bg-[var(--surface-hover)] disabled:opacity-40"
                        title={t('chat.ghostCall.mailRemoveAttachment', { name: file.filename })}
                        aria-label={t('chat.ghostCall.mailRemoveAttachment', {
                          name: file.filename,
                        })}
                        onClick={() => {
                          const next = removeMailAttachment(values, field.name, file.key);
                          setValues(next);
                          onChange(next);
                        }}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        }
        if (field.kind === 'recipients') {
          const group = fields.filter(
            (f) => f.kind === 'recipients' && (!readOnly || values[f.name]?.trim()),
          );
          if (group[0] !== field) return null;
          return (
            <GhostCardRecipients
              key={field.name}
              fields={group.map((f) => ({ ...f, value: values[f.name] }))}
              disabled={disabled || readOnly}
              readOnly={readOnly}
              onChange={change}
            />
          );
        }
        const control = readOnly ? (
          <div className="whitespace-pre-wrap break-words p-1 text-13 text-foreground">
            {values[field.name]}
          </div>
        ) : field.multiline ? (
          <CardTextarea
            expanded={expanded}
            aria-label={field.label}
            disabled={disabled || readOnly}
            value={values[field.name]}
            maxLength={GHOST_CARD_FORM_MAX_VALUE}
            rows={field.collapsed ? 4 : 3}
            className="min-h-0 border-transparent bg-transparent p-1 shadow-none"
            onChange={(value) => change(field.name, value)}
          />
        ) : (
          <Input
            aria-label={field.label}
            disabled={disabled || readOnly}
            value={values[field.name]}
            maxLength={GHOST_CARD_FORM_MAX_VALUE}
            size="sm"
            inputClassName="border-transparent bg-transparent shadow-none"
            onChange={(value) => change(field.name, value)}
          />
        );
        if (field.collapsed)
          return (
            <details key={field.name} className="w-full text-12 text-muted-foreground">
              <summary className="cursor-pointer py-2">{field.label}</summary>
              {control}
            </details>
          );
        return (
          <div
            key={field.name}
            className={
              (field.row ? 'min-w-0 flex-[1_1_220px] ' : 'w-full ') +
              (field.multiline
                ? 'py-2'
                : 'flex min-w-0 items-center gap-2 border-b border-border py-1')
            }
          >
            {!field.multiline && (
              <span aria-hidden className="shrink-0 text-12 text-muted-foreground">
                {field.label}
              </span>
            )}
            <div className="min-w-0 flex-1">
              {field.name === 'body' && onEnlarge && !expanded && (
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={onEnlarge}
                    title={t('chat.ghostCall.mailEnlarge')}
                    aria-label={t('chat.ghostCall.mailEnlarge')}
                    className="rounded p-1 text-muted-foreground hover:bg-[var(--surface-hover)]"
                  >
                    <Maximize2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
              {control}
            </div>
          </div>
        );
      })}
      {preview && <ImageLightbox src={preview} onClose={() => setPreview(undefined)} />}
    </div>
  );
}

/** Grow with the draft and card width so signatures are visible during review. */
function CardTextarea({ expanded = false, ...props }: TextareaProps & { expanded?: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    const fit = () => {
      if (!input.clientWidth) return;
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight + 2, expanded ? Infinity : 440)}px`;
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    let width = input.clientWidth;
    const observer = new ResizeObserver(() => {
      if (input.clientWidth !== width) {
        width = input.clientWidth;
        fit();
      }
    });
    observer.observe(input);
    return () => observer.disconnect();
  }, [props.value, expanded]);
  return <Textarea {...props} textareaRef={ref} />;
}
