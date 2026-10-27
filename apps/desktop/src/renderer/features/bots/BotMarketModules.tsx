import { AlertTriangle, BarChart3, Check, Code2, FileText, Folder, History, Layers, LayoutPanelTop, Link2, ListChecks,
  Search, Target, Video, type LucideIcon } from 'lucide-react';
import { type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { BotCapabilityIcon, BotMarketEntry } from '../../../shared/botMarket';
import { botRoutineRhythm } from './botMarketDisplay';
import { SIDEBAR_NAVIGATION_ITEM_ICONS } from '@/components/sidebar/sidebarNavigationPrefs';
import { botSettingsIcons } from './botSettingsIcons';

/** What the renderer already knows about a plugin the package works with; display only, never an install. */
export interface BotMarketPluginInfo { name?: string; installed?: boolean }

/** Icons for key capabilities: the BOT_CAPABILITY_ICONS whitelist, nothing free-form. */
export const capabilityIcons: Record<BotCapabilityIcon, LucideIcon> = {
  code: Code2, check: Check, folder: Folder, file: FileText, target: Target, list: ListChecks, layout: LayoutPanelTop,
  search: Search, history: History, chart: BarChart3, alert: AlertTriangle,
  layers: Layers, link: Link2, video: Video,
};

/** Entrance stagger index (DESIGN.md §14.4); identity and capabilities take 0 and 1. */
export const rise = (index: number) => ({ '--rise-index': index }) as CSSProperties;

function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <li className={cn('rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-3', className)}>{children}</li>;
}
const Tag = ({ children }: { children: ReactNode }) => <span className="rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-2 py-0.5 text-12 text-[var(--text-secondary-mid)]">{children}</span>;

/** One module: label and count, then its rows. */
function Module({ title, icon: Icon, count, index, heading, children }: { title: string; icon: LucideIcon; count?: number; index: number; heading?: ReactNode; children: ReactNode }) {
  return <section className={cn('bot-market-rise', heading ? 'pt-6' : 'pt-8')} style={rise(index)}>
    {heading}
    <h4 className={cn('flex items-center gap-1.5 text-13 font-medium text-[var(--text-secondary-mid)]', heading && 'mt-5')}>
      <Icon size={14} aria-hidden className="shrink-0" />{count === undefined ? title : `${title} · ${count}`}
    </h4>
    {children}
  </section>;
}

export function BotMarketModules({ entry, plugins, heading }: { entry: BotMarketEntry; plugins: Record<string, BotMarketPluginInfo>; heading: ReactNode }) {
  const { t, i18n } = useTranslation();
  // Modules without data are hidden; the entrance order follows what is shown (at most 6 segments).
  let next = 2;
  const index = () => Math.min(next++, 5);
  const modules: ReactNode[] = [];
  // Module icons: teammate settings entries (botSettingsIcons) for skills, memory and routines; work tools are plugins, so they use the sidebar Plugins icon.
  let headingSlot: ReactNode = heading;
  const take = () => { const slot = headingSlot; headingSlot = undefined; return slot; };
  if (entry.skills.length) modules.push(<Module key="skills" title={t('bots.market.skills')} icon={botSettingsIcons.capabilities} count={entry.skills.length} index={index()} heading={take()}>
    <ul className="mt-3 flex flex-col gap-2">{entry.skills.map(skill => <Card key={skill.name}>
      <h5 className="text-15 font-medium text-[var(--text-primary)]">{skill.name}</h5>
      <p className="mt-0.5 line-clamp-2 text-13 leading-5 text-[var(--text-secondary-mid)]">{skill.description}</p>
    </Card>)}</ul>
  </Module>);
  if (entry.knowledge.length || entry.remembers.length) modules.push(<Module key="knowledge" title={t('bots.market.knowledge')} icon={botSettingsIcons.memory} count={entry.knowledge.length || undefined} index={index()} heading={take()}>
    {entry.knowledge.length > 0 && <ul className="mt-3 flex flex-col gap-2">{entry.knowledge.map(reference => <Card key={reference.title}>
      <h5 className="text-15 font-medium text-[var(--text-primary)]">{reference.title}</h5>
      <p className="mt-0.5 line-clamp-3 text-13 leading-5 text-[var(--text-secondary-mid)]">{reference.summary}</p>
    </Card>)}</ul>}
    {entry.remembers.length > 0 && <div className="mt-3 flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-13 font-medium text-[var(--text-primary)]">{t('bots.market.remembersLead')}</span>
      {entry.remembers.map(item => <Tag key={item}>{item}</Tag>)}
    </div>}
  </Module>);
  if (entry.tools.length) modules.push(<Module key="tools" title={t('bots.market.tools')} icon={SIDEBAR_NAVIGATION_ITEM_ICONS.plugins} index={index()} heading={take()}>
    <ul className="mt-3 divide-y divide-[var(--border-default)] rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
      {entry.tools.map(tool => <ToolRow key={tool.id} id={tool.id} purpose={tool.purpose} info={plugins[tool.id]} />)}
    </ul>
  </Module>);
  if (entry.routines.length) modules.push(<Module key="routines" title={t('bots.market.routines')} icon={botSettingsIcons.routines} count={entry.routines.length} index={index()} heading={take()}>
    <ul className="mt-3 flex flex-col gap-2">{entry.routines.map(routine => {
      const rhythm = routine.cron ? botRoutineRhythm(routine.cron, t, i18n.language) : undefined;
      return <Card key={routine.name}>
        <div className="flex items-center justify-between gap-3">
          <h5 className="min-w-0 truncate text-15 font-medium text-[var(--text-primary)]">{routine.name}{rhythm && <>
            <span aria-hidden className="mx-1.5 font-normal text-[var(--text-secondary-mid)]">·</span>
            <span className="text-13 font-normal text-[var(--text-secondary-mid)]">{rhythm}</span></>}</h5>
          <span className="shrink-0 text-12 text-[var(--text-secondary-mid)]">{t('bots.market.routineOff')}</span>
        </div>
        <p className="mt-0.5 truncate text-13 leading-5 text-[var(--text-secondary-mid)]">{routine.summary}</p>
      </Card>;
    })}</ul>
  </Module>);
  return <>{modules}</>;
}

const statusCell = 'col-start-1 row-start-1 transition-opacity duration-[var(--motion-fast)]';
function ToolRow({ id, purpose, info }: { id: string; purpose: string; info?: BotMarketPluginInfo }) {
  const { t } = useTranslation();
  const installed = info?.installed === true, notInstalled = info?.installed === false;
  return <li className="flex items-center gap-3 px-4 py-2.5">
    <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="text-14 font-medium text-[var(--text-primary)]">{info?.name ?? id}</span>
      <span className="min-w-0 text-13 leading-5 text-[var(--text-secondary-mid)]">{purpose}</span>
    </div>
    {/* Both state labels share one grid cell, so the cell is as wide as the longer one in any language and a late
        projection only fades the right label in; the row never changes width or height. */}
    <span data-plugin-status className="inline-grid shrink-0 justify-items-end whitespace-nowrap text-right text-12 text-[var(--text-secondary-mid)]">
      <span aria-hidden={!installed} className={cn(statusCell, installed ? 'opacity-100' : 'opacity-0')}>{t('bots.market.pluginInstalled')}</span>
      <span aria-hidden={!notInstalled} className={cn(statusCell, notInstalled ? 'opacity-100' : 'opacity-0')}>{t('bots.market.pluginNotInstalled')}</span>
    </span>
  </li>;
}
