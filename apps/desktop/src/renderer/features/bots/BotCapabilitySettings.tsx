import { Button } from '@/components/ui/button';
import { Collapse } from '@/components/ui/collapse';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { BOT_SYSTEM_SKILL_IDS, isBotSystemSkillOn, type BotSystemSkillId } from '../../../shared/botSystemSkills';
import { useBotTranslation } from './botPronounContext';
import type { BotCapabilities, BotProfile } from './botStore';
import type { BotCapabilityEntry as Entry, BotCapabilityKind as Kind } from './botSettingsTarget';
import { BotSkillPage, type BotSkillPageView } from './BotSkillPage';
import { useBotSettingsTarget } from './useBotSettingsTarget';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';

const kinds: Kind[] = ['toolset', 'mcp', 'skill'];
/** Rows shown per group before "Show N more"; enabled rows come first. */
const FOLD = 4;

type Row = Entry & { checked: boolean; disabled: boolean };

function folded(rows: Row[], open: boolean, searching: boolean) {
  const rank = (row: Row) => (!row.available ? 2 : row.checked ? 0 : 1);
  const ordered = [...rows].sort((a, b) => rank(a) - rank(b));
  // One hidden row is not worth a "Show 1 more" line.
  if (searching || ordered.length <= FOLD + 1) return { shown: ordered, hidden: [] as Row[] };
  return { shown: ordered.slice(0, FOLD), hidden: ordered.slice(FOLD) };
}

/**
 * The capability page (cindy-bots-runtime.md §6「伙伴技能分层」): the shared core, the system Skills this teammate
 * may turn off, its learned Skills, then shared references (Skills on this computer, built-in tools,
 * MCP) and permissions. References are edited per companion; installations and connections stay
 * host-owned.
 */
