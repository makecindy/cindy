/**
 * Task menu → "Continue on another Claude account…".
 *
 * Opens the shared three-way confirm dialog with an account picker and both pickup options:
 * - Resume here: switch the account; the same session continues there on the next message
 *   (main rebuilds the CLI and resumes the same session id);
 * - New session from brief: switch the account, then open a new session draft in the same
 *   folder, prefilled with the zero-token Mission Brief built from the local transcript.
 * Nothing is sent until the user acts. Only local Claude Code sessions qualify.
 * Design: docs/dev-rules/claude-multi-account.md §4.6.
 */
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { NEW_MAKER_DRAFT_KEY } from '@/features/cc-agent/newMakerDraftKeys';
import { plainTextToTiptapDoc, saveDraft } from '@/lib/composerDraftStore';
import { toast } from '@/lib/toast';
import { patchDraft, resetDraftWorkspaceTargets, switchVendor } from '@/state/newMakerDraft';
import type { ClaudeAccountView, ClaudeHandoffPreview } from '../../../shared/claudeAccounts';

export interface ClaudeHandoffSession {
  id: string;
  agentKind: string;
  workingDir: string | null;
  remoteHostId?: string | null;
  agentDeviceId?: string | null;
  deviceLinkDeviceId?: string | null;
}

export function isClaudeHandoffEligible(session: ClaudeHandoffSession): boolean {
  return session.agentKind === 'cc' && !session.remoteHostId && !session.agentDeviceId && !session.deviceLinkDeviceId;
}

type AvailablePreview = Extract<ClaudeHandoffPreview, { available: true }>;

function OptionCard({ title, detail, recommended }: { title: string; detail: string; recommended: string | null }) {
  return (
    <div className="rounded-xl border px-3 py-2.5" style={{ borderColor: 'var(--border-default)' }}>
      <div className="flex items-center gap-2">
        <span className="text-13 font-medium" style={{ color: 'var(--text-primary)' }}>
          {title}
        </span>
        {recommended && (
          <span
            className="rounded-full px-2 py-0.5 text-12 font-medium"
            style={{ background: 'var(--surface-chip)', color: 'var(--text-secondary)' }}
          >
            {recommended}
          </span>
        )}
      </div>
      <div className="mt-0.5 text-12" style={{ color: 'var(--text-tertiary)' }}>
        {detail}
      </div>
    </div>
  );
}

function HandoffContent({
  accounts,
  preview,
  onSelect,
}: {
  accounts: ClaudeAccountView[];
  preview: AvailablePreview;
  onSelect: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [selected, setSelected] = useState(accounts[0]!.id);
  const recommended = t('claudeAccounts.handoff.recommended');
  // Follow the app's UI language, not the OS locale (e.g. en-IN would print 3,25,502).
  const formatTokens = (n: number) => new Intl.NumberFormat(i18n.language || 'en').format(n);
  return (
    <div className="mt-3 flex flex-col gap-3">
      <fieldset>
        <legend className="mb-1.5 text-12 font-medium" style={{ color: 'var(--text-secondary)' }}>
          {t('claudeAccounts.handoff.account')}
        </legend>
        <div className="flex flex-col gap-1">
          {accounts.map((account) => (
            <label key={account.id} className="flex cursor-pointer items-center gap-2 text-13" style={{ color: 'var(--text-primary)' }}>
              <input
                type="radio"
                name="claude-handoff-account"
                value={account.id}
                checked={selected === account.id}
                onChange={() => {
                  setSelected(account.id);
                  onSelect(account.id);
                }}
              />
              <span>{account.label}</span>
              {account.email && (
                <span className="text-12" style={{ color: 'var(--text-tertiary)' }}>
                  {account.email}
                </span>
              )}
            </label>
          ))}
        </div>
      </fieldset>
      <OptionCard
        title={t('claudeAccounts.handoff.resumeTitle')}
        detail={
          preview.resumeTokens === null
            ? t('claudeAccounts.handoff.resumeDetailUnknown')
            : t('claudeAccounts.handoff.resumeDetail', { tokens: formatTokens(preview.resumeTokens) })
        }
        recommended={preview.recommended === 'resume' ? recommended : null}
      />
      <OptionCard
        title={t('claudeAccounts.handoff.briefTitle')}
        detail={t('claudeAccounts.handoff.briefDetail', { tokens: formatTokens(preview.briefTokens) })}
        recommended={preview.recommended === 'brief' ? recommended : null}
      />
      {preview.interruptedTool && (
        <div className="text-12" style={{ color: 'var(--text-tertiary)' }}>
          {t('claudeAccounts.handoff.interrupted', { tool: preview.interruptedTool })}
        </div>
      )}
    </div>
  );
}

export function ClaudeHandoffMenuItem({ session, className }: { session: ClaudeHandoffSession; className?: string }) {
  const { t } = useTranslation();
  const { confirmThree } = useConfirmDialog();
  const navigate = useNavigate();
  const targetRef = useRef<string | null>(null);
  if (!isClaudeHandoffEligible(session)) return null;

  const start = async () => {
    const api = window.electronAPI.maker;
    let list: Awaited<ReturnType<typeof api.claudeAccountsList>>;
    let preview: ClaudeHandoffPreview;
    try {
      [list, preview] = await Promise.all([api.claudeAccountsList(), api.claudeAccountsHandoffPreview(session.id)]);
    } catch {
      toast.error(t('claudeAccounts.settings.error.generic'));
      return;
    }
    if (!preview.available) {
      toast.error(t(`claudeAccounts.handoff.unavailable.${preview.reason}`));
      return;
    }
    const others = list.accounts.filter((a) => !a.active);
    if (others.length === 0) {
      toast.error(t('claudeAccounts.handoff.noOtherAccounts'));
      return;
    }
    targetRef.current = others[0]!.id;
    const choice = await confirmThree({
      title: t('claudeAccounts.handoff.title'),
      description: t('claudeAccounts.handoff.description'),
      content: (
        <HandoffContent
          accounts={others}
          preview={preview}
          onSelect={(id) => {
            targetRef.current = id;
          }}
        />
      ),
      maxWidth: 480,
      confirmText: t('claudeAccounts.handoff.resume'),
      tertiaryText: t('claudeAccounts.handoff.brief'),
      cancelText: t('claudeAccounts.handoff.cancel'),
    });
    if (choice === 'cancel') return;
    const target = others.find((a) => a.id === targetRef.current) ?? others[0]!;
    try {
      const switched = await api.claudeAccountsSwitch(target.id);
      if (!switched.ok) {
        toast.error(t(`claudeAccounts.settings.error.${switched.reason}`));
        return;
      }
    } catch {
      toast.error(t('claudeAccounts.settings.error.generic'));
      return;
    }
    if (choice === 'confirm') {
      toast.success(t('claudeAccounts.handoff.toast.resumed', { label: target.label }));
      return;
    }
    // New session from the brief: a clean draft (no inherited extra dirs), same folder, Claude Code.
    saveDraft(NEW_MAKER_DRAFT_KEY, { text: plainTextToTiptapDoc(preview.brief), attachments: [] });
    resetDraftWorkspaceTargets();
    switchVendor('cc');
    if (session.workingDir) patchDraft({ workingDir: session.workingDir });
    navigate('/cc-agent/new');
    toast.success(t('claudeAccounts.handoff.toast.briefReady', { label: target.label }));
  };

  return (
    <DropdownMenuItem onSelect={() => void start()} className={className}>
      {t('claudeAccounts.handoff.menuItem')}
    </DropdownMenuItem>
  );
}
