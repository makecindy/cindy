/**
 * PluginSidebarWidgets — 「全部任务」标题下的插件状态条(sidebarWidget 能力)。
 * ---------------------------------------------------------------------------
 * 插件只交分组标签、语义色和任务 id;胶囊和任务行由这里绘制。任务标题、项目名和操作都来自
 * 侧栏自己的任务数据,所以 id 对不上任务的直接不显示,数量也只算显示得出来的。
 * 这是原位任务的镜像:不改变任务所在分组、置顶和下方列表。
 */

import { useMemo, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useGhostSidebarWidgets } from '@/cindy-brain/ghostSidebarWidgetStore';
import { useInstalledGhosts } from '@/cindy-brain/useInstalledGhosts';
import { AttentionDot } from '@/components/sidebar/AttentionDot';
import { Tip } from '@/components/ui/tooltip';
import { useSidebarMainViewMode } from '@/hooks/useSidebarCardMode';
import type { Session } from '@/lib/ccAgent.types';
import { cn } from '@/lib/utils';
import type { GhostSidebarWidgetEntry, GhostSidebarWidgetTone } from '../../../../shared/ghost';
import { installedGhostStoragePart } from '../../../../shared/pluginIdentity';

import type { ProjectNode as ProjectNodeData } from '../lib/projectGrouping';
import { buildSessionSourceLabelMap } from '../lib/sessionSourceLabel';
import { SessionEntryRows, type SessionEntryRowsProps } from './SessionEntryList';

type ListProps = Omit<SessionEntryRowsProps, 'entries' | 'sourceLabelMap' | 'sessionVariant'>;

export interface PluginSidebarWidgetsProps extends ListProps {
  sessions: readonly Session[];
  allKnownProjects: readonly ProjectNodeData[];
}

function ToneMark({ tone }: { tone: GhostSidebarWidgetTone }) {
  // 与任务行同一套语义色:橙色转圈专职「正在跑」,其余走 AttentionDot。
  if (tone === 'running') {
    return <LoaderCircle size={12} strokeWidth={2} className="animate-spin text-[var(--warning-accent)]" />;
  }
  return <AttentionDot tone={tone} size={6} />;
}

function PluginSidebarWidget({
  entry,
  pluginName,
  sessionsById,
  allKnownProjects,
  listProps,
}: {
  entry: GhostSidebarWidgetEntry;
  pluginName: string;
  sessionsById: ReadonlyMap<string, Session>;
  allKnownProjects: readonly ProjectNodeData[];
  listProps: ListProps;
}) {
  const { t } = useTranslation();
  const { mode } = useSidebarMainViewMode();
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  const groups = useMemo(
    () =>
      entry.groups
        .map((group) => ({
          ...group,
          sessions: group.taskIds.flatMap((id) => sessionsById.get(id) ?? []),
        }))
        .filter((group) => group.sessions.length > 0),
    [entry.groups, sessionsById],
  );
  const expanded = groups.find((group) => group.key === expandedKey);
  const expandedSessions = expanded?.sessions;
  const sourceLabelMap = useMemo(
    () =>
      expandedSessions &&
      buildSessionSourceLabelMap(
        expandedSessions,
        allKnownProjects,
        t('ccAgent.sidebar.dialogues'),
        t('settings.cindyMake.title'),
      ),
    [expandedSessions, allKnownProjects, t],
  );

  if (groups.length === 0) return null;

  return (
    <div className="flex flex-col gap-1 pt-1 pl-3 select-none" data-plugin-sidebar-widget={entry.ghostId}>
      <Tip text={t('ccAgent.sidebar.pluginWidgetSource', { name: pluginName })} side="bottom">
        <div className="flex flex-wrap gap-0.5 pl-1.5" role="group" aria-label={pluginName}>
          {groups.map((group) => {
            const active = group.key === expandedKey;
            return (
              <button
                key={group.key}
                type="button"
                aria-expanded={active}
                onClick={() => setExpandedKey(active ? null : group.key)}
                className={cn(
                  'flex h-6 items-center gap-1 rounded-full px-1.5 text-12',
                  'text-[var(--sidebar-list-muted)] transition-colors hover:bg-sidebar-item-hover',
                  'focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--focus-ring)]',
                  active && 'bg-sidebar-item-active text-sidebar-item-active-foreground',
                )}
              >
                <ToneMark tone={group.tone} />
                <span>{group.label}</span>
                <span className="tabular-nums">{group.sessions.length}</span>
              </button>
            );
          })}
        </div>
      </Tip>
      {expanded && sourceLabelMap ? (
        <div className="flex flex-col gap-0.5 rounded-lg bg-sidebar-item-hover py-1">
          {/* 直接给普通行:胶囊的数量要和展开的行数一致,定时任务的多次运行不收成组头。 */}
          <SessionEntryRows
            {...listProps}
            entries={expanded.sessions.map((session) => ({ kind: 'session', session }))}
            sourceLabelMap={sourceLabelMap}
            sessionVariant={mode === 'list' ? 'list' : 'text'}
          />
        </div>
      ) : null}
    </div>
  );
}

export function PluginSidebarWidgets({ sessions, allKnownProjects, ...listProps }: PluginSidebarWidgetsProps) {
  const entries = useGhostSidebarWidgets();
  const ghosts = useInstalledGhosts();
  // 只认本机任务:cindy.observe 列不出远程任务,远程同 id 不能被借来显示。
  const sessionsById = useMemo(
    () => new Map(sessions.filter((session) => !session.deviceLinkDeviceId).map((session) => [session.id, session])),
    [sessions],
  );

  return (
    <>
      {entries.map((entry) => {
        const ghost = ghosts.find((item) => installedGhostStoragePart(item) === entry.ghostId);
        // 列表里没有(已卸载或换账号途中)就不画:身份说不清的状态条不显示。
        return ghost ? (
          <PluginSidebarWidget
            key={entry.ghostId}
            entry={entry}
            pluginName={ghost.manifest.name}
            sessionsById={sessionsById}
            allKnownProjects={allKnownProjects}
            listProps={listProps}
          />
        ) : null;
      })}
    </>
  );
}