export function BotCapabilitySettings({
  bot,
  capabilities,
  skills,
  onChange,
  onSystemSkillChange,
  onInputHandoffChange,
  expanded,
  onConfigure,
  backRef,
  leaveRef,
}: {
  expanded?: boolean;
  onConfigure?: (kind: Kind, id?: string) => void;
  bot: BotProfile;
  capabilities: BotCapabilities;
  skills: string[];
  onChange: (kind: Kind, values: string[]) => void;
  onSystemSkillChange?: (id: BotSystemSkillId, on: boolean) => void;
  onInputHandoffChange?: (allowed: boolean) => void;
  /** The settings page's back button steps out of a Skill page first. */
  backRef?: MutableRefObject<(() => Promise<boolean>) | null>;
  /** Set while a learned Skill is being edited: closing settings asks before discarding the draft. */
  leaveRef?: MutableRefObject<(() => Promise<boolean>) | null>;
}) {
  const { t } = useBotTranslation();
  const { confirm } = useConfirmDialog();
  const editorDirtyRef = useRef<(() => boolean) | null>(null);
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
  const [unfolded, setUnfolded] = useState<Record<string, boolean>>({});
  const [view, setView] = useState<BotSkillPageView | null>(null);
  const [pendingSkill, setPendingSkill] = useState<string | null>(null);
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

  // Same unsaved-changes question as routines and memory.
  const confirmDiscard = useCallback(async () => !editorDirtyRef.current?.() || confirm({
    presentation: 'standard',
    title: t('bots.capabilities.learned.unsavedTitle'),
    description: t('bots.capabilities.learned.unsavedDescription'),
    confirmText: t('bots.capabilities.learned.discard'),
    cancelText: t('bots.capabilities.learned.continueEditing'),
  }), [confirm, t]);
  const editing = view?.type === 'learned' && view.editing === true;
  useEffect(() => {
    if (!backRef) return;
    backRef.current = async () => {
      if (!view) return false;
      if (editing && !(await confirmDiscard())) return true;
      setView(editing ? { ...view, editing: false } : null);
      return true;
    };
    return () => {
      backRef.current = null;
    };
  }, [backRef, view, editing, confirmDiscard]);
  useEffect(() => {
    if (!leaveRef || !editing) return;
    leaveRef.current = confirmDiscard;
    return () => {
      leaveRef.current = null;
    };
  }, [leaveRef, editing, confirmDiscard]);

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

  const setLearnedEnabled = async (slug: string, enabled: boolean) => {
    if (!target.skills || pendingSkill) return;
    setPendingSkill(slug);
    try {
      await target.skills.setEnabled(bot.id, slug, enabled);
      refresh();
    } catch {
      toast.error(t('bots.capabilities.learned.saveFailed'));
    } finally {
      setPendingSkill(null);
    }
  };

  if (view) {
    return (
      <BotSkillPage
        bot={bot}
        view={view}
        onView={setView}
        systemSkillOn={(id) => isBotSystemSkillOn(capabilities, id)}
        onSystemSkillChange={onSystemSkillChange}
        onLearnedChanged={refresh}
        editorDirtyRef={editorDirtyRef}
      />
    );
  }

  const needle = query.trim().toLocaleLowerCase();
  const matches = (...parts: (string | undefined)[]) => !needle || parts.join(' ').toLocaleLowerCase().includes(needle);
  const rowsOf = (kind: Kind, personal: boolean) => {
    const rows: Entry[] = (entries[kind] ?? [])
      .filter((item) => Boolean(item.personal) === personal)
      .map((item) => kind === 'toolset' ? {
        ...item,
        name: t(`settings.builtinTools.plugins.${item.id}.name`, { defaultValue: item.name }),
        description: t(`settings.builtinTools.plugins.${item.id}.description`, { defaultValue: item.description ?? '' }),
      } : item);
    // A kept reference this computer does not have: its name (not its internal id), flagged as not here.
    if (!personal) for (const id of selected[kind])
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
    const shown: Row[] = rows
      .filter((item) => matches(item.id, item.name, item.description))
      .map((item) => {
        const checked = personal ? item.available : selectedIds.includes(item.id);
        return {
          ...item,
          checked,
          disabled: personal ? !target.skills || pendingSkill !== null : !canEdit || (!item.available && !checked),
        };
      });
    return { mode, canEdit, selectedIds, total: rows.length, rows: shown };
  };
  const toggleShared = (kind: Kind, id: string, on: boolean) => {
    const { canEdit, selectedIds } = rowsOf(kind, false);
    if (canEdit) onChange(kind, on ? [...selectedIds, id] : selectedIds.filter((value) => value !== id));
  };

  const groups: ReactNode[] = [];

  // Core: always on, opens a read-only explanation.
  if (matches(t('bots.capabilities.core.name'), t('bots.capabilities.core.hint'), 'teammate-guide')) {
    groups.push(
      <Group key="core" title={t('bots.capabilities.core.group')}>
        <ListRow
          title={t('bots.capabilities.core.name')}
          hint={t('bots.capabilities.core.hint')}
          onOpen={() => setView({ type: 'core' })}
          trailing={<span className="text-12 text-[var(--text-tertiary)]">{t('bots.capabilities.alwaysOn')}</span>}
        />
      </Group>,
    );
  }

  // System Skills: on unless this teammate turned one off.
  const systemRows = BOT_SYSTEM_SKILL_IDS.filter((id) =>
    matches(t(`bots.capabilities.system.items.${id}.name`), t(`bots.capabilities.system.items.${id}.hint`), id));
  if (systemRows.length) {
    const onCount = BOT_SYSTEM_SKILL_IDS.filter((id) => isBotSystemSkillOn(capabilities, id)).length;
    groups.push(
      <Group key="system" title={t('bots.capabilities.system.group')}
        meta={t('bots.capabilities.system.meta', { on: onCount, total: BOT_SYSTEM_SKILL_IDS.length })}>
        {systemRows.map((id) => {
          const on = isBotSystemSkillOn(capabilities, id);
          const name = t(`bots.capabilities.system.items.${id}.name`);
          return (
            <ListRow key={id} title={name} hint={t(`bots.capabilities.system.items.${id}.hint`)} dim={!on}
              onOpen={() => setView({ type: 'system', id })}
              control={<Switch aria-label={name} checked={on} disabled={!onSystemSkillChange}
                onCheckedChange={(value) => onSystemSkillChange?.(id, value === true)} />} />
          );
        })}
      </Group>,
    );
  }

  // Learned Skills: switch, then view / edit / delete on their own page.
  const learned = rowsOf('skill', true);
  // Groups wait for their catalog: an empty card while loading reads as "nothing here".
  if (entries.skill && (learned.rows.length || !needle)) {
    const fold = folded(learned.rows, Boolean(unfolded.learned), Boolean(needle));
    const row = (item: Row) => {
      const slug = item.id.replace(/^personal:/, '');
      return (
        <ListRow key={item.id} title={item.name} hint={item.description} dim={!item.checked}
          onOpen={target.skills ? () => setView({ type: 'learned', slug }) : undefined}
          control={<Switch aria-label={item.name} checked={item.checked} disabled={item.disabled}
            onCheckedChange={(value) => void setLearnedEnabled(slug, value === true)} />} />
      );
    };
    groups.push(
      <Group key="learned" title={t('bots.capabilities.learned.group')} meta={String(learned.total)}>
        {fold.shown.map(row)}
        <Fold hidden={fold.hidden.map(row)} count={fold.hidden.length} open={Boolean(unfolded.learned)}
          onToggle={() => setUnfolded((value) => ({ ...value, learned: !value.learned }))} />
        {learned.total === 0 && (
          <p className="px-4 py-3 text-12 leading-5 text-[var(--text-secondary)]">{t('bots.capabilities.learned.empty')}</p>
        )}
      </Group>,
    );
  }

  // Shared references: Skills on this computer, built-in tools, MCP.
  for (const kind of ['skill', 'toolset', 'mcp'] as const) {
    const data = rowsOf(kind, false);
    if (!data.rows.length && (needle || !entries[kind])) continue;
    const key = `shared-${kind}`;
    const fold = folded(data.rows, Boolean(unfolded[key]), Boolean(needle));
    const checkedCount = data.rows.filter((item) => item.checked).length;
    const meta = !entries[kind] ? undefined : data.mode === 'inherit'
      ? t('bots.capabilities.followMeta', { count: data.rows.filter((item) => item.available).length })
      : t('bots.capabilities.selectedMeta', { count: checkedCount, total: data.total });
    const row = (item: Row) => (
      <ListRow key={item.id} title={item.name} hint={item.description} dim={!item.available}
        note={item.available ? undefined : (
          <>
            {t(item.missing ? 'bots.capabilities.notOnThisComputer' : kind === 'toolset' ? 'bots.capabilities.notTurnedOn' : 'bots.capabilities.unavailableHint')}
            {kind === 'toolset' && !item.missing && onConfigure ? (
              <>
                {' · '}
                <button type="button" className={linkClass} onClick={() => onConfigure(kind, item.id)}>
                  {t('bots.capabilities.turnOn')}
                </button>
              </>
            ) : null}
          </>
        )}
        control={<Switch aria-label={item.name} checked={item.checked} disabled={item.disabled}
          onCheckedChange={(value) => toggleShared(kind, item.id, value === true)} />} />
    );
    groups.push(
      <Group key={key} title={t(kind === 'skill' ? 'bots.capabilities.local.group' : `bots.capabilities.${kind}`)} meta={meta}
        action={onConfigure ? {
          label: t(kind === 'toolset' ? 'bots.capabilities.toolSettings' : 'bots.capabilities.manage'),
          onClick: () => onConfigure(kind),
        } : undefined}>
        {fold.shown.map(row)}
        <Fold hidden={fold.hidden.map(row)} count={fold.hidden.length} open={Boolean(unfolded[key])}
          onToggle={() => setUnfolded((value) => ({ ...value, [key]: !value[key] }))} />
        {!busy && !error && data.total === 0 && (
          <p className="px-4 py-3 text-12 leading-5 text-[var(--text-secondary)]">{t(`bots.capabilities.empty_${kind}`)}</p>
        )}
      </Group>,
    );
  }

  // Permissions: a switch for the owner, not a Skill.
  if (onInputHandoffChange && matches(t('bots.capabilities.inputHandoff.title'), t('bots.capabilities.inputHandoff.description'))) {
    groups.push(
      <Group key="permissions" title={t('bots.capabilities.permissions')}>
        <ListRow title={t('bots.capabilities.inputHandoff.title')} hint={t('bots.capabilities.inputHandoff.description')} wrapHint
          control={<Switch aria-label={t('bots.capabilities.inputHandoff.title')} checked={capabilities.inputHandoff !== false}
            onCheckedChange={(value) => onInputHandoffChange(value === true)} />} />
      </Group>,
    );
  }

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
      <div className={cn('flex flex-col gap-5', expanded === undefined ? 'px-3 pt-4' : 'pt-1')}>
        <div className="flex flex-col gap-3">
          <p className="text-12 leading-5 text-[var(--text-secondary)]">{t('bots.capabilities.intro')}</p>
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
          {busy ? <p className="text-12 text-[var(--text-secondary)]">{t('bots.capabilities.loading')}</p> : null}
          {error ? (
            <Button variant="secondary" size="md" tone="danger" compact type="button" onClick={refresh}>
              {t('bots.retry')}
            </Button>
          ) : null}
        </div>
        {groups}
        {needle && groups.length === 0 ? (
          <p className="py-12 text-center text-13 text-[var(--text-secondary)]">{t('bots.capabilities.empty')}</p>
        ) : null}
      </div>
    </details>
  );
}

