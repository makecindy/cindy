/**
 * ContactDetailPane — 通讯录管理浮层右侧详情。
 *
 * 排版模型(v2 重构):
 *  - 头部块: 图标 + 大号名称(静默输入框) + 类型/别名脚注 + 操作(合并/删除)
 *  - 各小节统一形态: 节头(标题 + 右侧 "+" 触发添加行, 默认收起) + 内容行
 *  - 关联小节: 双向关系 chips(→ 任职 / ← 成员), 添加行 = 关系词 + 对端 + 备注
 *  - 合并: 头部按钮展开内联面板, 搜出重复档案点选, confirm 后并入当前档案
 *  - 文本字段(名称/简介/叙事/agent 指令)走 draft + 底部粘性保存条; 身份/事件/
 *    关系/分组即时提交
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ArrowRight, Building2, Check, GitMerge, Plus, Trash2, User, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { createLogger } from '@/lib/logger';
import {
  contactsService,
  contactsErrorI18nKey,
  type ContactGroupWithCount,
  type ContactProfile,
  type ContactSummary,
} from '@/lib/contactsService';

const log = createLogger('ContactDetailPane');

interface Props {
  profile: ContactProfile | null;
  groups: ContactGroupWithCount[];
  onChanged: () => void;
  onDelete: (profile: ContactProfile) => void;
}

interface Draft {
  displayName: string;
  summary: string;
  narrative: string;
  agentNotes: string;
}

const inputCls = cn(
  'rounded-lg bg-[var(--settings-input-bg)] px-2.5 text-13 outline-none',
  'text-[var(--settings-input-text)] placeholder:text-[var(--settings-section-desc)]',
);

const iconBtnCls = cn(
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors',
  'text-[var(--settings-section-desc)] hover:bg-[var(--settings-input-bg)] hover:text-[var(--settings-section-title)]',
);

const confirmBtnCls = cn(
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg',
  'bg-[var(--accent-cta-bg)] text-[var(--accent-pure-cta-fg)]',
  'disabled:cursor-not-allowed disabled:opacity-40',
);

/** 小节骨架: 节头(标题 + 可选 "+" 切换添加行)、内容 */
function Section(props: {
  label: string;
  addAria?: string;
  onToggleAdd?: () => void;
  adding?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-6 items-center justify-between">
        <p className="text-12 font-medium tracking-wide text-[var(--settings-section-desc)]">
          {props.label}
        </p>
        {props.onToggleAdd && (
          <button
            type="button"
            onClick={props.onToggleAdd}
            aria-label={props.addAria}
            aria-expanded={props.adding}
            className={cn(
              'flex h-6 w-6 items-center justify-center rounded-md transition-colors',
              props.adding
                ? 'bg-[var(--settings-input-bg)] text-[var(--settings-section-title)]'
                : 'text-[var(--settings-section-desc)] hover:bg-[var(--settings-input-bg)] hover:text-[var(--settings-section-title)]',
            )}
          >
            {props.adding ? <X size={13} /> : <Plus size={13} />}
          </button>
        )}
      </div>
      {props.children}
    </div>
  );
}

