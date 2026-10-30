/**
 * SkillhubDiffPanel — 原作者比较线上具体版本；其他本地修改保留安装快照 diff。
 *
 * 触发：DetailView 里点 mine-dirty banner → setOpen(true)。
 *
 * 复用：
 *   - DiffPanelShell:滑入容器 + 背景 + ESC + 标题栏(跟 SessionDiffPanel 共用)
 *   - DiffView: 单文件红绿行级 diff
 *   - computeDiffStats: 文件 +N/-N 计数
 *
 * 状态机:
 *   loading      → IPC 进行中
 *   no-snapshot  → 本地无快照(历史 publish 或换机器),给提示文案
 *   error        → IPC 失败,展示错误信息
 *   ready        → 渲染 changes;changes.length===0 时给"无差异"提示
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileDiff as FileDiffIcon } from 'lucide-react';

import { DiffPanelShell } from '@/components/diff-panel/DiffPanelShell';
import { FileChangeGroup, type FileChange } from '@/components/diff-panel/FileChangeGroup';
import { computeDiffStats } from '@/lib/agent-actions/diffStats';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';

interface SkillhubDiffPanelProps {
  open: boolean;
  onClose: () => void;
  /** Skill 名(不带 scope 前缀) — IPC 用它定位 snapshot 目录。 */
  skillName: string;
  /** Skill 在本机的绝对路径 — IPC 用它读当前文件。 */
  absolutePath: string;
  skillId?: string;
  published?: boolean;
}

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'no-snapshot' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; changes: FileChange[]; version?: string };

export function SkillhubDiffPanel({ open, onClose, skillName, absolutePath, skillId, published }: SkillhubDiffPanelProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<LoadState>({ kind: 'idle' });

  // 打开时拉 diff;关闭时清掉(下次打开重新拉,保证最新)
  useEffect(() => {
    if (!open) {
      setState({ kind: 'idle' });
      return;
    }
    let cancelled = false;
    const owner = getDataOwnerGeneration();
    setState({ kind: 'loading' });
    if (published) {
      window.electronAPI.skillhub.comparePublished({ absolutePath, skillId, includeDiff: true })
        .then((res) => {
          if (cancelled || !isDataOwnerGenerationCurrent(owner)) return;
          if (res.status !== 'same' && res.status !== 'different') {
            setState({ kind: 'error', message: t('skillhub.publishComparison.unavailable') });
            return;
          }
          setState({ kind: 'ready', version: res.version, changes: res.changes ?? [] });
        })
        .catch(() => {
          if (!cancelled && isDataOwnerGenerationCurrent(owner)) {
            setState({ kind: 'error', message: t('skillhub.publishComparison.unavailable') });
          }
        });
      return () => { cancelled = true; };
    }
    window.electronAPI.skillhub
      .getSnapshotDiff({ absolutePath, name: skillName })
      .then((res) => {
        if (cancelled || !isDataOwnerGenerationCurrent(owner)) return;
        if (!res.success) {
          setState({ kind: 'error', message: res.error ?? 'unknown error' });
          return;
        }
        if (!res.hasSnapshot) {
          setState({ kind: 'no-snapshot' });
          return;
        }
        setState({ kind: 'ready', changes: res.changes ?? [] });
      })
      .catch((err: unknown) => {
        if (cancelled || !isDataOwnerGenerationCurrent(owner)) return;
        setState({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [open, absolutePath, skillName, skillId, published, t]);

  // 汇总 +/- 计数(只对 ready 状态算)
  const totals = useMemo(() => {
    if (state.kind !== 'ready') return null;
    let add = 0;
    let del = 0;
    for (const c of state.changes) {
      if (c.isBinary) continue;
      const s = computeDiffStats(c.oldContent, c.newContent);
      add += s.add;
      del += s.del;
    }
    return { files: state.changes.length, add, del };
  }, [state]);

  return (
    <DiffPanelShell
      open={open}
      onClose={onClose}
      variant="floating"
      ariaLabel={t('skillhub.diffPanel.ariaLabel')}
      title={state.kind === 'ready' && state.version
        ? t('skillhub.publishComparison.diffTitle', { version: state.version })
        : t('skillhub.diffPanel.title')}
      defaultWidth={560}
      storageKey="diff-panel-shell:skillhub-width"
      rightHeader={
        totals && totals.files > 0 ? (
          <span className="text-xs text-muted-foreground tabular-nums">
            {t('skillhub.diffPanel.filesCount', { count: totals.files })}
            <span className="text-[var(--diff-add-fg)]">+{totals.add}</span>{' '}
            <span className="text-[var(--diff-del-fg)]">-{totals.del}</span>
          </span>
        ) : null
      }
    >
      {state.kind === 'loading' && <LoadingState />}
      {state.kind === 'no-snapshot' && <NoSnapshotState />}
      {state.kind === 'error' && <ErrorState message={state.message} />}
      {state.kind === 'ready' &&
        (state.changes.length === 0 ? (
          <CleanState />
        ) : (
          <ul className="flex flex-col gap-2 p-3">
            {state.changes.map((c) => (
              <FileChangeGroup key={c.path} change={c} summaryOnly={published && c.isBinary} />
            ))}
          </ul>
        ))}
    </DiffPanelShell>
  );
}

// ── 各状态空态 ────────────────────────────────────────────────────────────

function LoadingState() {
  const { t } = useTranslation();
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-sm text-muted-foreground">{t('skillhub.diffPanel.loading')}</p>
    </div>
  );
}

function NoSnapshotState() {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <FileDiffIcon size={28} className="text-muted-foreground" />
      <p className="text-sm text-muted-foreground">{t('skillhub.diffPanel.noSnapshotTitle')}</p>
      <p className="max-w-xs text-xs text-muted-foreground">
        {t('skillhub.diffPanel.noSnapshotHint')}
      </p>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <FileDiffIcon size={28} className="text-muted-foreground" />
      <p className="text-sm text-muted-foreground">{t('skillhub.diffPanel.errorTitle')}</p>
      <p className="max-w-xs break-all text-xs text-muted-foreground">{message}</p>
    </div>
  );
}

function CleanState() {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <FileDiffIcon size={28} className="text-muted-foreground" />
      <p className="text-sm text-muted-foreground">{t('skillhub.diffPanel.cleanTitle')}</p>
      <p className="text-xs text-muted-foreground">
        {t('skillhub.diffPanel.cleanHint')}
      </p>
    </div>
  );
}
