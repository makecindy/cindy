import { useCallback, useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import type { MemoryRecord } from '@cindy/maker-core';

function readError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * "TA 记得的" —— 真实数据,走批次 β 新增的 bot-memory 只读枚举 + 单删 + 清空 IPC
 * (window.electronAPI.maker.botMemory.*),scope key 与 workdir 记忆完全独立,不
 * 改任何 schema。`digest` 分片是系统内部压缩摘要(不进 MEMORY.md 索引),对用户
 * 而言不是"TA 记得的事",过滤掉不展示,但不影响它继续被检索使用。
 */
export function BotMemoryList({ botId }: { botId: string }) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [records, setRecords] = useState<MemoryRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyFilename, setBusyFilename] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const rows = await window.electronAPI.maker.botMemory.list(botId);
      setRecords(rows.filter((row) => row.frontmatter.type !== 'digest'));
    } catch (cause) {
      setError(readError(cause));
    }
  }, [botId]);

  useEffect(() => {
    void load();
  }, [load]);

  const deleteOne = async (record: MemoryRecord) => {
    const confirmed = await confirm({
      title: t('bots.memoryList.deleteTitle'),
      description: t('bots.memoryList.deleteDescription', { title: record.frontmatter.title }),
      confirmText: t('bots.memoryList.deleteConfirm'),
      cancelText: t('commonUi.confirmDialog.cancel'),
      confirmVariant: 'destructive',
    });
    if (!confirmed) return;
    setBusyFilename(record.filename);
    setError(null);
    try {
      await window.electronAPI.maker.botMemory.delete(botId, record.filename);
      await load();
    } catch (cause) {
      setError(readError(cause));
    } finally {
      setBusyFilename(null);
    }
  };

  const clearAll = async () => {
    const confirmed = await confirm({
      title: t('bots.memoryList.clearTitle'),
      description: t('bots.memoryList.clearDescription'),
      confirmText: t('bots.memoryList.clearConfirm'),
      cancelText: t('commonUi.confirmDialog.cancel'),
      confirmVariant: 'destructive',
    });
    if (!confirmed) return;
    setClearing(true);
    setError(null);
    try {
      await window.electronAPI.maker.botMemory.clear(botId);
      await load();
    } catch (cause) {
      setError(readError(cause));
    } finally {
      setClearing(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-12 font-medium text-[var(--text-primary)]">{t('bots.memoryList.title')}</p>
        {records && records.length > 0 ? (
          <button
            type="button"
            disabled={clearing}
            onClick={() => void clearAll()}
            className="text-11 text-[var(--text-tertiary)] hover:text-[var(--text-danger)] disabled:opacity-50"
          >
            {clearing ? t('bots.memoryList.clearing') : t('bots.memoryList.clearAll')}
          </button>
        ) : null}
      </div>
      {error ? <p className="mt-2 text-11 text-[var(--text-danger)]">{error}</p> : null}
      {records === null ? null : records.length === 0 ? (
        <p className="mt-2 text-11 leading-4 text-[var(--text-tertiary)]">{t('bots.memoryList.empty')}</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1.5">
          {records.map((record) => (
            <li
              key={record.filename}
              className="flex items-start justify-between gap-3 rounded-lg bg-[var(--surface-chip)] px-3 py-2"
            >
              <span className="min-w-0">
                <span className="block truncate text-12 text-[var(--text-primary)]">
                  {record.frontmatter.title}
                </span>
                <span className="mt-0.5 block truncate text-11 text-[var(--text-tertiary)]">
                  {record.frontmatter.description}
                </span>
              </span>
              <button
                type="button"
                disabled={busyFilename !== null}
                aria-label={t('bots.memoryList.deleteAria', { title: record.frontmatter.title })}
                onClick={() => void deleteOne(record)}
                className="shrink-0 rounded-lg p-1.5 text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-danger)] disabled:opacity-50"
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
