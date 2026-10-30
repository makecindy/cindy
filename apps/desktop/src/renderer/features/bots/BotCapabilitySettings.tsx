import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { ChevronDown, Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useBotTranslation } from './botPronounContext';
import type { BotCapabilities, BotProfile } from './botStore';
import type { BotCapabilityEntry as Entry, BotCapabilityKind as Kind } from './botSettingsTarget';
import { useBotSettingsTarget } from './useBotSettingsTarget';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';

const kinds: Kind[] = ['toolset', 'mcp', 'skill'];

/** References are edited per companion; shared installations and connections stay host-owned. */
export function BotCapabilitySettings({
  bot,
  capabilities,
  skills,
  onChange,
  expanded,
  onConfigure,
}: {
  expanded?: boolean;
  onConfigure?: (kind: Kind, id?: string) => void;
  bot: BotProfile;
  capabilities: BotCapabilities;
  skills: string[];
  onChange: (kind: Kind, values: string[]) => void;
}) {
  const { t } = useBotTranslation();
  const [catalog, setCatalog] = useState<{ key: string; entries: Partial<Record<Kind, Entry[]>> }>({
    key: '',
    entries: {},
  });
  const [localOpen, setOpen] = useState(false);
  const open = expanded ?? localOpen;
  const [revision, setRevision] = useState(0);
  const requestRef = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState('');
  const selected = { skill: skills, mcp: capabilities.mcpServers, toolset: capabilities.toolsets };
  const target = useBotSettingsTarget();
  // Followed defaults can change when providers / available harnesses change, even
  // if the profile still holds the previous modelChain snapshot.
  const defaultChain = target.useDefaultModelChain();
  const modelChain = capabilities.modelChainOverride === null ? defaultChain : capabilities.modelChain;
  const modelChainKey = JSON.stringify(modelChain);
  const catalogKey = JSON.stringify([
    bot.id,
    bot.canonicalSessionId,
    modelChainKey,
    revision,
    open,
  ]);
  // Invalidate during render as well as effect cleanup: stale checkboxes must never stay selectable.
  const entries = catalog.key === catalogKey ? catalog.entries : {};
  const refresh = useCallback(() => {
    requestRef.current += 1;
    setRevision((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!open) return;
    return target.capabilities.watch(bot, refresh);
  }, [open, bot.canonicalSessionId, refresh, target]);

  useEffect(() => {
    if (!open) return;
    const request = ++requestRef.current;
    const owner = getDataOwnerGeneration();
    const isCurrent = () => requestRef.current === request && isDataOwnerGenerationCurrent(owner);
    setBusy(true);
    setError(false);
    const load = async () => {
      try {
        const next = await target.capabilities.load(bot, JSON.parse(modelChainKey), isCurrent);
        if (!isCurrent()) return;
        setCatalog({ key: catalogKey, entries: next });
        setError(kinds.some((kind) => !next[kind]));
      } catch {
        if (isCurrent()) setError(true);
      } finally {
        if (isCurrent()) setBusy(false);
      }
    };
    void load();
    return () => {
      requestRef.current += 1;
    };
  }, [open, catalogKey, bot.id, bot.canonicalSessionId, modelChainKey, target]);
  return (
    <details
      data-testid="bot-capability-editor"
      open={open}
      className={cn('group', expanded === undefined && 'border-t border-[var(--border-default)] pt-3')}
      onToggle={(event) => {
        if (expanded === undefined) setOpen(event.currentTarget.open);
      }}
    >
      {/* A page-owned editor has its own title; `hidden` alone loses to `flex`. */}
      <summary
        hidden={expanded !== undefined}
        className={cn(
          'flex min-h-9 cursor-pointer list-none items-center justify-between gap-3 rounded-full px-3 py-2 text-13 text-[var(--text-secondary)] outline-none hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] [&::-webkit-details-marker]:hidden',
          expanded !== undefined && 'hidden',
        )}
      >
        {t('bots.capabilities.title')}
        <ChevronDown size={15} aria-hidden className="shrink-0 group-open:rotate-180" />
      </summary>
      <div className={cn('space-y-5', expanded === undefined ? 'px-3 pt-4' : 'pt-3')}>
        <p className="text-12 leading-5 text-[var(--text-secondary)]">{t('bots.capabilities.accessHint')}</p>
        <div className="relative">
          <Search
            size={14}
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-[var(--text-tertiary)]"
          />
          <Input
            size="md"
            ariaLabel={t('bots.capabilities.search')}
            placeholder={t('bots.capabilities.search')}
            value={query}
            onChange={setQuery}
            inputClassName="pl-8"
          />
        </div>
        {busy ? (
          <p className="text-12 text-[var(--text-secondary)]">{t('bots.capabilities.loading')}</p>
        ) : null}
        {error ? (
          <Button
            variant="secondary"
            size="md"
            tone="danger"
            compact
            type="button"
            onClick={refresh}
          >
            {t('bots.retry')}
          </Button>
        ) : null}
        {kinds.map((kind) => {
          const rows = (entries[kind] ?? []).map(item => kind === 'toolset' ? {
            ...item,
            name: t(`settings.builtinTools.plugins.${item.id}.name`, { defaultValue: item.name }),
            description: t(`settings.builtinTools.plugins.${item.id}.description`, { defaultValue: item.description ?? '' }),
          } : item);
          // A kept reference this computer does not have: its name (not its internal id), flagged as not here.
          for (const id of selected[kind])
            if (!rows.some((item) => item.id === id)) rows.push({
              id,
              name: kind === 'mcp' ? capabilities.mcpServerNames?.[id] || id
                : kind === 'toolset' ? t(`settings.builtinTools.plugins.${id}.name`, { defaultValue: id }) : id,
              available: false,
              missing: true,
            });
          const mode = kind === 'mcp' ? capabilities.mcpMode : kind === 'toolset' ? capabilities.toolsetMode : 'allowlist';
          // Inheritance can only become an explicit selection from a complete
          // catalog of this kind. Missing/refreshing entries must not drop tools.
          const canEdit = mode !== 'inherit' || entries[kind] !== undefined;
          const selectedIds = mode === 'inherit'
            ? [...new Set([...selected[kind], ...rows.filter((item) => item.available).map((item) => item.id)])]
            : selected[kind];
          const matching = rows.filter((item) =>
            `${item.id} ${item.name} ${item.description ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
          );
          return (
            <fieldset key={kind} className="min-w-0">
              <legend className="mb-2 text-12 font-medium text-[var(--text-primary)]">
                {t(`bots.capabilities.${kind}`)}
              </legend>
              {kind !== 'skill' && <p className="mb-3 text-12 leading-5 text-[var(--text-secondary)]">
                {t(mode === 'inherit' ? 'bots.capabilities.inheritedHint' : 'bots.capabilities.selectedHint')}
              </p>}
              <div className="divide-y divide-[var(--border-default)]">
                {matching.map(item => {
                  const checked = item.personal ? item.available : selectedIds.includes(item.id);
                  return <div key={item.id} className="flex items-start gap-3 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-13 font-medium text-[var(--text-primary)]">{item.name}</p>
                      {item.description && <p className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">{item.description}</p>}
                      {item.personal && <p className="mt-1 text-12 text-[var(--text-secondary)]">{t('bots.capabilities.personalHint')}</p>}
                      {!item.available && <p className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">{t(item.missing ? 'bots.capabilities.notOnThisComputer' : 'bots.capabilities.unavailableHint')}</p>}
                      {kind === 'toolset' && onConfigure && <Button type="button" size="sm" variant="secondary" className="mt-2"
                        onClick={() => onConfigure(kind, item.id)}>{t('bots.capabilities.configure')}</Button>}
                    </div>
                    <Switch aria-label={item.name} className="mt-0.5 shrink-0" checked={checked}
                      disabled={!canEdit || item.personal || (!item.available && !checked)}
                      onCheckedChange={value => canEdit && onChange(kind, value
                        ? [...selectedIds, item.id] : selectedIds.filter(id => id !== item.id))} />
                  </div>;
                })}
              </div>
              {!busy && !error && matching.length === 0 && <div className="space-y-2 py-2">
                <p className="text-12 text-[var(--text-secondary)]">{t(query.trim() ? 'bots.capabilities.empty' : `bots.capabilities.empty_${kind}`)}</p>
                {onConfigure && !query.trim() && <Button type="button" size="sm" variant="secondary" onClick={() => onConfigure(kind)}>{t('bots.capabilities.configure')}</Button>}
              </div>}
            </fieldset>
          );
        })}
      </div>
    </details>
  );
}
