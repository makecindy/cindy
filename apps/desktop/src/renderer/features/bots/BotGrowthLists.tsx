import { useCallback, useEffect, useState } from 'react';
import { BookMarked, ChevronDown, ChevronRight, GraduationCap, Trash2 } from 'lucide-react';
import { useBotTranslation } from './botPronounContext';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { cn } from '@/lib/utils';
import type { MemoryRecord } from '@cindy/maker-core';

import { BotSettingsBlockHeading, BOT_SETTINGS_BLOCK_CLASS } from './BotSettingsBlock';

import { artifactTimeLabel } from './botArtifactPresentation';
import { partitionBotMemoryRecords } from './botGrowth';
import { isBotSeedMemorySlug } from './botTemplates';
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
 * 设置页「TA 是谁」里并排的两个成长列表:「TA 记得的」与「TA 学会的」。
 *
 * ## 两个列表、三种东西
 *
 * 「TA 记得的」是伙伴记忆分域里除 `learned-` 之外的分片(见
 * botGrowth.partitionBotMemoryRecords)。
 *
 * 「TA 学会的」列的是**真技能**(批次 ζ):伙伴自己调 `save_bot_skill` 存下的
 * `SKILL.md`,下一次会话会被 harness 真正挂载。它们和记忆不在同一套存储里,所以
 * 这里要拉两份数据。
 *
 * `learned-` 前缀的记忆分片(批次 ε 的做法)继续留在同一个区块的下半段,标成
 * 「笔记」—— 它们是伙伴写给自己看的做法,不是可挂载的技能。老数据一条不丢,但
 * 视觉上必须能一眼看出「这条是能用的本事,那条只是一段笔记」。
 *
 * 两份数据在同一个组件里拉,删除后一起刷新 —— 分两个组件各拉一次会出现
 * 「删了一条,另一个列表还是旧的」。`digest` 分片(Pi 压缩产生的系统内部摘要)
 * 两边都不展示,但不影响它继续被检索使用。
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
              <span className="block truncate text-12 text-[var(--text-primary)]">{skill.name}</span>
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

  /*
    两个列表各自成为页面上的一个区块,而不是挤在「TA 是谁」那张卡的下半截。

    原来「TA 是谁」一张卡里装了六件事(头像名字 / 性格 / 背景设定 / 记得的 /
    学会的),而隔壁「TA 懂的」整张卡只有一个按钮 —— 卡片规格一样重,信息量差六倍,
    页面读起来就是上面一坨、下面空荡。现在每张卡只讲一件事,四块变六块但每块都
    更短,而且「TA 记得的 / TA 学会的」跟「TA 会的 / TA 懂的」本来就是同一个句式,
    并进这一排是它们本来该在的位置。

    两份数据仍在同一个组件里拉、删除后一起刷新(分成两个组件会出现「删了一条,
    另一个列表还是旧的」),只是渲染成两个并列的外壳。
  */
  return (
    <>
      <section
        data-testid="bot-memory-list"
        className={cn(BOT_SETTINGS_BLOCK_CLASS, highlightRing('memory'))}
      >
        <BotSettingsBlockHeading
          icon={BookMarked}
          title={t('bots.memoryList.title')}
          /* 这句回答的是「这些东西是谁放进来的、我能不能动」——列表本身答不了,
             所以它常驻。但它跟着标题走,不再自己占一整行。 */
          hint={
            hasSeedMemory ? t('bots.memoryList.footnoteWithSeed') : t('bots.memoryList.footnote')
          }
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
        />
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
      </section>

      {/* 「TA 学会的」与「TA 记得的」并列:记忆是你说过的,本事是 TA 做出来的。 */}
      <section
        data-testid="bot-learned-list"
        className={cn(BOT_SETTINGS_BLOCK_CLASS, highlightRing('learned'))}
      >
        {/*
          空的时候不给 hint:原来的脚注「TA 会从做过的事里自己长本事,用得越多越
          顺手」和空态那句「还没长出什么本事——多让 TA 做几件事」说的是同一件事,
          留一句就够。有内容时更不需要 —— 用户看着列表,不必再被讲一遍它是什么。
        */}
        <BotSettingsBlockHeading icon={GraduationCap} title={t('bots.learned.title')} />
        {/*
          两组都空才说「还没长出什么本事」。技能已经有了、只是没有笔记(反之亦然)
          时说这句就是对着一个非空列表讲假话。
        */}
        {skills === null || records === null ? null : skills.length === 0 && learned.length === 0 ? (
          <p className="mt-3 text-11 leading-4 text-[var(--text-tertiary)]">
            {t('bots.learned.empty')}
          </p>
        ) : null}
        {skills && skills.length > 0 ? (
          <ul data-testid="bot-skill-list" className="mt-3 flex flex-col gap-1.5">
            {skills.map(renderSkillRow)}
          </ul>
        ) : null}
        {/*
          `learned-` 记忆分片是批次 ε 的做法:伙伴写给自己看的一段笔记,不会被
          harness 挂载。老数据一条不丢,但必须和上面那组真技能分开标注 ——
          不然用户会以为每一条都是「能用的本事」。
        */}
        {records && learned.length > 0 ? (
          <div data-testid="bot-learned-notes" className="mt-4">
            <p className="text-11 text-[var(--text-tertiary)]">{t('bots.learned.notesTitle')}</p>
            <ul className="mt-1.5 flex flex-col gap-1.5">
              {learned.map((record) => renderRow(record, true))}
            </ul>
          </div>
        ) : null}
      </section>
    </>
  );
}
