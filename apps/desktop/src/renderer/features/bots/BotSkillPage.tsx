import { useEffect, useMemo, useState, type MutableRefObject } from 'react';
import { ChevronRight, PenLine } from 'lucide-react';

import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Input, Textarea } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { extractIpcError } from '@/utils/ipcError';
import type { BotCoreSkill, BotSkillDetail } from '../../../shared/botSkill';
import type { BotSystemSkillId } from '../../../shared/botSystemSkills';
import { useBotTranslation } from './botPronounContext';
import type { BotProfile } from './botStore';
import { useBotSettingsTarget } from './useBotSettingsTarget';

export type BotSkillPageView =
  | { type: 'core' }
  | { type: 'system'; id: BotSystemSkillId }
  | { type: 'learned'; slug: string; editing?: boolean };

const CORE_ITEMS = ['tasks', 'teammates', 'models', 'memory', 'self'] as const;
const DESCRIPTION_MAX = 280;
const BODY_MAX = 64 * 1024;

/**
 * A Skill's own page inside the capability page: the shared core (read-only), a system Skill and
 * what turning it off stops, or a learned Skill to turn off, edit or delete. The settings page's
 * back button returns to the list (BotCapabilitySettings `backRef`).
 */
export function BotSkillPage({ bot, view, onView, systemSkillOn, onSystemSkillChange, onLearnedChanged, editorDirtyRef }: {
  bot: BotProfile;
  view: BotSkillPageView;
  onView: (view: BotSkillPageView | null) => void;
  systemSkillOn: (id: BotSystemSkillId) => boolean;
  onSystemSkillChange?: (id: BotSystemSkillId, on: boolean) => void;
  onLearnedChanged: () => void;
  /** Set while a learned Skill is being edited: whether the draft differs from what was opened. */
  editorDirtyRef?: MutableRefObject<(() => boolean) | null>;
}) {
  if (view.type === 'core') return <CorePage />;
  if (view.type === 'system') {
    return <SystemPage id={view.id} on={systemSkillOn(view.id)} onChange={onSystemSkillChange} />;
  }
  return <LearnedPage bot={bot} slug={view.slug} editing={Boolean(view.editing)}
    onEdit={(editing) => onView({ ...view, editing })} onDeleted={() => { onLearnedChanged(); onView(null); }}
    onChanged={onLearnedChanged} editorDirtyRef={editorDirtyRef} />;
}

function Heading({ title, meta }: { title: string; meta: string }) {
  return (
    <>
      <h3 className="break-words text-16 font-medium leading-[1.45] text-[var(--text-primary)] [overflow-wrap:anywhere]">{title}</h3>
      <p className="mt-1 text-12 leading-[1.5] text-[var(--text-secondary)]">{meta}</p>
    </>
  );
}

function SwitchCard({ title, hint, checked, disabled, onChange }: {
  title: string; hint: string; checked: boolean; disabled?: boolean; onChange: (on: boolean) => void;
}) {
  return (
    <div className="mt-4 flex items-center gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-13 font-medium leading-[1.45] text-[var(--text-primary)]">{title}</p>
        <p className="mt-0.5 text-12 leading-[1.5] text-[var(--text-secondary)]">{hint}</p>
      </div>
      <Switch aria-label={title} className="shrink-0" checked={checked} disabled={disabled}
        onCheckedChange={(value) => onChange(value === true)} />
    </div>
  );
}

