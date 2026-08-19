import { useCallback, useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import type { MemoryRecord } from '@cindy/maker-core';

import { artifactTimeLabel } from './botArtifactPresentation';
import { partitionBotMemoryRecords } from './botGrowth';
import { isBotSeedMemorySlug } from './botTemplates';
import type { BotMemorySeedEntry } from '../../../shared/botMemorySeed';
import type { BotSettingsHighlightId } from './botSettingsNav';

function readError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** frontmatter.updatedAt 是 ISO 串;解析不出来就不显示时间,不编造。 */
function parseUpdatedAt(value: string): number | null {
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

/**
 * 设置页「TA 是谁」里并排的两个成长列表:「TA 记得的」与「TA 学会的」。
 *
 * 两个列表是**同一份**伙伴记忆分域的两个切片(见 botGrowth.partitionBotMemoryRecords):
 * `learned-` 前缀的分片是本事,其余是记忆。所以这里只拉一次
 * `window.electronAPI.maker.botMemory.list`,删除后两边同步刷新 —— 分两个组件各拉
 * 一次会出现"删了一条,另一个列表还是旧的"。
 *
 * 批次 β 已经把 list / delete / clear 三个 IPC 打通;本批只多用了一个幂等的 seed
 * 写入(见 shared/botMemorySeed.ts),没有新增存储与 schema。
 * scope key 与 workdir 记忆完全独立。`digest` 分片(Pi 压缩产生的系统内部摘要)两边
 * 都不展示,但不影响它继续被检索使用。
 */
export function BotGrowthLists({
  botId,
  highlight,
  seedEntries,
}: {
  botId: string;
  /** 从消息气泡的成长尾注跳进来时,短暂高亮对应的那个列表。 */
  highlight?: BotSettingsHighlightId | null;
  /**
   * 这个伙伴**本该**自带的开场笔记(按名字反查到的模板;查不到就是空)。
   *
   * 它只有一个用途:加入时那次写入没成功(记忆引擎当时没起来 / IPC 失败)时,给
   * 一条自己补回来的路。seed IPC 按 slug 幂等,所以重复点是安全的。
   */
  seedEntries?: readonly BotMemorySeedEntry[];
}) {
  const { t, i18n } = useTranslation();
  const { confirm } = useConfirmDialog();
  // 「本事」行要带来源时间。判定复用 botArtifactPresentation 的纯函数,文案复用
  // 已有的 bots.artifacts.time.* —— 同一套相对时间口径,不另造一份。
  const timeText = (at: number): string => {
    const label = artifactTimeLabel(at, Date.now());
    if (label.kind === 'justNow') return t('bots.artifacts.time.justNow');
    if (label.kind !== 'date') return t(`bots.artifacts.time.${label.kind}`, { n: label.n });
    try {
      return new Date(label.at).toLocaleDateString(i18n?.language, {
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return new Date(label.at).toLocaleDateString();
    }
  };
  const [records, setRecords] = useState<MemoryRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyFilename, setBusyFilename] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [seeding, setSeeding] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRecords(await window.electronAPI.maker.botMemory.list(botId));
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

  const seedBack = async () => {
    const seed = window.electronAPI?.maker?.botMemory?.seed;
    if (!seed || !seedEntries || seedEntries.length === 0) return;
    setSeeding(true);
    setError(null);
    try {
      await seed(botId, seedEntries);
      await load();
    } catch (cause) {
      setError(readError(cause));
    } finally {
      setSeeding(false);
    }
  };

  const { memories, learned } = partitionBotMemoryRecords(records ?? []);
  /*
    「列表里真的有加入时自带的那几条吗」——脚注和补写入口都挂在这一个判据上。

    之前脚注写死成「有几条是 TA 加入时自带的」,可写入失败、或用户把那几条删光之后
    它就成了对着一个空列表说的假话。现在没有自带条目就退回中性那句。
  */
  const hasSeedMemory = (records ?? []).some((record) => isBotSeedMemorySlug(record.slug));
  // 已经加载完、模板确实定义了开场笔记、但一条都没落地 —— 只有这三条同时成立才
  // 提供补写入口。records 还没回来时不显示:那会在每次进设置页时闪一下。
  const canSeedBack =
    records !== null && !hasSeedMemory && (seedEntries?.length ?? 0) > 0;

  const renderRow = (record: MemoryRecord, withTime: boolean) => {
    const at = withTime ? parseUpdatedAt(record.frontmatter.updatedAt) : null;
    /*
      描述是可空的（老分片、手写分片都可能没有 hook 那一行）。之前是
      `{description}{' · ' + time}` 直接拼，描述为空时副行就成了「· 2 天前」——
      一个没有左操作数的分隔点。这里改成只把**非空**的片段用 · 连起来。
    */
    const metaLine = [record.frontmatter.description.trim(), at !== null ? timeText(at) : '']
      .filter((part) => part.length > 0)
      .join(' · ');
    return (
      <li
        key={record.filename}
        className="flex items-start justify-between gap-3 rounded-lg bg-[var(--surface-chip)] px-3 py-2"
      >
        <span className="min-w-0">
          <span className="block truncate text-12 text-[var(--text-primary)]">
            {record.frontmatter.title}
          </span>
          {metaLine ? (
            <span className="mt-0.5 block truncate text-11 text-[var(--text-tertiary)]">
              {metaLine}
            </span>
          ) : null}
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
    );
  };

  // 高亮是"从尾注跳进来"的落点提示:加一圈焦点色描边,不改配色也不加阴影。
  const highlightRing = (id: BotSettingsHighlightId): string =>
    highlight === id ? ' rounded-xl ring-2 ring-[var(--focus-ring-soft)]' : '';

  return (
    <>
      <div data-testid="bot-memory-list" className={`-m-1 p-1${highlightRing('memory')}`}>
        <div className="flex items-center justify-between gap-3">
          <p className="text-12 font-medium text-[var(--text-primary)]">
            {t('bots.memoryList.title')}
          </p>
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
        {records === null ? null : memories.length === 0 ? (
          <p className="mt-2 text-11 leading-4 text-[var(--text-tertiary)]">
            {t('bots.memoryList.empty')}
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1.5">
            {memories.map((record) => renderRow(record, false))}
          </ul>
        )}
        {/* 脚注回答的是「这些东西是谁放进来的、我能不能动」——列表本身答不了。 */}
        <p className="mt-2 text-11 leading-4 text-[var(--text-tertiary)]">
          {hasSeedMemory ? t('bots.memoryList.footnoteWithSeed') : t('bots.memoryList.footnote')}
        </p>
        {canSeedBack ? (
          <button
            type="button"
            disabled={seeding}
            onClick={() => void seedBack()}
            className="mt-1.5 rounded-lg text-11 text-[var(--text-secondary)] underline underline-offset-2 hover:text-[var(--text-primary)] disabled:opacity-50"
          >
            {seeding ? t('bots.memoryList.seedingBack') : t('bots.memoryList.seedBack')}
          </button>
        ) : null}
      </div>

      {/* 「TA 学会的」与「TA 记得的」并列:记忆是你说过的,本事是 TA 做出来的。 */}
      <div
        data-testid="bot-learned-list"
        className={`-m-1 mt-5 border-t border-[var(--border-default)] p-1 pt-4${highlightRing('learned')}`}
      >
        <p className="text-12 font-medium text-[var(--text-primary)]">{t('bots.learned.title')}</p>
        {records === null ? null : learned.length === 0 ? (
          <p className="mt-1.5 text-11 leading-4 text-[var(--text-tertiary)]">
            {t('bots.learned.empty')}
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1.5">
            {learned.map((record) => renderRow(record, true))}
          </ul>
        )}
        <p className="mt-2 text-11 leading-4 text-[var(--text-tertiary)]">
          {t('bots.learned.footnote')}
        </p>
      </div>
    </>
  );
}
