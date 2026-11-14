/**
 * Get-started guide (docs/product-rules/first-run-guide.md): one window that leads a person
 * through only the steps that apply to them — earlier-version data that was brought over,
 * what Cindy is, migrating from another computer, connecting a model, and bringing in what
 * other AI tools on this computer already hold.
 *
 * Every step reuses an existing capability (Migration Assistant, the provider connect flow and
 * its detection, task import, teammate import). Steps that are finished on another page park the guide and
 * leave a small bar to come back; nothing here installs, writes settings or stores secrets.
 */
import { Children, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import * as Dialog from '@radix-ui/react-dialog';
import {
  Archive,
  ArrowRight,
  Check,
  ChevronRight,
  Compass,
  Download,
  KeyRound,
  Laptop,
  Sparkles,
  X,
  type LucideIcon,
} from 'lucide-react';

import { presetDisplayName, type ProviderView } from '@cindy/model-providers';
import { IMPORT_SOURCE_NAMES } from '@cindy/maker-shared/import-source-marks';
import type { CompanionImportSource } from '@cindy/maker-shared/companion-import';

import { ThemeBrandLockup } from '@/components/branding/ThemeBrandLockup';
import { ImportSourceMark } from '@/components/icons/ImportSourceMark';
import { hasProviderLogo, ProviderLogoMark, type ProviderLogoRouting } from '@/components/icons/ProviderLogoMark';
import { WINDOW_DRAG_STYLE, WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { canAccessBillingSettings } from '@/components/settings/billingVisibility';
import { estimateMinutes, useFormatSize } from '@/components/settings/SessionImportSection';
import { useProviderSubscriptionCard } from '@/components/settings/useProviderSubscriptionCard';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/contexts/AuthContext';
import { billingApi } from '@/features/billing/api';
import { BILLING_CURRENCY, formatBillingAmount } from '@/features/billing/money';
import {
  openSetupMigration,
  subscribeSetupMigrationStateChanged,
  useSetupMigrationDialog,
} from '@/features/setup-migration/setupMigrationStore';
import { useProviderOnboarding, type ProviderOnboardingRow } from '@/hooks/useProviderOnboarding';
import { useProviders } from '@/hooks/useProviders';
import { useSignInToCindy } from '@/hooks/useSignInToCindy';
import { providerMonogram } from '@/lib/providerModels';
import { isSecondaryWindow } from '@/lib/secondaryWindow';
import { isSidebarWindow } from '@/lib/sidebarWindow';
import { cn } from '@/lib/utils';
import { themeService } from '@/themes/theme-service';
import { localCliDisplayName } from '../../../shared/localCliDetect';
import {
  IMPORT_CONFIRM_BYTES,
  IMPORT_CONFIRM_COUNT,
  type ImportScanResult,
  type ImportSourceId,
} from '../../../shared/sessionImport';
import type { ModelAccessBalance } from '../../../shared/modelAccess';
import type { SetupMigrationState } from '../../../shared/setupMigration';
import {
  closeFirstRunGuide,
  firstRunGuideSteps,
  parkFirstRunGuide,
  parkFirstRunGuideForConnection,
  updateFirstRunGuideConnections,
  resumeFirstRunGuide,
  useFirstRunGuide,
  type FirstRunGuideContext,
  type FirstRunGuideStepId,
} from './firstRunGuideStore';

/** Named provider rows on the model step, so the two cards stay on one screen. */
const MODEL_ROWS = 3;
/** Local detection that has not answered by now is treated as "nothing found". */
const DETECTION_TIMEOUT_MS = 4000;
const COMPANION_SOURCE_NAMES: Record<CompanionImportSource['kind'], string> = {
  openclaw: 'OpenClaw',
  hermes: 'Hermes',
};

interface SourceTasks {
  source: ImportSourceId;
  keys: string[];
  bytes: number;
}

/** Tasks the guide can import in one go: listed, readable, and with their folder still there. */
function tasksBySource(scan: ImportScanResult | null): SourceTasks[] {
  const groups = new Map<ImportSourceId, SourceTasks>();
  for (const candidate of scan?.candidates ?? []) {
    if (candidate.hidden || candidate.unsupportedVersion || candidate.missingDir) continue;
    const group = groups.get(candidate.source) ?? { source: candidate.source, keys: [], bytes: 0 };
    group.keys.push(candidate.key);
    group.bytes += candidate.sizeBytes;
    groups.set(candidate.source, group);
  }
  return [...groups.values()].sort((a, b) => b.keys.length - a.keys.length);
}

function withTimeout<T>(work: Promise<T>, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(fallback), DETECTION_TIMEOUT_MS);
    work
      .then(resolve, () => resolve(fallback))
      .finally(() => window.clearTimeout(timer));
  });
}

export function FirstRunGuide() {
  const guide = useFirstRunGuide();
  if (!guide.open || isSecondaryWindow() || isSidebarWindow()) return null;
  return <FirstRunGuideBody key={guide.session} context={guide} parked={guide.parked} />;
}

