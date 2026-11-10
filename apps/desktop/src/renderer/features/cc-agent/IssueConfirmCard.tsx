import { Button } from '@/components/ui/button';
import { ChevronDown, Globe2, Pencil } from 'lucide-react';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
/**
 * IssueConfirmCard
 * ---------------------------------------------------------------------------
 * submit_github_issue 工具的提交前确认卡片(kind='issue_confirm')。agent 整理好
 * issue 草稿后,main 进程 IssueConfirmBridge 把草稿 + 环境信息推到这里;用户可以
 * 编辑标题/正文、切换类型,确认或取消。确认是工具通往提交的唯一路径(main 侧
 * 代码强制),卡片上展示的环境信息就是最终附进 issue body 的内容。
 *
 * 视觉对齐 PermissionPrompt(替换 ChatInput 的占位卡片)。
 *
 * Keyboard shortcuts:
 *   Ctrl/Cmd+Enter → 编辑时回到预览；预览时提交
 *   Esc            → 编辑时回到预览；预览时取消
 */

import { useCallback, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  getIssueConfirmDraft,
  saveIssueConfirmDraft,
  type IssueConfirmDraft,
} from '@/lib/issueConfirmDraftStore';
import { cn } from '@/lib/utils';
import { SegmentedControl } from '@/components/ui/segmented-control';
import type { PendingIssueConfirm } from '@/lib/makerChatStore';
import { shouldLabelRegion } from '../../../shared/regionCode';
import { ISSUE_PUBLIC_NAME_MAX, normalizeIssuePublicName } from '../../../shared/issuePublicName';

interface IssueConfirmCardProps {
  sessionId: string;
  pending: PendingIssueConfirm;
  onRespond: (
    result:
      | {
          confirmed: true;
          title: string;
          body: string;
          type: 'bug' | 'feature';
          submissionIdentity: PendingIssueConfirm['submissionIdentity'];
          publicName?: string;
          uiLanguage: string;
        }
      | { confirmed: false },
  ) => void;
}

const TITLE_MAX = 200;
// 4500 有意大于工具 schema 的 max(4000):schema 约束的是 agent 生成的草稿,
// 用户在确认卡上可以再扩写一些;最终 description(body + env 块)由
// githubIssueSubmitService clamp 到 server 上限 SERVER_DESC_MAX(5000)。
const BODY_MAX = 4500;

