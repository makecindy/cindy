/**
 * GitlabItemFields — GitLab「指定 MR 或 Issue」：一个输入框。GitLab 的 MR（!N）和 Issue（#N）编号各自独立，
 * 所以靠链接或前缀区分，不需要向服务器查询。MR 按状态变化触发（存为 prTrigger，靠定时检查读取状态）；
 * Issue 按 GitLab Webhook 事件触发（地址型发送方加项目与编号筛选），或通过 GitLab 插件轮询（插件来源加条件）。
 * 规则见 docs/product-rules/schedule-webhook-trigger.md。颜色只用语义 token，Light / Dark 自动适配。
 */
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  GITLAB_ISSUE_CHANGES,
  GITLAB_PLUGIN_ISSUE_CHANGES,
  parseGitlabItemReference,
  type GitlabIssueChange,
  type GitlabPluginIssueChange,
  type GitlabItemReference,
} from '@cindy/maker-scheduler/github-item';
import { PR_CHANGES, type PrChange } from '@cindy/maker-scheduler/pr-trigger';

const hintClass = 'text-12 leading-relaxed text-[var(--text-secondary)]';

type Problem = 'invalid' | 'ambiguous' | 'needs-link' | 'needs-account';

export function gitlabItemProblem(
  text: string,
  reference: GitlabItemReference | null,
  addressAvailable: boolean,
  mrCanOmitHost = false,
): Problem | null {
  if (!text.trim()) return null;
  if (!reference) return /^\d+$/.test(text.trim()) ? 'ambiguous' : 'invalid';
  // Timed MR status reads talk directly to the instance, so a full link with host is required unless using the GitLab plugin.
  if (reference.kind === 'mr' && !mrCanOmitHost && !reference.host) return 'needs-link';
  // An issue arrives through this computer's GitLab Webhook address or the GitLab plugin.
  if (reference.kind === 'issue' && !addressAvailable) return 'needs-account';
  return null;
}

export interface GitlabItemFieldsProps {
  text: string;
  /** 上次识别的实例和项目：只填 !N / #N 时使用。 */
  known?: { host?: string; project: string };
  prChange: PrChange;
  issueChange?: GitlabIssueChange;
  /** Issue 能收到事件：这台电脑能接收 Webhook 地址（已登录 Cindy），或装了 GitLab 插件；MR 不需要。 */
  addressAvailable: boolean;
  /** 当前通过 GitLab 插件接收（MR 或 Issue）。 */
  viaPlugin?: boolean;
  /** MR 是否允许省略域名（装了 GitLab 插件且未强制选「定时读取状态」时可只填 group/project!N）。 */
  mrCanOmitHost?: boolean;
  pluginIssueChange?: GitlabPluginIssueChange;
  onPluginIssueChange?(change: GitlabPluginIssueChange): void;
  /** 表单里已经按当前输入保存了 MR / Issue（打开已有任务时）；为 false 时挂载后立即应用一次。 */
  applied: boolean;
  onTextChange(text: string): void;
  onResolved(item: GitlabItemReference): void;
  onUnresolved(): void;
  onPrChange(change: PrChange): void;
  onIssueChange(change: GitlabIssueChange): void;
}

export function GitlabItemFields({
  text,
  known,
  prChange,
  issueChange,
  addressAvailable,
  viaPlugin = false,
  mrCanOmitHost = viaPlugin,
  pluginIssueChange,
  onPluginIssueChange,
  applied,
  onTextChange,
  onResolved,
  onUnresolved,
  onPrChange,
  onIssueChange,
}: GitlabItemFieldsProps) {
  const { t } = useTranslation();
  const reference = parseGitlabItemReference(text, known);
  const problem = gitlabItemProblem(text, reference, addressAvailable, mrCanOmitHost);
  const usable = reference && !problem ? reference : null;
  const key = usable
    ? `${usable.host ?? ''}/${usable.project}${usable.kind === 'mr' ? '!' : '#'}${usable.number}:${mrCanOmitHost ? 'p' : 'l'}`
    : `raw:${text}:${mrCanOmitHost ? 'p' : 'l'}`;
  const callbacks = useRef({ onResolved, onUnresolved });
  callbacks.current = { onResolved, onUnresolved };
  const first = useRef(true);

  useEffect(() => {
    // A saved item is already applied when the form opens; a fresh scope applies the current text once.
    if (first.current) {
      first.current = false;
      if (applied) return;
    }
    if (usable) callbacks.current.onResolved(usable);
    else callbacks.current.onUnresolved();
    // key covers the parsed item and the raw text.
  }, [key]);

  const summary = usable
    ? `${t(`scheduler.editor.webhook.item.${usable.kind === 'mr' ? 'mr' : 'issue'}`, { number: usable.number })} · ${usable.project}`
    : null;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <FormField
        label={t('scheduler.editor.webhook.gitlabItem.label')}
        hint={summary ?? t('scheduler.editor.webhook.gitlabItem.hint')}
        error={problem ? t(`scheduler.editor.webhook.gitlabItem.errors.${problem}`) : undefined}
      >
        {(control) => (
          <Input {...control} value={text} onChange={onTextChange}
            placeholder={t('scheduler.editor.webhook.gitlabItem.placeholder')} spellCheck={false} />
        )}
      </FormField>
      {usable?.kind === 'mr' && (
        <>
          <FormField label={t('scheduler.prTrigger.condition')}>
            {(control) => <Select {...control} label={t('scheduler.prTrigger.condition')} value={prChange}
              options={PR_CHANGES.map((value) => ({ value, label: t(`scheduler.editor.webhook.gitlabItem.mrChange.${value}`) }))}
              onValueChange={(value) => onPrChange(value as PrChange)} />}
          </FormField>
          <p className={hintClass}>{t(viaPlugin ? 'scheduler.editor.webhook.gitlabItem.mrPluginHint' : 'scheduler.editor.webhook.gitlabItem.mrHint')}</p>
        </>
      )}
      {usable?.kind === 'issue' && viaPlugin && (
        <>
          <FormField label={t('scheduler.prTrigger.condition')}>
            {(control) => <Select {...control} label={t('scheduler.prTrigger.condition')} value={pluginIssueChange ?? 'any'}
              options={GITLAB_PLUGIN_ISSUE_CHANGES.map((value) => ({ value, label: t(`scheduler.editor.webhook.gitlabItem.issueChange.${value}`) }))}
              onValueChange={(value) => onPluginIssueChange?.(value as GitlabPluginIssueChange)} />}
          </FormField>
          <p className={hintClass}>{t('scheduler.editor.webhook.gitlabItem.issuePluginHint')}</p>
        </>
      )}
      {usable?.kind === 'issue' && !viaPlugin && (
        <>
          <FormField label={t('scheduler.prTrigger.condition')}>
            {(control) => <Select {...control} label={t('scheduler.prTrigger.condition')} value={issueChange ?? 'any'}
              options={GITLAB_ISSUE_CHANGES.map((value) => ({ value, label: t(`scheduler.editor.webhook.gitlabItem.issueChange.${value}`) }))}
              onValueChange={(value) => onIssueChange(value as GitlabIssueChange)} />}
          </FormField>
          <p className={hintClass}>{t('scheduler.editor.webhook.gitlabItem.issueHint')}</p>
        </>
      )}
    </div>
  );
}
