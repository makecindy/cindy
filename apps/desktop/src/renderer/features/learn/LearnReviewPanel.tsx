import { Button } from '@/components/ui/button';
/**
 * LearnReviewPanel —— /learn 蒸馏提案的 diff 审查面板。
 *
 * 数据流:open 时 learn:get-proposal-diff 拉 FileChange[](全新 skill = 全 added;
 * 覆盖已装 skill = 与现有版本的差异)。底部动作:「应用到本地技能」(learn:apply,
 * 用户确认后才落盘 —— 提案永远不自动写)、「放弃」(learn:discard,丢弃 staging)。
 *
 * 复用:DiffPanelShell(滑入容器)+ FileChangeGroup(单文件折叠 diff,与
 * SkillhubDiffPanel 共用)。
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileDiff as FileDiffIcon, ShieldAlert, Replace } from 'lucide-react';
import { toast } from '@/lib/toast';

import { DiffPanelShell } from '@/components/diff-panel/DiffPanelShell';
import { FileChangeGroup, type FileChange } from '@/components/diff-panel/FileChangeGroup';
import { computeDiffStats } from '@/lib/agent-actions/diffStats';
import { mapIpcErrorToI18nKey } from '@/utils/ipcError';
import type { LearnRunPublic } from '../../../shared/learnTypes';
import { learnApiFor } from './learnTransport';

interface LearnReviewPanelProps {
  open: boolean;
  onClose: () => void;
  run: LearnRunPublic;
  /** 所在会话视图的 sessionId —— 决定 diff/apply/discard 路由到哪台设备的 learn-host
   *  (device-link 远程会话经隧道到被控端);本机会话可缺省。 */
  contextSessionId?: string | null;
}

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; targetExists: boolean; changes: FileChange[] };

export function LearnReviewPanel({ open, onClose, run, contextSessionId }: LearnReviewPanelProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<LoadState>({ kind: 'idle' });
  const [acting, setActing] = useState<'apply' | 'discard' | null>(null);

  // 打开时拉 diff;关闭清空(重开重新拉,保证最新)
  useEffect(() => {
    if (!open) {
      setState({ kind: 'idle' });
      return;
    }
    let cancelled = false;
    setState({ kind: 'loading' });
    learnApiFor(contextSessionId)
      .getProposalDiff({ runId: run.runId })
      .then((res) => {
        if (cancelled) return;
        setState({ kind: 'ready', targetExists: res.targetExists, changes: res.changes });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
    // run.proposalFingerprint:面板开着时用户在蒸馏会话继续对话、提案被 watcher
    // 刷新(learn:event 推动 run 更新)→ 重新拉 diff,不展示过期提案(Codex review)。
    // 不能依赖 run.updatedAt:getProposalDiff 本身会登记 reviewed 指纹并 bump
    // updatedAt + 广播,依赖它会"读→更新→再读"无限循环(Codex review #548 P1);
    // 指纹只在提案内容真变时才变。contextSessionId:device-link 路由上下文变化时重拉。
  }, [open, run.runId, run.proposalFingerprint, contextSessionId]);

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

  const handleApply = async (): Promise<void> => {
    setActing('apply');
    try {
      const result = await learnApiFor(contextSessionId).apply({ runId: run.runId });
      toast.success(t('learn.review.appliedToast', { name: result.name }));
      onClose();
    } catch (err) {
      toast.error(t(mapIpcErrorToI18nKey(err, { namespace: 'learn.ipcError', fallback: 'learn.review.applyFailed' })));
    } finally {
      setActing(null);
    }
  };

  const handleDiscard = async (): Promise<void> => {
    setActing('discard');
    try {
      await learnApiFor(contextSessionId).discard({ runId: run.runId });
      toast.success(t('learn.review.discardedToast'));
      onClose();
    } catch (err) {
      toast.error(t(mapIpcErrorToI18nKey(err, { namespace: 'learn.ipcError', fallback: 'learn.review.discardFailed' })));
    } finally {
      setActing(null);
    }
  };

  return (
    <DiffPanelShell
      open={open}
      onClose={onClose}
      variant="floating"
      ariaLabel={t('learn.review.ariaLabel')}
      title={t('learn.review.title', { name: run.skillName ?? '' })}
      defaultWidth={560}
      storageKey="diff-panel-shell:learn-width"
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
      <div className="flex h-full flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* 提示条:敏感内容 warning(redaction 第二层防线)+ 覆盖已装版本提示。
              蒸馏说明与迭代都在会话本身 —— 面板只做 diff 核对 + 落盘闸门。 */}
          {run.redactionWarnings && run.redactionWarnings.length > 0 && (
            <div className="mx-3 mt-3 flex items-start gap-2 rounded-md bg-[var(--warning-bg-soft)] px-3 py-2">
              <ShieldAlert size={14} className="mt-0.5 shrink-0 text-muted-foreground" />
              <p className="text-xs text-muted-foreground">
                {t('learn.review.redactionWarning', {
                  categories: run.redactionWarnings.join(', '),
                })}
              </p>
            </div>
          )}
          {state.kind === 'ready' && state.targetExists && (
            <div className="mx-3 mt-3 flex items-start gap-2 rounded-md bg-[var(--warning-bg-soft)] px-3 py-2">
              <Replace size={14} className="mt-0.5 shrink-0 text-muted-foreground" />
              <p className="text-xs text-muted-foreground">{t('learn.review.overwriteWarning')}</p>
            </div>
          )}

          {state.kind === 'loading' && (
            <div className="flex h-full items-center justify-center">
              <p className="text-sm text-muted-foreground">{t('skillhub.diffPanel.loading')}</p>
            </div>
          )}
          {state.kind === 'error' && (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <FileDiffIcon size={28} className="text-muted-foreground" />
              <p className="text-sm text-muted-foreground">{t('learn.review.errorTitle')}</p>
              <p className="max-w-xs break-all text-xs text-muted-foreground">{state.message}</p>
            </div>
          )}
          {state.kind === 'ready' && (
            <ul className="flex flex-col gap-2 p-3">
              {state.changes.map((c) => (
                // 审查场景内容即主体:SKILL.md 一律展开;文件少(≤3)时全展开,
                // 避免"全新 skill 单文件折叠 = 打开一片空白"的反体验。
                <FileChangeGroup
                  key={c.path}
                  change={c}
                  defaultExpanded={c.path === 'SKILL.md' || state.changes.length <= 3}
                />
              ))}
            </ul>
          )}
        </div>

        {/* 底部动作条:apply 是唯一落盘入口(提案永不自动写)。想改?直接在
            蒸馏会话里说 —— 对话即迭代,面板不承载对话。 */}
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-3 py-2.5">
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {t('learn.review.reviseHint')}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="secondary"
              size="md"
              compact
              tone="quiet"
              loading={acting === 'discard'}
              type="button"
              disabled={acting !== null}
              onClick={() => void handleDiscard()}
            >
              {acting === 'discard' ? t('learn.review.discarding') : t('learn.review.discard')}
            </Button>
            <Button
              variant="cta"
              size="md"
              compact
              loading={acting === 'apply'}
              type="button"
              disabled={acting !== null || state.kind !== 'ready'}
              onClick={() => void handleApply()}
            >
              {acting === 'apply' ? t('learn.review.applying') : t('learn.review.apply')}
            </Button>
          </div>
        </div>
      </div>
    </DiffPanelShell>
  );
}
