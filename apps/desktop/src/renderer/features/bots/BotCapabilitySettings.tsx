import { ChevronDown } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useBotTranslation } from './botPronounContext';
import {
  getEffectiveBotModelChain,
  subscribeBotGlobalModel,
  type BotCapabilities,
  type BotProfile,
} from './botStore';
import * as sessionService from '@/lib/sessionService';
import { onPatch } from '@/lib/sessionsBus';
import type { Session } from '@/lib/ccAgent.types';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  isDataOwnerPushCurrent,
} from '@/contexts/dataOwnerGeneration';

type Kind = 'skill' | 'mcp' | 'toolset';
type Entry = { id: string; name: string; available: boolean };
const kinds: Kind[] = ['skill', 'mcp', 'toolset'];

/** References are edited per companion; shared installations and connections stay host-owned. */
export function BotCapabilitySettings({
  bot,
  capabilities,
  skills,
  onChange,
}: {
  bot: BotProfile;
  capabilities: BotCapabilities;
  skills: string[];
  onChange: (kind: Kind, values: string[]) => void;
}) {
  const { t } = useBotTranslation();
  const [catalog, setCatalog] = useState<{ key: string; entries: Partial<Record<Kind, Entry[]>> }>({ key: '', entries: {} });
  const [open, setOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const requestRef = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState('');
  const selected = { skill: skills, mcp: capabilities.mcpServers, toolset: capabilities.toolsets };
  // Followed defaults can change when providers / available harnesses change, even
  // if the local profile still holds the previous modelChain snapshot.
  useSyncExternalStore(subscribeBotGlobalModel, () => JSON.stringify(getEffectiveBotModelChain()));
  const modelChain = capabilities.modelChainOverride === null
    ? getEffectiveBotModelChain()
    : capabilities.modelChain;
  const modelChainKey = JSON.stringify(modelChain);
  const catalogKey = JSON.stringify([bot.id, bot.canonicalSessionId, modelChainKey, revision, open]);
  // Invalidate during render as well as effect cleanup: stale checkboxes must never stay selectable.
  const entries = catalog.key === catalogKey ? catalog.entries : {};
  const refresh = useCallback(() => {
    requestRef.current += 1;
    setRevision((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!open) return;
    const changed = (sessionId: string, patch: Partial<Session>) => {
      if (sessionId !== bot.canonicalSessionId) return;
      if (['agentKind', 'model', 'providerId', 'effort', 'fastMode', 'runtimeGeneration',
        'runtimeEffective', 'runtimePending', 'workingDir', 'remoteHostId'].some((key) => key in patch)) refresh();
    };
    const offLocal = onPatch(changed);
    const offPush = window.electronAPI.localDb?.sessionsPush?.onPatched(({ sessionId, patch }, stamp) => {
      if (isDataOwnerPushCurrent(stamp)) changed(sessionId, patch);
    });
    const offMcp = window.electronAPI.maker.onMcpChanged(refresh);
    return () => { offLocal(); offPush?.(); offMcp(); };
  }, [open, bot.canonicalSessionId, refresh]);

  useEffect(() => {
    if (!open) return;
    const request = ++requestRef.current;
    const owner = getDataOwnerGeneration();
    const isCurrent = () => requestRef.current === request && isDataOwnerGenerationCurrent(owner);
    setBusy(true);
    setError(false);
    const load = async () => {
      try {
        if (!bot.canonicalSessionId) throw new Error('Missing canonical task');
        const session = await sessionService.get(bot.canonicalSessionId);
        if (!isCurrent()) return;
        const api = window.electronAPI.maker;
        const mcpResult = await api.listCustomMcpServers({
          agentKind: session.runtimePending?.profile.agentKind ?? session.runtimeEffective?.agentKind
            ?? (session.agentKind === 'codex' || session.agentKind === 'pi' ? session.agentKind : 'claude-code'),
          botSessionId: bot.canonicalSessionId,
          modelChain: JSON.parse(modelChainKey),
        });
        if (!isCurrent()) return;
        const agentKind = mcpResult.agentKind;
        if (!agentKind) throw new Error('Missing next-turn route');
        const results = await Promise.allSettled([
          api.listAgentSkills(agentKind, {
            forceReload: true,
            workingDir: session.workingDir ?? undefined,
            remoteHostId: session.remoteHostId ?? undefined,
          }),
          api.plugins.list(session.workingDir ?? undefined, true, {
            botId: bot.id, agentKind, remoteHostId: session.remoteHostId,
          }),
        ]);
        if (!isCurrent()) return;
        const [skillResult, toolsetResult] = results;
        const next: Partial<Record<Kind, Entry[]>> = {};
        if (skillResult.status === 'fulfilled' && skillResult.value.success)
          next.skill = (skillResult.value.skills ?? []).map((item) => ({
            id: item.name,
            name: item.name,
            available: item.enabled !== false && item.runtimeStatus !== 'failed',
          }));
        next.mcp = mcpResult.servers.map((item) => ({
          id: item.id,
          name: item.name,
          available: item.available === true,
        }));
        if (toolsetResult.status === 'fulfilled')
          next.toolset = toolsetResult.value
            .filter((item) => !['memory', 'xdt_helper', 'collab'].includes(item.id))
            .map((item) => ({
              id: item.id,
              name: item.name,
              available: item.available === true,
            }));
        setCatalog({ key: catalogKey, entries: next });
        setError(kinds.some((kind) => !next[kind]));
      } catch {
        if (isCurrent()) setError(true);
      } finally {
        if (isCurrent()) setBusy(false);
      }
    };
    void load();
    return () => { requestRef.current += 1; };
  }, [open, catalogKey, bot.id, bot.canonicalSessionId, modelChainKey]);
  return (
    <details
      className="group border-t border-[var(--border-default)] pt-3"
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
    >
      <summary className="flex min-h-9 cursor-pointer list-none items-center justify-between gap-3 rounded-full px-3 py-2 text-13 text-[var(--text-secondary)] outline-none hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] [&::-webkit-details-marker]:hidden">
        {t('bots.capabilities.title')}
        <ChevronDown size={15} aria-hidden className="shrink-0 group-open:rotate-180" />
      </summary>
      <div className="space-y-4 px-3 pt-4">
        <input
          aria-label={t('bots.capabilities.search')}
          placeholder={t('bots.capabilities.search')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="h-9 w-full rounded-full border border-[var(--border-default)] bg-[var(--surface)] px-3 text-12 text-[var(--text-primary)]"
        />
        {busy ? (
          <p className="text-12 text-[var(--text-secondary)]">{t('bots.capabilities.loading')}</p>
        ) : null}
        {error ? (
          <button
            type="button"
            onClick={refresh}
            className="rounded-full px-4 py-2 text-12 text-[var(--text-danger)]"
          >
            {t('bots.retry')}
          </button>
        ) : null}
        {kinds.map((kind) => {
          const rows = [...(entries[kind] ?? [])];
          for (const id of selected[kind])
            if (!rows.some((item) => item.id === id)) rows.push({ id, name: id, available: false });
          const matching = rows.filter((item) =>
            `${item.id} ${item.name}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
          );
          return (
            <fieldset key={kind} className="min-w-0">
              <legend className="mb-2 text-12 font-medium text-[var(--text-primary)]">
                {t(`bots.capabilities.${kind}`)}
              </legend>
              <div className="max-h-48 space-y-1 overflow-y-auto">
                {matching.map((item) => (
                  <label
                    key={item.id}
                    className="flex min-h-9 items-center gap-3 rounded-lg px-2 text-12 text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
                  >
                    <input
                      type="checkbox"
                      className="accent-[var(--text-primary)]"
                      checked={selected[kind].includes(item.id)}
                      disabled={!item.available && !selected[kind].includes(item.id)}
                      onChange={(event) =>
                        onChange(
                          kind,
                          event.target.checked
                            ? [...selected[kind], item.id]
                            : selected[kind].filter((id) => id !== item.id),
                        )
                      }
                    />
                    <span className="min-w-0 flex-1 truncate" title={item.name}>
                      {item.name}
                    </span>
                    {!item.available ? (
                      <span className="text-11 text-[var(--text-tertiary)]">
                        {t('bots.capabilities.unavailable')}
                      </span>
                    ) : null}
                  </label>
                ))}
                {!busy && !error && matching.length === 0 ? (
                  <p className="text-12 text-[var(--text-tertiary)]">
                    {t('bots.capabilities.empty')}
                  </p>
                ) : null}
              </div>
            </fieldset>
          );
        })}
      </div>
    </details>
  );
}
