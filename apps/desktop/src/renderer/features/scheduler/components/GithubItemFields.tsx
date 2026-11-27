/**
 * GithubItemFields — GitHub「指定 PR 或 Issue」：一个输入框，填编号、#编号、owner/repo#编号或链接。
 * ---------------------------------------------------------------------------
 * PR 与 Issue 共用编号，由宿主向 GitHub 查询是哪一种（/pull/ 链接直接确定是 PR），识别后下方
 * 条件随类型切换。PR 按状态变化触发，存为 prTrigger；Issue 按事件触发，需要通过 Cindy 连接 GitHub。
 * 规则见 docs/product-rules/schedule-webhook-trigger.md。颜色只用语义 token，Light / Dark 自动适配。
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { GithubAppCard } from '@/features/cc-agent/GithubAppCard';
import { ISSUE_CHANGES, parseGithubItemReference, type GithubItemReference, type IssueChange } from '@cindy/maker-scheduler/github-item';
import { PR_CHANGES, type PrChange } from '@cindy/maker-scheduler/pr-trigger';

const hintClass = 'text-12 leading-relaxed text-[var(--text-secondary)]';
const RESOLVE_DELAY_MS = 400;

type Status =
  | { kind: 'idle' }
  | { kind: 'resolving' }
  | { kind: 'resolved'; item: 'pr' | 'issue'; title: string; closed: boolean }
  | { kind: 'error'; reason: 'invalid' | 'no-repository' | 'not-connected' | 'not-found' | 'unavailable' | 'needs-account' };

export interface GithubItemFieldsProps {
  text: string;
  /** 只填编号时使用的仓库：上次识别的仓库，或「整个仓库」里唯一填写的仓库。 */
  defaultRepository?: string;
  /** 当前保存的类型；未识别时为空。 */
  kind?: 'pr' | 'issue';
  prChange: PrChange;
  issueChange?: IssueChange;
  /** 这台电脑能接收 GitHub App 事件（已登录 Cindy）；Issue 需要它，PR 不需要。 */
  appEventsAvailable: boolean;
  timedCheck: boolean;
  onTextChange(text: string): void;
  onResolved(item: GithubItemReference, kind: 'pr' | 'issue'): void;
  onUnresolved(): void;
  onPrChange(change: PrChange): void;
  onIssueChange(change: IssueChange): void;
}

export function GithubItemFields({
  text,
  defaultRepository,
  kind,
  prChange,
  issueChange,
  appEventsAvailable,
  timedCheck,
  onTextChange,
  onResolved,
  onUnresolved,
  onPrChange,
  onIssueChange,
}: GithubItemFieldsProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const callbacks = useRef({ onResolved, onUnresolved });
  callbacks.current = { onResolved, onUnresolved };
  // A saved item stays saved while GitHub is unreachable; only an edited input re-decides the type.
  const saved = useRef(kind ? text : null);
  const reference = parseGithubItemReference(text, defaultRepository);
  // Re-identify only when the item itself changes: recording the resolved repository must not
  // trigger a second lookup for the same owner/repo#number.
  const referenceKey = reference ? `${reference.repository}#${reference.number}#${reference.kind ?? ''}` : `raw:${text}`;

  useEffect(() => {
    let current = true;
    const unchanged = saved.current !== null && saved.current === text;
    const fail = (reason: Extract<Status, { kind: 'error' }>['reason']) => {
      if (!current) return;
      setStatus({ kind: 'error', reason });
      if (!unchanged) callbacks.current.onUnresolved();
    };
    if (!text.trim()) {
      setStatus({ kind: 'idle' });
      if (!unchanged) callbacks.current.onUnresolved();
      return () => { current = false; };
    }
    if (!reference) {
      fail(/^#?\d+$/.test(text.trim()) ? 'no-repository' : 'invalid');
      return () => { current = false; };
    }
    // A /pull/ link is a PR without asking GitHub; any other edited input clears the previous
    // resolved target immediately so saving during the lookup cannot persist a stale item.
    if (!unchanged) {
      if (reference.kind === 'pr') callbacks.current.onResolved(reference, 'pr');
      else callbacks.current.onUnresolved();
    }
    setStatus({ kind: 'resolving' });
    const timer = setTimeout(() => {
      const resolve = window.electronAPI.gitContext?.resolveGithubItem;
      if (typeof resolve !== 'function') {
        if (reference.kind !== 'pr') fail('unavailable');
        else setStatus({ kind: 'resolved', item: 'pr', title: '', closed: false });
        return;
      }
      void resolve(reference.repository, reference.number).then((result) => {
        if (!current) return;
        if (!result.ok) {
          if (reference.kind === 'pr') setStatus({ kind: 'resolved', item: 'pr', title: '', closed: false });
          else fail(result.reason);
          return;
        }
        if (result.kind === 'issue' && !appEventsAvailable) {
          fail('needs-account');
          return;
        }
        setStatus({ kind: 'resolved', item: result.kind, title: result.title, closed: result.state === 'closed' });
        if (!unchanged) callbacks.current.onResolved(reference, result.kind);
      }, () => fail('unavailable'));
    }, RESOLVE_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
    // referenceKey covers text and the default repository.
  }, [referenceKey, appEventsAvailable]);

  const itemKind = status.kind === 'resolved' ? status.item : kind;
  const summary = status.kind === 'resolving'
    ? t('scheduler.editor.webhook.item.resolving')
    : status.kind === 'resolved' && reference
      ? [t(`scheduler.editor.webhook.item.${status.item}`, { number: reference.number }), status.title,
        status.closed ? t('scheduler.editor.webhook.item.closed') : ''].filter(Boolean).join(' · ')
      : null;
  const error = status.kind === 'error' ? t(`scheduler.editor.webhook.item.errors.${status.reason}`) : undefined;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <FormField label={t('scheduler.editor.webhook.item.label')} hint={summary ?? t('scheduler.editor.webhook.item.hint')} error={error}>
        {(control) => (
          <Input {...control} value={text} onChange={(value) => {
            saved.current = null;
            onTextChange(value);
            const next = parseGithubItemReference(value, defaultRepository);
            if (next?.kind === 'pr') callbacks.current.onResolved(next, 'pr');
            else callbacks.current.onUnresolved();
          }} placeholder={t('scheduler.editor.webhook.item.placeholder')} spellCheck={false} />
        )}
      </FormField>
      {itemKind && reference && (
        <GithubAppCard automation {...(itemKind === 'pr' ? { timedPrCheck: timedCheck } : {})} repositories={[reference.repository]} />
      )}
      {itemKind === 'pr' && (
        <FormField label={t('scheduler.prTrigger.condition')}>
          {(control) => <Select {...control} label={t('scheduler.prTrigger.condition')} value={prChange}
            options={PR_CHANGES.map((value) => ({ value, label: t(`scheduler.prTrigger.${value}`) }))}
            onValueChange={(value) => onPrChange(value as PrChange)} />}
        </FormField>
      )}
      {itemKind === 'issue' && (
        <FormField label={t('scheduler.prTrigger.condition')}>
          {(control) => <Select {...control} label={t('scheduler.prTrigger.condition')} value={issueChange ?? 'any'}
            options={ISSUE_CHANGES.map((value) => ({ value, label: t(`scheduler.editor.webhook.item.issueChange.${value}`) }))}
            onValueChange={(value) => onIssueChange(value as IssueChange)} />}
        </FormField>
      )}
      {itemKind === 'issue' && <p className={hintClass}>{t('scheduler.editor.webhook.item.issueHint')}</p>}
    </div>
  );
}