export function ContactDetailPane({ profile, groups, onChanged, onDelete }: Props) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  // 添加行展开态
  const [addingIdentity, setAddingIdentity] = useState(false);
  const [addingEvent, setAddingEvent] = useState(false);
  const [addingRelation, setAddingRelation] = useState(false);
  const [merging, setMerging] = useState(false);
  // 添加行字段
  const [idPlatform, setIdPlatform] = useState('email');
  const [idValue, setIdValue] = useState('');
  const [evDate, setEvDate] = useState('');
  const [evText, setEvText] = useState('');
  const [relTargetId, setRelTargetId] = useState('');
  const [relVerb, setRelVerb] = useState('');
  const [relNote, setRelNote] = useState('');
  const [relCandidates, setRelCandidates] = useState<ContactSummary[]>([]);
  // 合并面板
  const [mergeQuery, setMergeQuery] = useState('');
  const [mergeCandidates, setMergeCandidates] = useState<ContactSummary[]>([]);

  // draft 的种子快照(baseline): 记录 draft 各字段最初来自哪份持久化值, 用于同人
  // 刷新时区分"用户已改动的字段"(保留)与"未动字段"(跟进最新持久化值)
  const draftBaseline = useRef<{ id: string; fields: Draft } | null>(null);

  // 切换选中人 → 全量重置 draft 与临时态; 同人刷新(onChanged 广播/身份关系等即时
  // 提交后父组件重拉同一档案) → 只同步未被用户编辑的字段, 不打掉未保存的输入
  useEffect(() => {
    if (!profile) {
      setDraft(null);
      draftBaseline.current = null;
      return;
    }
    const fields: Draft = {
      displayName: profile.displayName,
      summary: profile.summary,
      narrative: profile.narrative,
      agentNotes: profile.agentNotes,
    };
    const prev = draftBaseline.current;
    if (prev && prev.id === profile.id) {
      // 同人刷新: 字段仍等于种子值 = 用户没动过 → 跟进最新持久化值;
      // 不等 = 用户有未保存编辑 → 保留(保存/放弃由用户决定)
      draftBaseline.current = { id: profile.id, fields };
      setDraft((d) =>
        d
          ? {
              displayName: d.displayName === prev.fields.displayName ? fields.displayName : d.displayName,
              summary: d.summary === prev.fields.summary ? fields.summary : d.summary,
              narrative: d.narrative === prev.fields.narrative ? fields.narrative : d.narrative,
              agentNotes: d.agentNotes === prev.fields.agentNotes ? fields.agentNotes : d.agentNotes,
            }
          : fields,
      );
      return;
    }
    draftBaseline.current = { id: profile.id, fields };
    setDraft(fields);
    setAddingIdentity(false);
    setAddingEvent(false);
    setAddingRelation(false);
    setMerging(false);
    setIdValue('');
    setEvDate('');
    setEvText('');
    setRelTargetId('');
    setRelVerb('');
    setRelNote('');
    setMergeQuery('');
    setMergeCandidates([]);
  }, [profile]);

  // 展开关系添加行时拉候选(全部条目, 排除自己)。store 侧单次 limit 上限 200,
  // 大库按 offset 翻页拉齐 — 只取首页会让第 201 条之后的档案无法被选为关系对端
  useEffect(() => {
    if (!addingRelation || !profile) return;
    let cancelled = false;
    void (async () => {
      try {
        const PAGE = 200;
        const MAX_PAGES = 50; // 兜底上限(1 万条), 防御异常场景下的无界循环
        const all: ContactSummary[] = [];
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const batch = await contactsService.list({ limit: PAGE, offset: page * PAGE });
          all.push(...batch);
          if (batch.length < PAGE) break;
        }
        if (!cancelled) setRelCandidates(all.filter((c) => c.id !== profile.id));
      } catch (err) {
        log.warn('relation candidates load failed', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [addingRelation, profile]);

  // 合并面板候选(空 query = 最近条目; 有 query = FTS; 量小不需要防抖)
  useEffect(() => {
    if (!merging || !profile) return;
    const q = mergeQuery.trim();
    const load = async () => {
      try {
        if (!q) {
          const all = await contactsService.list({ limit: 50 });
          setMergeCandidates(all.filter((c) => c.id !== profile.id));
          return;
        }
        const hits = await contactsService.search(q, { limit: 20 });
        setMergeCandidates(
          hits
            .filter((h) => h.contactId !== profile.id)
            .map((h) => ({
              id: h.contactId,
              kind: h.kind,
              displayName: h.displayName,
              aliases: [],
              summary: h.summary,
              status: h.status,
              source: 'agent' as const,
              identityCount: 0,
              updatedAt: '',
            })),
        );
      } catch (err) {
        log.warn('merge candidates load failed', err);
      }
    };
    void load();
  }, [merging, mergeQuery, profile]);

  const dirty =
    !!profile &&
    !!draft &&
    (draft.displayName !== profile.displayName ||
      draft.summary !== profile.summary ||
      draft.narrative !== profile.narrative ||
      draft.agentNotes !== profile.agentNotes);

  const run = useCallback(
    async (fn: () => Promise<unknown>, failedKey: string) => {
      try {
        await fn();
        onChanged();
      } catch (err) {
        log.warn(failedKey, err);
        toast.error(t(contactsErrorI18nKey(err)));
      }
    },
    [onChanged, t],
  );

  const handleSave = useCallback(async () => {
    if (!profile || !draft) return;
    setSaving(true);
    try {
      await contactsService.update(profile.id, {
        displayName: draft.displayName,
        summary: draft.summary,
        narrative: draft.narrative,
        agentNotes: draft.agentNotes,
      });
      onChanged();
      toast.success(t('settings.contacts.toast.saved'));
    } catch (err) {
      log.warn('contacts update failed', err);
      toast.error(t(contactsErrorI18nKey(err)));
    } finally {
      setSaving(false);
    }
  }, [profile, draft, onChanged, t]);

  const handleMergeInto = useCallback(
    async (source: ContactSummary) => {
      if (!profile) return;
      const ok = await confirm({
        title: t('settings.contacts.merge.confirmTitle', {
          source: source.displayName,
          target: profile.displayName,
        }),
        description: t('settings.contacts.merge.confirmDescription', {
          source: source.displayName,
        }),
        confirmText: t('settings.contacts.merge.confirm'),
        cancelText: t('settings.contacts.deleteConfirm.cancel'),
      });
      if (!ok) return;
      try {
        await contactsService.merge(profile.id, source.id);
        setMerging(false);
        onChanged();
        toast.success(
          t('settings.contacts.merge.success', { source: source.displayName, target: profile.displayName }),
        );
      } catch (err) {
        log.warn('contacts merge failed', err);
        toast.error(t(contactsErrorI18nKey(err)));
      }
    },
    [profile, confirm, onChanged, t],
  );

  if (!profile || !draft) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-13 text-[var(--settings-section-desc)]">
          {t('settings.contacts.detail.empty')}
        </p>
      </div>
    );
  }

  const memberGroupIds = new Set(profile.groups.map((g) => g.id));
  const addableGroups = groups.filter((g) => !memberGroupIds.has(g.id));
  const KindIcon = profile.kind === 'person' ? User : Building2;

  return (
    <div className="flex flex-col gap-5 p-5">
      {/* 待确认横幅 */}
      {profile.status === 'pending' && (
        <div className="flex items-center justify-between gap-3 rounded-lg bg-[var(--warning-bg-soft)] px-3 py-2.5">
          <p className="text-12 leading-[1.4] text-[var(--settings-section-title)]">
            {t('settings.contacts.detail.pendingBanner')}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() =>
                void run(
                  () => contactsService.update(profile.id, { status: 'confirmed' }),
                  'settings.contacts.toast.confirmFailed',
                )
              }
              className="flex h-7 items-center gap-1 rounded-lg bg-[var(--accent-cta-bg)] px-2.5 text-12 font-medium text-[var(--accent-pure-cta-fg)]"
            >
              <Check size={13} />
              {t('settings.contacts.detail.pendingConfirm')}
            </button>
            <button
              type="button"
              onClick={() => onDelete(profile)}
              className="flex h-7 items-center gap-1 rounded-lg px-2.5 text-12 text-[var(--error-fg)] hover:bg-[var(--error-bg)]"
            >
              <X size={13} />
              {t('settings.contacts.detail.pendingDiscard')}
            </button>
          </div>
        </div>
      )}

      {/* 头部块 */}
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--settings-input-bg)] text-[var(--settings-section-title)]">
          <KindIcon size={18} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <input
            value={draft.displayName}
            onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
            aria-label={t('settings.contacts.detail.nameAria')}
            className={cn(
              'w-full rounded-lg bg-transparent px-1 py-0.5 text-16 font-medium outline-none transition-colors',
              'text-[var(--settings-section-title)]',
              'hover:bg-[var(--settings-input-bg)] focus:bg-[var(--settings-input-bg)]',
            )}
          />
          <p className="px-1 text-12 text-[var(--settings-section-desc)]">
            {t(profile.kind === 'person' ? 'settings.contacts.kind.person' : 'settings.contacts.kind.org')}
            {profile.aliases.length > 0 && ` · ${profile.aliases.join(' / ')}`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setMerging((v) => !v)}
            aria-label={t('settings.contacts.merge.buttonAria')}
            title={t('settings.contacts.merge.button')}
            className={cn(iconBtnCls, merging && 'bg-[var(--settings-input-bg)] text-[var(--settings-section-title)]')}
          >
            <GitMerge size={15} />
          </button>
          <button
            type="button"
            onClick={() => onDelete(profile)}
            aria-label={t('settings.contacts.detail.deleteAria')}
            className={cn(iconBtnCls, 'hover:bg-[var(--error-bg)] hover:text-[var(--error-fg)]')}
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>

      {/* 合并面板 */}
      {merging && (
        <div className="flex flex-col gap-2 rounded-lg border border-[var(--settings-theme-card-border)] bg-[var(--settings-input-bg)] p-3">
          <p className="text-12 leading-[1.4] text-[var(--settings-section-desc)]">
            {t('settings.contacts.merge.hint', { target: profile.displayName })}
          </p>
          <input
            autoFocus
            value={mergeQuery}
            onChange={(e) => setMergeQuery(e.target.value)}
            placeholder={t('settings.contacts.merge.searchPlaceholder')}
            className={cn(inputCls, 'h-8 w-full bg-[var(--cmd-palette-bg)]')}
          />
          <div className="flex max-h-[180px] flex-col overflow-y-auto">
            {mergeCandidates.length === 0 ? (
              <p className="py-3 text-center text-12 text-[var(--settings-section-desc)]">
                {t('settings.contacts.list.noResults')}
              </p>
            ) : (
              mergeCandidates.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => void handleMergeInto(c)}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[var(--cmd-palette-bg)]"
                >
                  {c.kind === 'person' ? (
                    <User size={13} className="shrink-0 text-[var(--settings-section-desc)]" />
                  ) : (
                    <Building2 size={13} className="shrink-0 text-[var(--settings-section-desc)]" />
                  )}
                  <span className="truncate text-13 text-[var(--settings-section-title)]">{c.displayName}</span>
                  {c.summary && (
                    <span className="min-w-0 flex-1 truncate text-12 text-[var(--settings-section-desc)]">
                      {c.summary}
                    </span>
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {/* 一行简介 */}
      <input
        value={draft.summary}
        onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
        placeholder={t('settings.contacts.detail.summaryPlaceholder')}
        className={cn(inputCls, 'h-8 w-full')}
      />

      {/* 身份 */}
      <Section
        label={t('settings.contacts.detail.identities')}
        addAria={t('settings.contacts.detail.identityAddAria')}
        adding={addingIdentity}
        onToggleAdd={() => setAddingIdentity((v) => !v)}
      >
        {profile.identities.length === 0 && !addingIdentity && (
          <p className="text-12 text-[var(--settings-section-desc)]">
            {t('settings.contacts.detail.identitiesEmpty')}
          </p>
        )}
        {profile.identities.map((i) => (
          <div key={i.id} className="group flex h-7 items-center gap-2">
            <span className="w-[68px] shrink-0 truncate rounded-md bg-[var(--settings-input-bg)] px-1.5 py-1 text-center text-11 leading-none text-[var(--settings-section-desc)]">
              {i.platform}
            </span>
            <span className="min-w-0 flex-1 truncate text-13 text-[var(--settings-section-title)]">{i.value}</span>
            {i.label && <span className="shrink-0 text-11 text-[var(--settings-section-desc)]">{i.label}</span>}
            <button
              type="button"
              onClick={() =>
                void run(() => contactsService.removeIdentity(i.id), 'settings.contacts.toast.identityRemoveFailed')
              }
              aria-label={t('settings.contacts.detail.identityRemoveAria', { value: i.value })}
              className="shrink-0 text-[var(--settings-section-desc)] opacity-0 transition-opacity hover:text-[var(--error-fg)] group-hover:opacity-100"
            >
              <X size={13} />
            </button>
          </div>
        ))}
        {addingIdentity && (
          <div className="flex items-center gap-1.5">
            <input
              value={idPlatform}
              onChange={(e) => setIdPlatform(e.target.value)}
              aria-label={t('settings.contacts.detail.identityPlatformAria')}
              className={cn(inputCls, 'h-7 w-[68px] shrink-0 text-12')}
            />
            <input
              autoFocus
              value={idValue}
              onChange={(e) => setIdValue(e.target.value)}
              placeholder={t('settings.contacts.detail.identityValuePlaceholder')}
              className={cn(inputCls, 'h-7 min-w-0 flex-1 text-12')}
            />
            <button
              type="button"
              disabled={!idValue.trim() || !idPlatform.trim()}
              onClick={() =>
                void run(async () => {
                  await contactsService.addIdentity(profile.id, {
                    platform: idPlatform.trim(),
                    value: idValue.trim(),
                  });
                  setIdValue('');
                  setAddingIdentity(false);
                }, 'settings.contacts.toast.identityAddFailed')
              }
              aria-label={t('settings.contacts.detail.identityAddAria')}
              className={confirmBtnCls}
            >
              <Check size={13} />
            </button>
          </div>
        )}
      </Section>

      {/* 关联(关系边, 双向) */}
      <Section
        label={t('settings.contacts.detail.relations')}
        addAria={t('settings.contacts.detail.relationAddAria')}
        adding={addingRelation}
        onToggleAdd={() => setAddingRelation((v) => !v)}
      >
        {profile.relations.length === 0 && !addingRelation && (
          <p className="text-12 text-[var(--settings-section-desc)]">
            {t('settings.contacts.detail.relationsEmpty')}
          </p>
        )}
        {profile.relations.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {profile.relations.map((r) => (
              <span
                key={`${r.relationId}:${r.direction}`}
                className="group flex h-6 items-center gap-1 rounded-full bg-[var(--settings-input-bg)] px-2.5 text-12 text-[var(--settings-section-title)]"
                title={r.note || undefined}
              >
                {r.direction === 'out' ? (
                  <ArrowRight size={11} className="text-[var(--settings-section-desc)]" />
                ) : (
                  <ArrowLeft size={11} className="text-[var(--settings-section-desc)]" />
                )}
                <span className="text-[var(--settings-section-desc)]">{r.relation}</span>
                <span className="max-w-[160px] truncate font-medium">{r.displayName}</span>
                <button
                  type="button"
                  onClick={() =>
                    void run(
                      () => contactsService.removeRelation(r.relationId),
                      'settings.contacts.toast.relationRemoveFailed',
                    )
                  }
                  aria-label={t('settings.contacts.detail.relationRemoveAria', { name: r.displayName })}
                  className="text-[var(--settings-section-desc)] opacity-0 transition-opacity hover:text-[var(--error-fg)] group-hover:opacity-100"
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        {addingRelation && (
          <div className="flex items-center gap-1.5">
            <input
              autoFocus
              value={relVerb}
              onChange={(e) => setRelVerb(e.target.value)}
              placeholder={t('settings.contacts.detail.relationVerbPlaceholder')}
              className={cn(inputCls, 'h-7 w-[76px] shrink-0 text-12')}
            />
            <select
              value={relTargetId}
              onChange={(e) => setRelTargetId(e.target.value)}
              aria-label={t('settings.contacts.detail.relationTargetAria')}
              className={cn(inputCls, 'h-7 min-w-0 flex-1 text-12')}
            >
              <option value="">{t('settings.contacts.detail.relationTargetPlaceholder')}</option>
              {relCandidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName}
                </option>
              ))}
            </select>
            <input
              value={relNote}
              onChange={(e) => setRelNote(e.target.value)}
              placeholder={t('settings.contacts.detail.relationNotePlaceholder')}
              className={cn(inputCls, 'h-7 w-[90px] shrink-0 text-12')}
            />
            <button
              type="button"
              disabled={!relVerb.trim() || !relTargetId}
              onClick={() =>
                void run(async () => {
                  await contactsService.addRelation(profile.id, {
                    toId: relTargetId,
                    relation: relVerb.trim(),
                    ...(relNote.trim() ? { note: relNote.trim() } : {}),
                  });
                  setRelVerb('');
                  setRelNote('');
                  setRelTargetId('');
                  setAddingRelation(false);
                }, 'settings.contacts.toast.relationAddFailed')
              }
              aria-label={t('settings.contacts.detail.relationAddAria')}
              className={confirmBtnCls}
            >
              <Check size={13} />
            </button>
          </div>
        )}
      </Section>

      {/* 关系叙事 */}
      <Section label={t('settings.contacts.detail.narrative')}>
        <textarea
          value={draft.narrative}
          onChange={(e) => setDraft({ ...draft, narrative: e.target.value })}
          placeholder={t('settings.contacts.detail.narrativePlaceholder')}
          rows={5}
          className={cn(inputCls, 'w-full resize-y py-2 leading-[1.5]')}
        />
      </Section>

      {/* agent 处置指令 */}
      <Section label={t('settings.contacts.detail.agentNotes')}>
        <textarea
          value={draft.agentNotes}
          onChange={(e) => setDraft({ ...draft, agentNotes: e.target.value })}
          placeholder={t('settings.contacts.detail.agentNotesPlaceholder')}
          rows={2}
          className={cn(inputCls, 'w-full resize-y py-2 leading-[1.5]')}
        />
      </Section>

      {/* 事件时间线(添加行在最上, 新事件通常最靠前) */}
      <Section
        label={t('settings.contacts.detail.events')}
        addAria={t('settings.contacts.detail.eventAddAria')}
        adding={addingEvent}
        onToggleAdd={() => setAddingEvent((v) => !v)}
      >
        {profile.events.length === 0 && !addingEvent && (
          <p className="text-12 text-[var(--settings-section-desc)]">
            {t('settings.contacts.detail.eventsEmpty')}
          </p>
        )}
        {addingEvent && (
          <div className="flex items-center gap-1.5">
            <input
              autoFocus
              value={evDate}
              onChange={(e) => setEvDate(e.target.value)}
              placeholder={t('settings.contacts.detail.eventDatePlaceholder')}
              className={cn(inputCls, 'h-7 w-[100px] shrink-0 text-12 tabular-nums')}
            />
            <input
              value={evText}
              onChange={(e) => setEvText(e.target.value)}
              placeholder={t('settings.contacts.detail.eventTextPlaceholder')}
              className={cn(inputCls, 'h-7 min-w-0 flex-1 text-12')}
            />
            <button
              type="button"
              disabled={!/^\d{4}-\d{2}(-\d{2})?$/.test(evDate.trim()) || !evText.trim()}
              onClick={() =>
                void run(async () => {
                  await contactsService.appendEvent(profile.id, {
                    date: evDate.trim(),
                    text: evText.trim(),
                    source: 'manual',
                  });
                  setEvDate('');
                  setEvText('');
                  setAddingEvent(false);
                }, 'settings.contacts.toast.eventAddFailed')
              }
              aria-label={t('settings.contacts.detail.eventAddAria')}
              className={confirmBtnCls}
            >
              <Check size={13} />
            </button>
          </div>
        )}
        {profile.events.map((e) => (
          <div key={e.id} className="group flex items-start gap-2.5">
            <span className="w-[80px] shrink-0 pt-px text-12 tabular-nums text-[var(--settings-section-desc)]">
              {e.date}
            </span>
            <span className="min-w-0 flex-1 text-13 leading-[1.5] text-[var(--settings-section-title)]">
              {e.text}
              {e.source && (
                <span className="ml-1.5 text-11 text-[var(--settings-section-desc)]">({e.source})</span>
              )}
            </span>
            <button
              type="button"
              onClick={() =>
                void run(() => contactsService.deleteEvent(e.id), 'settings.contacts.toast.eventDeleteFailed')
              }
              aria-label={t('settings.contacts.detail.eventDeleteAria')}
              className="shrink-0 pt-px text-[var(--settings-section-desc)] opacity-0 transition-opacity hover:text-[var(--error-fg)] group-hover:opacity-100"
            >
              <X size={13} />
            </button>
          </div>
        ))}
      </Section>

      {/* 分组 */}
      <Section label={t('settings.contacts.detail.groups')}>
        <div className="flex flex-wrap items-center gap-1.5">
          {profile.groups.map((g) => (
            <span
              key={g.id}
              className="group flex h-6 items-center gap-1 rounded-full bg-[var(--settings-input-bg)] px-2.5 text-12 text-[var(--settings-section-title)]"
            >
              {g.name}
              <button
                type="button"
                onClick={() =>
                  void run(
                    () => contactsService.groupsSetMembers(g.id, { remove: [profile.id] }),
                    'settings.contacts.toast.groupRemoveFailed',
                  )
                }
                aria-label={t('settings.contacts.detail.groupRemoveAria', { name: g.name })}
                className="text-[var(--settings-section-desc)] hover:text-[var(--error-fg)]"
              >
                <X size={11} />
              </button>
            </span>
          ))}
          {addableGroups.length > 0 && (
            <select
              value=""
              onChange={(e) => {
                const gid = e.target.value;
                if (!gid) return;
                void run(
                  () => contactsService.groupsSetMembers(gid, { add: [profile.id] }),
                  'settings.contacts.toast.groupAddFailed',
                );
              }}
              aria-label={t('settings.contacts.detail.groupAddAria')}
              className="h-6 rounded-full bg-[var(--settings-input-bg)] px-2 text-12 text-[var(--settings-section-desc)] outline-none"
            >
              <option value="">{t('settings.contacts.detail.groupAddPlaceholder')}</option>
              {addableGroups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </Section>

      {/* 保存条(dirty 才出现) */}
      {dirty && (
        <div className="sticky bottom-0 -mx-5 flex items-center justify-end gap-2 border-t border-[var(--settings-theme-card-border)] bg-[var(--cmd-palette-bg)] px-5 py-2.5">
          <button
            type="button"
            disabled={saving}
            onClick={() =>
              setDraft({
                displayName: profile.displayName,
                summary: profile.summary,
                narrative: profile.narrative,
                agentNotes: profile.agentNotes,
              })
            }
            className="h-8 rounded-lg px-3 text-13 text-[var(--settings-section-desc)] hover:text-[var(--settings-section-title)]"
          >
            {t('settings.contacts.detail.discardChanges')}
          </button>
          <button
            type="button"
            disabled={saving || !draft.displayName.trim()}
            onClick={() => void handleSave()}
            className={cn(
              'h-8 rounded-lg px-3.5 text-13 font-medium',
              'bg-[var(--accent-cta-bg)] text-[var(--accent-pure-cta-fg)]',
              'disabled:cursor-not-allowed disabled:opacity-40',
            )}
          >
            {t('settings.contacts.detail.save')}
          </button>
        </div>
      )}
    </div>
  );
}