export function IssueConfirmCard({ sessionId, pending, onRespond }: IssueConfirmCardProps) {
  const { t, i18n } = useTranslation();
  const cardRef = useRef<HTMLDivElement>(null);
  const titleInputId = useId();
  const bodyInputId = useId();
  const publicNameInputId = useId();
  const [editing, setEditing] = useState(false);
  const legacyFixedGithubIdentity =
    pending.submissionIdentity.kind === 'github-user' ? pending.submissionIdentity : null;
  const [draft, setDraft] = useState<IssueConfirmDraft>(() => {
    const saved = getIssueConfirmDraft(sessionId, pending.requestId);
    if (legacyFixedGithubIdentity) {
      return {
        ...(saved ?? pending.draft),
        submissionIdentityKind: 'github-user',
        publicName: undefined,
      };
    }
    return (
      saved ?? {
        ...pending.draft,
        submissionIdentityKind: 'platform',
        publicName: pending.suggestedPublicName ?? t('issueAgent.confirm.anonymous'),
      }
    );
  });
  const { title, body, type, publicName = '' } = draft;
  const hasRelatedLogs = body.includes('## 相关日志');
  const selectedIdentity =
    legacyFixedGithubIdentity ??
    (draft.submissionIdentityKind === 'github-user' && pending.githubUserIdentity
      ? pending.githubUserIdentity
      : pending.submissionIdentity);

  const confirmedPublicName =
    selectedIdentity.kind === 'platform' ? normalizeIssuePublicName(publicName) : null;
  const [identityExpanded, setIdentityExpanded] = useState(
    () => selectedIdentity.kind === 'platform' && confirmedPublicName === null,
  );
  const canSubmit =
    !editing &&
    title.trim().length > 0 &&
    body.trim().length > 0 &&
    (selectedIdentity.kind !== 'platform' || confirmedPublicName !== null);

  const updateDraft = useCallback(
    (patch: Partial<IssueConfirmDraft>) => {
      const next = { ...draft, ...patch };
      if (
        next.title === draft.title &&
        next.body === draft.body &&
        next.type === draft.type &&
        next.submissionIdentityKind === draft.submissionIdentityKind &&
        next.publicName === draft.publicName
      ) {
        return;
      }
      // Save synchronously with the input event so an immediate session switch
      // cannot unmount the card before its latest edit reaches the draft slot.
      saveIssueConfirmDraft(sessionId, pending.requestId, next);
      setDraft(next);
    },
    [draft, pending.requestId, sessionId],
  );

  // 构建区域代号,与登录页区域徽标同一套不对称命名(DESIGN.md §16.3):cn → CN、
  // dev → Dev、global 不标。「哪些区域要标」只有 CINDY_REGION_CODE 一个事实源 ——
  // main 侧 issue 正文用的是同一个常量,卡片承诺展示的就是最终写进 issue 的内容,
  // 两侧各写一份判断迟早漂移。region 缺失(IPC payload 异常)时按不标处理,不猜。
  // 展示文案仍走 i18n(同 login.regionPill.*,便于日后改判为可译文案),所以这里是
  // 「常量决定标不标 + i18n 提供文案」;两者逐区域逐语言的一致性由
  // __tests__/regionCode.consistency.test.ts 断言。key 写成字面量分支而非
  // 动态拼接,保证 pnpm check:i18n 的静态提取能看到全部 key。
  const regionCode = !shouldLabelRegion(pending.env.region)
    ? null
    : pending.env.region === 'cn'
      ? t('issueAgent.confirm.regionCodeCn')
      : t('issueAgent.confirm.regionCodeDev');

  const handleSubmit = useCallback(() => {
    if (!canSubmit) return;
    onRespond({
      confirmed: true,
      title: title.trim(),
      body: body.trim(),
      type,
      submissionIdentity: selectedIdentity,
      ...(confirmedPublicName ? { publicName: confirmedPublicName } : {}),
      uiLanguage: i18n.language,
    });
  }, [
    canSubmit,
    confirmedPublicName,
    onRespond,
    title,
    body,
    type,
    selectedIdentity,
    i18n.language,
  ]);

  const handleCancel = useCallback(() => {
    onRespond({ confirmed: false });
  }, [onRespond]);

  const finishEditing = () => {
    setEditing(false);
    // The focused editor unmounts. Keep keyboard ownership on this card so a
    // subsequent explicit shortcut can act on its preview, never another pane.
    cardRef.current?.focus({ preventScroll: true });
  };

  const identityButton = (identity: PendingIssueConfirm['submissionIdentity'], label: string) => {
    const selected =
      selectedIdentity.kind === identity.kind && selectedIdentity.login === identity.login;
    return (
      <button
        type="button"
        aria-pressed={selected}
        onClick={() => updateDraft({ submissionIdentityKind: identity.kind })}
        className={cn(
          'rounded-full border px-3 py-2 text-13 font-medium transition-colors',
          selected
            ? 'border-[var(--chat-input-border)] bg-[var(--perm-allow-btn-bg)] text-[var(--perm-allow-btn-text)]'
            : 'border-[var(--chat-input-border)] bg-transparent text-[var(--chat-input-text)] hover:bg-[var(--chat-input-bg)]',
        )}
      >
        {label}
      </button>
    );
  };

  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      onKeyDown={(e) => {
        // Scoped bubbling excludes other panes and portalled Markdown content.
        if (e.repeat || e.nativeEvent.isComposing || !e.currentTarget.contains(e.target as Node))
          return;
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          e.stopPropagation();
          if (editing) finishEditing();
          else handleSubmit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          if (editing) finishEditing();
          else handleCancel();
        }
      }}
      className={cn(
        'w-full max-w-[914px] overflow-hidden rounded-[12px] border',
        'border-[var(--chat-input-border)] bg-[var(--chat-input-bg)]',
      )}
    >
      <div className="flex min-h-11 items-center justify-between gap-3 px-5 pt-3">
        <p className="flex items-center gap-2 text-12 text-[var(--status-bar-meta)]">
          <Globe2 size={14} aria-hidden="true" />
          {t('issueAgent.confirm.previewLabel')}
        </p>
        {!editing && (
          <Button
            variant="secondary"
            tone="quiet"
            size="md"
            compact
            type="button"
            onClick={() => setEditing(!editing)}
          >
            <Pencil size={14} aria-hidden="true" />
            {t('issueAgent.confirm.edit')}
          </Button>
        )}
      </div>
      <div className="max-h-[50vh] overflow-y-auto px-5 pb-4">
        {editing ? (
          <>
            <div className="mt-3 flex justify-end">
              <SegmentedControl
                aria-label={[
                  t('issueAgent.confirm.typeBug'),
                  t('issueAgent.confirm.typeFeature'),
                ].join(' / ')}
                value={type}
                onValueChange={(next) => updateDraft({ type: next })}
                height={28}
                optionHeight={24}
                optionClassName="px-2.5"
                options={[
                  { value: 'bug', label: t('issueAgent.confirm.typeBug') },
                  { value: 'feature', label: t('issueAgent.confirm.typeFeature') },
                ]}
              />
            </div>

            {/* Issue title input */}
            <label
              htmlFor={titleInputId}
              className="mt-3 block text-12 font-medium text-[var(--status-bar-meta)]"
            >
              {t('issueAgent.confirm.titleLabel')}
            </label>
            <input
              id={titleInputId}
              type="text"
              value={title}
              maxLength={TITLE_MAX}
              onChange={(e) => updateDraft({ title: e.target.value })}
              className={cn(
                'mt-1 w-full rounded-[8px] border px-3 py-2',
                'border-[var(--perm-code-border)] bg-[var(--perm-code-bg)]',
                'text-13 leading-tight text-[var(--chat-input-text)]',
                'focus:outline-none focus:ring-1 focus:ring-[var(--focus-ring)]',
              )}
            />

            {/* Issue body textarea */}
            <label
              htmlFor={bodyInputId}
              className="mt-3 block text-12 font-medium text-[var(--status-bar-meta)]"
            >
              {t('issueAgent.confirm.bodyLabel')}
            </label>
            <textarea
              id={bodyInputId}
              value={body}
              maxLength={BODY_MAX}
              onChange={(e) => updateDraft({ body: e.target.value })}
              rows={8}
              className={cn(
                'mt-1 w-full resize-y rounded-[8px] border px-3 py-2',
                'border-[var(--perm-code-border)] bg-[var(--perm-code-bg)]',
                'font-mono text-13 leading-relaxed text-[var(--chat-input-text)]',
                'focus:outline-none focus:ring-1 focus:ring-[var(--focus-ring)]',
              )}
            />
          </>
        ) : (
          <article className="pb-4 pt-2 [overflow-wrap:anywhere]">
            <h2 className="mb-4 text-18 font-semibold leading-snug text-[var(--chat-input-text)]">
              {title}
            </h2>
            <MarkdownRenderer
              content={body}
              workingDir=""
              allowPrivilegedLinks={false}
              renderRichAnswers={false}
            />
          </article>
        )}
        {hasRelatedLogs && (
          <p className="mt-1 text-12 leading-snug text-[var(--status-bar-meta)]">
            {t('issueAgent.confirm.relatedLogsHint')}
          </p>
        )}

        {/*
        新版 Main:平台 Bot 默认 + 可选 GitHub 用户。旧版 Main 可能已固定为 GitHub
        用户，此时只能如实展示该单一身份，不能提供旧 Main 不会执行的平台切换。
      */}
        <details
          className="group border-t border-[var(--chat-input-border)] py-2"
          open={identityExpanded}
          onToggle={(event) => setIdentityExpanded(event.currentTarget.open)}
        >
          <summary className="flex min-h-9 cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 text-13 text-[var(--chat-input-text)] [&::-webkit-details-marker]:hidden">
            <span className="flex-1">
              {selectedIdentity.kind === 'platform'
                ? t('issueAgent.confirm.attribution', { name: publicName })
                : `@${selectedIdentity.login}`}
            </span>
            <span className="text-12 text-[var(--status-bar-meta)]">
              {t('issueAgent.confirm.identitySettings')}
            </span>
            <ChevronDown
              size={14}
              className="shrink-0 transition-transform group-open:rotate-180"
              aria-hidden="true"
            />
          </summary>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {pending.submissionIdentity.kind === 'platform'
              ? identityButton(
                  pending.submissionIdentity,
                  t('issueAgent.confirm.identityPlatform', {
                    login: pending.submissionIdentity.login,
                  }),
                )
              : identityButton(
                  pending.submissionIdentity,
                  t('issueAgent.confirm.identityGithubUser', {
                    login: pending.submissionIdentity.login,
                  }),
                )}
            {pending.githubUserIdentity &&
              identityButton(
                pending.githubUserIdentity,
                t('issueAgent.confirm.identityGithubUser', {
                  login: pending.githubUserIdentity.login,
                }),
              )}
          </div>
          <p className="mt-1 text-12 leading-snug text-[var(--status-bar-meta)]">
            {selectedIdentity.kind === 'github-user'
              ? t('issueAgent.confirm.identityGithubUserHint')
              : t('issueAgent.confirm.identityPlatformHint')}
          </p>

          {selectedIdentity.kind === 'platform' && (
            <>
              <label
                htmlFor={publicNameInputId}
                className="mt-3 block select-none text-12 font-medium text-[var(--status-bar-meta)]"
              >
                {t('issueAgent.confirm.publicNameLabel')}
              </label>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <input
                  id={publicNameInputId}
                  type="text"
                  value={publicName}
                  maxLength={ISSUE_PUBLIC_NAME_MAX}
                  onChange={(event) => updateDraft({ publicName: event.target.value })}
                  className={cn(
                    'min-w-0 flex-[1_1_220px] rounded-full border px-3 py-2',
                    'border-[var(--chat-input-border)] bg-[var(--chat-input-bg)]',
                    'text-13 leading-tight text-[var(--chat-input-text)]',
                    'focus:outline-none focus:ring-1 focus:ring-[var(--focus-ring)]',
                  )}
                />
                <Button
                  variant="secondary"
                  size="md"
                  compact
                  type="button"
                  onClick={() => updateDraft({ publicName: t('issueAgent.confirm.anonymous') })}
                  className="shrink-0 select-none"
                >
                  {t('issueAgent.confirm.useAnonymous')}
                </Button>
              </div>
              <p className="mt-1 text-12 leading-snug text-[var(--status-bar-meta)]">
                {t('issueAgent.confirm.publicNameHint')}
              </p>
            </>
          )}
        </details>

        {/* 只读环境信息(main 侧自动附进 issue body) */}
        <details className="group border-t border-[var(--chat-input-border)] py-2">
          <summary className="flex min-h-9 cursor-pointer list-none items-center justify-between gap-2 text-12 text-[var(--status-bar-meta)] [&::-webkit-details-marker]:hidden">
            {t('issueAgent.confirm.environment')}
            <ChevronDown
              size={14}
              className="shrink-0 transition-transform group-open:rotate-180"
              aria-hidden="true"
            />
          </summary>
          {regionCode && (
            <p className="mt-1 text-12 leading-tight text-[var(--status-bar-meta)]">
              {t('issueAgent.confirm.regionLine', { region: regionCode })}
            </p>
          )}
          <p className="mt-1 text-12 leading-tight text-[var(--status-bar-meta)]">
            {t('issueAgent.confirm.envLine', {
              appVersion: pending.env.appVersion,
              platform: pending.env.platform,
              arch: pending.env.arch,
              osVersion: pending.env.osVersion,
              uiLanguage: i18n.language,
            })}
          </p>
          {pending.env.harness && pending.env.modelId && (
            <p className="mt-1 [overflow-wrap:anywhere] text-12 leading-tight text-[var(--status-bar-meta)]">
              {t('issueAgent.confirm.runtimeLine', {
                harness: pending.env.harness,
                modelId: pending.env.modelId,
              })}
            </p>
          )}
        </details>
      </div>

      {/* Action buttons */}
      <div className="flex flex-wrap items-center justify-end gap-3 border-t border-[var(--chat-input-border)] px-5 py-3">
        <p className="min-w-0 flex-[1_1_220px] text-12 leading-relaxed text-[var(--status-bar-meta)]">
          {t('issueAgent.confirm.publicationNotice')}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="secondary" size="md" compact type="button" onClick={handleCancel}>
            <span>{t('issueAgent.confirm.cancel')}</span>
          </Button>
          {editing ? (
            <Button variant="cta" size="md" compact type="button" onClick={finishEditing}>
              {t('issueAgent.confirm.doneEditing')}
            </Button>
          ) : (
            <Button
              variant="cta"
              palette="permission"
              size="md"
              compact
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
            >
              <span>{t('issueAgent.confirm.publicSubmit')}</span>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
