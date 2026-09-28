import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PiKernelInstallRequest, PiKernelState } from '../../../shared/piKernel';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { HARNESS_MENU_ITEM_CLASS, HarnessMenuFootnote, HarnessVersionMenuItem, HarnessVersionMenuRow } from './HarnessVersionMenuRow';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';

function newer(candidate: string | undefined, current: string | null): boolean {
  if (!candidate || !current) return false;
  const a = candidate.split('.').map(Number);
  const b = current.split(/[+-]/, 1)[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  // Upstream candidates are stable releases; the same core version supersedes a prerelease.
  return current.split('+', 1)[0].includes('-');
}

/** One harness, one row. Sources and recovery only appear in the action menu. */
export function PiKernelVersionRow() {
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<PiKernelState | null>(null);
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [target, setTarget] = useState<PiKernelInstallRequest | null>(null);
  const mounted = useRef(false);
  const generation = useRef(0);
  const checkPending = useRef(false);
  const k = (key: string) => t(`settings.about.piKernel.${key}`);
  const refresh = useCallback(async (check = false) => {
    if (checkPending.current) return;
    const id = ++generation.current;
    if (check) { checkPending.current = true; setChecking(true); }
    try {
      const next = await window.electronAPI.maker.piKernel.getState(check);
      if (mounted.current && id === generation.current) { setState(next); setFailed(false); }
    } catch {
      if (mounted.current && id === generation.current) setFailed(true);
    } finally {
      if (check) { checkPending.current = false; if (mounted.current) setChecking(false); }
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh().then(() => { if (mounted.current) void refresh(true); });
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    // Also observes updates initiated through a managed Pi command.
    const interval = window.setInterval(() => { void refresh(); }, 3_000);
    return () => { mounted.current = false; generation.current++; window.clearInterval(interval); window.removeEventListener('focus', onFocus); };
  }, [refresh]);

  const install = async () => {
    if (!target || installing || state?.operation) return;
    const request = target;
    setTarget(null);
    setInstalling(true);
    ++generation.current;
    try {
      const next = await window.electronAPI.maker.piKernel.install(request);
      if (mounted.current) { ++generation.current; setState(next); setFailed(false); }
      toast.success(t(`settings.about.piKernel.${next.restartRequired ? 'restartRequired' : 'installed'}`, { version: request.version }));
    } catch (error) {
      const detail = extractIpcError(error);
      const reason = detail?.message.replace(/^\[[A-Z_]+\]\s*/, '');
      toast.error(k(reason === 'version-changed' ? 'versionChanged' : reason === 'busy' ? 'busy' : 'installFailed'));
      if (mounted.current) void refresh(true);
    } finally {
      if (mounted.current) { setInstalling(false); void refresh(); }
    }
  };
  const busy = installing || !!state?.operation;
  const upstream = state?.upstream.release;
  const official = state?.official.release;
  const checkError = failed || state?.upstream.error || state?.official.error;
  const update = newer(upstream?.version, state?.currentVersion ?? null);
  const status = busy ? k(state?.operation?.phase ?? 'lookup') : checking ? k('checking') : checkError ? k('checkFailed') : update ? k('available') : '';

  return <>
    <HarnessVersionMenuRow label={t('settings.about.piVersionLabel')} manageLabel={k('manage')} testId="pi-kernel-row"
      version={state?.currentVersion ?? t(`settings.about.version.${state ? 'notReady' : failed ? 'unknown' : 'loading'}`)}
      status={status} pending={busy || checking}>
      <HarnessVersionMenuItem label={k('update')} version={upstream?.version} disabled={busy || !upstream || (!!state?.currentVersion && !newer(upstream.version, state.currentVersion))} onSelect={() => upstream && setTarget({ source: 'upstream', version: upstream.version })} />
      <HarnessVersionMenuItem label={k('restore')} version={official?.version} disabled={busy || !official} onSelect={() => official && setTarget({ source: 'official', version: official.version })} />
      <DropdownMenuSeparator />
      <DropdownMenuItem className={HARNESS_MENU_ITEM_CLASS} disabled={busy || checking} onSelect={() => void refresh(true)}>{checking ? k('checking') : k('check')}</DropdownMenuItem>
      <DropdownMenuItem className={HARNESS_MENU_ITEM_CLASS} disabled={!upstream?.releaseUrl} onSelect={() => {
        if (upstream?.releaseUrl) void window.electronAPI.openExternal(upstream.releaseUrl).then(result => { if (!result.success) toast.error(k('openFailed')); }).catch(() => toast.error(k('openFailed')));
      }}>{k('releaseNotes')}</DropdownMenuItem>
      {state?.upstream.checkedAt && <HarnessMenuFootnote>{t('settings.about.piKernel.checkedAt', { time: new Date(state.upstream.checkedAt).toLocaleString(i18n.language) })}</HarnessMenuFootnote>}
    </HarnessVersionMenuRow>
    <ConfirmDialog open={!!target} onOpenChange={open => { if (!open) setTarget(null); }} presentation="standard" cancelFirst
      title={t(`settings.about.piKernel.${target?.source === 'official' ? 'restoreTitle' : 'updateTitle'}`, { version: target?.version })}
      description={k(target?.source === 'official' ? 'restoreDescription' : 'updateDescription')}
      confirmText={k(target?.source === 'official' ? 'restoreConfirm' : 'updateConfirm')}
      onConfirm={() => void install()} />
  </>;
}