const linkClass =
  'rounded-[4px] text-12 font-medium text-[var(--text-secondary)] outline-none hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]';

/** One group: a quiet heading with its count, and the rows on one card (as on the Memory page). */
function Group({ title, meta, action, children }: {
  title: string;
  meta?: string;
  action?: { label: string; onClick: () => void };
  children: ReactNode;
}) {
  return (
    <fieldset className="min-w-0">
      <div className="flex items-baseline justify-between gap-3 px-1 pb-2">
        <legend className="float-left flex min-w-0 items-baseline gap-1.5 text-12 font-medium leading-[1.33] text-[var(--text-secondary)]">
          {title}
          {meta ? <span className="font-normal tabular-nums text-[var(--text-tertiary)]">{meta}</span> : null}
        </legend>
        {action ? (
          <button type="button" className={cn(linkClass, 'shrink-0')} onClick={action.onClick}>{action.label}</button>
        ) : null}
      </div>
      <div className="clear-both overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
        <div className="divide-y divide-[var(--border-default)]">{children}</div>
      </div>
    </fieldset>
  );
}

/**
 * A row: name and a one-line description on the left, a switch and/or a chevron on the right.
 * Rows that open a page are buttons; the switch stays a separate control.
 */
function ListRow({ title, hint, note, control, trailing, onOpen, dim, wrapHint }: {
  title: string;
  hint?: string;
  note?: ReactNode;
  control?: ReactNode;
  trailing?: ReactNode;
  onOpen?: () => void;
  dim?: boolean;
  wrapHint?: boolean;
}) {
  const text = (
    <span className="min-w-0 flex-1">
      <span className={cn('block break-words text-13 font-medium leading-[1.45] [overflow-wrap:anywhere]',
        dim ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-primary)]')}>{title}</span>
      {hint ? (
        <span title={wrapHint ? undefined : hint} className={cn('mt-0.5 block text-12 leading-[1.5] text-[var(--text-secondary)] [overflow-wrap:anywhere]',
          !wrapHint && 'line-clamp-1')}>{hint}</span>
      ) : null}
      {note ? <span className="mt-0.5 block text-12 leading-[1.5] text-[var(--text-tertiary)]">{note}</span> : null}
    </span>
  );
  // The whole row opens the page; the switch keeps its own click.
  return (
    <div onClick={onOpen}
      className={cn('flex min-h-[52px] items-center gap-3 px-4 py-3 transition-colors duration-fast',
        onOpen && 'cursor-pointer hover:bg-[var(--surface-hover)]')}>
      {onOpen ? (
        <button type="button" onClick={(event) => { event.stopPropagation(); onOpen(); }}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
          {text}
          {trailing}
        </button>
      ) : (
        <>
          {text}
          {trailing}
        </>
      )}
      {control ? (
        <span className="flex shrink-0 items-center" onClick={(event) => event.stopPropagation()}>{control}</span>
      ) : null}
      {onOpen ? <ChevronRight size={14} aria-hidden className="-ml-1 shrink-0 text-[var(--text-tertiary)]" /> : null}
    </div>
  );
}

/**
 * "Show N more" / "Show less" with the hidden rows unfolding underneath. One child of the card's
 * divided list, so it draws a single divider above it; the unfolded rows bring their own.
 */
function Fold({ hidden, count, open, onToggle }: { hidden: ReactNode[]; count: number; open: boolean; onToggle: () => void }) {
  const { t } = useBotTranslation();
  if (!count && !open) return null;
  return (
    <div>
      <Collapse open={open}>
        <div className="divide-y divide-[var(--border-default)] border-b border-[var(--border-default)]">{hidden}</div>
      </Collapse>
      {count ? (
        <button type="button" onClick={onToggle} aria-expanded={open}
          className="flex w-full items-center gap-1 px-4 py-2.5 text-left text-12 font-medium text-[var(--text-secondary)] outline-none transition-colors duration-fast hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]">
          {open ? t('bots.capabilities.showLess') : t('bots.capabilities.showRest', { count })}
          <ChevronDown size={12} aria-hidden className={cn('transition-transform duration-fast', open && 'rotate-180')} />
        </button>
      ) : null}
    </div>
  );
}
