import { useEffect, useState } from 'react';
import type { MediaModelRef, TeammateMediaModels, TeammateMediaCatalog } from '@cindy/maker-shared/teammate-media-models';
import { Select } from '@/components/ui/select';
import { FormField } from '@/components/ui/form-field';
import { Button } from '@/components/ui/button';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { useBotSettingsTarget } from './useBotSettingsTarget';
import { useBotTranslation } from './botPronounContext';

const key = (ref: MediaModelRef) => JSON.stringify([ref.providerId, ref.modelId]);

/** Shares the execution owner's configured catalog on local and remote Desktop. */
export function BotMediaModelEditor({ value, onChange }: {
  value: TeammateMediaModels | null;
  onChange(value: TeammateMediaModels | null): void;
}) {
  const { t } = useBotTranslation();
  const target = useBotSettingsTarget();
  const [catalog, setCatalog] = useState<TeammateMediaCatalog | null>(null);
  const [failed, setFailed] = useState(false);
  const [revision, refresh] = useState(0);
  useEffect(() => {
    let active = true;
    const owner = getDataOwnerGeneration();
    setCatalog(null);
    setFailed(false);
    target.mediaModels?.().then(next => {
      if (active && isDataOwnerGenerationCurrent(owner)) { setCatalog(next); setFailed(Boolean(next.unavailable?.length)); }
    }, () => { if (active && isDataOwnerGenerationCurrent(owner)) setFailed(true); });
    return () => { active = false; };
  }, [target, revision]);
  if (!target.mediaModels) return null;
  const select = (kind: 'vision' | 'image' | 'video', label: string, current: MediaModelRef | null | undefined,
    change: (ref: MediaModelRef | null) => void, empty = t('bots.mediaModels.inherit')) => {
    const rows = catalog?.[kind] ?? [];
    const options = [{ value: 'inherit', label: empty }, ...rows.map(ref => ({ value: key(ref), label: ref.label }))];
    if (current && !rows.some(ref => key(ref) === key(current))) options.push({ value: key(current), label: `${current.modelId} · ${current.providerId}` });
    return <FormField label={label} key={label}>{control => <Select {...control} label={label}
      disabled={!target.online || (!catalog && !current)} value={current ? key(current) : 'inherit'} options={options}
      className="h-auto min-h-10 w-full py-2 [&>span:first-child]:whitespace-normal [&>span:first-child]:break-words [&>span:first-child]:overflow-visible [&>span:first-child]:text-clip" onValueChange={id => {
        if (id === 'inherit') change(null);
        else { const selected = rows.find(ref => key(ref) === id); if (selected) change(selected); }
      }} />}</FormField>;
  };
  const patch = (next: TeammateMediaModels) => onChange(Object.values(next).some(Boolean) ? next : null);
  return <div className="mt-4 min-w-0 space-y-4 border-t border-[var(--border-default)] pt-4">
    <p className="text-12 leading-5 text-[var(--text-secondary)]">{t('bots.mediaModels.hint')}</p>
    {failed && <div className="space-y-2"><p role="alert" className="text-12 leading-5 text-[var(--text-secondary)]">{t('bots.mediaModels.unavailable')}</p><Button size="sm" variant="secondary" onClick={() => refresh(n => n + 1)}>{t('commonUi.retry')}</Button></div>}
    {select('vision', t('bots.mediaModels.vision'), value?.vision?.primary, primary => patch({ ...value,
      vision: primary ? { primary: { providerId: primary.providerId, modelId: primary.modelId }, fallback: value?.vision?.fallback ?? null } : null }))}
    {value?.vision && select('vision', t('bots.mediaModels.fallback'), value.vision.fallback, fallback => patch({ ...value,
      vision: { primary: value.vision!.primary, fallback: fallback ? { providerId: fallback.providerId, modelId: fallback.modelId } : null } }), t('bots.mediaModels.none'))}
    {(['image', 'video'] as const).map(kind => select(kind, t(`bots.mediaModels.${kind}`), value?.[kind], ref => patch({ ...value,
      [kind]: ref ? { providerId: ref.providerId, modelId: ref.modelId } : null })))}
  </div>;
}
