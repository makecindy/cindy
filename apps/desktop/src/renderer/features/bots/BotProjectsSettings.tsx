import { useCallback, useEffect, useRef, useState } from 'react';
import { FolderOpen, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { useBotTranslation } from './botPronounContext';
import type { BotProjectOption } from '../../../shared/botWorkbench';

export function BotProjectsSettings({ botId }: { botId: string }) {
  const { t } = useBotTranslation();
  const [projects, setProjects] = useState<BotProjectOption[] | null>(null);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const load = useCallback(async () => {
    const token = ++generation.current;
    try {
      const next = await window.electronAPI.localDb.bots.projects.list(botId);
      if (token === generation.current) { setProjects(next); setError(false); }
    } catch { if (token === generation.current) setError(true); }
  }, [botId]);
  useEffect(() => {
    void load();
    const unsubscribe = window.electronAPI.maker.onBotWorkbenchChanged(({ botId: changed }) => {
      if (changed === botId && !inFlight.current) void load();
    });
    return () => { generation.current++; unsubscribe(); };
  }, [botId, load]);
  const set = async (id: string, linked: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError(false);
    const token = ++generation.current;
    try {
      const next = await window.electronAPI.localDb.bots.projects.set(botId, id, linked);
      if (token === generation.current) { setProjects(next); setSelected(''); }
    } catch { if (token === generation.current) setError(true); }
    finally { inFlight.current = false; if (token === generation.current) setBusy(false); }
  };
  const linked = projects?.filter(project => project.linked) ?? [];
  const available = projects?.filter(project => !project.linked && project.available) ?? [];
  return <div className="space-y-4 py-3">
    <p className="text-13 leading-6 text-[var(--text-secondary)]">{t('bots.projects.description')}</p>
    {error && <div role="alert" className="flex items-center justify-between gap-3 text-13 text-[var(--text-danger)]">
      <span>{t('bots.projects.failed')}</span>
      <Button variant="secondary" compact disabled={busy} onClick={() => void load()}>{t('bots.memory.useLatest')}</Button>
    </div>}
    {!projects && !error ? <Spinner size={18} /> : null}
    {linked.length > 0 ? <ul className="divide-y divide-[var(--border-default)] rounded-xl border border-[var(--border-default)]">
      {linked.map(project => <li key={project.id} className="flex items-center gap-3 px-4 py-3">
        <FolderOpen size={16} className="shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="break-words text-13 font-medium text-[var(--text-primary)]">{project.name}</p>
          <p className="mt-1 break-all text-12 leading-5 text-[var(--text-secondary)]">{project.path}</p>
          {(project.deviceId || !project.available) && <p className="mt-1 text-12 leading-5 text-[var(--text-tertiary)]">
            {project.deviceId ? t('bots.projects.otherComputer', { device: project.deviceId }) : t('bots.projects.unavailable')}
          </p>}
        </div>
        <Tip text={busy ? t('bots.autosave.saving') : t('bots.projects.remove', { name: project.name })}>
          <span className="inline-flex shrink-0">
            <Button variant="secondary" tone="quiet" compact disabled={busy} aria-label={t('bots.projects.remove', { name: project.name })}
              onClick={() => void set(project.id, false)}><X size={16} /></Button>
          </span>
        </Tip>
      </li>)}
    </ul> : projects ? <p className="py-3 text-13 text-[var(--text-tertiary)]">{t('bots.projects.empty')}</p> : null}
    {projects && <div className="flex flex-wrap items-center gap-2">
      <Select label={t('bots.projects.choose')} value={selected} disabled={busy || !available.length}
        className="min-w-0 flex-1" onValueChange={setSelected}
        options={available.map(project => ({ value: project.id, label: project.name, title: project.path }))} />
      <Button variant="secondary" disabled={busy || !available.some(project => project.id === selected)} onClick={() => void set(selected, true)}>
        <Plus size={16} />{t('bots.projects.add')}
      </Button>
    </div>}
    {projects && !available.length && <p className="text-12 leading-5 text-[var(--text-tertiary)]">{t('bots.projects.noAvailable')}</p>}
  </div>;
}