function CorePage() {
  const { t } = useBotTranslation();
  const target = useBotSettingsTarget();
  const [core, setCore] = useState<BotCoreSkill | null>(null);
  useEffect(() => {
    let live = true;
    target.skills?.core().then((value) => { if (live) setCore(value); }).catch(() => {});
    return () => { live = false; };
  }, [target]);
  return (
    <article className="animate-fade-in pt-1">
      <Heading title={t('bots.capabilities.core.name')} meta={t('bots.capabilities.core.meta')} />
      <p className="mt-3 text-13 leading-[1.6] text-[var(--text-secondary)]">{t('bots.capabilities.core.note')}</p>
      <p className="px-1 pb-2 pt-5 text-12 font-medium leading-[1.33] text-[var(--text-secondary)]">{t('bots.capabilities.core.covers')}</p>
      <ul className="divide-y divide-[var(--border-default)] overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
        {CORE_ITEMS.map((item) => (
          <li key={item} className="px-4 py-3">
            <p className="text-13 font-medium leading-[1.45] text-[var(--text-primary)]">{t(`bots.capabilities.core.items.${item}.title`)}</p>
            <p className="mt-0.5 text-12 leading-[1.5] text-[var(--text-secondary)]">{t(`bots.capabilities.core.items.${item}.body`)}</p>
          </li>
        ))}
      </ul>
      {core ? (
        <details className="group mt-4">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-[4px] text-12 font-medium text-[var(--text-secondary)] outline-none hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] [&::-webkit-details-marker]:hidden">
            <ChevronRight size={12} aria-hidden className="transition-transform duration-fast group-open:rotate-90" />
            {t('bots.capabilities.core.raw')}
          </summary>
          <pre className="mt-2 max-h-[320px] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-3 font-mono text-12 leading-[1.6] text-[var(--text-secondary)]">
            {core.body}
          </pre>
        </details>
      ) : null}
    </article>
  );
}

function SystemPage({ id, on, onChange }: { id: BotSystemSkillId; on: boolean; onChange?: (id: BotSystemSkillId, on: boolean) => void }) {
  const { t } = useBotTranslation();
  return (
    <article className="animate-fade-in pt-1">
      <Heading title={t(`bots.capabilities.system.items.${id}.name`)} meta={t('bots.capabilities.system.pageMeta')} />
      <SwitchCard title={t('bots.capabilities.system.use')} hint={t(`bots.capabilities.system.items.${id}.hint`)}
        checked={on} disabled={!onChange} onChange={(value) => onChange?.(id, value)} />
      <p className="px-1 pb-1 pt-5 text-12 font-medium leading-[1.33] text-[var(--text-secondary)]">{t('bots.capabilities.system.whenOff')}</p>
      <p className="px-1 text-13 leading-[1.6] text-[var(--text-secondary)]">{t(`bots.capabilities.system.items.${id}.off`)}</p>
    </article>
  );
}

function useUpdatedLabel() {
  const { t, i18n } = useBotTranslation();
  return useMemo(() => {
    const format = new Intl.DateTimeFormat(i18n?.language || undefined, { month: 'short', day: 'numeric' });
    return (iso: string) => {
      const date = new Date(iso);
      return Number.isNaN(date.getTime())
        ? t('bots.capabilities.learned.metaUndated')
        : t('bots.capabilities.learned.meta', { date: format.format(date) });
    };
  }, [i18n?.language, t]);
}

