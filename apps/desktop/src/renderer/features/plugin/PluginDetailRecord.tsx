import { ChevronRight, Shield, type LucideIcon } from 'lucide-react';
import { createContext, useContext, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsCard } from '@/components/ui/settings-rows';
import { cn } from '@/lib/utils';

const steps = ['description', 'updates', 'readme', 'permissions', 'facts'] as const;
type DetailBlock = typeof steps[number];
type DetailBlocks = Partial<Record<DetailBlock, boolean>>;
type DetailRelaxation = { level: number; blocks: DetailBlocks };
const compact: DetailRelaxation = { level: 0, blocks: {} };

type DetailVisit = {
  id: string;
  navigationScope?: object;
  relaxation?: DetailRelaxation;
  choices: Map<string, boolean>;
};
type DetailTrail = {
  parents: DetailVisit[];
  opening?: { id: string; parent: DetailVisit };
  returning?: DetailVisit;
};
const trails = new WeakMap<object, DetailTrail>();

function startVisit(id: string, navigationScope?: object): DetailVisit {
  const returning = navigationScope ? trails.get(navigationScope)?.returning : undefined;
  return returning?.id === id ? returning : { id, navigationScope, choices: new Map() };
}

const PluginDetailLayoutContext = createContext<{
  visit: DetailVisit;
  relaxation: DetailRelaxation;
} | null>(null);

/** Measure at most once per visit, applying each available step before measuring again. */
export function usePluginDetailLayout({
  id, blocks, ready = true, readmePending = false, navigationScope, hasParent = false,
}: {
  id: string;
  blocks: DetailBlocks;
  ready?: boolean;
  readmePending?: boolean;
  navigationScope?: object;
  hasParent?: boolean;
}) {
  const article = useRef<HTMLElement>(null);
  const [activeVisit, setVisit] = useState(() => startVisit(id, navigationScope));
  let visit = activeVisit;
  if (visit.id !== id || visit.navigationScope !== navigationScope) {
    visit = startVisit(id, navigationScope);
    setVisit(visit);
  }
  const [measuring, setMeasuring] = useState<{ visit: DetailVisit; relaxation: DetailRelaxation }>();
  const [waiting, setWaiting] = useState<DetailVisit>();
  const [timedOut, setTimedOut] = useState<DetailVisit>();
  const measuringThisVisit = measuring?.visit === visit ? measuring.relaxation : undefined;
  const relaxation = visit.relaxation ?? measuringThisVisit ?? compact;

  useLayoutEffect(() => {
    if (!navigationScope) return;
    const trail = trails.get(navigationScope);
    if (!trail) return;
    if (trail.returning === visit) {
      trail.returning = undefined;
    } else if (!hasParent) {
      trails.delete(navigationScope);
    } else if (trail.opening?.id === id) {
      trail.parents.push(trail.opening.parent);
      trail.opening = undefined;
    }
  }, [hasParent, id, navigationScope, visit]);

  useLayoutEffect(() => {
    if (waiting !== visit) return;
    const timeout = setTimeout(() => setTimedOut(visit), 150);
    return () => clearTimeout(timeout);
  }, [visit, waiting]);

  useLayoutEffect(() => {
    if (visit.relaxation || !ready) return;
    const frame = article.current;
    const scroller = frame?.closest('main');
    const end = frame?.querySelector('[data-plugin-detail-end]');
    if (!scroller || !end) return;
    if (scroller.clientHeight === 0) {
      visit.relaxation = compact;
      if (waiting === visit) setWaiting(undefined);
      return;
    }
    if (!measuringThisVisit) {
      if (readmePending && timedOut !== visit) {
        if (waiting !== visit) setWaiting(visit);
      } else {
        // Give the text disclosures a layout pass to settle their line counts.
        setMeasuring({ visit, relaxation: { level: 0, blocks } });
      }
      return;
    }
    const bottom = end.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const space = scroller.clientHeight - bottom;
    const next = steps.findIndex((block, index) => (
      index >= relaxation.level && relaxation.blocks[block] && space > (index === 0 ? 0 : 120)
    ));
    if (next >= 0) {
      setMeasuring({ visit, relaxation: { ...relaxation, level: next + 1 } });
    } else {
      visit.relaxation = relaxation;
      if (waiting === visit) setWaiting(undefined);
    }
  });

  const context = useMemo(() => ({ visit, relaxation }), [visit, relaxation]);
  return {
    article,
    context,
    waiting: waiting === visit,
    rememberForward(pluginId: string) {
      if (!navigationScope) return;
      const trail = trails.get(navigationScope) ?? { parents: [] };
      trail.opening = { id: `market:${pluginId}`, parent: visit };
      trails.set(navigationScope, trail);
    },
    rememberBack() {
      if (!navigationScope) return;
      const trail = trails.get(navigationScope);
      if (!trail) return;
      trail.opening = undefined;
      trail.returning = hasParent ? trail.parents.pop() : undefined;
      if (!trail.returning) trails.delete(navigationScope);
    },
  };
}

