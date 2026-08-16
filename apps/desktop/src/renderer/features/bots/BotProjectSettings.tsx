import { useEffect, useMemo, useState } from 'react';
import { Archive, FolderGit2, FolderOpen, Save } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { extractIpcError } from '@/utils/ipcError';

import {
  archiveBotProjectBinding,
  releaseBotWorkspaceLease,
  upsertBotProjectBinding,
  type BotProfile,
  type BotProjectBinding,
  type BotWorkspaceLease,
} from './botStore';
import {
  BOT_WORKSPACE_POLICIES,
  type BotWorkspacePolicy,
} from '../../../shared/botWorkspace';

function splitAllowedPaths(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))];
}

function bindingErrorKey(error: unknown): string {
  const code = extractIpcError(error)?.code;
  if (code === 'PRECONDITION_FAILED') return 'bots.projects.errors.activeLease';
  if (code === 'INVALID_PARAMS') return 'bots.projects.errors.invalid';
  return 'bots.projects.errors.generic';
}

function latestLeaseForBinding(
  leases: BotWorkspaceLease[],
  bindingId: string,
): BotWorkspaceLease | undefined {
  return leases
    .filter((lease) => lease.projectBindingId === bindingId)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

function ProjectBindingEditor({
  botId,
  binding,
  lease,
}: {
  botId: string;
  binding: BotProjectBinding;
  lease?: BotWorkspaceLease;
}) {
  const { t } = useTranslation();
  const [policy, setPolicy] = useState<BotWorkspacePolicy>(binding.workspacePolicy);
  const [defaultBranch, setDefaultBranch] = useState(binding.defaultBranch ?? '');
  const [isDefault, setIsDefault] = useState(binding.isDefault);
  const [allowedPaths, setAllowedPaths] = useState(binding.allowedPaths.join('\n'));
  const [busy, setBusy] = useState<'save' | 'archive' | 'release' | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  useEffect(() => {
    setPolicy(binding.workspacePolicy);
    setDefaultBranch(binding.defaultBranch ?? '');
    setIsDefault(binding.isDefault);
    setAllowedPaths(binding.allowedPaths.join('\n'));
  }, [binding]);

  const save = async () => {
    setBusy('save');
    setErrorKey(null);
    try {
      await upsertBotProjectBinding(botId, {
        id: binding.id,
        workingDir: binding.workingDir,
        remoteHostId: binding.remoteHostId ?? null,
        defaultBranch: defaultBranch.trim() || null,
        workspacePolicy: policy,
        isDefault,
        allowedPaths: splitAllowedPaths(allowedPaths),
      });
    } catch (error) {
      setErrorKey(bindingErrorKey(error));
    } finally {
      setBusy(null);
    }
  };

  const archive = async () => {
    setBusy('archive');
    setErrorKey(null);
    try {
      await archiveBotProjectBinding(botId, binding.id);
    } catch (error) {
      setErrorKey(bindingErrorKey(error));
    } finally {
      setBusy(null);
    }
  };

  const releaseLease = async () => {
    if (!lease) return;
    setBusy('release');
    setErrorKey(null);
    try {
      await releaseBotWorkspaceLease(botId, lease.id, lease.generation);
    } catch (error) {
      setErrorKey(bindingErrorKey(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-xl border border-[var(--border-default)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-13 font-medium text-[var(--text-primary)]">
            {binding.workingDir}
          </p>
          <p className="mt-1 text-11 text-[var(--text-tertiary)]">
            {binding.remoteHostId
              ? t('bots.projects.remoteProject')
              : t('bots.projects.localProject')}
          </p>
        </div>
        {binding.isDefault ? (
          <span className="shrink-0 rounded-full bg-[var(--surface-chip)] px-2 py-1 text-10 text-[var(--text-secondary)]">
            {t('bots.projects.defaultBadge')}
          </span>
        ) : null}
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-11 text-[var(--text-secondary)]">
          {t('bots.projects.policyLabel')}
          <select
            value={policy}
            onChange={(event) => setPolicy(event.target.value as BotWorkspacePolicy)}
            className="h-9 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-12 text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]"
          >
            {BOT_WORKSPACE_POLICIES.map((item) => (
              <option key={item} value={item}>
                {t(`bots.projects.policies.${item}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-11 text-[var(--text-secondary)]">
          {t('bots.projects.defaultBranchLabel')}
          <input
            value={defaultBranch}
            onChange={(event) => setDefaultBranch(event.target.value)}
            placeholder={t('bots.projects.defaultBranchPlaceholder')}
            className="h-9 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-12 text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]"
          />
        </label>
      </div>

      <label className="mt-3 flex flex-col gap-1.5 text-11 text-[var(--text-secondary)]">
        {t('bots.projects.allowedPathsLabel')}
        <textarea
          value={allowedPaths}
          onChange={(event) => setAllowedPaths(event.target.value)}
          placeholder={t('bots.projects.allowedPathsPlaceholder')}
          rows={2}
          className="resize-y rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-2 text-12 text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]"
        />
      </label>

      <label className="mt-3 flex items-center gap-2 text-11 text-[var(--text-secondary)]">
        <input
          type="checkbox"
          checked={isDefault}
          onChange={(event) => setIsDefault(event.target.checked)}
        />
        {t('bots.projects.makeDefault')}
      </label>

      {lease ? (
        <div className="mt-4 rounded-lg bg-[var(--surface-chip)] px-3 py-2 text-11 leading-5 text-[var(--text-secondary)]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>{t('bots.projects.leaseTitle')}</span>
            <span>{t(`bots.projects.leaseStatus.${lease.status}`)}</span>
          </div>
          <p className="mt-1 break-all text-[var(--text-tertiary)]">
            {lease.worktreePath ?? lease.baseRepo}
          </p>
          <p className="text-[var(--text-tertiary)]">
            {t('bots.projects.leaseGeneration', { generation: lease.generation })}
          </p>
        </div>
      ) : null}

      {errorKey ? (
        <p className="mt-3 rounded-lg bg-[var(--error-bg)] px-3 py-2 text-11 text-[var(--error-fg)]">
          {t(errorKey)}
        </p>
      ) : null}

      <div className="mt-4 flex justify-end gap-2">
        {lease && lease.status !== 'released' ? (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void releaseLease()}
            className="inline-flex h-8 items-center gap-2 rounded-lg px-3 text-11 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
          >
            <Archive size={13} />
            {busy === 'release'
              ? t('bots.projects.releasingLease')
              : t('bots.projects.releaseLease')}
          </button>
        ) : null}
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void archive()}
          className="inline-flex h-8 items-center gap-2 rounded-lg px-3 text-11 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
        >
          <Archive size={13} />
          {busy === 'archive' ? t('bots.projects.archiving') : t('bots.projects.archive')}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void save()}
          className="inline-flex h-8 items-center gap-2 rounded-lg border border-[var(--border-default)] px-3 text-11 font-medium text-[var(--text-primary)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
        >
          <Save size={13} />
          {busy === 'save' ? t('bots.projects.saving') : t('bots.projects.saveBinding')}
        </button>
      </div>
    </div>
  );
}

export function BotProjectSettings({ bot }: { bot: BotProfile }) {
  const { t } = useTranslation();
  const activeBindings = useMemo(
    () => (bot.projectBindings ?? []).filter((binding) => binding.status !== 'archived'),
    [bot.projectBindings],
  );
  const leases = bot.workspaceLeases ?? [];
  const [workingDir, setWorkingDir] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('');
  const [policy, setPolicy] = useState<BotWorkspacePolicy>('none');
  const [isDefault, setIsDefault] = useState(activeBindings.length === 0);
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  useEffect(() => {
    if (activeBindings.length === 0) setIsDefault(true);
  }, [activeBindings.length]);

  const chooseDirectory = async () => {
    setErrorKey(null);
    try {
      const result = await window.electronAPI.showOpenDirectoryDialog();
      if (!result.canceled && result.path) setWorkingDir(result.path);
    } catch (error) {
      setErrorKey(bindingErrorKey(error));
    }
  };

  const addBinding = async () => {
    if (!workingDir.trim()) {
      setErrorKey('bots.projects.errors.chooseDirectory');
      return;
    }
    setBusy(true);
    setErrorKey(null);
    try {
      await upsertBotProjectBinding(bot.id, {
        workingDir: workingDir.trim(),
        defaultBranch: defaultBranch.trim() || null,
        workspacePolicy: policy,
        isDefault,
        allowedPaths: [],
      });
      setWorkingDir('');
      setDefaultBranch('');
      setPolicy('none');
      setIsDefault(false);
    } catch (error) {
      setErrorKey(bindingErrorKey(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5">
      <div className="flex items-center gap-2 text-14 font-medium text-[var(--text-primary)]">
        <FolderGit2 size={16} />
        {t('bots.projects.title')}
      </div>
      <p className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">
        {t('bots.projects.description')}
      </p>

      {activeBindings.length > 0 ? (
        <div className="mt-4 flex flex-col gap-3">
          {activeBindings.map((binding) => (
            <ProjectBindingEditor
              key={binding.id}
              botId={bot.id}
              binding={binding}
              lease={latestLeaseForBinding(leases, binding.id)}
            />
          ))}
        </div>
      ) : (
        <p className="mt-4 rounded-xl border border-dashed border-[var(--border-default)] px-3 py-3 text-12 text-[var(--text-tertiary)]">
          {t('bots.projects.empty')}
        </p>
      )}

      <div className="mt-4 rounded-xl border border-[var(--border-default)] p-4">
        <p className="text-12 font-medium text-[var(--text-primary)]">
          {t('bots.projects.addTitle')}
        </p>
        <div className="mt-3 flex gap-2">
          <input
            readOnly
            value={workingDir}
            placeholder={t('bots.projects.directoryPlaceholder')}
            className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-12 text-[var(--text-primary)] outline-none"
          />
          <button
            type="button"
            onClick={() => void chooseDirectory()}
            className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border border-[var(--border-default)] px-3 text-11 text-[var(--text-primary)] hover:bg-[var(--surface-hover)]"
          >
            <FolderOpen size={14} />
            {t('bots.projects.chooseDirectory')}
          </button>
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-11 text-[var(--text-secondary)]">
            {t('bots.projects.policyLabel')}
            <select
              value={policy}
              onChange={(event) => setPolicy(event.target.value as BotWorkspacePolicy)}
              className="h-9 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-12 text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]"
            >
              {BOT_WORKSPACE_POLICIES.map((item) => (
                <option key={item} value={item}>
                  {t(`bots.projects.policies.${item}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5 text-11 text-[var(--text-secondary)]">
            {t('bots.projects.defaultBranchLabel')}
            <input
              value={defaultBranch}
              onChange={(event) => setDefaultBranch(event.target.value)}
              placeholder={t('bots.projects.defaultBranchPlaceholder')}
              className="h-9 rounded-lg border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 text-12 text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]"
            />
          </label>
        </div>
        <label className="mt-3 flex items-center gap-2 text-11 text-[var(--text-secondary)]">
          <input
            type="checkbox"
            checked={isDefault}
            onChange={(event) => setIsDefault(event.target.checked)}
          />
          {t('bots.projects.makeDefault')}
        </label>
        {errorKey ? (
          <p className="mt-3 rounded-lg bg-[var(--error-bg)] px-3 py-2 text-11 text-[var(--error-fg)]">
            {t(errorKey)}
          </p>
        ) : null}
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            disabled={busy}
            onClick={() => void addBinding()}
            className="h-8 rounded-lg bg-[var(--accent-cta-bg)] px-3 text-11 font-medium text-[var(--accent-pure-cta-fg)] hover:opacity-90 disabled:opacity-50"
          >
            {busy ? t('bots.projects.adding') : t('bots.projects.add')}
          </button>
        </div>
      </div>
    </section>
  );
}
