import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Puzzle, RefreshCw, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type {
  PiPackageMutationAction,
  PiPackageResourceKind,
  PiPackageResourceView,
  PiPackageRuntimeRequirement,
  PiPackageView,
} from '@/../shared/piPackages';
import { isRelativeLocalPiPackageSource } from '@/../shared/piPackages';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { extractIpcError } from '@/utils/ipcError';
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
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
  'disabled:cursor-not-allowed disabled:opacity-50',
);

const ICON_ACTION_CLASS = cn(
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg',
  'text-[var(--settings-section-desc)] transition-colors hover:bg-sidebar-item-hover',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
  'disabled:cursor-not-allowed disabled:opacity-50',
);

type PiPackagesLoadState = 'loading' | 'ready' | 'error';

interface PiPackageBusyOperation {
  action: PiPackageMutationAction;
  packageId: string;
}

function packageRowId(pkg: PiPackageView): string {
  return pkg.mutationTarget ?? pkg.source;
}

function resourceLabel(
  kind: PiPackageResourceKind,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  return t(`settings.piPackages.resources.${kind}`);
}

function resourceStatusKey(resource: PiPackageResourceView): string {
  if (resource.kind === 'extension' && resource.compatibility === 'supported')
    return 'extensionSupported';
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

function packageCompatibilityNoticeCount(pkg: PiPackageView): number {
  const resourceNotices = pkg.resources.filter(
    (resource) =>
      resource.compatibility !== 'supported' || Boolean(resource.compatibilityIssues?.length),
  ).length;
  const runtimeNotices =
    pkg.runtimeRequirements?.filter((requirement) => requirement.compatible !== true).length ?? 0;
  return resourceNotices + runtimeNotices + (pkg.warning ? 1 : 0);
}

export function PiPackagesSection() {
  const { t } = useTranslation();
  const [source, setSource] = useState('');
  const [packages, setPackages] = useState<PiPackageView[]>([]);
  const [available, setAvailable] = useState(true);
  const [loadState, setLoadState] = useState<PiPackagesLoadState>('loading');
  const [busy, setBusy] = useState<PiPackageBusyOperation | null>(null);
  const [expandedSources, setExpandedSources] = useState<Set<string>>(() => new Set());
  const mountedRef = useRef(false);
  const hasLoadedRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const mutationInFlightRef = useRef(false);
  const tRef = useRef(t);
  tRef.current = t;

  const load = useCallback(async () => {
    const generation = ++loadGenerationRef.current;
    if (!hasLoadedRef.current) setLoadState('loading');
    try {
      const result = await window.electronAPI.maker.listPiPackages();
      if (!mountedRef.current || generation !== loadGenerationRef.current) return;
      hasLoadedRef.current = true;
      setAvailable(result.available);
      setPackages(result.packages);
      setLoadState('ready');
    } catch {
      if (!mountedRef.current || generation !== loadGenerationRef.current) return;
      setLoadState('error');
      toast.error(tRef.current('settings.piPackages.operationFailed'));
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    const unsubscribe = window.electronAPI.maker.onPiPackagesChanged(() => {
      void load();
    });
    return () => {
      mountedRef.current = false;
      loadGenerationRef.current += 1;
      unsubscribe();
    };
  }, [load]);

  const runMutation = async (
    action: PiPackageMutationAction,
    packageSource: string,
    options?: { enabled?: boolean; mutationTarget?: string },
  ): Promise<boolean> => {
    if (mutationInFlightRef.current) return false;
    mutationInFlightRef.current = true;
    setBusy({ action, packageId: options?.mutationTarget ?? packageSource });
    try {
      const result = await window.electronAPI.maker.mutatePiPackage({
        action,
        source: packageSource,
        ...options,
      });
      if (mountedRef.current) {
        // Any older refresh started before this mutation must not overwrite the
        // authoritative mutation receipt when it eventually resolves.
        loadGenerationRef.current += 1;
        hasLoadedRef.current = true;
        setLoadState(result.projectionUnavailable ? 'error' : 'ready');
        if (!result.projectionUnavailable) {
          setAvailable(result.available);
          setPackages(result.packages);
        }
        if (action === 'install' && result.affectedPackage?.enabled) setSource('');
      }
      // Installation success means installed and enabled. Keep this Renderer
      // assertion even though Main enforces the same invariant so an older or
      // malformed receipt can never produce a false success toast.
      if (action === 'install' && result.affectedPackage?.enabled !== true) {
        toast.error(t('settings.piPackages.operationFailed'));
        return false;
      }
      // Toasts are app-level feedback: even if the user leaves this panel while
      // the host mutation is running, they still need the final outcome.
      const successKey =
        action === 'install' && result.affectedPackage?.enabled
          ? 'settings.piPackages.success.installEnabled'
          : action === 'remove'
            ? 'settings.piPackages.success.settingsRemove'
            : action === 'set-enabled' && options?.enabled === false
              ? 'settings.piPackages.success.settingsDisable'
              : `settings.piPackages.success.${action}`;
      if (result.runtimeConvergence === 'partial') {
        toast.error(t('settings.piPackages.failure.runtimeConvergencePartial'));
      } else {
        toast.success(t(successKey));
      }
      if (result.projectionUnavailable) {
        toast.error(t('settings.piPackages.failure.stateUnavailable'));
      }
      return true;
    } catch (error) {
      const ipcError = extractIpcError(error);
      toast.error(
        ipcError?.code === 'PI_PACKAGE_MUTATION_FAILED'
          ? ipcError.message
          : t('settings.piPackages.operationFailed'),
      );
      return false;
    } finally {
      mutationInFlightRef.current = false;
      if (mountedRef.current) setBusy(null);
    }
  };

  const installSource = source.trim();
  const empty = useMemo(
    () => loadState === 'ready' && available && packages.length === 0,
    [available, loadState, packages],
  );
  const toggleDetails = (packageSource: string) => {
    setExpandedSources((current) => {
      const next = new Set(current);
      if (next.has(packageSource)) next.delete(packageSource);
      else next.add(packageSource);
      return next;
    });
  };
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
              disabled={loadState === 'loading' || !available || !installSource || Boolean(busy)}
              onClick={() => {
                if (isRelativeLocalPiPackageSource(installSource)) {
                  toast.error(t('settings.piPackages.relativePathUnsupported'));
                  return;
                }
                void runMutation('install', installSource);
              }}
              aria-busy={busy?.action === 'install'}
              className={cn(ACTION_CLASS, 'shrink-0')}
            >
              {busy?.action === 'install' ? <Spinner size={14} /> : <Puzzle size={14} />}
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

        {loadState === 'loading' && (
          <div
            role="status"
            className="flex items-center justify-center gap-2 rounded-xl border border-[var(--settings-theme-card-border)] px-5 py-8 text-12 text-[var(--settings-section-desc)]"
          >
            <Spinner size={15} />
            {t('settings.piPackages.loading')}
          </div>
        )}

        {loadState === 'error' && (
          <div
            role="alert"
            className="flex flex-col items-center gap-3 rounded-xl border border-[var(--settings-theme-card-border)] px-5 py-8 text-center"
          >
            <p className="text-12 leading-[1.45] text-[var(--settings-section-desc)]">
              {t('settings.piPackages.loadFailed')}
            </p>
            <button type="button" onClick={() => void load()} className={ACTION_CLASS}>
              <RefreshCw size={14} />
              {t('settings.piPackages.retry')}
            </button>
          </div>
        )}

        {loadState === 'ready' && !available && (
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

        <div className={packages.length > 0 ? CARD_CLASS : undefined}>
          {packages.map((pkg) => {
            const mutationTargetOption = pkg.mutationTarget
              ? { mutationTarget: pkg.mutationTarget }
              : {};
            const rowId = packageRowId(pkg);
            const packageBusy = busy?.packageId === rowId;
            const packageManageable = pkg.manageable !== false;
            const packageCanToggle = packageManageable && pkg.canToggle !== false;
            const expanded = expandedSources.has(rowId);
            const noticeCount = packageCompatibilityNoticeCount(pkg);
            return (
              <div
                key={rowId}
                className="border-b border-[var(--settings-theme-card-border)] last:border-b-0"
              >
                <div className="flex min-h-11 items-center gap-1.5 px-3 py-1">
                  <button
                    type="button"
                    onClick={() => toggleDetails(rowId)}
                    aria-expanded={expanded}
                    className="flex min-w-0 flex-1 items-baseline gap-2 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
                  >
                    <span className="truncate text-13 font-medium text-[var(--settings-section-sublabel)]">
                      {pkg.name}
                    </span>
                    {pkg.version && (
                      <span className="shrink-0 text-11 text-[var(--settings-section-desc)]">
                        v{pkg.version}
                      </span>
                    )}
                  </button>
                  <span
                    aria-hidden="true"
                    className="hidden shrink-0 text-11 text-[var(--settings-section-desc)] xl:block"
                  >
                    {!packageManageable
                      ? t('settings.piPackages.rowStatus.unmanageable')
                      : noticeCount > 0
                        ? t('settings.piPackages.rowStatus.noticeCount', { count: noticeCount })
                        : t('settings.piPackages.rowStatus.compatible')}
                  </span>
                  {packageManageable && noticeCount > 0 && (
                    <>
                      <span
                        className="flex shrink-0 items-center text-[var(--warning-fg)] xl:hidden"
                        title={t('settings.piPackages.rowStatus.noticeCount', {
                          count: noticeCount,
                        })}
                        aria-hidden="true"
                      >
                        <AlertTriangle size={14} />
                      </span>
                      <span className="sr-only">
                        {t('settings.piPackages.rowStatus.noticeCount', { count: noticeCount })}
                      </span>
                    </>
                  )}
                  {packageBusy && (
                    <span
                      role="status"
                      aria-label={t('settings.piPackages.operationInProgress', { name: pkg.name })}
                      className="flex shrink-0 text-[var(--settings-section-desc)]"
                    >
                      <Spinner size={14} />
                    </span>
                  )}
                  <Switch
                    checked={pkg.enabled}
                    disabled={Boolean(busy) || !packageCanToggle}
                    onCheckedChange={(enabled) => {
                      void runMutation('set-enabled', pkg.source, {
                        ...mutationTargetOption,
                        enabled,
                      });
                    }}
                    aria-label={t('settings.piPackages.toggleAria', { name: pkg.name })}
                  />
                  <button
                    type="button"
                    disabled={Boolean(busy) || !packageManageable}
                    onClick={() => void runMutation('update', pkg.source, mutationTargetOption)}
                    aria-label={t('settings.piPackages.updateAria', { name: pkg.name })}
                    aria-busy={packageBusy && busy?.action === 'update'}
                    className={ICON_ACTION_CLASS}
                  >
                    <RefreshCw size={14} />
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(busy) || !packageManageable}
                    onClick={() => void runMutation('remove', pkg.source, mutationTargetOption)}
                    aria-label={t('settings.piPackages.removeAria', { name: pkg.name })}
                    aria-busy={packageBusy && busy?.action === 'remove'}
                    className={ICON_ACTION_CLASS}
                  >
                    <Trash2 size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleDetails(rowId)}
                    aria-expanded={expanded}
                    aria-label={
                      expanded
                        ? t('settings.piPackages.collapseDetails', { name: pkg.name })
                        : t('settings.piPackages.showDetails', { name: pkg.name })
                    }
                    className={ICON_ACTION_CLASS}
                  >
                    {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                  </button>
                </div>

                {expanded && (
                  <div className="flex flex-col gap-2 border-t border-[var(--settings-theme-card-border)] bg-[var(--surface-subtle)] px-4 py-3">
                    <p className="break-all font-mono text-11 text-[var(--settings-section-desc)]">
                      {pkg.source}
                    </p>
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
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
