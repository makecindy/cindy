/**
 * SshKeySetupDialog — the "Setup SSH key" wizard.
 *
 * Two-step UX:
 *   1. Pick a key (or generate new). Lists everything under ~/.ssh/,
 *      shows which are loaded in the system ssh-agent.
 *   2. Show the picked key's pubkey + the `ssh-copy-id` command the user
 *      should run from their terminal. After running it on their end,
 *      they close the dialog and retry connect.
 *
 * Why we don't run ssh-copy-id from xdt-maker: it needs interactive
 * password input on the remote, which means a PTY round-trip. Out of
 * scope for this iteration — surfacing the command verbatim is the next
 * best thing.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as Dialog from '@radix-ui/react-dialog';
import { X, Copy, Key, KeyRound, Lock, Plus, Server, CheckCircle2, Circle, Unlock, Eye, EyeOff, AlertTriangle } from 'lucide-react';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { Spinner } from '@/components/ui/spinner';
import { mapIpcErrorToI18nKey } from '@/utils/ipcError';

/** ssh-add failure reasons mirrored from the main-side classification. Kept in
 *  sync with `AgentFailureReason` in vite-env.d.ts / ssh-keys.ts. */
type AgentTroubleState = {
  reason: AgentFailureReason;
  /** Short English hint from main — surfaced as the "Details" line. */
  errorHint: string | null;
};

/** Inline host info for the not-yet-saved case (typically the add/edit form
 *  in RemoteSection). When provided, the install command is rendered from
 *  these values via the inline IPC instead of looking the host up by id. */
interface HostInline {
  user: string;
  hostname: string;
  port?: number;
}

interface Props {
  /** Host this wizard targets (saved, looked up via pool). Mutually exclusive
   *  with `hostInline`. When neither is set, the install-command step is hidden. */
  hostId: string | null;
  /** Host info for in-form usage where the host isn't saved to the pool yet. */
  hostInline?: HostInline | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fired when user picks/generates a key — caller can prefill identityFile. */
  onKeyPicked?: (pubkeyPath: string, privateKeyPath: string) => void;
}

