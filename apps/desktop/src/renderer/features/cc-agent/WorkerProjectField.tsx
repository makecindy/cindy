import { useEffect, useRef, useState } from 'react';
import { Folder, ChevronDown, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  FolderPickerPopover,
  type FolderPickerSelectSource,
} from '@/components/new-chat/FolderPickerPopover';
import { BranchWorktreeChip } from '@/components/new-chat/WorktreeChipsRow';
import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { Button } from '@/components/ui/button';
import type {
  WorkerProjectContext,
  WorkerWorktreeRequest,
} from '../../../shared/orca-worker-project';

const basename = (value: string) =>
  value
    .replace(/[\\/]$/, '')
    .split(/[\\/]/)
    .pop() || value;

export function useWorkerProjectSelection(
  open: boolean,
  leadSessionId: string | undefined,
  enabled: boolean,
) {
  const owner = getDataOwnerGeneration();
  const scope = JSON.stringify([open, enabled, leadSessionId, owner]);
  const [target, setTarget] = useState<{ scope: string; directory?: string }>();
  const directory = target?.scope === scope ? target.directory : undefined;
  const [checked, setChecked] = useState(false);
  const [sourceBranch, setSourceBranch] = useState('');
  const [retry, setRetry] = useState(0);
  const baseSnapshot = useRef<{ scope: string; context: WorkerProjectContext } | undefined>(
    undefined,
  );
  const [snapshot, setSnapshot] = useState<{
    key: string;
    context?: WorkerProjectContext;
    failed?: boolean;
  }>();
  const key = JSON.stringify([scope, directory, retry]);
  useEffect(() => {
    setTarget(undefined);
    setChecked(false);
    setSourceBranch('');
    setSnapshot(undefined);
    if (!open || !enabled) baseSnapshot.current = undefined;
  }, [scope, open, enabled]);
  useEffect(() => {
    if (!open || !enabled || !leadSessionId) return;
    let cancelled = false;
    const capturedOwner = getDataOwnerGeneration();
    const base = baseSnapshot.current?.scope === scope ? baseSnapshot.current.context : undefined;
    const read = async (): Promise<WorkerProjectContext> => {
      if (!base || directory === undefined) {
        if (base) return base;
        const context =
          await window.electronAPI.localDb.orcaWorkflows.projectContext(leadSessionId);
        if (!cancelled) baseSnapshot.current = { scope, context };
        return context;
      }
      const selected = await window.electronAPI.localDb.orcaWorkflows.projectContext(
        leadSessionId,
        directory,
      );
      return { ...base, selected };
    };
    void read().then(
      (context) => {
        const current = getDataOwnerGeneration();
        if (
          !cancelled &&
          current.dataOwnerId === capturedOwner.dataOwnerId &&
          current.generation === capturedOwner.generation
        )
          setSnapshot({ key, context });
      },
      () => {
        if (!cancelled) setSnapshot({ key, failed: true });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, scope, open, enabled, leadSessionId, directory]);
  const context = snapshot?.key === key ? snapshot.context : undefined;
  const sameProject = !!context && context.selected.directory === context.inherited.directory;
  const canWorktree =
    !!context?.selected.exists &&
    !!context.selected.baseRepo &&
    context.selected.headState !== 'unborn' &&
    !(sameProject && context.dialogue);
  const branch = sourceBranch || context?.selected.branch || '';
  return {
    context,
    sameProject,
    canWorktree,
    checked,
    setChecked,
    branch,
    setSourceBranch,
    failed: snapshot?.key === key && snapshot.failed,
    reload: () => setRetry((value) => value + 1),
    ready: !!context?.selected.exists && (!checked || (canWorktree && !!branch)),
    select: (value: string, source: FolderPickerSelectSource = 'project') => {
      const current = context?.inherited.baseRepo ?? context?.recordedDirectory;
      setTarget({ scope, directory: source !== 'browse' && value === current ? undefined : value });
      setChecked(false);
      setSourceBranch('');
    },
    fields: (context
      ? {
          ...(directory !== undefined && !sameProject
            ? { projectPath: context.selected.baseRepo ?? context.selected.directory }
            : {}),
          ...(context.selected.directory !== context.recordedDirectory
            ? { workingDir: context.selected.directory }
            : {}),
          ...(checked && canWorktree ? { worktree: { sourceBranch: branch } } : {}),
        }
      : {}) as { projectPath?: string; workingDir?: string; worktree?: WorkerWorktreeRequest },
  };
}

export function WorkerProjectField({
  selection,
  disabled,
}: {
  selection: ReturnType<typeof useWorkerProjectSelection>;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [branchSnapshot, setBranchSnapshot] = useState<{
    base: string;
    values: string[];
    remoteDefaultBranch?: string;
    failed?: boolean;
  }>();
  const [branchLoading, setBranchLoading] = useState(false);
  const { context, sameProject, canWorktree, checked, branch } = selection;
  const base = context?.selected.baseRepo ?? '';
  const branchRequest = useRef(0);
  useEffect(() => {
    branchRequest.current++;
    setBranchSnapshot(undefined);
    setBranchLoading(false);
  }, [base]);
  const loadBranches = () => {
    if (!base) return;
    const request = ++branchRequest.current;
    setBranchLoading(true);
    void window.electronAPI
      .worktreeListBranches({ baseRepo: base })
      .then(
        (value) => {
          if (request === branchRequest.current)
            setBranchSnapshot({
              base,
              values: value.branches,
              remoteDefaultBranch: value.remoteDefaultBranch,
            });
        },
        () => {
          if (request === branchRequest.current)
            setBranchSnapshot({ base, values: [], failed: true });
        },
      )
      .finally(() => {
        if (request === branchRequest.current) setBranchLoading(false);
      });
  };
  const selectedName = context
    ? basename(context.selected.baseRepo ?? context.selected.directory)
    : '';
  const sharedName = context
    ? `${selectedName}${context.selected.isWorktree ? ` (${context.selected.worktreeName ?? basename(context.selected.directory)})` : ''}`
    : '';
  const detached = context?.selected.headState === 'detached';
  const currentBranchLabel = detached
    ? t('orca.workerProject.detachedHead', { sha: context.selected.branch?.slice(0, 8) })
    : (context?.selected.branch ?? '—');
  const sourceBranchLabel =
    detached && branch === context?.selected.branch
      ? currentBranchLabel
      : branch.replace(/^refs\/remotes\//, '');
  return (
    <div className="mb-4 space-y-2 text-12 text-[var(--text-secondary)]">
      <div className="font-medium text-[var(--text-tertiary)]">{t('orca.workerProject.label')}</div>
      {!context ? (
        <div role="status">
          {selection.failed ? (
            <>
              {t('orca.workerProject.loadFailed')}{' '}
              <Button size="sm" variant="secondary" tone="quiet" onClick={selection.reload}>
                {t('commonUi.retry')}
              </Button>
            </>
          ) : (
            t('ccAgent.common.loading')
          )}
        </div>
      ) : (
        <>
          <FolderPickerPopover
            open={pickerOpen && !disabled}
            onOpenChange={setPickerOpen}
            allowDialogue={false}
            allowRemove={false}
            projectOptions={context.projects}
            onSelect={selection.select}
            align="start"
          >
            <button
              type="button"
              disabled={disabled}
              className="flex min-h-8 max-w-full items-center gap-2 rounded-full border border-[var(--border-default)] px-3 text-13 text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
            >
              <Folder size={14} className="shrink-0" />
              <span className="truncate">
                {sameProject ? t('orca.workerProject.current') : selectedName}
              </span>
              <ChevronDown size={12} className="shrink-0" />
            </button>
          </FolderPickerPopover>
          {context.selected.exists &&
            context.selected.baseRepo &&
            context.selected.headState !== 'unborn' &&
            !checked && (
              <div className="break-words" title={context.selected.directory}>
                {sameProject
                  ? t('orca.workerProject.shared', {
                      project: sharedName,
                      branch: currentBranchLabel,
                    })
                  : t(
                      detached ? 'orca.workerProject.directDetached' : 'orca.workerProject.direct',
                      {
                        project: selectedName,
                        branch: currentBranchLabel,
                      },
                    )}
              </div>
            )}
          {context.selected.exists &&
            sameProject &&
            context.selected.directory !== context.recordedDirectory && (
              <div>{t('orca.workerProject.inferred')}</div>
            )}
          {context.selected.exists && !sameProject && !checked && context.selected.dirty && (
            <div>{t('orca.workerProject.dirty')}</div>
          )}
          {!context.selected.exists ? (
            <div role="status">{t('orca.workerProject.missingDirectory')}</div>
          ) : canWorktree ? (
            <>
              <label className="flex min-h-8 cursor-pointer items-center gap-2">
                <input
                  className="peer sr-only"
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={(event) => selection.setChecked(event.target.checked)}
                />
                <span
                  aria-hidden
                  className={`inline-flex size-3.5 shrink-0 items-center justify-center rounded border peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--focus-ring)] ${checked ? 'border-[var(--create-agent-send-bg)] bg-[var(--create-agent-send-bg)] text-[var(--create-agent-send-icon)]' : 'border-[var(--text-secondary)]'}`}
                >
                  {checked && <Check size={10} />}
                </span>
                {t('orca.workerProject.newWorktree')}
              </label>
              {checked && (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <span>{t('orca.workerProject.from')}</span>
                    <BranchWorktreeChip
                      branchOnly
                      compact
                      branchLabel={branch}
                      baseRepo={base}
                      remoteDefaultBranch={
                        branchSnapshot?.base === base
                          ? branchSnapshot.remoteDefaultBranch
                          : undefined
                      }
                      branchDisplayLabel={sourceBranchLabel}
                      branches={branchSnapshot?.base === base ? branchSnapshot.values : []}
                      branchesLoading={branchLoading}
                      branchesFailed={
                        branchSnapshot?.base === base && branchSnapshot.failed === true
                      }
                      onRetryBranches={loadBranches}
                      checked={false}
                      branchSourceSelected
                      branchInteractive={!disabled}
                      onPick={selection.setSourceBranch}
                      onOpenRequested={loadBranches}
                      onToggle={() => {}}
                    />
                    <span>{t('orca.workerProject.fromSuffix')}</span>
                  </div>
                  {sameProject && (
                    <div className="leading-relaxed">
                      {t('orca.workerProject.splitWarning', { branch: sourceBranchLabel })}
                    </div>
                  )}
                </>
              )}
            </>
          ) : (
            <div className="break-words">
              {t(
                sameProject && context.dialogue
                  ? 'orca.workerProject.dialogue'
                  : context.selected.headState === 'unborn'
                    ? 'orca.workerProject.emptyRepo'
                    : 'orca.workerProject.notGit',
                { directory: context.selected.directory },
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
