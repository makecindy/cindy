import { useEffect, useMemo, useState } from 'react';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { AlertTriangle, Puzzle, RefreshCw, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type {
  PiPackageMutationAction,
  PiPackageResourceKind,
  PiPackageResourceView,
  PiPackageRuntimeRequirement,
  PiPackageView,
} from '@/../shared/piPackages';
import {
  shouldShowPiPackagePostMutationNotice,
} from '@/../shared/piPackages';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { SettingsTextInput } from './SettingsTextInput';

const CARD_CLASS = cn(
  'flex flex-col overflow-hidden rounded-xl',
  'bg-[var(--settings-theme-card-bg)]',
  'border border-[var(--settings-theme-card-border)]',
);

const ACTION_CLASS = cn(
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-full px-3 text-12 font-medium',
  'border border-[var(--settings-theme-card-border)]',
  'text-[var(--settings-section-sublabel)] transition-colors hover:bg-sidebar-item-hover',
  'disabled:cursor-not-allowed disabled:opacity-50',
);

function resourceLabel(kind: PiPackageResourceKind, t: ReturnType<typeof useTranslation>['t']): string {
  return t(`settings.piPackages.resources.${kind}`);
}

function resourceStatusKey(resource: PiPackageResourceView): string {
  if (resource.kind === 'extension' && resource.compatibility === 'supported') return 'extensionSupported';
  return resource.compatibility;
}

function ResourceCompatibilityDetails({ resource }: { resource: PiPackageResourceView }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-lg border border-[var(--settings-theme-card-border)] px-3 py-2.5">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-12 font-medium text-[var(--settings-section-sublabel)]">
            {resourceLabel(resource.kind, t)} · <span className="font-mono">{resource.name}</span>
          </p>
        </div>
        <span className="shrink-0 text-11 text-[var(--settings-section-desc)]">
          {t(`settings.piPackages.status.${resourceStatusKey(resource)}`)}
        </span>
      </div>
      {resource.compatibilityIssues && resource.compatibilityIssues.length > 0 && (
        <div className="mt-2 flex flex-col gap-1 text-11 leading-[1.45] text-[var(--settings-section-desc)]">
          {resource.compatibilityIssues.map((issue) => (
            <p key={issue}>{t(`settings.piPackages.issues.${issue}`)}</p>
          ))}
          {resource.detectedApis && resource.detectedApis.length > 0 && (
            <p className="break-all font-mono">
              {t('settings.piPackages.detectedApis', { apis: resource.detectedApis.join(', ') })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function RuntimeRequirementDetails({ requirement }: { requirement: PiPackageRuntimeRequirement }) {
  const { t } = useTranslation();
  if (requirement.compatible === true) return null;
  return (
    <div className="rounded-lg border border-[var(--settings-theme-card-border)] px-3 py-2.5">
      <p className="text-12 font-medium text-[var(--settings-section-sublabel)]">
        {t('settings.piPackages.runtimeRequirementTitle')}
      </p>
      <p className="mt-1 text-11 leading-[1.45] text-[var(--settings-section-desc)]">
        {requirement.reason === 'legacy-runtime-package'
          ? t('settings.piPackages.runtimeLegacyPackage', {
              packageName: requirement.packageName,
            })
          : requirement.compatible === false
          ? t('settings.piPackages.runtimeMismatch', {
              packageName: requirement.packageName,
              range: requirement.range,
              currentVersion: requirement.currentVersion,
            })
          : t('settings.piPackages.runtimeUnknown', {
              packageName: requirement.packageName,
              range: requirement.range,
            })}
      </p>
    </div>
  );
}

export function PiPackagesSection() {
  const { t } = useTranslation();
  const [source, setSource] = useState('');
  const [packages, setPackages] = useState<PiPackageView[]>([]);
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [pendingInstall, setPendingInstall] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<PiPackageView | null>(null);
  const [compatibilityNotice, setCompatibilityNotice] = useState<PiPackageView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    try {
      const result = await window.electronAPI.maker.listPiPackages();
      setAvailable(result.available);
      setPackages(result.packages);
    } catch {
      toast.error(t('settings.piPackages.operationFailed'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const runMutation = async (
    action: PiPackageMutationAction,
    packageSource: string,
    options?: { confirmed?: boolean; enabled?: boolean },
  ) => {
    if (busy) return;
    setBusy(`${action}:${packageSource}`);
    try {
      const result = await window.electronAPI.maker.mutatePiPackage({
        action,
        source: packageSource,
        ...options,
      });
      setAvailable(result.available);
      setPackages(result.packages);
      if (action === 'install') {
        setSource('');
      }
      if (
        (action === 'install' || action === 'update')
        && result.affectedPackage
        && shouldShowPiPackagePostMutationNotice(result.affectedPackage)
      ) {
        setCompatibilityNotice(result.affectedPackage);
      }
      toast.success(t(`settings.piPackages.success.${action}`));
    } catch {
      toast.error(t('settings.piPackages.operationFailed'));
    } finally {
      setBusy(null);
      setPendingInstall(null);
      setPendingRemoval(null);
    }
  };

  const installSource = source.trim();
  const empty = useMemo(() => !loading && available && packages.length === 0, [available, loading, packages]);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
          {t('settings.piPackages.title')}
        </h2>
        <p className="text-12 leading-[1.45] text-[var(--settings-section-desc)]">
          {t('settings.piPackages.description')}
        </p>
      </div>

      <section className="flex flex-col gap-3" aria-labelledby="pi-extension-install-title">
        <div className="flex flex-col gap-1">
          <h3
            id="pi-extension-install-title"
            className="text-14 font-medium text-[var(--settings-section-sublabel)]"
          >
            {t('settings.piPackages.installSectionTitle')}
          </h3>
          <p className="text-12 leading-[1.45] text-[var(--settings-section-desc)]">
            {t('settings.piPackages.installSectionDescription')}
          </p>
        </div>
        <div className={CARD_CLASS}>
          <div className="flex items-center gap-2 px-4 py-4">
            <SettingsTextInput
              value={source}
              onChange={setSource}
              placeholder={t('settings.piPackages.sourcePlaceholder')}
              size="md"
              mono
              className="min-w-0 flex-1"
            />
            <button
              type="button"
              disabled={!available || !installSource || Boolean(busy)}
              onClick={() => setPendingInstall(installSource)}
              className={cn(ACTION_CLASS, 'shrink-0')}
            >
              <Puzzle size={14} />
              {t('settings.piPackages.install')}
            </button>
          </div>
          <div className="mx-4 h-px bg-[var(--settings-theme-card-border)]" />
          <p className="px-4 py-3 text-12 leading-[1.45] text-[var(--settings-section-desc)]">
            {t('settings.piPackages.inspectionHint')}
          </p>
        </div>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="pi-extension-installed-title">
        <h3
          id="pi-extension-installed-title"
          className="text-14 font-medium text-[var(--settings-section-sublabel)]"
        >
          {t('settings.piPackages.installedSectionTitle')}
        </h3>

        {!available && (
          <p className="text-12 text-[var(--settings-section-desc)]">
            {t('settings.piPackages.piUnavailable')}
          </p>
        )}

        {empty && (
          <div className="rounded-xl border border-dashed border-[var(--settings-theme-card-border)] px-5 py-8 text-center">
            <p className="text-12 text-[var(--settings-section-desc)]">
              {t('settings.piPackages.empty')}
            </p>
          </div>
        )}

        <div className="flex flex-col gap-3">
          {packages.map((pkg) => {
            const packageBusy = Boolean(busy?.endsWith(`:${pkg.source}`));
            const packageManageable = pkg.manageable !== false;
            return (
              <div key={pkg.source} className={CARD_CLASS}>
                <div className="flex items-start justify-between gap-4 px-4 py-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <p className="truncate text-13 font-medium text-[var(--settings-section-sublabel)]">
                        {pkg.name}
                      </p>
                      {pkg.version && (
                        <span className="text-11 text-[var(--settings-section-desc)]">v{pkg.version}</span>
                      )}
                    </div>
                    <p className="mt-1 break-all font-mono text-11 text-[var(--settings-section-desc)]">
                      {pkg.source}
                    </p>
                  </div>
                  <Switch
                    checked={pkg.enabled}
                    disabled={packageBusy || !packageManageable}
                    onCheckedChange={(enabled) => {
                      if (enabled && pkg.requiresExtensionApproval) {
                        setCompatibilityNotice(pkg);
                        return;
                      }
                      void runMutation('set-enabled', pkg.source, { enabled });
                    }}
                    aria-label={t('settings.piPackages.toggleAria', { name: pkg.name })}
                  />
                </div>

                <div className="mx-4 h-px bg-[var(--settings-theme-card-border)]" />

                <div className="flex flex-col gap-2 px-4 py-3">
                  {pkg.resources.map((resource, index) => (
                    <ResourceCompatibilityDetails
                      key={`${resource.kind}:${resource.name}:${index}`}
                      resource={resource}
                    />
                  ))}
                  {pkg.runtimeRequirements?.map((requirement) => (
                    <RuntimeRequirementDetails
                      key={`${requirement.packageName}:${requirement.range}`}
                      requirement={requirement}
                    />
                  ))}
                  {pkg.warning && (
                    <span className="text-12 text-[var(--settings-section-desc)]">
                      {t(`settings.piPackages.warning.${pkg.warning}`)}
                    </span>
                  )}
                </div>

                <div className="flex items-center justify-end gap-2 px-4 pb-4">
                  <button
                    type="button"
                    disabled={packageBusy || !packageManageable}
                    onClick={() => void runMutation('update', pkg.source)}
                    className={ACTION_CLASS}
                  >
                    <RefreshCw size={14} />
                    {t('settings.piPackages.update')}
                  </button>
                  <button
                    type="button"
                    disabled={packageBusy || !packageManageable}
                    onClick={() => setPendingRemoval(pkg)}
                    className={ACTION_CLASS}
                  >
                    <Trash2 size={14} />
                    {t('settings.piPackages.remove')}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <AlertDialog.Root
        open={pendingRemoval !== null}
        onOpenChange={(open) => !open && setPendingRemoval(null)}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-[100] bg-black/35" />
          <AlertDialog.Content
            className={cn(
              'fixed left-1/2 top-1/2 z-[101] w-[min(480px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2',
              'rounded-2xl border border-[var(--confirm-border)] bg-[var(--confirm-bg)] p-5 shadow-xl',
            )}
          >
            <AlertDialog.Title className="text-16 font-medium text-[var(--confirm-title)]">
              {t('settings.piPackages.uninstallTitle')}
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-13 leading-[1.5] text-[var(--confirm-desc)]">
              {t('settings.piPackages.uninstallDescription', { name: pendingRemoval?.name ?? '' })}
            </AlertDialog.Description>
            <div className="mt-5 flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <button type="button" className={ACTION_CLASS}>
                  {t('settings.piPackages.cancel')}
                </button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button
                  type="button"
                  className={cn(ACTION_CLASS, 'bg-[var(--button-primary-bg)] text-[var(--button-primary-text)]')}
                  onClick={() => pendingRemoval && void runMutation('remove', pendingRemoval.source)}
                >
                  {t('settings.piPackages.confirmUninstall')}
                </button>
              </AlertDialog.Action>
            </div>
        </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>

      <AlertDialog.Root open={pendingInstall !== null} onOpenChange={(open) => !open && setPendingInstall(null)}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-[100] bg-black/35" />
          <AlertDialog.Content
            className={cn(
              'fixed left-1/2 top-1/2 z-[101] w-[min(480px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2',
              'rounded-2xl border border-[var(--confirm-border)] bg-[var(--confirm-bg)] p-5 shadow-xl',
            )}
          >
            <AlertDialog.Title className="text-16 font-medium text-[var(--confirm-title)]">
              {t('settings.piPackages.confirmTitle')}
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-13 leading-[1.5] text-[var(--confirm-desc)]">
              {t('settings.piPackages.confirmDescription', { source: pendingInstall ?? '' })}
            </AlertDialog.Description>
            <div className="mt-5 flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <button type="button" className={ACTION_CLASS}>
                  {t('settings.piPackages.cancel')}
                </button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button
                  type="button"
                  className={cn(ACTION_CLASS, 'bg-[var(--button-primary-bg)] text-[var(--button-primary-text)]')}
                  onClick={() => pendingInstall && void runMutation('install', pendingInstall, { confirmed: true })}
                >
                  {t('settings.piPackages.confirmInstall')}
                </button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>

      <AlertDialog.Root
        open={compatibilityNotice !== null}
        onOpenChange={(open) => !open && setCompatibilityNotice(null)}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-[100] bg-black/35" />
          <AlertDialog.Content
            className={cn(
              'fixed left-1/2 top-1/2 z-[101] max-h-[min(680px,calc(100vh-32px))]',
              'w-[min(520px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto',
              'rounded-2xl border border-[var(--confirm-border)] bg-[var(--confirm-bg)] p-5 shadow-xl',
            )}
          >
            <div className="flex items-start gap-3">
              <AlertTriangle size={18} className="mt-0.5 shrink-0 text-[var(--confirm-title)]" />
              <div className="min-w-0">
                <AlertDialog.Title className="text-16 font-medium text-[var(--confirm-title)]">
                  {t('settings.piPackages.compatibilityNoticeTitle')}
                </AlertDialog.Title>
                <AlertDialog.Description className="mt-2 text-13 leading-[1.5] text-[var(--confirm-desc)]">
                  {t('settings.piPackages.compatibilityNoticeDescription', {
                    name: compatibilityNotice?.name ?? '',
                  })}
                </AlertDialog.Description>
              </div>
            </div>
            <div className="mt-4 flex flex-col gap-2">
              {compatibilityNotice?.warning && (
                <div className="rounded-lg border border-[var(--settings-theme-card-border)] px-3 py-2.5 text-12 text-[var(--confirm-desc)]">
                  {t(`settings.piPackages.warning.${compatibilityNotice.warning}`)}
                </div>
              )}
              {compatibilityNotice?.requiresExtensionApproval && (
                <div className="rounded-lg border border-[var(--settings-theme-card-border)] px-3 py-2.5">
                  <p className="text-12 font-medium text-[var(--confirm-title)]">
                    {t('settings.piPackages.extensionApprovalTitle')}
                  </p>
                  <p className="mt-1 text-11 leading-[1.45] text-[var(--confirm-desc)]">
                    {t('settings.piPackages.extensionApprovalDescription')}
                  </p>
                </div>
              )}
              {compatibilityNotice?.runtimeRequirements?.map((requirement) => (
                <RuntimeRequirementDetails
                  key={`${requirement.packageName}:${requirement.range}`}
                  requirement={requirement}
                />
              ))}
              {compatibilityNotice?.resources
                .filter((resource) => resource.compatibility !== 'supported')
                .map((resource, index) => (
                  <ResourceCompatibilityDetails
                    key={`${resource.kind}:${resource.name}:${index}`}
                    resource={resource}
                  />
                ))}
            </div>
            <p className="mt-3 text-11 leading-[1.45] text-[var(--confirm-desc)]">
              {t('settings.piPackages.parserDisclaimer')}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              {(compatibilityNotice?.requiresExtensionApproval || compatibilityNotice?.enabled) && (
                <button
                  type="button"
                  className={ACTION_CLASS}
                  disabled={Boolean(busy)}
                  onClick={() => {
                    const packageSource = compatibilityNotice?.source;
                    setCompatibilityNotice(null);
                    if (packageSource && compatibilityNotice?.enabled) {
                      void runMutation('set-enabled', packageSource, { enabled: false });
                    }
                  }}
                >
                  {compatibilityNotice?.requiresExtensionApproval
                    ? t('settings.piPackages.keepDisabled')
                    : t('settings.piPackages.disableAfterInstall')}
                </button>
              )}
              <button
                type="button"
                className={cn(ACTION_CLASS, 'bg-[var(--button-primary-bg)] text-[var(--button-primary-text)]')}
                disabled={Boolean(busy)}
                onClick={() => {
                  const packageSource = compatibilityNotice?.source;
                  const requiresApproval = compatibilityNotice?.requiresExtensionApproval;
                  setCompatibilityNotice(null);
                  if (packageSource && requiresApproval) {
                    void runMutation('set-enabled', packageSource, { enabled: true, confirmed: true });
                  }
                }}
              >
                {compatibilityNotice?.requiresExtensionApproval
                  ? t('settings.piPackages.approveAndEnable')
                  : compatibilityNotice?.enabled
                    ? t('settings.piPackages.keepEnabled')
                    : t('settings.piPackages.done')}
              </button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  );
}