export function SshKeySetupDialog({ hostId, hostInline, open, onOpenChange, onKeyPicked }: Props) {
  const { t } = useTranslation();
  const [keys, setKeys] = useState<LocalSshKeyInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [showGenerateForm, setShowGenerateForm] = useState(false);
  const [selectedPub, setSelectedPub] = useState<string | null>(null);
  const [pubkeyContent, setPubkeyContent] = useState<string | null>(null);
  const [installCmd, setInstallCmd] = useState<string | null>(null);
  /** When non-null, the Unlock dialog is open for this key's private path. */
  const [unlockingKeyPath, setUnlockingKeyPath] = useState<string | null>(null);
  /** When non-null, the AgentTrouble dialog is open with this classification. */
  const [agentTrouble, setAgentTrouble] = useState<AgentTroubleState | null>(null);

  const refreshKeys = useCallback(async () => {
    setLoading(true);
    try {
      const res = await window.electronAPI.remoteSsh.listLocalKeys();
      setKeys(res.keys);
    } catch (err) {
      toast.error(t(mapIpcErrorToI18nKey(err, { fallback: 'settings.remote.keys.toast.loadFailed' })));
    } finally {
      setLoading(false);
    }
  }, [t]);

  // Re-fetch keys every time the dialog opens (user may have edited ~/.ssh
  // outside xdt-maker).
  useEffect(() => {
    if (!open) return;
    setSelectedPub(null);
    setPubkeyContent(null);
    setInstallCmd(null);
    setShowGenerateForm(false);
    setUnlockingKeyPath(null);
    setAgentTrouble(null);
    void refreshKeys();
  }, [open, refreshKeys]);

  // When user picks a key, load its pubkey + install command. Command source
  // depends on context:
  //   - hostId set     → look up the saved host via pool (BUILD_INSTALL_CMD)
  //   - hostInline set → render from inline user/hostname/port (form not saved yet)
  //   - neither        → skip install-command step entirely (pure local browse)
  // hostInline is only consulted when hostInline.user AND hostInline.hostname
  // are filled — half-typed forms shouldn't synthesise a broken command.
  useEffect(() => {
    if (!selectedPub) {
      setPubkeyContent(null);
      setInstallCmd(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const inlineReady = hostInline && hostInline.user && hostInline.hostname;
        const cmdPromise = hostId
          ? window.electronAPI.remoteSsh.buildInstallCmd(hostId, selectedPub)
          : inlineReady
            ? window.electronAPI.remoteSsh.buildInstallCmdInline({
                user: hostInline!.user,
                hostname: hostInline!.hostname,
                port: hostInline!.port,
                pubkeyPath: selectedPub,
              })
            : Promise.resolve({ command: '', platform: window.electronAPI.platform });
        const [pubRes, cmdRes] = await Promise.all([
          window.electronAPI.remoteSsh.readPubkey(selectedPub),
          cmdPromise,
        ]);
        if (cancelled) return;
        setPubkeyContent(pubRes.content);
        setInstallCmd(cmdRes.command || null);
      } catch (err) {
        if (cancelled) return;
        toast.error(t(mapIpcErrorToI18nKey(err, { fallback: 'settings.remote.keys.toast.readFailed' })));
      }
    })();
    return () => { cancelled = true; };
  }, [selectedPub, hostId, hostInline, t]);

  const handleGenerate = useCallback(async (params: { name?: string; passphrase?: string }) => {
    setGenerating(true);
    try {
      const res = await window.electronAPI.remoteSsh.generateKey({
        name: params.name,
        passphrase: params.passphrase,
      });
      // Re-list to include the new key, then auto-select it.
      await refreshKeys();
      setSelectedPub(res.result.pubkeyPath);
      setShowGenerateForm(false);
      onKeyPicked?.(res.result.pubkeyPath, res.result.privateKeyPath);
      if (res.agentLoaded) {
        toast.success(t('settings.remote.keys.toast.generatedAndLoaded'));
      } else if (params.passphrase) {
        // Key file landed but ssh-add couldn't load it. Surface the
        // platform-specific recovery panel — key creation itself succeeded
        // so we don't error-toast; the trouble dialog takes over.
        toast.success(t('settings.remote.keys.toast.generatedNotLoadedShort'));
        setAgentTrouble({
          reason: res.agentFailureReason ?? 'other',
          errorHint: res.agentErrorHint,
        });
      } else {
        toast.success(t('settings.remote.keys.toast.generated'));
      }
    } catch (err) {
      toast.error(t(mapIpcErrorToI18nKey(err, { fallback: 'settings.remote.keys.toast.generateFailed' })));
    } finally {
      setGenerating(false);
    }
  }, [t, onKeyPicked, refreshKeys]);

  const handleUnlock = useCallback(async (privateKeyPath: string, passphrase: string) => {
    try {
      const { result } = await window.electronAPI.remoteSsh.addKeyToAgent({
        privateKeyPath,
        passphrase,
      });
      if (!result.success) {
        // Bad passphrase is a retry-in-place case (don't close the unlock
        // dialog, just toast). Anything else needs the rich recovery panel.
        if (result.failureReason === 'bad_passphrase') {
          toast.error(t('settings.remote.keys.toast.unlockBadPassphrase'));
        } else {
          setAgentTrouble({
            reason: result.failureReason ?? 'other',
            errorHint: result.errorHint,
          });
          setUnlockingKeyPath(null);
        }
        return false;
      }
      await refreshKeys();
      toast.success(t('settings.remote.keys.toast.unlocked'));
      return true;
    } catch (err) {
      toast.error(t(mapIpcErrorToI18nKey(err, { fallback: 'settings.remote.keys.toast.unlockFailed' })));
      return false;
    }
  }, [t, refreshKeys]);

  const handlePick = useCallback(
    (key: LocalSshKeyInfo) => {
      setSelectedPub(key.pubkeyPath);
      onKeyPicked?.(key.pubkeyPath, key.privateKeyPath);
    },
    [onKeyPicked],
  );

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-50"
          style={{ backgroundColor: 'var(--overlay-modal, rgba(0,0,0,0.4))' }}
        />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-[640px] max-w-[92vw] max-h-[88vh] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl flex flex-col"
          style={{
            backgroundColor: 'var(--surface-elevated, #ffffff)',
            border: '1px solid var(--border-default, #d4d4d4)',
          }}
        >
          {/* Header */}
          <div
            className="flex items-center justify-between px-5 py-4"
            style={{ borderBottom: '1px solid var(--border-default, #d4d4d4)' }}
          >
            <Dialog.Title
              className="text-15 font-medium"
              style={{ color: 'var(--text-primary, #262626)' }}
            >
              {t('settings.remote.keys.title')}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label={t('settings.remote.keys.close')}
                className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-chip,#f5f5f5)]"
                style={{ color: 'var(--text-secondary, #737373)' }}
              >
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-5 py-4">
            <KeyList
              keys={keys}
              loading={loading}
              selectedPub={selectedPub}
              onPick={handlePick}
              onToggleGenerate={() => setShowGenerateForm((v) => !v)}
              showGenerateForm={showGenerateForm}
              generating={generating}
              onUnlock={(privPath) => setUnlockingKeyPath(privPath)}
            />

            {showGenerateForm && (
              <GenerateForm
                generating={generating}
                onSubmit={handleGenerate}
                onCancel={() => setShowGenerateForm(false)}
              />
            )}

            {selectedPub && pubkeyContent && (
              <InstallGuide
                // InstallGuide only cares whether a target host exists, not
                // which transport (pool vs inline) supplied the command.
                hasTarget={hostId != null || !!(hostInline && hostInline.user && hostInline.hostname)}
                pubkeyContent={pubkeyContent}
                installCmd={installCmd}
              />
            )}
          </div>

          {/* Footer */}
          <div
            className="flex justify-end gap-2 px-5 py-3"
            style={{ borderTop: '1px solid var(--border-default, #d4d4d4)' }}
          >
            <Dialog.Close asChild>
              <button
                type="button"
                className="flex h-8 items-center rounded-full px-[14px] text-13 leading-none font-medium border"
                style={{
                  backgroundColor: 'var(--settings-btn-secondary-bg)',
                  borderColor: 'var(--settings-btn-secondary-border)',
                  color: 'var(--settings-btn-secondary-text)',
                }}
              >
                <span className="relative top-px">{t('settings.remote.keys.done')}</span>
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>

      {/* Nested unlock dialog. Sits at root level so its overlay paints
          on top of the wizard's overlay. */}
      <UnlockDialog
        privateKeyPath={unlockingKeyPath}
        onClose={() => setUnlockingKeyPath(null)}
        onSubmit={async (priv, pass) => {
          const ok = await handleUnlock(priv, pass);
          if (ok) setUnlockingKeyPath(null);
        }}
      />

      {/* Platform-specific recovery panel for ssh-add / ssh-agent failures.
          Shown when key generation succeeded but ssh-add couldn't load it,
          or when Unlock failed for a non-passphrase reason. */}
      <AgentTroubleDialog
        state={agentTrouble}
        onClose={() => setAgentTrouble(null)}
      />
    </Dialog.Root>
  );
}

