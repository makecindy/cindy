/**
 * FileChangeGroup —— 文件级 diff 列表的单文件折叠块(点击展开行级红绿 diff)。
 *
 * 从 SkillhubDiffPanel 抽出的共享组件,SkillhubDiffPanel(发布快照 diff)与
 * LearnReviewPanel(/learn 提案 diff)共用。i18n 沿用 skillhub.diffPanel.* 的
 * 通用标签(added/removed/modified/binary),两处消费语义一致。
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Plus, Minus, Pencil } from 'lucide-react';

import { cn, basename } from '@/lib/utils';
import { DiffView } from '@/components/chat/DiffView';
import { Tip } from '@/components/ui/tooltip';
import { computeDiffStats } from '@/lib/agent-actions/diffStats';

/** 与 main 侧 skillhub/snapshot.ts 的 FileChange / shared learnTypes 的
 *  LearnFileChange 逐字段对齐(IPC 契约形状)。 */
export interface FileChange {
  path: string;
  kind: 'added' | 'removed' | 'modified';
  isBinary: boolean;
  oldContent: string;
  newContent: string;
  oldSize: number;
  newSize: number;
}

export function FileChangeGroup({
  change,
  defaultExpanded = false,
}: {
  change: FileChange;
  /** 默认展开(learn 提案审查这类"内容即主体"的场景传 true;快照 diff 保持折叠)。 */
  defaultExpanded?: boolean;
}) {
  const { t } = useTranslation();
  // 默认折叠 — 用户先扫一眼哪些文件变了,再展开关心的那个
  const [expanded, setExpanded] = useState(defaultExpanded);
  const fileName = useMemo(() => basename(change.path), [change.path]);
  const stats = useMemo(() => {
    if (change.isBinary) return null;
    return computeDiffStats(change.oldContent, change.newContent);
  }, [change.isBinary, change.oldContent, change.newContent]);

  const KindBadge = () => {
    if (change.kind === 'added') {
      return (
        <Tip text={t('skillhub.diffPanel.addedAria')}>
          <Plus size={12} className="text-[var(--diff-add-fg)]" />
        </Tip>
      );
    }
    if (change.kind === 'removed') {
      return (
        <Tip text={t('skillhub.diffPanel.removedAria')}>
          <Minus size={12} className="text-[var(--diff-del-fg)]" />
        </Tip>
      );
    }
    return (
      <Tip text={t('skillhub.diffPanel.modifiedAria')}>
        <Pencil size={12} className="text-muted-foreground" />
      </Tip>
    );
  };

  return (
    <li className="rounded-md border border-border bg-background/50">
      <button
        type="button"
        onClick={() => setExpanded((p) => !p)}
        className={cn(
          'flex w-full items-center gap-2 px-3 py-2 text-left',
          'hover:bg-muted/50 focus-visible:outline-none',
        )}
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown size={14} className="shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight size={14} className="shrink-0 text-muted-foreground" />
        )}
        <KindBadge />
        <span className="flex-1 min-w-0">
          <Tip text={change.path} mono>
            <span className="block truncate text-sm font-medium">{fileName}</span>
          </Tip>
          <Tip text={change.path} mono>
            <span className="block truncate text-xs text-muted-foreground">{change.path}</span>
          </Tip>
        </span>
        <span className="flex shrink-0 items-center gap-2 text-xs tabular-nums">
          {change.isBinary ? (
            <span className="rounded bg-muted px-1.5 py-0.5 text-10 text-muted-foreground">
              {t('skillhub.diffPanel.binaryBadge')}
            </span>
          ) : stats ? (
            <>
              <span className="text-[var(--diff-add-fg)]">+{stats.add}</span>
              <span className="text-[var(--diff-del-fg)]">-{stats.del}</span>
            </>
          ) : null}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border p-2">
          {change.isBinary ? (
            <BinaryChangedView change={change} />
          ) : (
            // contextLines=3:整文件对比时只显示变化前后 3 行,中间折叠,
            // 避免一改一行铺出整屏。
            <DiffView
              oldString={change.oldContent}
              newString={change.newContent}
              contextLines={3}
            />
          )}
        </div>
      )}
    </li>
  );
}

function BinaryChangedView({ change }: { change: FileChange }) {
  const { t } = useTranslation();
  const fmtSize = (n: number) => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  };
  return (
    <div className="flex flex-col gap-1 px-2 py-3 text-xs text-muted-foreground">
      <span>{t('skillhub.diffPanel.binaryNote')}</span>
      <span className="tabular-nums">
        {change.kind === 'added'
          ? t('skillhub.diffPanel.binarySizeNew', { size: fmtSize(change.newSize) })
          : change.kind === 'removed'
            ? t('skillhub.diffPanel.binarySizeRemoved', { size: fmtSize(change.oldSize) })
            : t('skillhub.diffPanel.binarySizeChanged', { oldSize: fmtSize(change.oldSize), newSize: fmtSize(change.newSize) })}
      </span>
    </div>
  );
}
