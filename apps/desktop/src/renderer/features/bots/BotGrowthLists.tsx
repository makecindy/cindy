import { useCallback, useEffect, useState } from 'react';
import { BookMarked, ChevronDown, ChevronRight, GraduationCap, Trash2 } from 'lucide-react';
import { useBotTranslation } from './botPronounContext';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { cn } from '@/lib/utils';
import type { MemoryRecord } from '@cindy/maker-core';

import { BotSettingsBlock } from './BotSettingsBlock';

import { isBotSeedMemorySlug } from './botCapabilityDefaults';
import { partitionBotMemoryRecords } from './botGrowth';
import type { BotMemorySeedEntry } from '../../../shared/botMemorySeed';
import type { BotSkillDetail, BotSkillSummary } from '../../../shared/botSkill';
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
 * 相对时间的**判定**部分(纯函数,不碰 i18n)。渲染方拿到 kind + n 后自己去
 * 查文案,这样判定逻辑可以脱离 i18n 直接单测。
 */
type ArtifactTimeLabel =
  | { kind: 'justNow' }
  | { kind: 'minutes' | 'hours' | 'days'; n: number }
  | { kind: 'date'; at: number };

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function artifactTimeLabel(createdAt: number, now: number): ArtifactTimeLabel {
  const delta = now - createdAt;
  // 时钟回拨 / 未来时间戳:当「刚刚」处理,不显示负数。
  if (delta < MINUTE_MS) return { kind: 'justNow' };
  if (delta < HOUR_MS) return { kind: 'minutes', n: Math.floor(delta / MINUTE_MS) };
  if (delta < DAY_MS) return { kind: 'hours', n: Math.floor(delta / HOUR_MS) };
  if (delta < 7 * DAY_MS) return { kind: 'days', n: Math.floor(delta / DAY_MS) };
  return { kind: 'date', at: createdAt };
}

