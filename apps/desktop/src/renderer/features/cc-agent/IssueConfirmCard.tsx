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
 *   Ctrl/Cmd+Enter → 提交
 *   Esc            → 取消
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import type { PendingIssueConfirm } from '@/lib/makerChatStore';
import { shouldLabelIssueRegion } from '../../../shared/issueRegionCode';

interface IssueConfirmCardProps {
  pending: PendingIssueConfirm;
  onRespond: (
    result:
      | { confirmed: true; title: string; body: string; type: 'bug' | 'feature'; uiLanguage: string }
      | { confirmed: false },
  ) => void;
}

const TITLE_MAX = 200;
// 4500 有意大于工具 schema 的 max(4000):schema 约束的是 agent 生成的草稿,
// 用户在确认卡上可以再扩写一些;最终 description(body + env 块)由
// githubIssueSubmitService clamp 到 server 上限 SERVER_DESC_MAX(5000)。
const BODY_MAX = 4500;

export function IssueConfirmCard({ pending, onRespond }: IssueConfirmCardProps) {
  const { t, i18n } = useTranslation();
  const [title, setTitle] = useState(pending.draft.title);
  const [body, setBody] = useState(pending.draft.body);
  const [type, setType] = useState<'bug' | 'feature'>(pending.draft.type);

  // 同一会话内连续两次提交(新 requestId)时重置编辑态。
  useEffect(() => {
    setTitle(pending.draft.title);
    setBody(pending.draft.body);
    setType(pending.draft.type);
  }, [pending.requestId, pending.draft.title, pending.draft.body, pending.draft.type]);

  const canSubmit = title.trim().length > 0 && body.trim().length > 0;

  // 构建区域代号,与登录页区域徽标同一套不对称命名(DESIGN.md §16.3):cn → CN、
  // dev → Dev、global 不标。「哪些区域要标」只有 ISSUE_REGION_CODE 一个事实源 ——
  // main 侧 issue 正文用的是同一个常量,卡片承诺展示的就是最终写进 issue 的内容,
  // 两侧各写一份判断迟早漂移。region 缺失(IPC payload 异常)时按不标处理,不猜。
  // 展示文案仍走 i18n(同 login.regionPill.*,便于日后改判为可译文案),所以这里是
  // 「常量决定标不标 + i18n 提供文案」;两者逐区域逐语言的一致性由
  // __tests__/issueRegionCode.consistency.test.ts 断言。key 写成字面量分支而非
  // 动态拼接,保证 pnpm check:i18n 的静态提取能看到全部 key。
  const regionCode = !shouldLabelIssueRegion(pending.env.region)
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
      uiLanguage: i18n.language,
    });
  }, [canSubmit, onRespond, title, body, type, i18n.language]);

  const handleCancel = useCallback(() => {
    onRespond({ confirmed: false });
  }, [onRespond]);

  // ── Keyboard shortcuts(textarea 内 Enter 正常换行,只有带修饰键才提交)──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleSubmit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleCancel();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSubmit, handleCancel]);

  const typeButton = (value: 'bug' | 'feature', label: string) => (
    <button
      type="button"
      onClick={() => setType(value)}
      className={cn(
        'rounded-[6px] border px-2.5 py-[3px] text-12 font-medium transition-colors',
        type === value
          ? 'border-[var(--chat-input-border)] bg-[var(--perm-allow-btn-bg)] text-[var(--perm-allow-btn-text)]'
          : 'border-[var(--chat-input-border)] bg-transparent text-[var(--status-bar-meta)] hover:bg-[var(--perm-code-bg)]',
      )}
    >
      {label}
    </button>
  );

  return (
    <div
      className={cn(
        'w-full max-w-[914px] rounded-[12px] border p-4',
        'border-[var(--chat-input-border)] bg-[var(--chat-input-bg)]',
      )}
    >
      {/* Title row: heading + type toggle */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-15 font-semibold leading-tight text-[var(--chat-input-text)]">
          {t('issueAgent.confirm.title')}
        </p>
        <div className="flex items-center gap-1.5">
          {typeButton('bug', t('issueAgent.confirm.typeBug'))}
          {typeButton('feature', t('issueAgent.confirm.typeFeature'))}
        </div>
      </div>

      {/* Issue title input */}
      <label className="mt-3 block text-12 font-medium text-[var(--status-bar-meta)]">
        {t('issueAgent.confirm.titleLabel')}
      </label>
      <input
        type="text"
        value={title}
        maxLength={TITLE_MAX}
        onChange={(e) => setTitle(e.target.value)}
        className={cn(
          'mt-1 w-full rounded-[8px] border px-3 py-2',
          'border-[var(--perm-code-border)] bg-[var(--perm-code-bg)]',
          'text-13 leading-tight text-[var(--chat-input-text)]',
          'focus:outline-none focus:ring-1 focus:ring-[var(--focus-ring)]',
        )}
      />

      {/* Issue body textarea */}
      <label className="mt-3 block text-12 font-medium text-[var(--status-bar-meta)]">
        {t('issueAgent.confirm.bodyLabel')}
      </label>
      <textarea
        value={body}
        maxLength={BODY_MAX}
        onChange={(e) => setBody(e.target.value)}
        rows={8}
        className={cn(
          'mt-1 w-full resize-y rounded-[8px] border px-3 py-2',
          'border-[var(--perm-code-border)] bg-[var(--perm-code-bg)]',
          'font-mono text-13 leading-relaxed text-[var(--chat-input-text)]',
          'focus:outline-none focus:ring-1 focus:ring-[var(--focus-ring)]',
        )}
      />

      {/* 只读环境信息(main 侧自动附进 issue body) */}
      <p className="mt-2 text-12 leading-tight text-[var(--status-bar-meta)]">
        {pending.submissionIdentity.kind === 'github-user'
          ? t('issueAgent.confirm.identityGithubUser', {
              login: pending.submissionIdentity.login,
            })
          : t('issueAgent.confirm.identityPlatform', {
              login: pending.submissionIdentity.login,
            })}
      </p>
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
          uiLanguage: i18n.language,
        })}
      </p>

      {/* Action buttons */}
      <div className="mt-4 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={handleCancel}
          className={cn(
            'flex items-center gap-2 rounded-[8px] border px-3 py-[7px]',
            'border-[var(--chat-input-border)] bg-transparent',
            'text-13 font-medium text-[var(--chat-input-text)]',
            'transition-colors hover:bg-[var(--perm-code-bg)]',
          )}
        >
          <span>{t('issueAgent.confirm.cancel')}</span>
          <kbd className="rounded-[4px] border border-[var(--chat-input-border)] bg-[var(--perm-code-bg)] px-1.5 py-[1px] text-[11px] font-normal text-[var(--status-bar-meta)]">
            Esc
          </kbd>
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className={cn(
            'flex items-center gap-2 rounded-[8px] border px-3 py-[7px]',
            'border-[var(--chat-input-border)]',
            'bg-[var(--perm-allow-btn-bg)] text-[var(--perm-allow-btn-text)]',
            'text-13 font-medium',
            'transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50',
          )}
        >
          <span>{t('issueAgent.confirm.submit')}</span>
          <kbd className="rounded-[4px] border border-[var(--perm-allow-kbd-border)] bg-[var(--perm-allow-kbd-bg)] px-1.5 py-[1px] text-[11px] font-normal text-[var(--perm-allow-btn-text)] opacity-70">
            {window.electronAPI?.platform === 'darwin' ? '⌘↵' : 'Ctrl+Enter'}
          </kbd>
        </button>
      </div>
    </div>
  );
}
