/**
 * Claude accounts panel (Settings → Providers → Claude Code, under the connection header).
 *
 * Sign in to each account once; switching never signs in again. The master account is always
 * listed first and cannot be removed. Every account shares this computer's Claude Code memory.
 * Design: docs/dev-rules/claude-multi-account.md §5. Colors use semantic tokens only (Light/Dark).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Input } from '@/components/ui/input';
import { toast } from '@/lib/toast';
import {
  CLAUDE_ACCOUNT_LABEL_MAX,
  type ClaudeAccountHealthView,
  type ClaudeAccountView,
  type ClaudeAccountsListView,
} from '../../../shared/claudeAccounts';

const STRIP_STYLE = { borderColor: 'var(--settings-theme-card-border)' } as const;
const BADGE_CLASS = 'rounded-full px-2 py-0.5 text-12 font-medium';
const BADGE_STYLE = { background: 'var(--surface-chip)', color: 'var(--text-secondary)' } as const;

function Badge({ children }: { children: string }) {
  return (
    <span className={BADGE_CLASS} style={BADGE_STYLE}>
      {children}
    </span>
  );
}

export function ClaudeAccountsPanel() {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const [view, setView] = useState<ClaudeAccountsListView | null>(null);
  const [health, setHealth] = useState<Map<string, ClaudeAccountHealthView> | null>(null);
  const [checking, setChecking] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  const loginRef = useRef<string | null>(null);
  const api = window.electronAPI.maker;
  // The list must load once per mount, not once per `t` identity: keep `t` out of the deps.
  const tRef = useRef(t);
  tRef.current = t;

  const reload = useCallback(async () => {
    try {
      setView(await window.electronAPI.maker.claudeAccountsList());
    } catch {
      toast.error(tRef.current('claudeAccounts.settings.error.generic'));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Leaving the page cancels a sign-in that is still waiting for the browser.
  useEffect(
    () => () => {
      if (loginRef.current) void window.electronAPI.maker.claudeAccountsCancelAdd(loginRef.current).catch(() => undefined);
    },
    [],
  );

  const handleSwitch = async (account: ClaudeAccountView) => {
    setBusyId(account.id);
    try {
      const result = await api.claudeAccountsSwitch(account.id);
      if (result.ok) {
        toast.success(t('claudeAccounts.settings.toast.switched', { label: account.label }));
        await reload();
      } else {
        toast.error(t(`claudeAccounts.settings.error.${result.reason}`));
      }
    } catch {
      toast.error(t('claudeAccounts.settings.error.generic'));
    } finally {
      setBusyId(null);
    }
  };

  const handleRemove = async (account: ClaudeAccountView) => {
    const confirmed = await confirm({
      title: t('claudeAccounts.settings.removeConfirm.title', { label: account.label }),
      description: t('claudeAccounts.settings.removeConfirm.description'),
      confirmText: t('claudeAccounts.settings.removeConfirm.confirm'),
      cancelText: t('claudeAccounts.settings.removeConfirm.cancel'),
      confirmVariant: 'destructive',
    });
    if (!confirmed) return;
    setBusyId(account.id);
    try {
      await api.claudeAccountsRemove(account.id);
      toast.success(t('claudeAccounts.settings.toast.removed', { label: account.label }));
      setHealth(null);
      await reload();
    } catch {
      toast.error(t('claudeAccounts.settings.error.generic'));
    } finally {
      setBusyId(null);
    }
  };

  const handleSignIn = async () => {
    const loginKey = crypto.randomUUID();
    loginRef.current = loginKey;
    setSigningIn(true);
    try {
      const result = await api.claudeAccountsAdd(label, loginKey);
      if (loginRef.current !== loginKey) return;
      if (result.ok) {
        toast.success(t('claudeAccounts.settings.toast.added', { label: result.account.label }));
        setAdding(false);
        setLabel('');
        await reload();
      } else if (result.reason !== 'login_cancelled') {
        toast.error(t(`claudeAccounts.settings.error.${result.reason}`));
      }
    } catch {
      if (loginRef.current === loginKey) toast.error(t('claudeAccounts.settings.error.generic'));
    } finally {
      if (loginRef.current === loginKey) {
        loginRef.current = null;
        setSigningIn(false);
      }
    }
  };

  const handleCancelSignIn = () => {
    const loginKey = loginRef.current;
    if (!loginKey) return;
    void api.claudeAccountsCancelAdd(loginKey).catch(() => undefined);
  };

  const handleCheck = async () => {
    setChecking(true);
    try {
      const report = await api.claudeAccountsHealth();
      setHealth(new Map(report.map((h) => [h.accountId, h])));
    } catch {
      toast.error(t('claudeAccounts.settings.error.generic'));
    } finally {
      setChecking(false);
    }
  };

  const healthText = (h: ClaudeAccountHealthView | undefined): string | null => {
    if (!h) return null;
    if (h.checkFailed) return t('claudeAccounts.settings.health.checkFailed');
    if (!h.loggedIn) return t('claudeAccounts.settings.health.loggedOut');
    if (h.profile && h.profile.problems.length > 0) {
      return t('claudeAccounts.settings.health.needsRepair', { names: h.profile.problems.map((p) => p.name).join(', ') });
    }
    if (h.profile?.mode === 'mirror') return t('claudeAccounts.settings.health.mirror');
    return t('claudeAccounts.settings.health.ok');
  };

  const trimmed = label.trim();
  const labelValid = trimmed.length > 0 && trimmed.length <= CLAUDE_ACCOUNT_LABEL_MAX;

  return (
    <div className="shrink-0 border-t px-5 py-4" style={STRIP_STYLE}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-13 font-medium" style={{ color: 'var(--text-primary)' }}>
            {t('claudeAccounts.settings.title')}
          </div>
          <div className="mt-0.5 text-12" style={{ color: 'var(--text-tertiary)' }}>
            {t('claudeAccounts.settings.hint')}
          </div>
        </div>
        <Button size="sm" variant="secondary" loading={checking} onClick={() => void handleCheck()}>
          {checking ? t('claudeAccounts.settings.checking') : t('claudeAccounts.settings.check')}
        </Button>
      </div>

      <ul className="mt-3 divide-y" style={STRIP_STYLE} role="list">
        {view?.accounts.map((account) => {
          const status = healthText(health?.get(account.id));
          const detail = [account.email, account.subscriptionType].filter(Boolean).join(' · ');
          return (
            <li key={account.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-13 font-medium" style={{ color: 'var(--text-primary)' }}>
                    {account.label}
                  </span>
                  {account.kind === 'master' && <Badge>{t('claudeAccounts.settings.master')}</Badge>}
                  {account.active && <Badge>{t('claudeAccounts.settings.active')}</Badge>}
                </div>
                {detail && (
                  <div className="truncate text-12" style={{ color: 'var(--text-tertiary)' }}>
                    {detail}
                  </div>
                )}
                {status && (
                  <div className="text-12" style={{ color: 'var(--text-secondary)' }}>
                    {status}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {!account.active && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busyId !== null || signingIn}
                    loading={busyId === account.id}
                    onClick={() => void handleSwitch(account)}
                  >
                    {t('claudeAccounts.settings.switch')}
                  </Button>
                )}
                {account.kind === 'extra' && (
                  <Button
                    size="sm"
                    variant="secondary"
                    tone="danger"
                    disabled={busyId !== null || signingIn}
                    onClick={() => void handleRemove(account)}
                  >
                    {t('claudeAccounts.settings.remove')}
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {adding ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="min-w-[200px] flex-1">
            <Input
              aria-label={t('claudeAccounts.settings.nameLabel')}
              placeholder={t('claudeAccounts.settings.namePlaceholder')}
              value={label}
              maxLength={CLAUDE_ACCOUNT_LABEL_MAX}
              disabled={signingIn}
              autoFocus
              onChange={setLabel}
            />
          </div>
          {signingIn ? (
            <>
              <span className="text-12" style={{ color: 'var(--text-tertiary)' }}>
                {t('claudeAccounts.settings.signingIn')}
              </span>
              <Button size="sm" variant="secondary" onClick={handleCancelSignIn}>
                {t('claudeAccounts.settings.cancel')}
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="primary" disabled={!labelValid} onClick={() => void handleSignIn()}>
                {t('claudeAccounts.settings.signIn')}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setAdding(false)}>
                {t('claudeAccounts.settings.cancel')}
              </Button>
            </>
          )}
        </div>
      ) : (
        <Button className="mt-3" size="sm" variant="secondary" onClick={() => setAdding(true)}>
          {t('claudeAccounts.settings.add')}
        </Button>
      )}

      <p className="mt-3 text-12" style={{ color: 'var(--text-tertiary)' }}>
        {t('claudeAccounts.settings.ownership')}
      </p>
    </div>
  );
}