/**
 * “记得的”展示普通记忆分片；“学会的”展示可挂载 Skill 和兼容旧数据的
 * `learned-` 笔记。两份数据共用刷新周期，`digest` 系统摘要不展示。
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
  const { t, i18n } = useBotTranslation();
  const { confirm } = useConfirmDialog();
  // 「本事」行要带来源时间。判定用上面内联的纯函数(原属已删除的
  // botArtifactPresentation.ts,这里是仅存引用方),文案复用 bots.growth.time.*。
  const timeText = (at: number): string => {
    const label = artifactTimeLabel(at, Date.now());
    if (label.kind === 'justNow') return t('bots.growth.time.justNow');
    if (label.kind !== 'date') return t(`bots.growth.time.${label.kind}`, { n: label.n });
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
  const [skills, setSkills] = useState<BotSkillSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyFilename, setBusyFilename] = useState<string | null>(null);
  const [busySkillSlug, setBusySkillSlug] = useState<string | null>(null);
  const [openSkillSlug, setOpenSkillSlug] = useState<string | null>(null);
  const [openSkill, setOpenSkill] = useState<BotSkillDetail | null>(null);
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

  /*
    技能与记忆是两套存储,失败也要分开处理:记忆读不出来不该把技能列表一起变成
    错误态。`botSkill` 桥在旧版 preload 上可能不存在(用户先起了新 renderer、
    preload 还是旧的),此时按"还没学会任何东西"处理而不是整块报错。
  */
  const loadSkills = useCallback(async () => {
    const bridge = window.electronAPI?.maker?.botSkill;
    if (!bridge) {
      setSkills([]);
      return;
    }
    try {
      setSkills(await bridge.list(botId));
    } catch (cause) {
      setSkills([]);
      setError(readError(cause));
    }
  }, [botId]);

  useEffect(() => {
    void load();
    void loadSkills();
  }, [load, loadSkills]);

  /** 展开一条技能看正文。再点一次收起;读失败就收起并把原因说出来。 */
  const toggleSkill = async (slug: string) => {
    if (openSkillSlug === slug) {
      setOpenSkillSlug(null);
      setOpenSkill(null);
      return;
    }
    setOpenSkillSlug(slug);
    setOpenSkill(null);
    try {
      setOpenSkill(await window.electronAPI.maker.botSkill.read(botId, slug));
    } catch (cause) {
      setOpenSkillSlug(null);
      setError(readError(cause));
    }
  };

  const deleteSkill = async (skill: BotSkillSummary) => {
    const confirmed = await confirm({
      title: t('bots.learned.deleteTitle'),
      description: t('bots.learned.deleteDescription', { title: skill.name }),
      confirmText: t('bots.learned.deleteConfirm'),
      cancelText: t('commonUi.confirmDialog.cancel'),
      confirmVariant: 'destructive',
    });
    if (!confirmed) return;
    setBusySkillSlug(skill.slug);
    setError(null);
    try {
      await window.electronAPI.maker.botSkill.delete(botId, skill.slug);
      if (openSkillSlug === skill.slug) {
        setOpenSkillSlug(null);
        setOpenSkill(null);
      }
      await loadSkills();
    } catch (cause) {
      setError(readError(cause));
    } finally {
      setBusySkillSlug(null);
    }
  };

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
  const canSeedBack = records !== null && !hasSeedMemory && (seedEntries?.length ?? 0) > 0;

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

  /**
   * 一条真技能:名字 + 说明 · 相对时间,点开看正文,右侧删除。
   *
   * 展开用的是行内一段折叠正文而不是弹窗 —— 这个列表回答的是「TA 会点什么」,
   * 想看细节的人不该被拽出设置页。
   */
  const renderSkillRow = (skill: BotSkillSummary) => {
    const at = parseUpdatedAt(skill.updatedAt);
    const metaLine = [skill.description.trim(), at !== null ? timeText(at) : '']
      .filter((part) => part.length > 0)
      .join(' · ');
    const open = openSkillSlug === skill.slug;
    return (
      <li key={skill.slug} className="rounded-lg bg-[var(--surface-chip)]">
        <div className="flex items-start justify-between gap-3 px-3 py-2">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => void toggleSkill(skill.slug)}
            className="flex min-w-0 flex-1 items-start gap-1.5 text-left"
          >
            {open ? (
              <ChevronDown size={13} className="mt-0.5 shrink-0 text-[var(--text-tertiary)]" />
            ) : (
              <ChevronRight size={13} className="mt-0.5 shrink-0 text-[var(--text-tertiary)]" />
            )}
            <span className="min-w-0">
              <span className="block truncate text-12 text-[var(--text-primary)]">
                {skill.name}
              </span>
              {metaLine ? (
                <span className="mt-0.5 block truncate text-11 text-[var(--text-tertiary)]">
                  {metaLine}
                </span>
              ) : null}
            </span>
          </button>
          <button
            type="button"
            disabled={busySkillSlug !== null}
            aria-label={t('bots.learned.deleteAria', { title: skill.name })}
            onClick={() => void deleteSkill(skill)}
            className="shrink-0 rounded-lg p-1.5 text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-danger)] disabled:opacity-50"
          >
            <Trash2 size={13} />
          </button>
        </div>
        {open ? (
          <p className="whitespace-pre-wrap break-words border-t border-[var(--border-default)] px-3 py-2 text-11 leading-4 text-[var(--text-secondary)]">
            {openSkill?.slug === skill.slug ? openSkill.body : t('bots.learned.loadingBody')}
          </p>
        ) : null}
      </li>
    );
  };

  // 高亮是"从尾注跳进来"的落点提示:加一圈焦点色描边,不改配色也不加阴影。
  // 圆角由区块外壳自己带,这里只加描边 —— 两边都写 rounded 会在 cn() 里打架。
  const highlightRing = (id: BotSettingsHighlightId): string | false =>
    highlight === id && 'ring-2 ring-[var(--focus-ring-soft)]';

  return (
    <>
      <BotSettingsBlock
        testId="bot-memory-list"
        className={cn(highlightRing('memory'))}
        icon={BookMarked}
        title={t('bots.memoryList.title')}
        hint={hasSeedMemory ? t('bots.memoryList.footnoteWithSeed') : t('bots.memoryList.footnote')}
        action={
          records && records.length > 0 ? (
            <button
              type="button"
              disabled={clearing}
              onClick={() => void clearAll()}
              className="text-11 text-[var(--text-tertiary)] hover:text-[var(--text-danger)] disabled:opacity-50"
            >
              {clearing ? t('bots.memoryList.clearing') : t('bots.memoryList.clearAll')}
            </button>
          ) : null
        }
      >
        {error ? <p className="mt-3 text-11 text-[var(--text-danger)]">{error}</p> : null}
        {records === null ? null : memories.length === 0 ? (
          <p className="mt-3 text-11 leading-4 text-[var(--text-tertiary)]">
            {t('bots.memoryList.empty')}
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-1.5">
            {memories.map((record) => renderRow(record, false))}
          </ul>
        )}
        {canSeedBack ? (
          <button
            type="button"
            disabled={seeding}
            onClick={() => void seedBack()}
            className="mt-2 rounded-lg text-11 text-[var(--text-secondary)] underline underline-offset-2 hover:text-[var(--text-primary)] disabled:opacity-50"
          >
            {seeding ? t('bots.memoryList.seedingBack') : t('bots.memoryList.seedBack')}
          </button>
        ) : null}
      </BotSettingsBlock>

      <BotSettingsBlock
        testId="bot-learned-list"
        className={cn(highlightRing('learned'))}
        icon={GraduationCap}
        title={t('bots.learned.title')}
        hint={t('bots.learned.description')}
      >
        {/* 仅当 Skill 和兼容笔记都为空时显示空态。 */}
        {skills === null || records === null ? null : skills.length === 0 &&
          learned.length === 0 ? (
          <p className="mt-3 text-11 leading-4 text-[var(--text-tertiary)]">
            {t('bots.learned.empty')}
          </p>
        ) : null}
        {skills && skills.length > 0 ? (
          <ul data-testid="bot-skill-list" className="mt-3 flex flex-col gap-1.5">
            {skills.map(renderSkillRow)}
          </ul>
        ) : null}
        {/* `learned-` 旧记忆不是可挂载 Skill，单独标为笔记。 */}
        {records && learned.length > 0 ? (
          <div data-testid="bot-learned-notes" className="mt-4">
            <p className="text-11 text-[var(--text-tertiary)]">{t('bots.learned.notesTitle')}</p>
            <ul className="mt-1.5 flex flex-col gap-1.5">
              {learned.map((record) => renderRow(record, true))}
            </ul>
          </div>
        ) : null}
      </BotSettingsBlock>
    </>
  );
}
