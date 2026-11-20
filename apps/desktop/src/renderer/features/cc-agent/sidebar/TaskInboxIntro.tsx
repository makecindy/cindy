/**
 * Introduction shown the first time inbox mode is turned on on this computer (2026-11-18 user
 * request; docs/product-rules/task-inbox.md). Three cards: pending, Done and Snooze, each with a
 * small scene that plays once.
 */
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Clock, ListChecks } from 'lucide-react';

import { FeatureIntroDialog } from '@/components/feature-intro/FeatureIntroDialog';
import { at } from '@/components/feature-intro/GuideCover';
import { cn } from '@/lib/utils';

const SEEN_KEY = 'featureIntro.taskInbox.seen';

/** True once, the first time this computer turns inbox mode on; records it at the same time. */
export function claimTaskInboxIntro(): boolean {
  try {
    if (localStorage.getItem(SEEN_KEY)) return false;
    localStorage.setItem(SEEN_KEY, '1');
    return true;
  } catch {
    return false;
  }
}

export function TaskInboxIntro({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const scenes = { pending: PendingScene, done: DoneScene, snooze: SnoozeScene } as const;
  return (
    <FeatureIntroDialog
      open={open}
      onClose={onClose}
      mark={(
        <span className="flex size-14 items-center justify-center rounded-xl bg-[var(--surface-chip)] text-[var(--text-primary)]">
          <ListChecks size={26} strokeWidth={1.7} aria-hidden="true" />
        </span>
      )}
      title={t('featureIntro.taskInbox.title')}
      lead={t('featureIntro.taskInbox.lead')}
      cards={(Object.keys(scenes) as (keyof typeof scenes)[]).map((id) => {
        const Scene = scenes[id];
        return {
          id,
          title: t(`featureIntro.taskInbox.${id}.title`),
          body: t(`featureIntro.taskInbox.${id}.body`),
          scene: (start: number) => <Scene start={start} />,
        };
      })}
      actionLabel={t('featureIntro.taskInbox.start')}
      note={t('featureIntro.taskInbox.note')}
    />
  );
}

const LIST = 'flex w-[72%] flex-col rounded-lg border border-[var(--border-default)] bg-[var(--confirm-bg)] px-2.5 py-2.5';
const ROW = 'flex h-[11px] items-center gap-2';
const LINE = 'h-1.5 rounded-full bg-[var(--border-default)]';
/** The same colours as a real row's dot: green for a new result, blue for waiting on you. */
const NEW_RESULT = 'size-1.5 shrink-0 rounded-full bg-[var(--card-status-done)]';
const AWAITING = 'size-1.5 shrink-0 rounded-full bg-[var(--card-status-awaiting)]';
/** Row height plus the gap between rows: how far a row moves up to close a gap. */
const ROW_PITCH = 19;

/** Pending: tasks with a new result or waiting on you arrive one after another. */
function PendingScene({ start }: { start: number }) {
  return (
    <div className={cn(LIST, 'gap-2')}>
      {['w-[70%]', 'w-[50%]', 'w-[60%]'].map((width, row) => {
        const arrived = start + row * 180;
        return (
          <span key={row} className={ROW}>
            <span className={cn('first-run-draw', LINE, width)} style={at(arrived)} />
            <span className={cn('first-run-pop ml-auto', row === 1 ? AWAITING : NEW_RESULT)} style={at(arrived + 120)} />
          </span>
        );
      })}
    </div>
  );
}

/** Done: the top task is ticked, leaves, and the tasks below move up into its place. */
function DoneScene({ start }: { start: number }) {
  const ticked = start + 150;
  const leaves = ticked + 350;
  const shift = { ...at(leaves), '--shift': `${ROW_PITCH}px` } as CSSProperties;
  return (
    <div className={LIST}>
      <div className="relative h-[49px]">
        <span className={cn('first-run-leave absolute inset-x-0 top-0', ROW)} style={at(leaves)}>
          <span className={cn(LINE, 'w-[64%] bg-[var(--text-tertiary)]')} />
          {/* The wrapper carries the motion: nothing animates on SVG. */}
          <span className="first-run-pop ml-auto flex" style={at(ticked)}>
            <Check size={11} strokeWidth={2.2} className="text-[var(--status-success)]" />
          </span>
        </span>
        <div className="first-run-shift flex flex-col gap-2" style={shift}>
          <span className={ROW}><span className={cn(LINE, 'w-[50%]')} /></span>
          <span className={ROW}><span className={cn(LINE, 'w-[60%]')} /></span>
        </div>
      </div>
    </div>
  );
}

/** Snooze: a task is put off with a clock, time passes, and it comes back with a dot. */
function SnoozeScene({ start }: { start: number }) {
  const card = 'relative flex h-10 w-[58px] flex-col justify-center gap-1 rounded border border-[var(--text-tertiary)] bg-[var(--confirm-bg)] px-2';
  const lines = (
    <>
      <span className="h-1 w-[78%] rounded-full bg-[var(--text-tertiary)]" />
      <span className="h-1 w-[52%] rounded-full bg-[var(--border-default)]" />
    </>
  );
  const clock = start + 150;
  const wait = clock + 250;
  const back = wait + 3 * 90 + 60;
  return (
    <div className="flex items-center gap-2">
      <span className={cn('first-run-pop', card)} style={at(start)}>
        {lines}
        <span
          className="first-run-pop absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full border border-[var(--border-default)] bg-[var(--confirm-bg)] text-[var(--text-secondary)]"
          style={at(clock)}
        >
          <Clock size={9} strokeWidth={2.2} />
        </span>
      </span>
      <span className="flex items-center gap-1">
        {[0, 1, 2].map((dot) => (
          <span key={dot} className="first-run-pop size-1 rounded-full bg-[var(--text-tertiary)]" style={at(wait + dot * 90)} />
        ))}
      </span>
      <span className={cn('first-run-pop', card)} style={at(back)}>
        {lines}
        <span className={cn('first-run-pop absolute right-1 top-1', NEW_RESULT)} style={at(back + 150)} />
      </span>
    </div>
  );
}