// ── key list ──────────────────────────────────────────────────────────────

interface KeyListProps {
  keys: LocalSshKeyInfo[];
  loading: boolean;
  selectedPub: string | null;
  onPick: (key: LocalSshKeyInfo) => void;
  onToggleGenerate: () => void;
  showGenerateForm: boolean;
  generating: boolean;
  onUnlock: (privateKeyPath: string) => void;
}

function KeyList({
  keys,
  loading,
  selectedPub,
  onPick,
  onToggleGenerate,
  showGenerateForm,
  generating,
  onUnlock,
}: KeyListProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p
          className="text-13 font-medium"
          style={{ color: 'var(--settings-section-sublabel, #737373)' }}
        >
          {t('settings.remote.keys.pickOrGenerate')}
        </p>
        <button
          type="button"
          onClick={onToggleGenerate}
          disabled={generating}
          className={cn(
            'flex h-7 items-center gap-1 rounded-full px-3 text-12 leading-none font-medium border',
            generating && 'cursor-not-allowed opacity-60',
          )}
          style={{
            backgroundColor: showGenerateForm
              ? 'transparent'
              : 'var(--settings-btn-secondary-bg)',
            borderColor: 'var(--settings-btn-secondary-border)',
            color: 'var(--settings-btn-secondary-text)',
          }}
        >
          {generating ? <Spinner size={12} /> : <Plus size={12} />}
          <span className="relative top-px">{showGenerateForm
            ? t('settings.remote.keys.cancelGenerate')
            : t('settings.remote.keys.generateButton')}</span>
        </button>
      </div>

      <div
        className="flex flex-col rounded-lg"
        style={{ border: '1px solid var(--settings-theme-card-border)' }}
      >
        {loading && (
          <div className="flex items-center gap-2 px-3 py-3 text-12"
               style={{ color: 'var(--settings-integration-subtitle)' }}>
            <Spinner size={14} />
            {t('settings.remote.keys.loading')}
          </div>
        )}
        {!loading && keys.length === 0 && (
          <div className="px-3 py-4 text-center text-12"
               style={{ color: 'var(--settings-integration-subtitle)' }}>
            {t('settings.remote.keys.empty')}
          </div>
        )}
        {keys.map((key, idx) => {
          const isSelected = key.pubkeyPath === selectedPub;
          return (
            <div
              key={key.pubkeyPath}
              className="flex items-start gap-2 pr-3"
              style={idx > 0 ? { borderTop: '1px solid var(--settings-theme-card-border)' } : undefined}
            >
              <button
                type="button"
                onClick={() => onPick(key)}
                className="flex flex-1 items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-[var(--settings-menu-bg-hover)] min-w-0"
              >
                <div
                  className="mt-0.5 flex h-5 w-5 items-center justify-center shrink-0"
                  style={{ color: isSelected
                    ? 'var(--settings-section-title)'
                    : 'var(--settings-integration-subtitle)' }}
                >
                  {isSelected ? <CheckCircle2 size={16} /> : <Circle size={16} />}
                </div>
                <div className="flex flex-1 flex-col gap-0.5 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <KeyRound size={12} style={{ color: 'var(--settings-integration-subtitle)' }} />
                    <span
                      className="text-13 font-medium"
                      style={{ color: 'var(--settings-section-title)' }}
                    >
                      {key.privateKeyPath.split(/[/\\]/).pop()}
                    </span>
                    <span
                      className="text-11 leading-none rounded px-1.5 py-0.5 inline-flex items-center"
                      style={{
                        backgroundColor: 'var(--surface-chip, #f5f5f5)',
                        color: 'var(--settings-integration-subtitle)',
                      }}
                    >
                      {key.type}
                    </span>
                    {key.inAgent ? (
                      <span
                        className="text-11 leading-none rounded px-1.5 py-0.5 inline-flex items-center gap-1"
                        style={{
                          backgroundColor: 'var(--surface-chip, #f5f5f5)',
                          color: 'var(--settings-section-title)',
                        }}
                      >
                        <Key size={9} />
                        <span className="relative top-px">{t('settings.remote.keys.inAgent')}</span>
                      </span>
                    ) : (
                      <span
                        className="text-11 leading-none rounded px-1.5 py-0.5 inline-flex items-center gap-1"
                        style={{
                          backgroundColor: 'var(--surface-chip, #f5f5f5)',
                          color: 'var(--settings-integration-warning, #b45309)',
                        }}
                        title={t('settings.remote.keys.notInAgentTip')}
                      >
                        <Lock size={9} />
                        <span className="relative top-px">{t('settings.remote.keys.notInAgent')}</span>
                      </span>
                    )}
                  </div>
                  <span
                    className="text-11 truncate"
                    style={{ color: 'var(--settings-integration-subtitle)' }}
                  >
                    {key.fingerprintSha256 ?? key.privateKeyPath}
                  </span>
                  {key.comment && (
                    <span
                      className="text-11 truncate"
                      style={{ color: 'var(--settings-integration-subtitle)' }}
                    >
                      {key.comment}
                    </span>
                  )}
                </div>
              </button>
              {!key.inAgent && (
                <button
                  type="button"
                  onClick={() => onUnlock(key.privateKeyPath)}
                  className="self-center flex h-7 items-center gap-1 rounded-full px-3 text-11 leading-none font-medium border shrink-0"
                  title={t('settings.remote.keys.unlockTip')}
                  style={{
                    backgroundColor: 'var(--settings-btn-secondary-bg)',
                    borderColor: 'var(--settings-btn-secondary-border)',
                    color: 'var(--settings-btn-secondary-text)',
                  }}
                >
                  <Unlock size={11} />
                  <span className="relative top-px">{t('settings.remote.keys.unlockButton')}</span>
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── generate form ─────────────────────────────────────────────────────────

interface GenerateFormProps {
  generating: boolean;
  onSubmit: (params: { name?: string; passphrase?: string }) => void;
  onCancel: () => void;
}

function GenerateForm({ generating, onSubmit, onCancel }: GenerateFormProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [encrypt, setEncrypt] = useState(true);
  const [pass, setPass] = useState('');
  const [passConfirm, setPassConfirm] = useState('');
  const [showPass, setShowPass] = useState(false);

  const mismatch = encrypt && pass.length > 0 && passConfirm.length > 0 && pass !== passConfirm;
  // Min 4 chars to avoid trivially weak — same threshold ssh-keygen warns at.
  const tooShort = encrypt && pass.length > 0 && pass.length < 4;
  const canSubmit =
    !generating &&
    (!encrypt || (pass.length >= 4 && pass === passConfirm));

  return (
    <div
      className="mt-3 flex flex-col gap-3 rounded-lg p-3"
      style={{
        backgroundColor: 'var(--surface-chip, #f5f5f5)',
        border: '1px solid var(--settings-theme-card-border)',
      }}
    >
      <p className="text-13 font-medium" style={{ color: 'var(--settings-section-title)' }}>
        {t('settings.remote.keys.generateTitle')}
      </p>

      <label className="flex flex-col gap-1">
        <span className="text-12 font-medium"
              style={{ color: 'var(--settings-section-sublabel)' }}>
          {t('settings.remote.keys.nameLabel')}
        </span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="cindy"
          disabled={generating}
          className="h-8 rounded-md border bg-transparent px-2 text-12 outline-none"
          style={{
            borderColor: 'var(--settings-theme-card-border)',
            color: 'var(--settings-section-title)',
          }}
        />
        <span className="text-11" style={{ color: 'var(--settings-integration-subtitle)' }}>
          {t('settings.remote.keys.nameHint')}
        </span>
      </label>

      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={encrypt}
          onChange={(e) => setEncrypt(e.target.checked)}
          disabled={generating}
          className="mt-0.5 accent-[var(--settings-menu-text-selected)]"
        />
        <span className="flex flex-col gap-0.5">
          <span className="text-12 font-medium"
                style={{ color: 'var(--settings-section-title)' }}>
            {t('settings.remote.keys.encryptLabel')}
          </span>
          <span className="text-11" style={{ color: 'var(--settings-integration-subtitle)' }}>
            {t('settings.remote.keys.encryptHint')}
          </span>
        </span>
      </label>

      {encrypt && (
        <div className="flex flex-col gap-2">
          <PasswordInput
            label={t('settings.remote.keys.passLabel')}
            value={pass}
            onChange={setPass}
            disabled={generating}
            visible={showPass}
            onToggleVisible={() => setShowPass((v) => !v)}
          />
          <PasswordInput
            label={t('settings.remote.keys.passConfirmLabel')}
            value={passConfirm}
            onChange={setPassConfirm}
            disabled={generating}
            visible={showPass}
            onToggleVisible={() => setShowPass((v) => !v)}
            errorText={mismatch ? t('settings.remote.keys.passMismatch') : null}
          />
          {tooShort && (
            <span className="text-11" style={{ color: 'var(--settings-integration-warning, #b45309)' }}>
              {t('settings.remote.keys.passTooShort')}
            </span>
          )}
          <p className="text-11" style={{ color: 'var(--settings-integration-subtitle)' }}>
            {t('settings.remote.keys.passStorageNote')}
          </p>
        </div>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          disabled={generating}
          className="flex h-7 items-center rounded-full px-3 text-12 leading-none font-medium border"
          style={{
            backgroundColor: 'transparent',
            borderColor: 'var(--settings-btn-secondary-border)',
            color: 'var(--settings-btn-secondary-text)',
          }}
        >
          <span className="relative top-px">{t('settings.remote.add.cancel')}</span>
        </button>
        <button
          type="button"
          onClick={() => onSubmit({
            name: name.trim() || undefined,
            passphrase: encrypt ? pass : undefined,
          })}
          disabled={!canSubmit}
          className={cn(
            'flex h-7 items-center gap-1 rounded-full px-3 text-12 leading-none font-medium border',
            !canSubmit && 'cursor-not-allowed opacity-60',
          )}
          style={{
            backgroundColor: 'var(--settings-btn-secondary-bg)',
            borderColor: 'var(--settings-btn-secondary-border)',
            color: 'var(--settings-btn-secondary-text)',
          }}
        >
          {generating ? <Spinner size={11} /> : <Plus size={11} />}
          <span className="relative top-px">{t('settings.remote.keys.generateSubmit')}</span>
        </button>
      </div>
    </div>
  );
}

// ── unlock dialog ─────────────────────────────────────────────────────────

interface UnlockDialogProps {
  /** Non-null = open the dialog targeted at this key. */
  privateKeyPath: string | null;
  onClose: () => void;
  onSubmit: (privateKeyPath: string, passphrase: string) => Promise<void>;
}

function UnlockDialog({ privateKeyPath, onClose, onSubmit }: UnlockDialogProps) {
  const { t } = useTranslation();
  const [pass, setPass] = useState('');
  const [visible, setVisible] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Wipe local state whenever the target key changes (or dialog closes).
  useEffect(() => {
    setPass('');
    setVisible(false);
    setSubmitting(false);
  }, [privateKeyPath]);

  if (!privateKeyPath) return null;

  const fileName = privateKeyPath.split(/[/\\]/).pop();

  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-[60]"
          style={{ backgroundColor: 'var(--overlay-modal, rgba(0,0,0,0.5))' }}
        />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[60] w-[420px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl"
          style={{
            backgroundColor: 'var(--surface-elevated, #ffffff)',
            border: '1px solid var(--border-default, #d4d4d4)',
          }}
        >
          <div className="flex items-center justify-between px-5 py-3"
               style={{ borderBottom: '1px solid var(--border-default, #d4d4d4)' }}>
            <Dialog.Title className="text-14 font-medium"
                          style={{ color: 'var(--text-primary, #262626)' }}>
              {t('settings.remote.keys.unlockTitle', { name: fileName })}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" aria-label={t('settings.remote.keys.close')}
                      className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-chip,#f5f5f5)]"
                      style={{ color: 'var(--text-secondary, #737373)' }}>
                <X size={14} />
              </button>
            </Dialog.Close>
          </div>
          <div className="px-5 py-4 flex flex-col gap-3">
            <p className="text-12" style={{ color: 'var(--settings-integration-subtitle)' }}>
              {t('settings.remote.keys.unlockHint')}
            </p>
            <PasswordInput
              label={t('settings.remote.keys.passLabel')}
              value={pass}
              onChange={setPass}
              disabled={submitting}
              visible={visible}
              onToggleVisible={() => setVisible((v) => !v)}
              autoFocus
              onSubmit={async () => {
                if (!pass || submitting) return;
                setSubmitting(true);
                await onSubmit(privateKeyPath, pass);
                setSubmitting(false);
              }}
            />
            <p className="text-11" style={{ color: 'var(--settings-integration-subtitle)' }}>
              {t('settings.remote.keys.passStorageNote')}
            </p>
          </div>
          <div className="flex justify-end gap-2 px-5 py-3"
               style={{ borderTop: '1px solid var(--border-default, #d4d4d4)' }}>
            <Dialog.Close asChild>
              <button type="button"
                      className="flex h-7 items-center rounded-full px-3 text-12 leading-none font-medium border"
                      style={{
                        backgroundColor: 'transparent',
                        borderColor: 'var(--settings-btn-secondary-border)',
                        color: 'var(--settings-btn-secondary-text)',
                      }}>
                <span className="relative top-px">{t('settings.remote.add.cancel')}</span>
              </button>
            </Dialog.Close>
            <button
              type="button"
              disabled={!pass || submitting}
              onClick={async () => {
                setSubmitting(true);
                await onSubmit(privateKeyPath, pass);
                setSubmitting(false);
              }}
              className={cn(
                'flex h-7 items-center gap-1 rounded-full px-3 text-12 leading-none font-medium border',
                (!pass || submitting) && 'cursor-not-allowed opacity-60',
              )}
              style={{
                backgroundColor: 'var(--settings-btn-secondary-bg)',
                borderColor: 'var(--settings-btn-secondary-border)',
                color: 'var(--settings-btn-secondary-text)',
              }}
            >
              {submitting ? <Spinner size={11} /> : <Unlock size={11} />}
              <span className="relative top-px">{t('settings.remote.keys.unlockSubmit')}</span>
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ── shared password input ─────────────────────────────────────────────────

interface PasswordInputProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  visible: boolean;
  onToggleVisible: () => void;
  errorText?: string | null;
  autoFocus?: boolean;
  onSubmit?: () => void;
}

function PasswordInput({
  label, value, onChange, disabled, visible, onToggleVisible, errorText, autoFocus, onSubmit,
}: PasswordInputProps) {
  const { t } = useTranslation();
  return (
    <label className="flex flex-col gap-1">
      <span className="text-12 font-medium"
            style={{ color: 'var(--settings-section-sublabel)' }}>
        {label}
      </span>
      <div
        className="flex items-center rounded-md border"
        style={{ borderColor: errorText
          ? 'var(--settings-integration-warning, #b45309)'
          : 'var(--settings-theme-card-border)' }}
      >
        <input
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          autoFocus={autoFocus}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && onSubmit) {
              e.preventDefault();
              onSubmit();
            }
          }}
          // 4-char min hint comes from caller; HTML minLength bypasses our
          // own UI guard so we leave it off.
          autoComplete="new-password"
          className="h-8 flex-1 bg-transparent px-2 text-12 outline-none"
          style={{ color: 'var(--settings-section-title)' }}
        />
        <button
          type="button"
          onClick={onToggleVisible}
          disabled={disabled}
          aria-label={
            visible ? t('sessionShare.export.hidePassword') : t('sessionShare.export.showPassword')
          }
          className="flex h-8 w-8 items-center justify-center"
          style={{ color: 'var(--settings-integration-subtitle)' }}
        >
          {visible ? <EyeOff size={12} /> : <Eye size={12} />}
        </button>
      </div>
      {errorText && (
        <span className="text-11" style={{ color: 'var(--settings-integration-warning, #b45309)' }}>
          {errorText}
        </span>
      )}
    </label>
  );
}

// ── install guide ─────────────────────────────────────────────────────────

interface InstallGuideProps {
  /** True when a host context exists (pool host OR inline form host). When
   *  false the install-command block is hidden — only the pubkey is shown. */
  hasTarget: boolean;
  pubkeyContent: string;
  installCmd: string | null;
}

function InstallGuide({ hasTarget, pubkeyContent, installCmd }: InstallGuideProps) {
  const { t } = useTranslation();
  const platform = window.electronAPI.platform;
  const copy = useCallback(async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t('settings.remote.keys.toast.copied', { what }));
    } catch {
      toast.error(t('settings.remote.keys.toast.copyFailed'));
    }
  }, [t]);

  // Pick the right "run this in <terminal>" label per OS. On Windows the
  // command is a PowerShell one-liner delegating to Git Bash, so the
  // copy/paste target is PowerShell — call that out explicitly.
  const runFromLabel = platform === 'win32'
    ? t('settings.remote.keys.runFromPowerShell')
    : t('settings.remote.keys.runFromTerminal');

  return (
    <div className="mt-5 flex flex-col gap-3">
      <p
        className="text-13 font-medium"
        style={{ color: 'var(--settings-section-sublabel, #737373)' }}
      >
        {hasTarget
          ? t('settings.remote.keys.installTitle')
          : t('settings.remote.keys.pubkeyTitle')}
      </p>

      {hasTarget && installCmd && (
        <>
          <CodeBlock
            label={runFromLabel}
            content={installCmd}
            onCopy={() => copy(installCmd, 'command')}
          />
          {platform === 'win32' && (
            <p
              className="text-11"
              style={{ color: 'var(--settings-integration-subtitle)' }}
            >
              {t('settings.remote.keys.win32InstallNote')}
            </p>
          )}
        </>
      )}

      <CodeBlock
        label={
          hasTarget
            ? t('settings.remote.keys.orPasteManually')
            : t('settings.remote.keys.pubkeyContent')
        }
        content={pubkeyContent}
        onCopy={() => copy(pubkeyContent, 'pubkey')}
        secondary={hasTarget}
      />

      {hasTarget && (
        <div className="flex items-start gap-2 rounded-lg p-3 text-12 leading-relaxed"
             style={{
               backgroundColor: 'var(--surface-chip, #f5f5f5)',
               color: 'var(--settings-integration-subtitle)',
             }}>
          <Server size={14} className="mt-0.5 shrink-0" />
          <span>{t('settings.remote.keys.afterInstallHint')}</span>
        </div>
      )}
    </div>
  );
}

// ── code block primitive ──────────────────────────────────────────────────

function CodeBlock({
  label,
  content,
  onCopy,
  secondary,
}: {
  label: string;
  content: string;
  onCopy: () => void;
  secondary?: boolean;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span
          className="text-11 font-medium"
          style={{ color: secondary
            ? 'var(--settings-integration-subtitle)'
            : 'var(--settings-section-title)' }}
        >
          {label}
        </span>
        <button
          type="button"
          onClick={onCopy}
          className="flex h-6 items-center gap-1 rounded-full px-2 text-11 border"
          style={{
            backgroundColor: 'transparent',
            borderColor: 'var(--settings-btn-secondary-border)',
            color: 'var(--settings-btn-secondary-text)',
          }}
        >
          <Copy size={10} aria-hidden="true" />
          {t('settings.remote.keys.copyButton')}
        </button>
      </div>
      <pre
        className="max-h-32 overflow-auto rounded-md border p-2.5 text-11 leading-relaxed whitespace-pre-wrap break-all"
        style={{
          backgroundColor: 'var(--settings-input-bg, #faf9f5)',
          borderColor: 'var(--settings-input-border, #d7d7d4)',
          color: 'var(--settings-input-text, #262626)',
          fontFamily: 'var(--app-font-code, var(--app-font-code-default))',
          margin: 0,
        }}
      >
        {content}
      </pre>
    </div>
  );
}

// ── agent trouble dialog ──────────────────────────────────────────────────
//
// Shown when ssh-add fails (ssh-agent down, ssh-add missing, etc). We
// deliberately don't try to auto-install / auto-start the agent stack:
//   - macOS: ssh-add is bundled — failure usually means GUI lost SSH_AUTH_SOCK.
//   - Linux: install requires sudo, persistent agent start requires touching
//     shell rc files (intrusive).
//   - Windows: enabling the ssh-agent service needs admin (UAC).
//
// Instead we surface platform-specific commands the user can run themselves,
// plus an explicit "fallback" note telling them they can skip the agent flow
// entirely and just use ~/.ssh/config with `IdentityFile` (security is then
// their responsibility — passphrase will be prompted on each connect).

interface AgentTroubleDialogProps {
  state: AgentTroubleState | null;
  onClose: () => void;
}

/** Build the list of (label, command) pairs to show for the current platform.
 *  Each command is a single shell line the user can copy verbatim. */
function buildPlatformCommands(
  platform: 'darwin' | 'linux' | 'win32' | string,
  reason: AgentFailureReason,
  t: (k: string) => string,
): Array<{ label: string; command: string }> {
  if (reason === 'no_such_file') {
    // Nothing platform-specific — the key file path itself is the problem.
    return [];
  }
  if (platform === 'darwin') {
    // macOS ships ssh-add/ssh-agent. Almost always this is SSH_AUTH_SOCK
    // missing from the GUI app's env. `launchctl getenv` confirms agent is
    // up; relaunching from Terminal inherits env.
    return [
      { label: t('settings.remote.keys.agentTrouble.cmd.verifySock'), command: 'launchctl getenv SSH_AUTH_SOCK' },
      { label: t('settings.remote.keys.agentTrouble.cmd.listAgent'), command: 'ssh-add -l' },
    ];
  }
  if (platform === 'win32') {
    // Windows ssh-agent is a service, disabled by default. Enabling needs
    // admin — instruct user to open elevated PowerShell, don't try to
    // launch the elevation ourselves.
    return [
      {
        label: t('settings.remote.keys.agentTrouble.cmd.win32Enable'),
        command: 'Set-Service ssh-agent -StartupType Automatic; Start-Service ssh-agent',
      },
      { label: t('settings.remote.keys.agentTrouble.cmd.listAgent'), command: 'ssh-add -l' },
    ];
  }
  // Linux + everything else.
  return [
    { label: t('settings.remote.keys.agentTrouble.cmd.linuxStart'), command: 'eval "$(ssh-agent -s)"' },
    { label: t('settings.remote.keys.agentTrouble.cmd.listAgent'), command: 'ssh-add -l' },
  ];
}

function AgentTroubleDialog({ state, onClose }: AgentTroubleDialogProps) {
  const { t } = useTranslation();
  const platform = window.electronAPI.platform;

  const commands = useMemo(
    () => state ? buildPlatformCommands(platform, state.reason, t) : [],
    [platform, state, t],
  );

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t('settings.remote.keys.toast.copied', { what: 'command' }));
    } catch {
      toast.error(t('settings.remote.keys.toast.copyFailed'));
    }
  }, [t]);

  if (!state) return null;

  const reasonKey = `settings.remote.keys.agentTrouble.reason.${state.reason}`;

  return (
    <Dialog.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-[60]"
          style={{ backgroundColor: 'var(--overlay-modal, rgba(0,0,0,0.5))' }}
        />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[60] w-[520px] max-w-[92vw] max-h-[88vh] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl flex flex-col"
          style={{
            backgroundColor: 'var(--surface-elevated, #ffffff)',
            border: '1px solid var(--border-default, #d4d4d4)',
          }}
        >
          <div
            className="flex items-center justify-between px-5 py-3"
            style={{ borderBottom: '1px solid var(--border-default, #d4d4d4)' }}
          >
            <Dialog.Title
              className="text-14 font-medium flex items-center gap-2"
              style={{ color: 'var(--text-primary, #262626)' }}
            >
              <AlertTriangle size={14} style={{ color: 'var(--settings-integration-warning, #b45309)' }} />
              {t('settings.remote.keys.agentTrouble.title')}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label={t('settings.remote.keys.close')}
                className="flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-chip,#f5f5f5)]"
                style={{ color: 'var(--text-secondary, #737373)' }}
              >
                <X size={14} />
              </button>
            </Dialog.Close>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-3">
            <p
              className="text-13 font-medium"
              style={{ color: 'var(--settings-section-title)' }}
            >
              {t(reasonKey)}
            </p>

            {state.errorHint && (
              <p
                className="text-11"
                style={{ color: 'var(--settings-integration-subtitle)' }}
              >
                {t('settings.remote.keys.agentTrouble.detailsLabel')}: {state.errorHint}
              </p>
            )}

            {commands.length > 0 && (
              <div className="flex flex-col gap-2">
                <p
                  className="text-12 font-medium"
                  style={{ color: 'var(--settings-section-sublabel)' }}
                >
                  {t('settings.remote.keys.agentTrouble.tryThis')}
                </p>
                {commands.map((c) => (
                  <CodeBlock
                    key={c.command}
                    label={c.label}
                    content={c.command}
                    onCopy={() => copy(c.command)}
                  />
                ))}
              </div>
            )}

            {/* Path problem (no_such_file): no platform commands help — the
                configured key path itself is wrong. Give an explicit fix
                direction (re-select the key / edit the host's Identity file
                path) instead of the generic "use a terminal" fallback below. */}
            {state.reason === 'no_such_file' && (
              <p
                className="text-12 leading-relaxed"
                style={{ color: 'var(--settings-integration-subtitle)' }}
              >
                {t('settings.remote.keys.agentTrouble.noSuchFileFix')}
              </p>
            )}

            {/* Fallback: skip the agent entirely and rely on ~/.ssh/config +
                IdentityFile. Spelled out so the user knows they're explicitly
                opting into "no agent, type passphrase per connect" mode. */}
            <div
              className="rounded-lg p-3 text-12 leading-relaxed flex flex-col gap-1"
              style={{
                backgroundColor: 'var(--surface-chip, #f5f5f5)',
                color: 'var(--settings-integration-subtitle)',
              }}
            >
              <span style={{ color: 'var(--settings-section-title)', fontWeight: 500 }}>
                {t('settings.remote.keys.agentTrouble.fallbackTitle')}
              </span>
              <span>{t('settings.remote.keys.agentTrouble.fallbackBody')}</span>
            </div>
          </div>

          <div
            className="flex justify-end gap-2 px-5 py-3"
            style={{ borderTop: '1px solid var(--border-default, #d4d4d4)' }}
          >
            <Dialog.Close asChild>
              <button
                type="button"
                className="flex h-7 items-center rounded-full px-3 text-12 leading-none font-medium border"
                style={{
                  backgroundColor: 'var(--settings-btn-secondary-bg)',
                  borderColor: 'var(--settings-btn-secondary-border)',
                  color: 'var(--settings-btn-secondary-text)',
                }}
              >
                <span className="relative top-px">{t('settings.remote.keys.agentTrouble.close')}</span>
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