function LearnedPage({ bot, slug, editing, onEdit, onDeleted, onChanged, editorDirtyRef }: {
  bot: BotProfile;
  slug: string;
  editing: boolean;
  onEdit: (editing: boolean) => void;
  onDeleted: () => void;
  onChanged: () => void;
  editorDirtyRef?: MutableRefObject<(() => boolean) | null>;
}) {
  const { t } = useBotTranslation();
  const target = useBotSettingsTarget();
  const { confirm } = useConfirmDialog();
  const updated = useUpdatedLabel();
  const [detail, setDetail] = useState<BotSkillDetail | null | undefined>(undefined);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const skills = target.skills;

  useEffect(() => {
    let live = true;
    setDetail(undefined);
    skills?.read(bot.id, slug)
      .then((value) => { if (live) setDetail(value); })
      .catch(() => { if (live) setDetail(null); });
    return () => { live = false; };
  }, [skills, bot.id, slug, reload]);

  if (detail === undefined) {
    return <div className="flex justify-center py-10"><Spinner size={16} /></div>;
  }
  if (!detail || !skills) {
    return <p className="py-12 text-center text-13 text-[var(--text-secondary)]">{t('bots.capabilities.learned.missing')}</p>;
  }
  const enabled = detail.enabled !== false;

  const setEnabled = async (on: boolean) => {
    setBusy(true);
    try {
      await skills.setEnabled(bot.id, slug, on);
      setDetail({ ...detail, enabled: on });
      onChanged();
    } catch {
      toast.error(t('bots.capabilities.learned.saveFailed'));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    const ok = await confirm({
      presentation: 'standard',
      title: t('bots.capabilities.learned.deleteTitle', { name: detail.name }),
      description: t('bots.capabilities.learned.deleteBody'),
      confirmText: t('bots.capabilities.learned.delete'),
      cancelText: t('bots.capabilities.learned.cancel'),
      confirmVariant: 'destructive',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await skills.delete(bot.id, slug);
      onDeleted();
    } catch (error) {
      if (extractIpcError(error)?.code === 'NOT_FOUND') onDeleted();
      else toast.error(t('bots.capabilities.learned.deleteFailed'));
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return <LearnedEditor detail={detail} dirtyRef={editorDirtyRef} onCancel={() => onEdit(false)} onSave={async (next) => {
      try {
        await skills.save(bot.id, { slug, name: detail.name, ...next, expectedUpdatedAt: detail.updatedAt });
        onChanged();
        setReload((value) => value + 1);
        onEdit(false);
      } catch {
        // Keep the editor and its draft: the owner can retry, or cancel to see the saved version.
        toast.error(t('bots.capabilities.learned.saveFailed'));
      }
    }} />;
  }

  return (
    <article className="animate-fade-in pt-1">
      <Heading title={detail.name} meta={updated(detail.updatedAt)} />
      <SwitchCard title={t('bots.capabilities.learned.use')} hint={t('bots.capabilities.learned.useHint')}
        checked={enabled} disabled={busy} onChange={(on) => void setEnabled(on)} />
      {detail.description ? (
        <p className="mt-4 text-13 leading-[1.6] text-[var(--text-secondary)]">{detail.description}</p>
      ) : null}
      <div className="mt-3 text-14 leading-[1.75] text-[var(--text-primary)]">
        <MarkdownRenderer workingDir="" content={detail.body} allowPrivilegedLinks={false} />
      </div>
      <div className="mt-6 flex items-center gap-2 border-t border-[var(--border-default)] pt-4">
        <Button variant="secondary" size="md" onClick={() => onEdit(true)} disabled={busy}>
          <PenLine size={14} aria-hidden="true" />
          {t('bots.capabilities.learned.edit')}
        </Button>
        <span className="flex-1" />
        <Button variant="secondary" tone="quiet" size="md" onClick={() => void remove()} disabled={busy}>
          {t('bots.capabilities.learned.delete')}
        </Button>
      </div>
    </article>
  );
}

function LearnedEditor({ detail, dirtyRef, onCancel, onSave }: {
  detail: BotSkillDetail;
  dirtyRef?: MutableRefObject<(() => boolean) | null>;
  onCancel: () => void;
  onSave: (next: { description: string; body: string }) => Promise<void>;
}) {
  const { t } = useBotTranslation();
  const [description, setDescription] = useState(detail.description);
  const [body, setBody] = useState(detail.body);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!dirtyRef) return;
    dirtyRef.current = () => description.trim() !== detail.description || body !== detail.body;
    return () => { dirtyRef.current = null; };
  }, [dirtyRef, description, body, detail]);
  const invalid = !description.trim() || !body.trim() || body.length > BODY_MAX;
  return (
    <article className="animate-fade-in flex flex-col gap-3 pt-1">
      <h3 className="break-words text-16 font-medium leading-[1.45] text-[var(--text-primary)] [overflow-wrap:anywhere]">{detail.name}</h3>
      <label className="block">
        <span className="mb-1.5 ml-1 block text-12 text-[var(--text-secondary)]">{t('bots.capabilities.learned.descriptionLabel')}</span>
        <Input size="md" value={description} maxLength={DESCRIPTION_MAX} onChange={setDescription} error={!description.trim()} />
      </label>
      <label className="block">
        <span className="mb-1.5 ml-1 block text-12 text-[var(--text-secondary)]">{t('bots.capabilities.learned.bodyLabel')}</span>
        <Textarea rows={14} value={body} onChange={setBody} error={!body.trim() || body.length > BODY_MAX}
          className={cn('min-h-[260px] resize-y font-mono text-13 leading-[1.6]')} />
      </label>
      <div className="mt-1 flex items-center justify-end gap-2">
        <Button variant="secondary" tone="quiet" size="md" onClick={onCancel} disabled={saving}>
          {t('bots.capabilities.learned.cancel')}
        </Button>
        <Button variant="secondary" size="md" disabled={invalid || saving} loading={saving} onClick={() => {
          setSaving(true);
          void onSave({ description: description.trim(), body }).finally(() => setSaving(false));
        }}>
          {t('bots.capabilities.learned.save')}
        </Button>
      </div>
    </article>
  );
}
