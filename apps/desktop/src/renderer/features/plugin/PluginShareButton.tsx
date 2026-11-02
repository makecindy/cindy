import { useCallback, useEffect, useRef, useState } from 'react';
import { Share2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ChromeIconButton } from '@/components/title-bar/ChromeIconButton';
import { Spinner } from '@/components/ui/spinner';
import { ShareDialog } from '@/features/share/ShareDialog';
import { useAuth } from '@/contexts/AuthContext';
import { ghostInstallApprovalToken, type InstalledGhost } from '../../../shared/ghost';
import { installedGhostStoragePart } from '../../../shared/pluginIdentity';
import type { ShareOptions } from '../../../shared/share';

type PluginShareButtonProps =
  | { pluginId: string; ghost?: never }
  | { pluginId?: never; ghost: InstalledGhost };

export function PluginShareButton({ pluginId, ghost }: PluginShareButtonProps) {
  const { t } = useTranslation();
  const { isAuthenticated, dataOwnerGeneration, dataOwnerId } = useAuth();
  const instanceId = ghost ? installedGhostStoragePart(ghost) : null;
  const version = ghost?.manifest.version;
  const approvalToken = ghost ? ghostInstallApprovalToken(ghost.approval) : null;
  const ownerKey = `${dataOwnerId ?? ''}:${dataOwnerGeneration}`;
  const sourceKey = `${instanceId ?? pluginId}:${ownerKey}`;
  const [session, setSession] = useState<{ key: string; id: string } | null>(null);
  const [preparing, setPreparing] = useState(false);
  const activeSession = instanceId && (!isAuthenticated || session?.key !== sourceKey) ? null : session;
  const operationId = instanceId ? activeSession?.id ?? null : null;
  const trigger = useRef<HTMLButtonElement | null>(null);
  const restoringFocus = useRef(false);
  useEffect(() => {
    if (instanceId) setSession(null);
  }, [instanceId, ownerKey, isAuthenticated]);
  useEffect(() => () => {
    if (operationId) void window.electronAPI.pluginMarket.releaseLocalShare(operationId).catch(() => undefined);
  }, [operationId]);
  const load = useCallback(
    (options: ShareOptions, uploadConfirmed: boolean) => pluginId !== undefined
      ? window.electronAPI.pluginMarket.prepareShare(pluginId, options)
      : window.electronAPI.pluginMarket.prepareLocalShare(instanceId!, operationId!, options, { version: version!, approvalToken: approvalToken! }, uploadConfirmed),
    [pluginId, instanceId, operationId, version, approvalToken],
  );
  return (
    <>
      <ChromeIconButton
        aria-label={t('sharing.title')}
        tooltip={t(instanceId && !isAuthenticated ? 'sharing.loginRequired' : preparing ? 'sharing.localPreparing' : 'sharing.title')}
        tooltipSide="bottom"
        disabled={preparing || (!!instanceId && !isAuthenticated)}
        aria-busy={preparing || undefined}
        onFocus={(event) => {
          if (restoringFocus.current) event.preventDefault();
        }}
        onClick={(event) => {
          trigger.current = event.currentTarget;
          setSession({ key: sourceKey, id: instanceId ? crypto.randomUUID() : pluginId! });
        }}
      >
        {preparing ? <Spinner size={14} /> : <Share2 size={14} aria-hidden />}
      </ChromeIconButton>
      {activeSession ? (
        <ShareDialog
          key={sourceKey}
          load={load}
          allowAttribution={isAuthenticated}
          onPreparingChange={setPreparing}
          confirmation={ghost ? {
            message: t('sharing.localUploadNotice', { name: ghost.manifest.name, version }),
            label: t('sharing.uploadLocal'),
          } : undefined}
          loadingLabel={instanceId ? t('sharing.localPreparing') : undefined}
          recipientHint={instanceId ? t('sharing.localRecipientHint') : undefined}
          onClose={() => setSession(null)}
          restoreFocus={() => {
            restoringFocus.current = true;
            trigger.current?.focus();
            restoringFocus.current = false;
          }}
        />
      ) : null}
    </>
  );
}
