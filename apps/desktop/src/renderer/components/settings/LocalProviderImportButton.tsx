import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Monitor } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { toast } from '@/lib/toast';
import { providersSettings } from './ProvidersSection.settings-search';
import { useSettingDefinition } from './useSettingDefinition';
import type {
  LocalProviderImportEdit,
  LocalProviderImportItem,
  LocalProviderImportScan,
} from '../../../shared/localProviderImport';

const SOURCE_NAMES = {
  alma: 'Alma',
  'cc-switch': 'CC Switch',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};
const WIRES = [
  'anthropic-messages',
  'openai-responses',
  'openai-chat',
  'google-generative-ai',
] as const;

/** Only source selection and non-secret edits. Review/commit reuse the existing batch dialog. */
export function LocalProviderImportButton({ onImported }: { onImported: (ids: string[]) => void }) {
  const { t } = useTranslation();
  const localImportSetting = useSettingDefinition(providersSettings.localImport);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [scan, setScan] = useState<LocalProviderImportScan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<LocalProviderImportItem | null>(null);
  const [name, setName] = useState('');
  const [endpoints, setEndpoints] = useState<
    { baseUrl: string; protocol: string; apiKey: string }[]
  >([]);
  const alive = useRef(true),
    running = useRef(false),
    generation = useRef(0);
  const owned = useRef<string[]>([]);
  const cancelDrafts = (ids: string[]) => {
    for (const id of ids)
      void window.electronAPI.maker.cancelProviderImport(id).catch(() => undefined);
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      queueMicrotask(() => {
        if (!alive.current) {
          generation.current++;
          cancelDrafts(owned.current);
          owned.current = [];
        }
      });
    };
  }, []);
  function close() {
    generation.current++;
    cancelDrafts(owned.current);
    owned.current = [];
    setOpen(false);
    setEditing(null);
    setEndpoints([]);
    setScan(null);
    setSelected(new Set());
  }
  async function start() {
    if (running.current) return;
    running.current = true;
    cancelDrafts(owned.current);
    owned.current = [];
    const current = ++generation.current;
    setOpen(true);
    setBusy(true);
    setScan(null);
    setSelected(new Set());
    try {
      const result = await window.electronAPI.maker.scanLocalProviderImports();
      if (!alive.current || current !== generation.current) {
        cancelDrafts(result.items.map((i) => i.importId));
        return;
      }
      owned.current = result.items.map((i) => i.importId);
      setScan(result);
      setSelected(
        new Set(result.items.filter((i) => !i.issue && !i.disabled).map((i) => i.importId)),
      );
    } catch {
      if (alive.current && current === generation.current)
        toast.error(t('settings.providers.import.local.failed'));
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function saveEdit() {
    if (!editing || running.current || endpoints.some((e) => !e.protocol || !e.baseUrl)) return;
    running.current = true;
    setBusy(true);
    const current = generation.current;
    try {
      const item = await window.electronAPI.maker.editLocalProviderImport(editing.importId, {
        name,
        endpoints: endpoints.map((e) => ({
          baseUrl: e.baseUrl,
          protocol: e.protocol as LocalProviderImportEdit['endpoints'][number]['protocol'],
          ...(e.apiKey ? { apiKey: e.apiKey } : {}),
        })),
      });
      if (!alive.current || current !== generation.current) return;
      setScan(
        (value) =>
          value && {
            ...value,
            items: value.items.map((i) => (i.importId === item.importId ? item : i)),
          },
      );
      setSelected((value) => {
        const next = new Set(value);
        if (item.issue) next.delete(item.importId);
        else next.add(item.importId);
        return next;
      });
      setEditing(null);
      setEndpoints([]);
    } catch {
      if (alive.current && current === generation.current)
        toast.error(t('settings.providers.import.local.editFailed'));
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const edit = (item: LocalProviderImportItem) => {
    setEditing(item);
    setName(item.name);
    setEndpoints(
      item.endpoints.map((e) => ({ baseUrl: e.baseUrl, protocol: e.protocol ?? '', apiKey: '' })),
    );
  };
  const submit = () => {
    const ids =
      scan?.items.filter((i) => !i.issue && selected.has(i.importId)).map((i) => i.importId) ?? [];
    if (!ids.length || busy) return;
    cancelDrafts(owned.current.filter((id) => !ids.includes(id)));
    owned.current = [];
    setOpen(false);
    setScan(null);
    setSelected(new Set());
    onImported(ids);
  };
  return (
    <>
      <Button
        {...localImportSetting.anchorProps}
        {...localImportSetting.controlProps}
        type="button"
        variant="secondary"
        size="lg"
        className="w-full"
        disabled={busy}
        onClick={() => void start()}
      >
        <Monitor size={15} />
        {localImportSetting.title}
      </Button>
      <ConfirmDialog
        presentation="standard"
        open={open && !editing}
        maxWidth={600}
        onOpenChange={(value) => {
          if (!value) close();
        }}
        title={localImportSetting.title}
        description={localImportSetting.description}
        descriptionClassName="text-13 font-normal leading-relaxed"
        confirmText={t('settings.providers.import.local.review', { count: selected.size })}
        confirmDisabled={busy || !selected.size || !!editing}
        cancelText={t('common.dismiss')}
        onCancel={close}
        onConfirm={submit}
        contentSelectable
        content={
          <div className="space-y-3 text-13 text-[var(--text-primary)]">
            {busy && !scan && <p role="status">{t('settings.providers.import.local.scanning')}</p>}
            {!busy && (
              <Button data-settings-search-action="Rescan saved API configurations for this pending import" type="button" variant="secondary" size="md" onClick={() => void start()}>
                {t('settings.providers.import.local.rescan')}
              </Button>
            )}
            {scan && (
              <>
                {!scan.items.length && <p>{t('settings.providers.import.local.empty')}</p>}
                {scan.sources
                  .filter((s) => s.issue && s.issue !== 'missing')
                  .map((s) => (
                    <p key={s.source} role="status">
                      {SOURCE_NAMES[s.source]} ·{' '}
                      {t(`settings.providers.import.local.status.${s.issue}`)}
                    </p>
                  ))}
                <ul className="divide-y divide-[var(--border-default)]">
                  {scan.items.map((item) => (
                    <li key={item.importId} className="space-y-2 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <label className="flex min-h-9 min-w-0 items-center gap-2 font-medium">
                          <input
                            data-settings-search-action="Select a temporary local-import candidate for review"
                            type="checkbox"
                            className="size-4 shrink-0 accent-[var(--text-primary)]"
                            checked={selected.has(item.importId)}
                            disabled={busy || !!item.issue}
                            onChange={(e) =>
                              setSelected((value) => {
                                const next = new Set(value);
                                if (e.target.checked) next.add(item.importId);
                                else next.delete(item.importId);
                                return next;
                              })
                            }
                          />
                          <span className="break-all">{item.name}</span>
                        </label>
                        {item.endpoints.length > 0 &&
                          !['unsupported', 'changed'].includes(item.issue ?? '') && (
                            <Button
                              data-settings-search-action="Edit a scanned API configuration before import review"
                              variant="secondary"
                              size="md"
                              disabled={busy}
                              onClick={() => edit(item)}
                            >
                              {t('settings.providers.import.local.edit')}
                            </Button>
                          )}
                      </div>
                      <p className="text-[var(--text-secondary)]">
                        {SOURCE_NAMES[item.source]}
                        {item.issue
                          ? ` · ${t(`settings.providers.import.local.status.${item.issue}`)}`
                          : ''}
                      </p>
                      {item.disabled && (
                        <p className="text-[var(--text-secondary)]">
                          {t('settings.providers.import.local.sourceDisabled')}
                        </p>
                      )}
                      {item.endpoints.map((e, i) => (
                        <p key={i} className="break-all text-[var(--text-secondary)]">
                          {e.agent === 'claude-code'
                            ? 'Claude Code'
                            : e.agent === 'codex'
                              ? 'Codex'
                              : 'Pi'}{' '}
                          · {e.baseUrl || t('settings.providers.import.local.missingUrl')}
                        </p>
                      ))}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        }
      />
      <ConfirmDialog
        presentation="standard"
        open={!!editing}
        maxWidth={560}
        title={t('settings.providers.import.local.edit')}
        description={t('settings.providers.import.local.editNote')}
        descriptionClassName="text-13 font-normal leading-relaxed"
        onOpenChange={(value) => {
          if (!value && !running.current) {
            setEditing(null);
            setEndpoints([]);
          }
        }}
        confirmText={t('settings.providers.custom.save')}
        cancelText={t('settings.providers.import.cancel')}
        confirmDisabled={busy || !name || endpoints.some((e) => !e.baseUrl || !e.protocol)}
        loading={busy}
        onCancel={() => {
          if (!busy) {
            setEditing(null);
            setEndpoints([]);
          }
        }}
        onConfirm={() => void saveEdit()}
        content={
          <div className="space-y-3 text-13 text-[var(--text-primary)]">
            <label className="flex flex-col gap-2">
              {t('settings.providers.import.local.name')}
              <Input data-settings-search-action="Edit the display name of a temporary import candidate" value={name} maxLength={60} disabled={busy} onChange={setName} />
            </label>
            {endpoints.map((ep, i) => (
              <div key={i} className="space-y-3">
                <label className="flex flex-col gap-2">
                  {t('settings.providers.import.local.baseUrl')}
                  <Input
                    data-settings-search-action="Edit the API address of a temporary import candidate"
                    value={ep.baseUrl}
                    disabled={busy}
                    onChange={(value) =>
                      setEndpoints((v) => v.map((r, j) => (j === i ? { ...r, baseUrl: value } : r)))
                    }
                  />
                </label>
                <label className="flex flex-col gap-2">
                  {t('settings.providers.import.local.protocol')}
                  <select
                    data-settings-search-action="Choose the wire protocol of a temporary import candidate"
                    className="h-9 rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3"
                    value={ep.protocol}
                    disabled={busy}
                    onChange={(e) =>
                      setEndpoints((v) =>
                        v.map((r, j) => (j === i ? { ...r, protocol: e.target.value } : r)),
                      )
                    }
                  >
                    <option value="">{t('settings.providers.import.local.chooseProtocol')}</option>
                    {WIRES.map((w) => (
                      <option key={w} value={w}>
                        {w}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-2">
                  {t('settings.providers.import.local.apiKey')}
                  <Input
                    data-settings-search-action="Replace the credential of a temporary import candidate before confirmation"
                    type="password"
                    autoComplete="off"
                    value={ep.apiKey}
                    placeholder={t('settings.providers.import.local.keepKey')}
                    disabled={busy}
                    onChange={(value) =>
                      setEndpoints((v) => v.map((r, j) => (j === i ? { ...r, apiKey: value } : r)))
                    }
                  />
                </label>
              </div>
            ))}
          </div>
        }
      />
    </>
  );
}
