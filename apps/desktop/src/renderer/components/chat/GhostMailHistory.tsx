import { useTranslation } from 'react-i18next';
import { visibleMailAttachments, mailPreviewImages, type GhostCardFormField } from '@cindy/maker-shared/ghost-card-form';
import { MailHtmlPreview } from './MailHtmlPreview';

/** Historical snapshots are readable text, never a second composer. */
export function GhostMailHistory({ fields, legacy = false }: { fields: GhostCardFormField[]; legacy?: boolean }) {
  const { t } = useTranslation();
  const values = Object.fromEntries(fields.map(field => [field.name, field.value]));
  return <details className="rounded-xl border border-border bg-[var(--surface-elevated)] text-sm">
    <summary className="cursor-pointer px-3 py-2 text-muted-foreground">
      {t(legacy ? 'chat.ghostCall.mailLegacy' : 'chat.ghostCall.mailUpdated')}
      {' · '}{fields.find(f => f.name === 'subject')?.value}
    </summary>
    <dl className="space-y-3 border-t border-border px-3 py-3">
      {fields.filter(f => f.value && f.kind !== 'hidden' && (f.kind !== 'mail-attachments' || visibleMailAttachments(values, f.name).length)).map(field => <div key={field.name}>
        <dt className="text-12 text-muted-foreground">{field.label}</dt>
        <dd className="whitespace-pre-wrap break-words">{field.kind === 'mail-html' ? <MailHtmlPreview value={field.value} images={mailPreviewImages(values)} /> : field.kind === 'mail-attachments' ? visibleMailAttachments(values, field.name).map(a => a.filename).join(' · ') : field.value}</dd>
      </div>)}
    </dl>
  </details>;
}
