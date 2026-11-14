import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Button } from '@/components/ui/button';
import { ErrorNotice } from '@/components/ui/error-notice';
import { FormField } from '@/components/ui/form-field';
import { Textarea } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import type { CompanionProfileRepairDraft, CompanionProfileRepairRequest } from '../../../shared/companionCloud';
import { companionCloudApi, refreshCompanionCloud } from './companionCloudStore';
import { ensureBotProfilesLoaded } from './botStore';
import { CompanionCindyConflictAction, useCompanionCindyConflictAction } from './CompanionCindyConflictAction';

type Values = Extract<CompanionProfileRepairRequest, { action: 'save' }>['values'];
type Props = { botId: string; open: boolean; onOpenChange: (open: boolean) => void };
export function CompanionProfileRepairDialog(props: Props) {
  return props.open ? <RepairForm key={JSON.stringify([getDataOwnerGeneration(), props.botId])} {...props} /> : null;
}

function RepairForm({ botId, open, onOpenChange }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const conflict = useCompanionCindyConflictAction();
  const [draft, setDraft] = useState<CompanionProfileRepairDraft | null>(null);
  const [values, setValues] = useState<Values>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const load = useCallback(async () => {
    const owner = getDataOwnerGeneration();
    setLoading(true); setError(null); setChanged(false);
    try {
      const result = await companionCloudApi()?.repairCompanionProfile?.(botId, { action: 'read' });
      if (!isDataOwnerGenerationCurrent(owner)) return;
      if (!result?.ok || !result.draft) {
        setChanged(true);
        setError(result && !result.ok && result.profileRepairError === 'changed' ? 'changed' : 'loadFailed');
        return;
      }
      setDraft(result.draft);
      setValues(Object.fromEntries(result.draft.fields.map(field => [field.field, field.source])));
    } catch { if (isDataOwnerGenerationCurrent(owner)) { setChanged(true); setError('loadFailed'); } }
    finally { if (isDataOwnerGenerationCurrent(owner)) setLoading(false); }
  }, [botId]);
  useEffect(() => { void load(); }, [load]);
  const invalid = !draft || draft.fields.some(f => (values[f.field] ?? '').trim().length > f.maxLength);
  const save = async () => {
    if (!draft || invalid || savingRef.current || loading || changed) return;
    const owner = getDataOwnerGeneration();
    savingRef.current = true;
    setSaving(true); setError(null); conflict.clear();
    try {
      const result = await companionCloudApi()?.repairCompanionProfile?.(botId, { action: 'save', token: draft.token, values });
      if (!isDataOwnerGenerationCurrent(owner)) return;
      if (!result?.ok) {
        if (result) conflict.report(result);
        const stale = result && (result.profileRepairError === 'changed' || result.code === 'HOME_CONFLICT');
        setChanged(!!stale);
        setError(stale ? 'changed' : result && result.profileRepairError === 'backup' ? 'backupFailed' : 'saveFailed');
        refreshCompanionCloud();
        return;
      }
      await ensureBotProfilesLoaded(true);
      if (!isDataOwnerGenerationCurrent(owner)) return;
      refreshCompanionCloud(); onOpenChange(false);
      navigate(`/bots/${encodeURIComponent(botId)}`);
    } catch { if (isDataOwnerGenerationCurrent(owner)) setError('saveFailed'); }
    finally { savingRef.current = false; if (isDataOwnerGenerationCurrent(owner)) setSaving(false); }
  };
  return <ConfirmDialog open={open} onOpenChange={value => { if (!savingRef.current) onOpenChange(value); }}
    maxWidth={600} contentSelectable
    title={t('bots.cloud.repair.title')} description={t('bots.cloud.repair.description')}
    confirmText={t('bots.cloud.repair.save')} cancelText={t('bots.cancel')}
    loading={saving} confirmDisabled={loading || invalid || changed} onConfirm={() => void save()}
    content={<div className="flex min-w-0 flex-col gap-4">
      {loading ? <Spinner size={20} /> : draft?.fields.map(field => {
        const count = (values[field.field] ?? '').trim().length;
        return <FormField key={field.field}
          label={t(field.field === 'identitySource' ? 'bots.profile.personality' : 'bots.memory.types.user')}
          hint={t('bots.cloud.repair.count', { count, limit: field.maxLength })}
          error={count > field.maxLength ? t('bots.cloud.repair.over', { count: count - field.maxLength }) : undefined}>
          {control => <Textarea {...control} value={values[field.field] ?? ''} disabled={saving}
            rows={9} className="resize-y" onChange={value => setValues(current => ({ ...current, [field.field]: value }))} />}
        </FormField>;
      })}
      {error ? <ErrorNotice message={t(`bots.cloud.repair.${error}`)} actions={<>
        <CompanionCindyConflictAction action={conflict.action} />
        {(!draft || changed || error === 'changed') && <Button variant="secondary" size="md" disabled={loading || saving} onClick={() => void load()}>{t('bots.cloud.repair.reload')}</Button>}
      </>} /> : null}
    </div>} />;
}
