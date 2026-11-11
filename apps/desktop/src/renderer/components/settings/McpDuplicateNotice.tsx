import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Check } from 'lucide-react';
import { groupMcpDuplicateConnections, type McpDuplicateChoice, type McpDuplicateConnection, type McpDuplicateReport } from '@/../shared/customMcp';
import { SETTINGS_HINT, SettingsBlock, SettingsCard } from '@/components/ui/settings-rows';

/** 来源行与操作行是自定义多项内容，不套 SettingsRow；分割线跟随卡片内的可见行。 */
const ROW_CLASS = 'flex flex-wrap items-center justify-between gap-3';

/** Advisory only: dismissing Settings never changes which connections are loaded. */
export function McpDuplicateNotice() {
  const { t } = useTranslation();
  const [report, setReport] = useState<McpDuplicateReport>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<McpDuplicateConnection[]>();
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try {
      const next = await window.electronAPI.maker.listMcpDuplicates();
      if (generation.current === current) setReport(next);
    } catch {
      if (generation.current === current) setReport({ connections: [], complete: false });
    }
  }, []);
  useEffect(() => {
    void refresh();
    const off = window.electronAPI.maker.onMcpChanged(() => void refresh());
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => { generation.current++; off(); window.removeEventListener('focus', onFocus); };
  }, [refresh]);
  const choose = async (group: McpDuplicateConnection[], choice: McpDuplicateChoice | null) => {
    setBusy(true); setError(undefined);
    try { await window.electronAPI.maker.chooseMcpDuplicate({ id: group[0]!.id, choice }); }
    catch { setError(group); }
    finally { await refresh(); setBusy(false); }
  };
  const groups = groupMcpDuplicateConnections(report?.connections ?? []);
  const hasError = (group: McpDuplicateConnection[]) => error?.some(previous =>
    group.some(current => current.cindyId === previous.cindyId && current.claudeName === previous.claudeName));
  if (!report || (report.complete && !report.connections.length && !error)) return null;
  return (
    <section id="settings-mcp-duplicates" aria-label={t('settings.mcp.duplicates.title')} className="flex flex-col gap-3 text-13 text-[var(--text-primary)]">
      <div>
        <h3 className="font-medium">{t('settings.mcp.duplicates.title')}</h3>
        <p className="mt-1 text-[var(--text-secondary)]">{t('settings.mcp.duplicates.description')}</p>
        <p className="mt-1 text-[var(--text-secondary)]">{t('settings.mcp.duplicates.scope')}</p>
      </div>
      {!report.complete && <p role="status" className="text-[var(--text-secondary)]">{t('settings.mcp.duplicates.unavailable')}</p>}
      {error && !groups.some(hasError) && <p role="alert" className="text-[var(--text-danger)]">
        {[...new Set(error.map(pair => pair.cindyName))].join(' / ')} · {t('settings.mcp.duplicates.saveFailed')}
      </p>}
      {groups.map(group => {
        const pair = group[0]!;
        const cindy = [...new Map(group.map(item => [item.cindyId, { id: item.cindyId, name: item.cindyName }])).values()];
        const claude = [...new Set(group.map(item => item.claudeName))].map(name => ({ id: name, name }));
        const title = [...new Set(cindy.map(item => item.name))].join(' / ');
        const choice = group.every(item => item.choice === pair.choice) ? pair.choice : undefined;
        return (
          <SettingsCard key={pair.id} role="group" aria-label={`${title} · ${pair.origin}`}>
            <div className="px-4 pt-4 pb-3">
              <h4 className="break-words font-medium">{title}</h4>
              <p className={`${SETTINGS_HINT} mt-1 break-all`}>{pair.origin} · {t(`settings.mcp.duplicates.${group.some(item => item.reason === 'similar') ? 'similar' : 'endpoint'}`)}</p>
            </div>
            {([['cindy', 'Cindy', cindy], ['claude', 'Claude Code', claude]] as const).map(([source, label, connections]) => (
              <SettingsBlock key={source} className={ROW_CLASS}>
                <div className="min-w-0 flex-1 basis-40">
                  <p className={SETTINGS_HINT}>{label}</p>
                  {connections.map(connection => (
                    <div key={connection.id} className="mt-1">
                      <p className="break-words font-medium">{connection.name}</p>
                      {connection.id !== connection.name && <p className={`${SETTINGS_HINT} break-all`}>{connection.id}</p>}
                    </div>
                  ))}
                </div>
                {choice ? (choice === source || choice === 'both' ? <Check size={16} aria-hidden="true" className="shrink-0" /> : null) : (
                  <Button variant="secondary" size="sm" disabled={busy}
                    data-settings-search-action="Choose the retained source for this detected MCP connection group"
                    aria-label={`${t(`settings.mcp.duplicates.${connections.length === 1 ? 'keepThis' : 'keepThese'}`)} · ${label} · ${connections.map(item => item.name).join(' / ')}`}
                    onClick={() => void choose(group, source)}>
                    {t(`settings.mcp.duplicates.${connections.length === 1 ? 'keepThis' : 'keepThese'}`)}
                  </Button>
                )}
              </SettingsBlock>
            ))}
            <SettingsBlock className={ROW_CLASS}>
              {choice ? <>
                <span role="status">{t(`settings.mcp.duplicates.selected.${choice}`)}</span>
                <Button variant="secondary" size="sm" disabled={busy} data-settings-search-action="Reset the retained source for this detected MCP connection group" onClick={() => void choose(group, null)}>{t('settings.mcp.duplicates.reset')}</Button>
              </> : <Button variant="secondary" size="sm" disabled={busy} data-settings-search-action="Keep both sources for this detected MCP connection group" onClick={() => void choose(group, 'both')}>{t('settings.mcp.duplicates.keep.both')}</Button>}
            </SettingsBlock>
            {hasError(group) && <p role="alert" className="px-4 pb-4 text-[var(--text-danger)]">{t('settings.mcp.duplicates.saveFailed')}</p>}
          </SettingsCard>
        );
      })}
    </section>
  );
}