export function PluginDetailArticle({ layout, className, children }: {
  layout: ReturnType<typeof usePluginDetailLayout>;
  className: string;
  children: ReactNode;
}) {
  return (
    <PluginDetailLayoutContext.Provider value={layout.context}>
      <article ref={layout.article} className={cn(className, layout.waiting && 'invisible')}>{children}</article>
    </PluginDetailLayoutContext.Provider>
  );
}

export function usePluginDetailRelaxed(block: DetailBlock) {
  const relaxation = useContext(PluginDetailLayoutContext)?.relaxation ?? compact;
  return Boolean(relaxation.blocks[block] && relaxation.level > steps.indexOf(block));
}

export function usePluginDetailChoice(key?: string) {
  const visit = useContext(PluginDetailLayoutContext)?.visit;
  const [choice, setChoice] = useState<{ visit: DetailVisit | undefined; open: boolean }>();
  return [
    choice?.visit === visit ? choice?.open : key ? visit?.choices.get(key) : undefined,
    (open: boolean) => {
      if (key && visit) visit.choices.set(key, open);
      setChoice({ visit, open });
    },
  ] as const;
}

export function PluginDetailSection({ title, titleEnd, children }: {
  title: string;
  titleEnd?: ReactNode;
  children: ReactNode;
}) {
  const titleId = useId();
  const heading = <h2 id={titleId} className="text-16 font-medium leading-[1.2] text-[var(--text-primary)]">{title}</h2>;
  return (
    <section aria-labelledby={titleId} className="mt-11 space-y-4">
      {titleEnd ? <div className="flex items-center gap-1.5">{heading}{titleEnd}</div> : heading}
      {children}
    </section>
  );
}

export function PluginDetailRecord({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <PluginDetailSection title={t('settings.ghosts.detail.recordTitle')}>
      <SettingsCard data-plugin-detail-end className="divide-y divide-[var(--border-default)] px-4">{children}</SettingsCard>
    </PluginDetailSection>
  );
}

export function PluginDetailRecordRow({ icon: Icon, title, summary, defaultOpen, open, onOpenChange, children }: {
  icon: LucideIcon;
  title: string;
  summary?: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <details className="group" open={open ?? defaultOpen} onToggle={event => {
      if (open === undefined && event.target === event.currentTarget) onOpenChange?.(event.currentTarget.open);
    }}>
      <summary onClick={open === undefined ? undefined : event => {
        event.preventDefault();
        onOpenChange?.(!open);
      }}
        className="flex min-h-14 cursor-pointer list-none items-center gap-3 rounded-lg py-2 text-14 font-medium leading-[1.429] text-[var(--text-primary)] hover:bg-[var(--surface-hover-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] [&::-webkit-details-marker]:hidden">
        <Icon size={18} aria-hidden="true" className="shrink-0 text-[var(--text-secondary)]" />
        <span className="min-w-0 flex-1">{title}</span>
        {summary && <span className="shrink-0 text-13 font-normal text-[var(--text-tertiary)]">{summary}</span>}
        <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-[var(--text-tertiary)] group-open:rotate-90" />
      </summary>
      <div className="min-w-0 px-1 pb-5 pt-1">{children}</div>
    </details>
  );
}

export function PluginDetailPermissionRow({ summary, children }: {
  summary?: ReactNode;
  children: (limit: number) => ReactNode;
}) {
  const { t } = useTranslation();
  const [choice, setChoice] = usePluginDetailChoice('permissions');
  const relaxed = usePluginDetailRelaxed('permissions');
  return (
    <PluginDetailRecordRow icon={Shield} title={t('settings.ghosts.detail.permissionsTitle')} summary={summary}
      open={choice ?? relaxed} onOpenChange={setChoice}>
      {children(choice === undefined && relaxed ? 3 : 5)}
    </PluginDetailRecordRow>
  );
}