function FirstRunGuideBody({ context, parked }: { context: FirstRunGuideContext; parked: boolean }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { mode, user } = useAuth();
  const signInToCindy = useSignInToCindy();
  const onboarding = useProviderOnboarding({ loadPresets: true, dismissible: false, always: true });
  // The cover's brand block follows the active theme, like the new-task page.
  const [theme, setTheme] = useState(() => themeService.getCurrentTheme());
  useEffect(() => themeService.onDidChangeTheme(setTheme), []);
  const { confirm } = useConfirmDialog();
  const formatSize = useFormatSize();
  const { providers, loading: providersLoading } = useProviders();
  const migrationDialogOpen = useSetupMigrationDialog().open;

  const hasModel = providers.some((provider) => provider.connected);
  const [scan, setScan] = useState<ImportScanResult | null | undefined>(undefined);
  const [companions, setCompanions] = useState<CompanionImportSource[] | undefined>(undefined);
  const [migrationState, setMigrationState] = useState<SetupMigrationState | null>(null);
  const [steps, setSteps] = useState<FirstRunGuideStepId[] | null>(null);
  const [index, setIndex] = useState(0);
  const [checked, setChecked] = useState<ReadonlySet<ImportSourceId>>(() => new Set());
  const [importState, setImportState] = useState<'idle' | 'starting' | 'started' | 'failed'>('idle');
  /** undefined = not read yet; null = this account has no readable balance (shown without it). */
  const [balance, setBalance] = useState<ModelAccessBalance | null | undefined>(undefined);

  const sourceTasks = useMemo(() => tasksBySource(scan ?? null), [scan]);
  const step = steps?.[index] ?? null;
  const stepRef = useRef(step);
  useEffect(() => {
    stepRef.current = step;
  }, [step]);

  // Read-only detection on this computer; each read is independent and may be absent.
  useEffect(() => {
    let cancelled = false;
    const api = window.electronAPI;
    void withTimeout<ImportScanResult | null>(
      Promise.resolve().then(() => api.localDb.sessionImport.scan()),
      null,
    ).then((result) => { if (!cancelled) setScan(result); });
    void withTimeout<CompanionImportSource[]>(
      Promise.resolve().then(() => api.companionImport.sources()),
      [],
    ).then((result) => { if (!cancelled) setCompanions(result); });
    return () => { cancelled = true; };
  }, []);

  const refreshMigration = useCallback(() => {
    window.electronAPI?.setupMigration?.state().then(setMigrationState).catch(() => {});
  }, []);
  useEffect(() => {
    refreshMigration();
    return subscribeSetupMigrationStateChanged(refreshMigration);
  }, [refreshMigration]);

  // Decide the steps once, when detection has answered; they do not shift under the person.
  useEffect(() => {
    if (steps || providersLoading || scan === undefined || companions === undefined) return;
    setSteps(firstRunGuideSteps(context, {
      cloud: mode === 'cloud',
      hadModel: hasModel,
      hasLocalContent: tasksBySource(scan).length > 0 || companions.length > 0,
    }));
  }, [companions, context, hasModel, mode, providersLoading, scan, steps]);

  // A step action that leads to another page (connect a model, pick tasks, import a
  // teammate) parks the guide instead of covering the page it just opened.
  const lastLocationKey = useRef(location.key);
  useEffect(() => {
    if (location.key === lastLocationKey.current) return;
    lastLocationKey.current = location.key;
    if (stepRef.current === 'models' || stepRef.current === 'import') parkFirstRunGuide();
  }, [location.key]);

  // The handoff coordinator owns completion. Credential pushes cannot finish a dialog.
  useEffect(() => {
    if (!parked) return;
    if (step === 'models') updateFirstRunGuideConnections(
      providers.filter(provider => provider.connected).map(provider => provider.id),
    );
    if (step === 'migration' && !migrationDialogOpen) {
      refreshMigration();
      resumeFirstRunGuide();
    }
  }, [providers, migrationDialogOpen, parked, refreshMigration, step]);

  const canOpenBilling = canAccessBillingSettings({ mode, membershipKind: user?.membershipKind ?? null });
  // The official service's balance, read once when the model step is first shown. Only personal
  // accounts have one; a failed read simply leaves the card without the number.
  const balanceRequested = useRef(false);
  useEffect(() => {
    if (step !== 'models' || !canOpenBilling || balanceRequested.current) return;
    balanceRequested.current = true;
    billingApi
      .getBalance()
      .then(setBalance)
      .catch(() => setBalance(null));
    // This read belongs to the guide instance, not the currently visible step.
    // Account changes close the instance; React discards its late state updates.
  }, [canOpenBilling, step]);

  const goNext = () => setIndex((current) => Math.min(current + 1, (steps?.length ?? 1) - 1));
  const goBack = () => setIndex((current) => Math.max(current - 1, 0));

  const openMigration = () => {
    parkFirstRunGuide();
    openSetupMigration();
  };

  const selectedTasks = sourceTasks.filter((group) => checked.has(group.source));
  const selectedKeys = selectedTasks.flatMap((group) => group.keys);
  const selectedBytes = selectedTasks.reduce((total, group) => total + group.bytes, 0);

  const startImport = async () => {
    if (selectedKeys.length === 0 || importState === 'starting') return;
    if (selectedKeys.length > IMPORT_CONFIRM_COUNT || selectedBytes > IMPORT_CONFIRM_BYTES) {
      const accepted = await confirm({
        title: t('settings.sessionImport.confirm.title', { count: selectedKeys.length }),
        description: t('settings.sessionImport.confirm.body', {
          minutes: estimateMinutes(selectedKeys.length, selectedBytes),
          size: formatSize(selectedBytes),
        }),
        confirmText: t('settings.sessionImport.importCount', { count: selectedKeys.length }),
        cancelText: t('settings.sessionImport.confirm.cancel'),
      });
      if (!accepted) return;
    }
    setImportState('starting');
    try {
      await window.electronAPI.localDb.sessionImport.start(selectedKeys);
      setImportState('started');
    } catch {
      setImportState('failed');
    }
  };

  const finish = () => {
    closeFirstRunGuide();
    navigate('/cc-agent/new');
  };

  const returning = context.migration || context.legacyMigrated;
  const title = t(returning ? 'firstRunGuide.title.returning' : 'firstRunGuide.title.new');
  const migrationDone = migrationState?.lastRun ?? null;
  const pendingChecklist = migrationDone?.checklist.filter((item) => !item.done).length ?? 0;
  const nativeToolsFound = sourceTasks.some((group) => group.source === 'claude' || group.source === 'codex')
    || (scan?.sources ?? []).some((source) => source.id === 'claude' || source.id === 'codex');

  if (parked) {
    // The Migration Assistant is a modal of its own; the bar would only sit behind it.
    if (migrationDialogOpen || !step) return null;
    return (
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex justify-center px-4">
        <div
          role="status"
          className="pointer-events-auto flex w-full max-w-[520px] items-center gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-2.5 text-[var(--text-primary)] shadow-[shadow:var(--shadow-menu)]"
        >
          <Compass size={16} strokeWidth={1.8} aria-hidden="true" className="shrink-0 text-[var(--text-secondary)]" />
          <span className="min-w-0 flex-1 truncate text-13">
            {t('firstRunGuide.resume.label', { step: t(`firstRunGuide.steps.${step}`) })}
          </span>
          <Button variant="secondary" size="sm" compact onClick={resumeFirstRunGuide}>
            {t('firstRunGuide.resume.back')}
          </Button>
          <button
            type="button"
            onClick={closeFirstRunGuide}
            aria-label={t('firstRunGuide.close')}
            title={t('firstRunGuide.close')}
            className="flex size-7 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  }

  const billingLocale = i18n.resolvedLanguage ?? i18n.language;
  const money = (amount: string) => formatBillingAmount(amount, BILLING_CURRENCY, billingLocale);
  const paidBalance = balance ? Number(balance.planCredits) > 0 || Number(balance.purchasedCredits) > 0 : false;
  const giftedBalance = balance ? Number(balance.promotionalCredits) > 0 : false;

  const goConnect = (id: string | null) => {
    parkFirstRunGuideForConnection(providers.filter(provider => provider.connected).map(provider => provider.id));
    navigate(id ? `/settings?tab=providers&connect=${encodeURIComponent(id)}` : '/settings?tab=providers&wizard=1');
  };
  const connectedRows = providers.filter((provider) => provider.connected && provider.id !== 'xd').slice(0, MODEL_ROWS);

  const providerRow = (row: ProviderOnboardingRow) => {
    const id = row.kind === 'builtin' ? row.provider.id : row.preset.id;
    const name = row.kind === 'builtin' ? row.provider.name : presetDisplayName(row.preset, i18n.language);
    return (
      <OptionRow
        key={id}
        icon={providerIcon(id, name, row.kind === 'builtin' ? row.provider.routing : undefined)}
        label={name}
        sub={t(row.kind === 'builtin' ? 'onboarding.connectProvider.oauthSub' : 'onboarding.connectProvider.presetSub')}
        onClick={() => goConnect(id)}
      />
    );
  };

  let body: ReactNode;
  /** The step has nothing left to do, so the footer offers "Next" rather than "Skip". */
  let settled = true;
  if (!step) {
    body = (
      <div className="flex h-full items-center justify-center gap-2 text-13 text-[var(--confirm-desc)]">
        <Spinner size={14} />
        {t('firstRunGuide.preparing')}
      </div>
    );
  } else if (step === 'legacy') {
    body = (
      <Centered>
        <StepHero icon={Archive} title={t('firstRunGuide.legacy.title')} body={t('firstRunGuide.legacy.body')} centered />
        <p className="max-w-[420px] text-center text-12 leading-relaxed text-[var(--confirm-desc)]">{t('firstRunGuide.legacy.note')}</p>
      </Centered>
    );
  } else if (step === 'intro') {
    body = null;
  } else if (step === 'migration') {
    settled = migrationDone !== null;
    body = (
      <Centered>
        <div className="flex items-center gap-4" aria-hidden="true">
          <ComputerMark label={t('firstRunGuide.migration.from')} muted />
          <ArrowRight size={18} strokeWidth={1.6} className="text-[var(--text-tertiary)]" />
          <ComputerMark label={t('firstRunGuide.migration.to')} />
        </div>
        <div className="flex max-w-[440px] flex-col items-center gap-1.5 text-center">
          <p className="text-20 font-medium leading-snug text-[var(--confirm-title)]">{t('firstRunGuide.migration.title')}</p>
          <p className="text-14 leading-relaxed text-[var(--confirm-desc)]">
            {t(context.migration ? 'firstRunGuide.migration.body' : 'firstRunGuide.migration.manualBody')}
          </p>
        </div>
        {migrationDone ? (
          <DoneLine>
            {t('firstRunGuide.migration.done', { name: migrationDone.sourceName })}
            {pendingChecklist > 0 ? ` · ${t('setupMigration.settings.pending', { count: pendingChecklist })}` : ''}
          </DoneLine>
        ) : null}
        <Button variant={migrationDone ? 'secondary' : 'cta'} size="lg" type="button" onClick={openMigration}>
          {t('setupMigration.settings.start')}
        </Button>
      </Centered>
    );
  } else if (step === 'models') {
    settled = hasModel;
    body = (
      <Stagger className="flex flex-col gap-3">
        <StepHero icon={Sparkles} title={t('firstRunGuide.models.title')} body={t('firstRunGuide.models.body')} />
        {/* Cindy AI comes with the account: there is nothing to turn on. Without an account the
            card offers sign-in; an account with no official service (organization-managed) omits it. */}
        {mode !== 'cloud' || onboarding.xdProvider ? (
          <OptionCard
            icon={providerIcon('xd', 'Cindy AI')}
            title={onboarding.xdProvider?.name ?? t('onboarding.connectProvider.cindy.title')}
            badge={t('firstRunGuide.models.cindy.badge')}
            body={t('firstRunGuide.models.cindy.body')}
          >
            {mode === 'cloud' ? (
              <div className="flex flex-wrap items-end justify-between gap-2">
                {balance ? (
                  // What is in the account now. A balance made only of gifted credit is named as
                  // free and for trying; once the person has paid, it is their available balance.
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-20 font-medium leading-[1.4] tabular-nums text-[var(--confirm-title)]">
                      {money(balance.available)}
                    </span>
                    <span className="text-12 leading-relaxed text-[var(--confirm-desc)]">
                      {!paidBalance && giftedBalance
                        ? t('firstRunGuide.models.cindy.freeBalance')
                        : giftedBalance
                          ? `${t('billing.balance.title')} · ${t('billing.balance.promotional')} ${money(balance.promotionalCredits)}`
                          : t('billing.balance.title')}
                    </span>
                  </div>
                ) : canOpenBilling && balance === undefined ? (
                  <Spinner size={14} className="text-[var(--confirm-desc)]" />
                ) : (
                  <DoneLine>{t('firstRunGuide.models.cindy.active')}</DoneLine>
                )}
                {canOpenBilling ? (
                  <Button variant="secondary" size="sm" tone="quiet" compact type="button" onClick={() => navigate('/settings?tab=billing')}>
                    {t('billing.sidebar')}
                  </Button>
                ) : null}
              </div>
            ) : (
              <div>
                <Button variant="secondary" size="md" type="button" onClick={() => void signInToCindy()}>
                  {t('onboarding.connectProvider.cindy.loginTitle')}
                </Button>
              </div>
            )}
          </OptionCard>
        ) : null}
        <OptionCard
          icon={<KeyRound size={16} strokeWidth={1.8} aria-hidden="true" />}
          title={t('firstRunGuide.models.own.title')}
          badge={t('firstRunGuide.models.own.badge')}
          body={t('firstRunGuide.models.own.body')}
          action={(
            <Button
              variant="secondary"
              size="sm"
              tone="quiet"
              compact
              type="button"
              onClick={() => goConnect(null)}
            >
              <KeyRound size={13} aria-hidden="true" />
              {t('firstRunGuide.models.own.more')}
            </Button>
          )}
        >
          <div className="flex flex-col">
            {/* What is already connected leads, in the same row form as what can be added. */}
            {connectedRows.map((provider) => (
              <ConnectedProviderRow key={`connected-${provider.id}`} provider={provider} onClick={() => goConnect(provider.id)} />
            ))}
            {onboarding.detectedRows.slice(0, Math.max(0, MODEL_ROWS - connectedRows.length)).map(({ provider, detection }) => (
              <OptionRow
                key={`detected-${provider.id}`}
                icon={providerIcon(provider.id, provider.name, provider.routing)}
                label={provider.name}
                badge={t('onboarding.connectProvider.detectedLabel')}
                sub={t('settings.providers.detect.hintLoggedIn', { cli: localCliDisplayName(detection.cli) })}
                onClick={() => goConnect(provider.id)}
              />
            ))}
            {onboarding.primaryRows
              .filter((row) => row.kind !== 'builtin' || !row.provider.connected)
              // A few named rows at most; everything else is one step away in the last row.
              .slice(0, Math.max(0, MODEL_ROWS - connectedRows.length - onboarding.detectedRows.length))
              .map(providerRow)}
          </div>
        </OptionCard>
      </Stagger>
    );
  } else if (step === 'import') {
    const nothing = sourceTasks.length === 0 && (companions?.length ?? 0) === 0;
    settled = nothing || importState === 'started';
    body = (
      <Stagger className="flex flex-col gap-3">
        <StepHero
          icon={Download}
          title={t('firstRunGuide.import.title')}
          body={t(nothing ? 'firstRunGuide.import.empty' : 'firstRunGuide.import.body')}
        />
        {sourceTasks.length > 0 ? (
          <section className="rounded-xl border border-[var(--border-default)] px-4 py-3" aria-label={t('firstRunGuide.import.tasksHeading')}>
            {/* Actions sit beside the heading so the list and the teammates card stay on one screen. */}
            <SectionHeading
              title={t('firstRunGuide.import.tasksHeading')}
              hint={t('firstRunGuide.import.tasksHint')}
              action={importState === 'started' ? null : (
                <>
                  <Button variant="secondary" size="sm" tone="quiet" compact type="button" onClick={() => navigate('/settings?tab=import')}>
                    {t('firstRunGuide.import.pick')}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    type="button"
                    disabled={selectedKeys.length === 0}
                    loading={importState === 'starting'}
                    onClick={() => void startImport()}
                  >
                    {selectedKeys.length > 0
                      ? t('settings.sessionImport.importCount', { count: selectedKeys.length })
                      : t('settings.sessionImport.import')}
                  </Button>
                </>
              )}
            />
            <ul className="mt-2 flex flex-col">
              {sourceTasks.map((group) => {
                const id = `first-run-import-${group.source}`;
                return (
                  <li key={group.source} className="flex min-h-9 items-center gap-2.5 border-b border-[var(--border-default)] text-14 text-[var(--confirm-title)] last:border-b-0">
                    <Checkbox
                      id={id}
                      checked={checked.has(group.source)}
                      disabled={importState === 'starting' || importState === 'started'}
                      onChange={(event) => {
                        const next = event.target.checked;
                        setChecked((current) => {
                          const updated = new Set(current);
                          if (next) updated.add(group.source);
                          else updated.delete(group.source);
                          return updated;
                        });
                      }}
                    />
                    <label htmlFor={id} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                      <ImportSourceMark source={group.source} size={16} className="shrink-0 text-[var(--text-secondary)]" />
                      <span className="truncate">{IMPORT_SOURCE_NAMES[group.source]}</span>
                    </label>
                    <span className="shrink-0 tabular-nums text-12 text-[var(--confirm-desc)]">
                      {group.keys.length} · {formatSize(group.bytes)}
                    </span>
                  </li>
                );
              })}
            </ul>
            {importState === 'started' ? (
              <div className="mt-2"><DoneLine>{t('firstRunGuide.import.started')}</DoneLine></div>
            ) : null}
            {importState === 'failed' ? (
              <p role="alert" className="mt-2 text-12 text-[var(--text-danger)]">{t('firstRunGuide.import.startFailed')}</p>
            ) : null}
          </section>
        ) : null}
        {companions && companions.length > 0 ? (
          <section className="rounded-xl border border-[var(--border-default)] px-4 py-3" aria-label={t('firstRunGuide.import.teammatesHeading')}>
            <SectionHeading
              title={t('firstRunGuide.import.teammatesHeading')}
              hint={t('firstRunGuide.import.teammatesHint')}
              action={(
                <Button variant="secondary" size="sm" type="button" onClick={() => navigate('/bots/roster')}>
                  {t('firstRunGuide.import.importTeammate')}
                </Button>
              )}
            />
            <ul className="mt-2 flex flex-col">
              {companions.map((source) => (
                <li key={source.id} className="flex min-h-9 items-center gap-2.5 border-b border-[var(--border-default)] text-14 text-[var(--confirm-title)] last:border-b-0">
                  <span className="min-w-0 flex-1 truncate">{source.name}</span>
                  <span className="shrink-0 text-12 text-[var(--confirm-desc)]">{COMPANION_SOURCE_NAMES[source.kind]}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </Stagger>
    );
  } else {
    body = (
      <Centered>
        <StepHero icon={Check} title={t('firstRunGuide.finish.title')} centered />
        <ul className="flex max-w-[460px] flex-col gap-2.5">
          {context.legacyMigrated ? <DoneLine as="li">{t('firstRunGuide.finish.legacy')}</DoneLine> : null}
          {migrationDone ? (
            <DoneLine as="li">
              {t('firstRunGuide.migration.done', { name: migrationDone.sourceName })}
              {pendingChecklist > 0 ? ` · ${t('setupMigration.settings.pending', { count: pendingChecklist })}` : ''}
            </DoneLine>
          ) : null}
          {hasModel ? (
            <DoneLine as="li">{t('firstRunGuide.finish.modelReady')}</DoneLine>
          ) : (
            <li className="text-14 leading-relaxed text-[var(--confirm-desc)]">{t('firstRunGuide.finish.modelMissing')}</li>
          )}
          {importState === 'started' ? <DoneLine as="li">{t('firstRunGuide.finish.importStarted')}</DoneLine> : null}
          {nativeToolsFound ? <DoneLine as="li">{t('firstRunGuide.finish.native')}</DoneLine> : null}
        </ul>
      </Centered>
    );
  }

  const last = steps !== null && index === steps.length - 1;
  /** What the cover leads to, so the person knows the guide is short. */
  const upcoming = (steps ?? []).filter((id) => id !== 'intro' && id !== 'finish');
  const closeButton = (
    <Dialog.Close asChild>
      <button
        type="button"
        aria-label={t('firstRunGuide.close')}
        title={t('firstRunGuide.close')}
        className="flex size-7 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </Dialog.Close>
  );

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) closeFirstRunGuide(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-[10000]" style={WINDOW_DRAG_STYLE} />
        <Dialog.Content
          aria-describedby={undefined}
          onPointerDownOutside={(event) => event.preventDefault()}
          style={WINDOW_NO_DRAG_STYLE}
          className="modal-panel fixed inset-0 z-[10000] m-auto flex h-[min(640px,88vh)] w-[min(640px,calc(100vw-32px))] flex-col overflow-hidden outline-none"
        >
          {step === 'intro' ? (
            // Cover: the one page that carries the brand block and no step chrome.
            <div className="first-run-cover relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-8 py-8">
              <div className="absolute right-3 top-3">{closeButton}</div>
              <div className="first-run-rise" style={coverRise(0)}>
                <ThemeBrandLockup theme={theme} />
              </div>
              <Dialog.Title asChild>
                <h2 className="first-run-rise mt-7 text-center text-28 font-medium leading-tight text-[var(--confirm-title)]" style={coverRise(1)}>
                  {t('firstRunGuide.title.new')}
                </h2>
              </Dialog.Title>
              <p className="first-run-rise mt-2 max-w-[440px] text-center text-15 leading-relaxed text-[var(--confirm-desc)]" style={coverRise(2)}>
                {t('firstRunGuide.intro.lead')}
              </p>
              <ul className="mt-8 grid w-full grid-cols-1 gap-3 sm:grid-cols-3">
                {([
                  ['work', <WorkVignette key="work" start={coverSceneStart(0)} />],
                  ['connect', (
                    <ModelsVignette key="connect" start={coverSceneStart(1)} />
                  )],
                  ['continue', <DevicesVignette key="continue" start={coverSceneStart(2)} />],
                ] as const).map(([point, vignette], position) => (
                  <li key={point} className="first-run-rise flex flex-col rounded-xl border border-[var(--border-default)] p-2" style={coverRise(COVER_CARD_INDEX + position)}>
                    {/* A small scene made of the product's own elements instead of a generic icon. */}
                    <div className="flex h-[88px] items-center justify-center rounded-lg bg-[var(--surface-chip)]" aria-hidden="true">
                      {vignette}
                    </div>
                    <div className="flex flex-col gap-1 px-2 pb-2 pt-3">
                      <span className="text-14 font-medium text-[var(--confirm-title)]">{t(`firstRunGuide.intro.${point}.title`)}</span>
                      <span className="text-13 leading-relaxed text-[var(--confirm-desc)]">{t(`firstRunGuide.intro.${point}.body`)}</span>
                    </div>
                  </li>
                ))}
              </ul>
              <div className="first-run-rise mt-8 shrink-0" style={coverRise(COVER_CARD_INDEX + 3)}>
                <Button variant="cta" size="lg" type="button" className="min-w-[168px]" onClick={goNext}>
                  {t('firstRunGuide.intro.start')}
                </Button>
              </div>
              {upcoming.length > 0 ? (
                <p className="first-run-rise mt-3 text-center text-12 text-[var(--text-tertiary)]" style={coverRise(COVER_CARD_INDEX + 4)}>
                  {[t('firstRunGuide.intro.next'), ...upcoming.map((id) => t(`firstRunGuide.steps.${id}`))].join(' · ')}
                </p>
              ) : null}
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3 px-5 pb-3 pt-4">
                <div className="flex min-w-0 items-center gap-4">
                  <Dialog.Title asChild>
                    <h2 className="shrink-0 text-14 font-medium text-[var(--confirm-title)]">{title}</h2>
                  </Dialog.Title>
                  {steps && steps.length > 1 ? (
                    <ol className="flex flex-wrap items-center gap-x-3 gap-y-1.5" aria-label={t('firstRunGuide.stepsLabel')}>
                      {steps.map((id, position) => {
                        const current = position === index;
                        const done = position < index;
                        return (
                          <li
                            key={id}
                            aria-current={current ? 'step' : undefined}
                            className={cn(
                              'flex items-center gap-1.5 text-12',
                              current ? 'text-[var(--confirm-title)]' : 'text-[var(--confirm-desc)]',
                            )}
                          >
                            <span
                              className={cn(
                                'flex h-[18px] w-[18px] items-center justify-center rounded-full border text-10 font-medium',
                                current
                                  ? 'border-[var(--accent-cta-bg)] bg-[var(--accent-cta-bg)] text-[var(--surface-on-card)]'
                                  : done
                                    ? 'border-[var(--surface-chip)] bg-[var(--surface-chip)] text-[var(--text-secondary)]'
                                    : 'border-[var(--border-default)]',
                              )}
                            >
                              {done ? <Check size={10} aria-hidden="true" /> : position + 1}
                            </span>
                            {current ? <span className="font-medium">{t(`firstRunGuide.steps.${id}`)}</span> : null}
                          </li>
                        );
                      })}
                    </ol>
                  ) : null}
                </div>
                {closeButton}
              </div>

              <div key={step ?? 'preparing'} className="min-h-0 flex-1 overflow-y-auto border-y border-[var(--border-default)] px-5 py-4">{body}</div>

              <div className="flex items-center justify-between px-5 pb-4 pt-3">
                {index > 0 ? (
                  <button type="button" onClick={goBack} className="text-13 font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                    {t('setupMigration.back')}
                  </button>
                ) : <span />}
                {last ? (
                  <Button variant="cta" size="lg" type="button" onClick={finish}>{t('firstRunGuide.finish.start')}</Button>
                ) : (
                  <Button variant={settled ? 'cta' : 'secondary'} size="lg" type="button" disabled={!steps} onClick={goNext}>
                    {t(settled ? 'firstRunGuide.next' : 'firstRunGuide.skip')}
                  </Button>
                )}
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function providerIcon(id: string, name: string, routing?: ProviderLogoRouting): ReactNode {
  if (hasProviderLogo(id, routing)) return <ProviderLogoMark providerId={id} routing={routing} size={16} />;
  return <span className="text-13 font-semibold leading-none">{providerMonogram(name)}</span>;
}

/** Neutral icon tile: the only "illustration" the guide uses besides the cover's brand block. */
function IconChip({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-chip)] text-[var(--text-primary)]" aria-hidden="true">
      <Icon size={18} strokeWidth={1.7} />
    </span>
  );
}

// Cover choreography (DESIGN.md §14.4, get-started guide entrance). The blocks arrive briskly,
// top first; each card's scene then plays once and carries the part worth watching. Delays are
// in ms from the moment the cover mounts and mirror `.first-run-cover` in globals.css.
const COVER_RISE_START = 0;
const COVER_RISE_STEP = 45;
const COVER_CARD_INDEX = 3;

function coverRise(index: number): CSSProperties {
  return { '--rise-index': index } as CSSProperties;
}

/** When a card's scene starts: once that card has arrived. */
function coverSceneStart(card: number): number {
  return COVER_RISE_START + (COVER_CARD_INDEX + card) * COVER_RISE_STEP + 150;
}

function at(ms: number): CSSProperties {
  return { '--at': `${ms}ms` } as CSSProperties;
}

/** Cover scene: three tasks are written down and ticked off one after another. */
function WorkVignette({ start }: { start: number }) {
  const widths = ['w-[72%]', 'w-[52%]', 'w-[62%]'];
  return (
    <div className="flex w-[70%] flex-col gap-2 rounded-lg border border-[var(--border-default)] bg-[var(--confirm-bg)] px-2.5 py-2.5">
      {widths.map((width, row) => {
        const written = start + row * 180;
        const last = row === widths.length - 1;
        // The last task is seen running for a moment before it is done as well.
        const done = written + (last ? 380 : 120);
        return (
          <span key={row} className="flex items-center gap-2">
            <span className="relative flex size-[11px] shrink-0 items-center justify-center">
              {last ? (
                <span className="first-run-pop absolute inset-0 flex" style={at(written)}>
                  <span
                    className="first-run-leave size-full rounded-full border-[1.5px] border-[var(--text-tertiary)]"
                    style={at(done)}
                  />
                </span>
              ) : null}
              {/* The wrapper carries the motion: nothing animates on SVG. */}
              <span className="first-run-pop flex" style={at(done)}>
                <Check size={11} strokeWidth={2.2} className="text-[var(--status-success)]" />
              </span>
            </span>
            <span className={cn('first-run-draw h-1.5 rounded-full bg-[var(--border-default)]', width)} style={at(written)} />
          </span>
        );
      })}
    </div>
  );
}

/**
 * Cover scene: three widely known model makers arrive one by one, then a key for everything
 * else. The set is fixed and the same in every edition (owner decision, 2026-11-11); it
 * illustrates "the models you already have" and is not the list of providers offered below.
 */
const COVER_MODEL_MARKS = ['anthropic', 'openai', 'deepseek'] as const;

function ModelsVignette({ start }: { start: number }) {
  const tile = 'first-run-pop flex size-8 items-center justify-center rounded-full border border-[var(--border-default)] bg-[var(--confirm-bg)] text-[var(--text-primary)]';
  return (
    <div className="flex items-center gap-1.5">
      {COVER_MODEL_MARKS.map((kind, position) => (
        <span key={kind} className={tile} style={at(start + position * 100)}>
          <ProviderLogoMark providerId={kind} logoKind={kind} size={15} />
        </span>
      ))}
      <span className={tile} style={at(start + COVER_MODEL_MARKS.length * 100)}>
        <KeyRound size={14} strokeWidth={1.8} />
      </span>
    </div>
  );
}

/** Cover scene: a task on the computer travels to the phone and continues there. */
function DevicesVignette({ start }: { start: number }) {
  const screen = 'flex flex-col justify-center gap-1 rounded border border-[var(--text-tertiary)] bg-[var(--confirm-bg)]';
  // The first line is the same task on both screens; the rest is whatever else is there.
  const lines = (widths: string[], from: number) => widths.map((width, position) => (
    <span
      key={position}
      className={cn('first-run-draw h-1 rounded-full', width, position === 0 ? 'bg-[var(--text-tertiary)]' : 'bg-[var(--border-default)]')}
      style={at(from + position * 60)}
    />
  ));
  const travel = start + 300;
  const phone = travel + 3 * 70;
  return (
    <div className="flex items-end gap-2">
      <span className="first-run-pop flex flex-col items-center gap-0.5" style={at(start)}>
        <span className={cn(screen, 'h-10 w-[62px] px-2')}>{lines(['w-[78%]', 'w-[52%]', 'w-[66%]'], start + 100)}</span>
        <span className="h-[3px] w-[74px] rounded-full bg-[var(--text-tertiary)]" />
      </span>
      <span className="mb-5 flex items-center gap-1">
        {[0, 1, 2].map((dot) => (
          <span key={dot} className="first-run-pop size-1 rounded-full bg-[var(--text-tertiary)]" style={at(travel + dot * 70)} />
        ))}
      </span>
      <span className={cn(screen, 'first-run-pop h-[46px] w-[26px] px-1.5')} style={at(phone)}>
        {lines(['w-full', 'w-[58%]', 'w-[80%]'], phone + 120)}
      </span>
    </div>
  );
}

/** Position in the step's entrance: blocks arrive in reading order, at most six apart. */
function rise(index: number): CSSProperties {
  return { '--rise-index': Math.min(index, 5) } as CSSProperties;
}

/** Lays out a step's blocks and lets each arrive after the one before it (DESIGN.md §14.4). */
function Stagger({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={className}>
      {Children.toArray(children).map((child, position) => (
        <div key={position} className="first-run-rise" style={rise(position)}>{child}</div>
      ))}
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <Stagger className="flex min-h-full flex-col items-center justify-center gap-5 py-2">{children}</Stagger>;
}

function StepHero({ icon, title, body, centered = false }: { icon: LucideIcon; title: string; body?: string; centered?: boolean }) {
  return (
    <div className={cn('flex gap-3', centered ? 'max-w-[440px] flex-col items-center text-center' : 'items-start')}>
      <IconChip icon={icon} />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-20 font-medium leading-snug text-[var(--confirm-title)]">{title}</p>
        {body ? <p className="text-14 leading-relaxed text-[var(--confirm-desc)]">{body}</p> : null}
      </div>
    </div>
  );
}

function ComputerMark({ label, muted = false }: { label: string; muted?: boolean }) {
  return (
    <span className="flex w-[104px] flex-col items-center gap-2">
      <span
        className={cn(
          'flex size-14 items-center justify-center rounded-xl border border-[var(--border-default)]',
          muted ? 'text-[var(--text-tertiary)]' : 'bg-[var(--surface-chip)] text-[var(--text-primary)]',
        )}
      >
        <Laptop size={24} strokeWidth={1.5} />
      </span>
      <span className="text-12 text-[var(--confirm-desc)]">{label}</span>
    </span>
  );
}

function OptionCard({ icon, title, badge, body, action, children }: {
  icon: ReactNode;
  title: string;
  badge: string;
  body: string;
  /** Sits at the end of the title line, so the card needs no extra row for it. */
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5 rounded-xl border border-[var(--border-default)] px-4 py-3">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-chip)] text-[var(--text-primary)]" aria-hidden="true">
          {icon}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-15 font-medium text-[var(--confirm-title)]">{title}</span>
            <span className="shrink-0 rounded-full border border-[var(--border-default)] px-2 py-px text-11 font-medium text-[var(--text-secondary)]">
              {badge}
            </span>
            {action ? <span className="ml-auto shrink-0">{action}</span> : null}
          </div>
          <p className="text-13 leading-relaxed text-[var(--confirm-desc)]">{body}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

/**
 * A provider that is already connected: same row as the ones that can be added, with the
 * account and plan the provider settings show for it.
 */
function ConnectedProviderRow({ provider, onClick }: { provider: ProviderView; onClick: () => void }) {
  const { t } = useTranslation();
  const account = useProviderSubscriptionCard(provider);
  const detail = [account?.identity, account?.planLabel].filter(Boolean).join(' · ');
  return (
    <OptionRow
      icon={providerIcon(provider.id, provider.name, provider.routing)}
      label={provider.name}
      badge={t('firstRunGuide.models.own.connected')}
      sub={detail || undefined}
      onClick={onClick}
    />
  );
}

function OptionRow({ icon, label, sub, badge, onClick }: {
  icon: ReactNode;
  label: string;
  sub?: string;
  badge?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-3 border-t border-[var(--border-default)] px-1 py-1.5 text-left transition-colors hover:bg-[var(--surface-hover)]"
    >
      <span className="grid size-7 shrink-0 place-items-center text-[var(--text-secondary)]">{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="truncate text-14 font-medium text-[var(--text-primary)]">{label}</span>
          {badge ? (
            <span className="shrink-0 rounded-full border border-[var(--border-default)] px-2 py-px text-10 font-medium text-[var(--text-tertiary)]">
              {badge}
            </span>
          ) : null}
        </span>
        {sub ? <span className="truncate text-12 text-[var(--text-tertiary)]">{sub}</span> : null}
      </span>
      <ChevronRight size={14} aria-hidden="true" className="shrink-0 text-[var(--text-tertiary)] transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}

function SectionHeading({ title, hint, action }: { title: string; hint: string; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
      <div className="flex min-w-0 flex-1 basis-[220px] flex-col gap-0.5">
        <span className="text-14 font-medium text-[var(--confirm-title)]">{title}</span>
        <span className="text-12 leading-relaxed text-[var(--confirm-desc)]">{hint}</span>
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}

function DoneLine({ children, as: Tag = 'p' }: { children: ReactNode; as?: 'p' | 'li' }) {
  return (
    <Tag className="flex items-start gap-2 text-13 leading-relaxed text-[var(--confirm-title)]">
      <Check size={14} aria-hidden="true" className="mt-[3px] shrink-0 text-[var(--status-success)]" />
      <span className="min-w-0">{children}</span>
    </Tag>
  );
}
