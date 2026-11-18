/**
 * Introduction shown before someone's first project (2026-11-18 user request;
 * docs/product-rules/project-settings.md). Three cards say what a project is good for: the
 * results are files in your own folder, a new task needs no briefing, and separate work stays
 * separate. Each has a small scene that plays once.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, Folder, FolderOpen, FolderPlus } from 'lucide-react';

import { FeatureIntroDialog } from '@/components/feature-intro/FeatureIntroDialog';
import { at } from '@/components/feature-intro/GuideCover';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { recentWorkdirsStore } from '@/lib/recentWorkdirsStore';
import { cn } from '@/lib/utils';

const SEEN_KEY = 'featureIntro.project.seen';

function projectIntroSeen(): boolean {
  try {
    return !!localStorage.getItem(SEEN_KEY);
  } catch {
    // Storage that cannot be read cannot record "seen" either: do not show it every time.
    return true;
  }
}

/**
 * Someone who already works in projects needs no introduction. The sidebar and the new-task page
 * keep both lists loaded, and they are where the form opens from; a list that has not loaded is
 * unknown, which is not the same as empty.
 */
function hasNoProjectYet(): boolean {
  const local = recentWorkdirsStore.get();
  if (
    !local ||
    local.length > 0 ||
    !remoteProjectsStore.getInitialDiscoverySettled() ||
    remoteProjectsStore.getBootstrapLoadingDeviceIds().size > 0 ||
    remoteProjectsStore.getBootstrapFailedDeviceIds().size > 0
  ) return false;
  return !remoteProjectsStore
    .getMergedRemoteSessions()
    .some((session) => session.workspaceKind === 'project');
}

/**
 * Whether the introduction stands in front of the new-project form. Every entrance opens the
 * same form, so the form decides here instead of each entrance: true for someone with no project
 * yet, once per computer, recorded as soon as it shows, and false again once it is closed.
 */
export function useProjectIntro(create: boolean): [boolean, () => void] {
  const [intro, setIntro] = useState(() => create && !projectIntroSeen() && hasNoProjectYet());
  useEffect(() => {
    if (!intro) return;
    try {
      localStorage.setItem(SEEN_KEY, '1');
    } catch {
      // Shown this once without a record.
    }
  }, [intro]);
  return [intro, () => setIntro(false)];
}

export function ProjectIntro({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const scenes = { files: FilesScene, context: ContextScene, separate: SeparateScene } as const;
  return (
    <FeatureIntroDialog
      open={open}
      onClose={onClose}
      mark={(
        <span className="flex size-14 items-center justify-center rounded-xl bg-[var(--surface-chip)] text-[var(--text-primary)]">
          <FolderPlus size={26} strokeWidth={1.7} aria-hidden="true" />
        </span>
      )}
      title={t('featureIntro.project.title')}
      lead={t('featureIntro.project.lead')}
      cards={(Object.keys(scenes) as (keyof typeof scenes)[]).map((id) => {
        const Scene = scenes[id];
        return {
          id,
          title: t(`featureIntro.project.${id}.title`),
          body: t(`featureIntro.project.${id}.body`),
          scene: (start: number) => <Scene start={start} />,
        };
      })}
      actionLabel={t('featureIntro.project.start')}
      note={t('featureIntro.project.note')}
    />
  );
}

const PANEL = 'rounded-lg border border-[var(--border-default)] bg-[var(--confirm-bg)]';
const ROW = 'flex h-[11px] items-center gap-2';
const LINE = 'h-1.5 rounded-full bg-[var(--border-default)]';
const NAME = 'h-1.5 rounded-full bg-[var(--text-tertiary)]';
/** The wrapper carries the motion: nothing animates on SVG. */
const ICON = 'first-run-pop flex shrink-0 text-[var(--text-secondary)]';
/** The same colours as a real row's dot: green for a new result, blue for waiting on you. */
const NEW_RESULT = 'size-1.5 shrink-0 rounded-full bg-[var(--card-status-done)]';
const AWAITING = 'size-1.5 shrink-0 rounded-full bg-[var(--card-status-awaiting)]';

/** Files: the project is one folder, and what gets made arrives in it file by file. */
function FilesScene({ start }: { start: number }) {
  return (
    <div className="flex w-[78%] items-center gap-3">
      <span className={cn('first-run-pop flex size-10 shrink-0 items-center justify-center text-[var(--text-secondary)]', PANEL)} style={at(start)}>
        <Folder size={18} strokeWidth={1.7} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {['w-[86%]', 'w-[58%]', 'w-[72%]'].map((width, row) => {
          const arrived = start + 180 + row * 160;
          return (
            <span key={row} className={ROW}>
              <span className={ICON} style={at(arrived)}>
                <FileText size={10} strokeWidth={2} />
              </span>
              <span className={cn('first-run-draw', LINE, width)} style={at(arrived + 70)} />
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** Context: a new task is given the project, and the project's files come with it. */
function ContextScene({ start }: { start: number }) {
  return (
    <div className={cn('flex w-[72%] flex-col gap-2 px-2.5 py-2.5', PANEL)}>
      {/* The project chip of the new-task composer. */}
      <span className="first-run-pop flex h-3.5 w-[58%] items-center gap-1.5 rounded-full bg-[var(--surface-chip)] px-1.5 text-[var(--text-secondary)]" style={at(start)}>
        <FolderOpen size={9} strokeWidth={2.2} className="shrink-0" />
        <span className={cn('flex-1', NAME)} />
      </span>
      {['w-[70%]', 'w-[52%]'].map((width, row) => {
        const arrived = start + 300 + row * 180;
        return (
          <span key={row} className={ROW}>
            <span className={ICON} style={at(arrived)}>
              <FileText size={10} strokeWidth={2} />
            </span>
            <span className={cn('first-run-draw', LINE, width)} style={at(arrived + 70)} />
          </span>
        );
      })}
    </div>
  );
}

/** Separate: two projects side by side, each collecting its own tasks. */
function SeparateScene({ start }: { start: number }) {
  return (
    <div className="flex w-[84%] gap-2">
      {[0, 1].map((project) => {
        const opened = start + project * 320;
        return (
          <div key={project} className={cn('flex min-w-0 flex-1 flex-col gap-2 px-2 py-2.5', PANEL)}>
            <span className={ROW}>
              <span className={ICON} style={at(opened)}>
                <FolderOpen size={11} strokeWidth={2} />
              </span>
              <span className={cn('first-run-draw', NAME, project === 0 ? 'w-[62%]' : 'w-[48%]')} style={at(opened + 70)} />
            </span>
            {[0, 1].map((row) => {
              const arrived = opened + 160 + row * 110;
              return (
                <span key={row} className={ROW}>
                  <span className={cn('first-run-draw', LINE, row === project ? 'w-[70%]' : 'w-[52%]')} style={at(arrived)} />
                  {row === 0 ? (
                    <span className={cn('first-run-pop ml-auto', project === 0 ? NEW_RESULT : AWAITING)} style={at(arrived + 120)} />
                  ) : null}
                </span>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
