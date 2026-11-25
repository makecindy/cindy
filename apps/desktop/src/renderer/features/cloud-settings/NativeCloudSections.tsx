import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { Tip } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { SettingsCard, SettingsSection } from '@/components/ui/settings-rows';
import { toast } from '@/lib/toast';
import { AgentResourceSectionView } from '@/components/settings/AgentResourceSection';
import { CollaborationSectionView } from '@/components/settings/CollaborationSection';
import { MemorySectionView } from '@/components/settings/MemorySection';
import { GitSafetySectionView } from '@/components/settings/GitSafetySection';
import { TerminalShellSectionView } from '@/components/settings/TerminalShellSection';
import { SilentEncryptedRetryCellView } from '@/components/settings/SilentEncryptedRetryCell';
import { ChatEmbeddingCellView } from '@/components/settings/ChatEmbeddingCell';
import { TipsSectionView } from '@/components/settings/TipsSection';
import { LanguageSectionView } from '@/components/settings/LanguageSection';
import type { LocalePreference } from '@/i18n';
import { LspBetaCellView } from '@/components/settings/LspBetaCell';
import { BuiltinToolsSectionView } from '@/components/settings/BuiltinToolsSection';
import {
  BrowserAutomationHeader,
  ComputerAutomationHeader,
  ComputerUseSectionHeader,
} from '@/components/settings/ComputerUseSection';
import { BrowserBackendSubsection } from '@/components/settings/BrowserBackendSubsection';
import {
  DatabaseWarningSettingsView,
  STORAGE_DATABASE_BODY_CLASS,
  StorageDatabaseSection,
  StorageSectionFrame,
} from '@/components/settings/StorageManagementCard';
import {
  AboutSectionView,
  AnalyticsToggleView,
  CrashAutoUploadToggleView,
  DebugLogToggleView,
  InfoRow,
} from '@/components/settings/AboutSection';
import { ExperimentalSectionView } from '@/components/settings/ExperimentalSection';
import {
  PersonalizationPage,
  PersonalizationPageTitle,
  UserPromptEditor,
} from '@/components/settings/UserPromptSection';
import { CloudUserPromptSection } from './CloudUserPromptSection';
import { CloudStorageUsage } from './CloudStorageUsage';
import { CloudDesktopFallback } from './CloudDesktopFallback';
import {
  CloudAuxiliarySettings,
  CloudSubagentSettings,
} from './CloudModelSettings';
import type { AvailableShell, ShellId } from '../../../shared/terminal-bridge';
import { CLOUD_SETTINGS_LOCALES } from '../../../shared/settingsEditableCatalog';
import { SETTINGS_DISPLAY_LOCALES } from '../../../shared/settingsReadCatalog';
import type {
  CloudSettingsDomain,
  CloudSettingsState,
  CloudSettingsTab,
} from '../../../shared/cloudSettings';

type Props = {
  tab: CloudSettingsTab;
  /** Target device; model pickers read its catalog. */
  deviceId: string;
  /** The instance's display name. */
  name: string;
  states: Partial<Record<CloudSettingsDomain, CloudSettingsState>>;
  disabled: boolean;
  cpuCount?: number;
  /** Instance runtime version from CIS; About shows it like the local app version. */
  appVersion?: string;
  trial: boolean;
  /** The Claude Code, Codex and Pi rows under the Cindy memory switch. */
  memoryAgentRows?: boolean;
  /**
   * Groups the instance still does not answer after the page's automatic reads: each shows a
   * notice where it would be, named as on the page.
   */
  unreadableNotice?: { reload(): void; disabled: boolean };
  /** Groups showing their last value read because the latest read failed: not editable. */
  stale?: (domain: CloudSettingsDomain) => boolean;
  save(
    state: CloudSettingsState,
    set: Record<string, unknown>,
    clear?: string[],
  ): Promise<CloudSettingsState>;
  changed(domain: string, dirty: boolean): void;
};
const num = (s: CloudSettingsState, key: string) => Number(s.value?.[key]);
const bool = (s: CloudSettingsState, key: string) => s.value?.[key] === true;
// Section spacing mirrors SettingsView: General sections are py, the rest pb.
const section = (id: string, content: ReactNode, className = 'pb-[18px]') => (
  <section id={id} key={id} className={className}>
    {content}
  </section>
);
const generalSection = (id: string, content: ReactNode) => section(id, content, 'py-[18px]');
/**
 * A group whose latest read failed keeps its last values in place, faded and not editable. Its
 * heading row stays as it is and carries the failure on its right, where the group's own action
 * would be, so 「重试」 stays usable. The shared views have no
 * faded state, so the rest of the group is marked from outside: everything beside the heading row
 * (and the description right under it) is faded and inert.
 */
function StaleFade({ target }: { target: string }) {
  const marker = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const group = marker.current?.parentElement?.querySelector<HTMLElement>(`#${CSS.escape(target)}`);
    const heading = group?.querySelector<HTMLElement>('h1, h2, h3, h4');
    const status = group?.querySelector<HTMLElement>('[data-cloud-group-status]');
    if (!group || !(heading || status)) return;
    // The heading row: what holds both the heading and the failure on its right (a card whose
    // first row is its heading: that row).
    let row = (status ?? heading!.parentElement ?? heading)!;
    if (status)
      while (row.parentElement && row.parentElement !== group && !(heading && row.contains(heading)))
        row = row.parentElement;
    const marked: HTMLElement[] = [];
    for (let node = row; node !== group && node.parentElement; node = node.parentElement)
      for (const sibling of node.parentElement.children) {
        if (sibling === node || !(sibling instanceof HTMLElement)) continue;
        // The group's description, when it follows the heading row instead of sitting in it.
        if (node === row && sibling.tagName === 'P' && sibling.previousElementSibling === row) continue;
        sibling.inert = true;
        sibling.style.opacity = '0.5';
        marked.push(sibling);
      }
    return () => {
      for (const element of marked) {
        element.inert = false;
        element.style.opacity = '';
      }
    };
  }, [target]);
  return <span ref={marker} hidden />;
}
/**
 * The heading each group has on this page, for the notice that takes its place when the instance
 * does not answer it. Groups sharing one card (tips, About) name the card's rows.
 */
export const CLOUD_GROUP_TITLE_KEYS: Partial<Record<CloudSettingsDomain, string>> = {
  desktopGeneral: 'settings.language.title',
  collaboration: 'settings.sections.collaboration',
  agentResource: 'settings.agentResource.title',
  gitSafety: 'settings.sections.gitSafety',
  lsp: 'settings.sections.experimental',
  personalization: 'settings.personalization.subtitle',
  memory: 'settings.memory.title',
  subagentModel: 'settings.subagentModels.title',
  auxiliaryModel: 'settings.sections.auxiliaryModels',
  terminal: 'settings.terminalShell.title',
  silentEncryptedRetry: 'settings.compatMode.title',
  chatEmbedding: 'settings.compatMode.title',
  builtinTools: 'settings.builtinTools.title',
  browserTools: 'settings.computerUse.browser.title',
  browserBackend: 'settings.computerUse.browserBackend.title',
  computerTools: 'settings.computerUse.directControl.title',
  databaseWarning: 'settings.about.storage.databaseSectionTitle',
  privacy: 'settings.about.analyticsLabel',
  desktopNotifications: 'settings.about.debugLogLabel',
  diagnostics: 'settings.about.logUpload.crashAutoLabel',
};
/** Languages the instance listed; an instance that lists none accepts only the original six. */
const displayLocales = (state: CloudSettingsState): readonly LocalePreference[] => {
  const listed = state.choices?.locale?.map((choice) => choice.value);
  return listed?.length
    ? SETTINGS_DISPLAY_LOCALES.filter((locale) => listed.includes(locale))
    : CLOUD_SETTINGS_LOCALES;
};

function Resource({
  state,
  save,
  changed,
  cpuCount,
  disabled,
  headingStatus,
}: Pick<Props, 'save' | 'changed' | 'cpuCount' | 'disabled'> & {
  state: CloudSettingsState;
  headingStatus?: ReactNode;
}) {
  const { t } = useTranslation();
  const [maxDraft, setMaxDraft] = useState<string | null>(null);
  useEffect(() => {
    changed('agentResource', maxDraft !== null);
  }, [maxDraft, changed]);
  const settings = {
    maxConcurrentCommands: num(state, 'maxConcurrentCommands'),
    processPriority: String(state.value?.processPriority) as 'normal' | 'low' | 'lowest',
    capToolchainThreads: bool(state, 'capToolchainThreads'),
    isCustomized: state.isCustomized,
    customizedKeys: state.customizedKeys,
    defaults: state.defaults,
  } as ComponentProps<typeof AgentResourceSectionView>['settings'];
  const presets = {
    full: { maxConcurrentCommands: 0, processPriority: 'normal', capToolchainThreads: false },
    balanced: {
      maxConcurrentCommands: Math.min(64, Math.max(2, Math.ceil((cpuCount ?? 2) / 2))),
      processPriority: 'low',
      capToolchainThreads: true,
    },
    background: { maxConcurrentCommands: 2, processPriority: 'lowest', capToolchainThreads: true },
  } as const;
  const activePreset =
    (Object.keys(presets) as (keyof typeof presets)[]).find((key) =>
      Object.entries(presets[key]).every(([field, value]) => state.value?.[field] === value),
    ) ?? null;
  const commit = async (set: Record<string, unknown>, clear?: string[]) => {
    try {
      await save(state, set, clear);
    } catch {
      toast.error(t('hostSettings.saveFailed'));
    }
  };
  return (
    <AgentResourceSectionView
      headingStatus={headingStatus}
      settings={settings}
      activePreset={activePreset}
      applyingPreset={disabled}
      maxDraft={maxDraft}
      setMaxDraft={setMaxDraft}
      persist={(key, value) => void commit({ [key]: value })}
      applyPreset={async (id) => {
        if (id === 'balanced' && !cpuCount) {
          toast.error(t('cloudSettings.readFailed'));
          return;
        }
        setMaxDraft(null);
        await commit(presets[id]);
      }}
      reset={() => void commit({}, Object.keys(state.defaults ?? {}))}
    />
  );
}
function Storage({
  state,
  save,
  disabled,
  changed,
}: Pick<Props, 'save' | 'disabled' | 'changed'> & { state: CloudSettingsState }) {
  const [draft, setDraft] = useState(String(state.value?.thresholdGiB));
  const [invalid, setInvalid] = useState(false);
  const dirty = draft !== String(state.value?.thresholdGiB);
  const previous = useRef(state.value?.thresholdGiB);
  useEffect(() => {
    if (draft === String(previous.current)) setDraft(String(state.value?.thresholdGiB));
    previous.current = state.value?.thresholdGiB;
  }, [state]);
  useEffect(() => {
    changed('databaseWarning', dirty);
  }, [dirty, changed]);
  const { t } = useTranslation();
  const persist = async (patch?: { disabled?: boolean; thresholdGiB?: number }) => {
    try {
      const result = await save(
        state,
        patch ?? {},
        patch ? undefined : ['disabled', 'thresholdGiB'],
      );
      setDraft(String(result.value?.thresholdGiB));
    } catch {
      toast.error(t('hostSettings.saveFailed'));
    }
  };
  return (
    <DatabaseWarningSettingsView
      warningThresholdDraft={draft}
      warningThresholdInvalid={invalid}
      warningSaving={disabled}
      warningDisabled={bool(state, 'disabled')}
      warningCustomized={!!state.isCustomized}
      onThresholdChange={(value) => {
        setDraft(value);
        setInvalid(false);
      }}
      saveWarningThreshold={async () => {
        if (!dirty) return;
        const value = Number(draft);
        if (!draft || !Number.isInteger(value) || value < 1 || value > 1024) {
          setInvalid(true);
          return;
        }
        await persist({ thresholdGiB: value });
      }}
      persistWarningSettings={persist}
    />
  );
}

export function NativeCloudSections(props: Props) {
  const {
    tab,
    states,
    save,
    disabled,
    changed,
    trial,
    deviceId,
    name,
    appVersion,
    memoryAgentRows,
    unreadableNotice,
    stale,
  } = props;
  const { t, i18n } = useTranslation();
  // In Chinese a Latin word next to Chinese text gets a space (「读不到 Agent 资源占用设置」).
  const spaced = (text: string) =>
    i18n?.language?.startsWith('zh')
      ? `${/^[A-Za-z0-9]/.test(text) ? ' ' : ''}${text}${/[A-Za-z0-9]$/.test(text) ? ' ' : ''}`
      : text;
  /**
   * The failure in the group's heading row, on the right where its own action would be: a red
   * icon, 「加载失败」 and an icon-only 「重试」.
   */
  const groupStatus = (names: string[]) =>
    unreadableNotice && (
      <div data-cloud-group-status className="flex shrink-0 items-center gap-1">
        <span className="flex items-center gap-1.5 text-12 text-[var(--text-secondary)]">
          <AlertCircle size={14} aria-hidden className="shrink-0 text-[var(--error-fg)]" />
          {t('cloudSettings.groupReadFailed', {
            names: spaced(names.join(t('cloudSettings.groupNameSeparator'))),
          })}
        </span>
        {/* The local restore control in this slot (DefaultOverrideControls.tsx): an icon-only
            quiet button with a tooltip, the list's 「刷新」 icon. */}
        <Tip text={t('commonUi.retry')} side="top">
          <Button
            variant="secondary"
            tone="quiet"
            size="sm"
            className="w-7 px-0"
            type="button"
            disabled={unreadableNotice.disabled}
            onClick={unreadableNotice.reload}
            aria-label={t('commonUi.retry')}
          >
            <RefreshCw size={15} aria-hidden />
          </Button>
        </Tip>
      </div>
    );
  const namesOf = (domains: CloudSettingsDomain[]) => [
    ...new Set(domains.map((d) => t(CLOUD_GROUP_TITLE_KEYS[d]!))),
  ];
  /** Of these groups, the ones showing values from an earlier read: their status for the heading row. */
  const keptStatus = (domains: CloudSettingsDomain[]) => {
    const kept = domains.filter((d) => states[d]?.status === 'ready' && stale?.(d));
    return kept.length ? groupStatus(namesOf(kept)) || undefined : undefined;
  };
  /**
   * These groups when the instance did not answer them. Read before: the last values stay, faded
   * and not editable, and the heading row says so (keptStatus, passed to the group's view). Never
   * read: only the heading row, the group's name on the left and the failure on the right.
   */
  const unreadableHere = (domains: CloudSettingsDomain[], id: string, className?: string) => {
    const missing = domains.filter((d) => states[d]?.status === 'unreadable');
    const kept = domains.filter((d) => states[d]?.status === 'ready' && stale?.(d));
    return (
      <>
        {/* Marked again once the failure shows in the heading row: its slot is no longer faded. */}
        {kept.length > 0 && <StaleFade key={`${id}-stale-${!!unreadableNotice}`} target={id} />}
        {unreadableNotice &&
          missing.length > 0 &&
          section(
            `${id}-unreadable`,
            <SettingsSection
              title={namesOf(missing).join(t('cloudSettings.groupNameSeparator'))}
              action={groupStatus(namesOf(missing))}
            >
              {null}
            </SettingsSection>,
            className,
          )}
      </>
    );
  };
  // The three-mode Git control requires the native mode wire field. The legacy
  // boolean cloud field cannot distinguish existing repositories from all projects.
  // The trial can demonstrate the native control; production does not guess a mode.
  const [trialGitMode, setTrialGitMode] = useState<'off' | 'existing-git' | 'all-projects'>(
    'all-projects',
  );
  const ready = (d: CloudSettingsDomain) => (states[d]?.status === 'ready' ? states[d] : undefined);
  const update = async (d: CloudSettingsDomain, set: Record<string, unknown>, clear?: string[]) => {
    const s = ready(d);
    if (!s || stale?.(d)) throw Error('NOT_READY');
    return save(s, set, clear);
  };
  // Resolves true once the target confirmed the write; failures are reported here.
  const confirmSave = async (
    d: CloudSettingsDomain,
    set: Record<string, unknown>,
    clear?: string[],
  ) => {
    try {
      await update(d, set, clear);
      return true;
    } catch {
      toast.error(t('hostSettings.saveFailed'));
      return false;
    }
  };
  const attempt = async (
    d: CloudSettingsDomain,
    set: Record<string, unknown>,
    clear?: string[],
  ) => {
    await confirmSave(d, set, clear);
  };
  const reset = (d: CloudSettingsDomain) => attempt(d, {}, Object.keys(states[d]?.defaults ?? {}));
  const s = (d: CloudSettingsDomain) => states[d]!;
  const c = (d: CloudSettingsDomain) => !!s(d).isCustomized;
  // One saved key's "customized" mark and reset, for rows the local page shows without one: the
  // instance stores the value even when it equals the default, as this computer does.
  const keyReset = (d: CloudSettingsDomain, key: string) => ({
    customized: !!s(d).customizedKeys?.includes(key),
    disabled,
    onReset: () => void attempt(d, {}, [key]),
  });
  if (tab === 'general')
    return (
      <>
        {ready('desktopGeneral') &&
          generalSection(
            'settings-search-target-general-language',
            <LanguageSectionView
              headingStatus={keptStatus(['desktopGeneral'])}
              locale={s('desktopGeneral').value?.locale as LocalePreference}
              locales={displayLocales(s('desktopGeneral'))}
              disabled={disabled}
              onChange={(locale) => void attempt('desktopGeneral', { locale })}
            />,
          )}
        {states.desktopGeneral?.status === 'unavailable' &&
          generalSection(
            'settings-search-target-general-language',
            // A display language newer than the cloud wire stays in the instance's own settings.
            <div className="flex flex-col gap-[14px]">
              <h2 className="text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]">
                {t('settings.language.title')}
              </h2>
              <CloudDesktopFallback deviceId={deviceId} name={name} />
            </div>,
          )}
        {unreadableHere(['desktopGeneral'], 'settings-search-target-general-language', 'py-[18px]')}
        {ready('collaboration') &&
          generalSection(
            'settings-collaboration',
            <CollaborationSectionView
              headingStatus={keptStatus(['collaboration'])}
              settings={{
                workerSoftLimit: num(s('collaboration'), 'workerSoftLimit'),
                workerHardLimit: num(s('collaboration'), 'workerHardLimit'),
                workerIdleReleaseMinutes: num(s('collaboration'), 'workerIdleReleaseMinutes'),
                isCustomized: c('collaboration'),
              }}
              persist={(key, value) => void attempt('collaboration', { [key]: value })}
              reset={() => void reset('collaboration')}
            />,
          )}
        {unreadableHere(['collaboration'], 'settings-collaboration', 'py-[18px]')}
        {ready('agentResource') &&
          generalSection('settings-agent-resource', <Resource
              {...props}
              state={s('agentResource')}
              headingStatus={keptStatus(['agentResource'])}
            />)}
        {unreadableHere(['agentResource'], 'settings-agent-resource', 'py-[18px]')}
        {trial && unreadableHere(['gitSafety'], 'settings-search-target-general-git-safety', 'py-[18px]')}
        {trial &&
          ready('gitSafety') &&
          generalSection(
            'settings-search-target-general-git-safety',
            <GitSafetySectionView
              headingStatus={keptStatus(['gitSafety'])}
              mode={trialGitMode}
              saving={disabled}
              isCustomized={trialGitMode !== 'all-projects'}
              handleModeChange={setTrialGitMode}
              handleReset={() => setTrialGitMode('all-projects')}
            />,
          )}
        {unreadableHere(['lsp'], 'settings-search-target-general-experimental', 'py-[18px]')}
        {ready('lsp') &&
          generalSection(
            'settings-search-target-general-experimental',
            // The Beta update channel is not shown: CIS updates the instance image.
            <ExperimentalSectionView
              headingStatus={keptStatus(['lsp'])}
              rows={[
                {
                  key: 'lsp',
                  node: (
                    <LspBetaCellView
                      enabled={bool(s('lsp'), 'enabled')}
                      pending={disabled}
                      handleToggle={(next) => attempt('lsp', { enabled: next })}
                      reset={keyReset('lsp', 'enabled')}
                    />
                  ),
                },
              ]}
            />,
          )}
      </>
    );
  if (tab === 'personalization')
    return (
      <>
        {/* A client that reports the prompt (the trial) keeps it; real instances answer over DeviceLink. */}
        {ready('personalization') ? (
          section(
            'settings-search-target-personalization-user-prompt',
            <PersonalizationPage headingStatus={keptStatus(['personalization'])}>
            <UserPromptEditor
              value={String(s('personalization').value?.userPrompt ?? '')}
              ready={!disabled}
              unavailable={false}
              customized={c('personalization')}
              revision={s('personalization').revision}
              ownerKey="cloud-target"
              onDirtyChange={(dirty) => changed('personalization', dirty)}
              setValue={async (value, revision) => {
                if (revision !== s('personalization').revision) throw Error('CONFLICT');
                await update('personalization', { userPrompt: value });
              }}
              resetValue={async (revision) => {
                if (revision !== s('personalization').revision) throw Error('CONFLICT');
                await update('personalization', {}, ['userPrompt']);
              }}
            />
            </PersonalizationPage>,
          )
        ) : trial ? (
          <div className="pb-[14px]">
            <PersonalizationPageTitle />
          </div>
        ) : (
          <CloudUserPromptSection
            deviceId={deviceId}
            disabled={disabled}
            onDirtyChange={(dirty) => changed('personalization', dirty)}
            wrap={(content) =>
              section('settings-search-target-personalization-user-prompt', content)
            }
          />
        )}
        {unreadableHere(['personalization'], 'settings-search-target-personalization-user-prompt')}
        {unreadableHere(['memory'], 'settings-search-target-personalization-memory')}
        {ready('memory') &&
          section(
            'settings-search-target-personalization-memory',
            <MemorySectionView
              headingStatus={keptStatus(['memory'])}
              settingsCustomized={c('memory')}
              makerEnabled={bool(s('memory'), 'maker')}
              makerTogglePending={disabled}
              makerResetPending={false}
              // Like the local page, Cindy memory turns the native Claude Code and Codex memory off
              // at runtime without rewriting their saved choices.
              slots={{
                'claude-code': {
                  enabled: !bool(s('memory'), 'maker') && bool(s('memory'), 'claudeCode'),
                  pending: disabled,
                },
                codex: {
                  enabled: !bool(s('memory'), 'maker') && bool(s('memory'), 'codex'),
                  pending: disabled,
                },
                pi: { enabled: bool(s('memory'), 'pi'), pending: disabled },
              }}
              handleResetSettings={() => reset('memory')}
              handleMakerToggle={(next) => attempt('memory', { maker: next })}
              handleMakerReset={undefined}
              handleReset={undefined}
              handleToggle={(kind, next) =>
                attempt('memory', { [kind === 'claude-code' ? 'claudeCode' : kind]: next })
              }
              agentRows={memoryAgentRows}
            />,
          )}
        {unreadableHere(['subagentModel'], 'settings-search-target-personalization-subagents')}
        {ready('subagentModel') &&
          section(
            'settings-search-target-personalization-subagents',
            <CloudSubagentSettings
              headingStatus={keptStatus(['subagentModel'])}
              state={s('subagentModel')}
              deviceId={deviceId}
              disabled={disabled}
              attempt={confirmSave}
            />,
          )}
        {unreadableHere(['auxiliaryModel'], 'settings-search-target-personalization-auxiliary-models')}
        {ready('auxiliaryModel') &&
          section(
            'settings-search-target-personalization-auxiliary-models',
            <CloudAuxiliarySettings
              headingStatus={keptStatus(['auxiliaryModel'])}
              state={s('auxiliaryModel')}
              disabled={disabled}
              attempt={confirmSave}
            />,
          )}
        {unreadableHere(['terminal'], 'settings-search-target-personalization-terminal-shell')}
        {ready('terminal') &&
          section(
            'settings-search-target-personalization-terminal-shell',
            <TerminalShellSectionView
              headingStatus={keptStatus(['terminal'])}
              pref={String(s('terminal').value?.defaultShellPref) as ShellId}
              shells={(s('terminal').choices?.defaultShellPref ?? [])
                .filter((x) => x.value !== 'auto')
                .map(
                  (x) =>
                    ({
                      id: x.value,
                      command: x.value,
                      displayName: x.label,
                      isAutoDetectTarget: false,
                    }) as AvailableShell,
                )}
              resetting={disabled}
              isCustomized={c('terminal')}
              onChange={(next) => void attempt('terminal', { defaultShellPref: next })}
              onReset={() => reset('terminal')}
              autoLabel={t('settings.terminalShell.auto')}
              unavailablePref={
                s('terminal').value?.defaultShellPref !== 'auto' &&
                !(s('terminal').choices?.defaultShellPref ?? []).some(
                  (choice) => choice.value === s('terminal').value?.defaultShellPref,
                )
                  ? (s('terminal').value?.defaultShellPref as ShellId)
                  : null
              }
            />,
          )}
        {unreadableHere(['silentEncryptedRetry', 'chatEmbedding'], 'settings-search-target-personalization-tips')}
        {(ready('silentEncryptedRetry') || ready('chatEmbedding')) &&
          section(
            'settings-search-target-personalization-tips',
            <TipsSectionView headingStatus={keptStatus(['silentEncryptedRetry', 'chatEmbedding'])}>
              {ready('silentEncryptedRetry') && (
                <SilentEncryptedRetryCellView
                  enabled={bool(s('silentEncryptedRetry'), 'enabled')}
                  isCustomized={c('silentEncryptedRetry')}
                  pending={disabled}
                  handleToggle={(next) => attempt('silentEncryptedRetry', { enabled: next })}
                  handleReset={() => reset('silentEncryptedRetry')}
                />
              )}
              {ready('chatEmbedding') && (
                <ChatEmbeddingCellView
                  enabled={bool(s('chatEmbedding'), 'enabled')}
                  isCustomized={c('chatEmbedding')}
                  pending={disabled}
                  handleToggle={(next) => attempt('chatEmbedding', { enabled: next })}
                  handleReset={() => reset('chatEmbedding')}
                />
              )}
            </TipsSectionView>,
          )}
      </>
    );
  if (tab === 'builtin-tools' && !ready('builtinTools'))
    return unreadableHere(['builtinTools', 'browserTools'], 'settings-builtin-tools');
  if (tab === 'builtin-tools')
    return (
      <>
      {unreadableHere(['builtinTools', 'browserTools'], 'settings-builtin-tools')}
      {/* The group the failure fades: the shared view has no id of its own here. */}
      <div id="settings-builtin-tools">
      <BuiltinToolsSectionView
        headingStatus={keptStatus(['builtinTools', 'browserTools'])}
        plugins={[
          // The browser tool is the same switch as browser automation; local lists it first.
          ...(ready('browserTools')
            ? [
                {
                  id: 'browser',
                  value: s('browserTools').value?.browser,
                  customized: s('browserTools').customizedKeys?.includes('browser'),
                },
              ]
            : []),
          ...Object.entries(s('builtinTools').value ?? {}).map(([id, value]) => ({
            id,
            value,
            customized: s('builtinTools').customizedKeys?.includes(id),
          })),
        ].map(({ id, value, customized }) => ({
          id,
          name: id,
          description: '',
          effectiveEnabled: value === true,
          userOverride: customized ? { enabled: value === true } : null,
        }))}
        pendingIds={
          new Set(
            disabled
              ? ['browser', ...Object.keys(s('builtinTools').value ?? {})]
              : [],
          )
        }
        handleToggle={(id, next) =>
          void (id === 'browser'
            ? attempt('browserTools', { browser: next })
            : attempt('builtinTools', { [id]: next }))
        }
        handleClearOverride={(id) =>
          void (id === 'browser'
            ? attempt('browserTools', {}, ['browser'])
            : attempt('builtinTools', {}, [id]))
        }
      />
      </div>
      </>
    );
  if (tab === 'computer-use')
    return (
      <div className="flex flex-col gap-[14px]">
        <ComputerUseSectionHeader />
        {unreadableHere(['browserTools', 'browserBackend'], 'automation-browser', '')}
        {ready('browserTools') && (
          <>
            <SettingsCard id="automation-browser">
              <BrowserAutomationHeader
                headingStatus={keptStatus(['browserTools', 'browserBackend'])}
                checked={bool(s('browserTools'), 'browser')}
                disabled={disabled}
                onChange={(next) => void attempt('browserTools', { browser: next })}
                reset={keyReset('browserTools', 'browser')}
              />
              {/* Real-profile reuse, Chrome detection and the login window act on the
                  target computer's browser; they are not settings and stay local-only. */}
              {ready('browserBackend') && (
                <BrowserBackendSubsection
                  active={String(s('browserBackend').value?.kind) as 'external' | 'rsb-webview'}
                  pending={disabled}
                  recovering={false}
                  health={null}
                  onSelect={(kind) => void attempt('browserBackend', { kind })}
                  onRecover={() => undefined}
                  reset={keyReset('browserBackend', 'kind')}
                />
              )}
            </SettingsCard>
            <p className="text-12 leading-[1.5] text-[var(--settings-section-desc)]">
              {t('settings.computerUse.browser.toggleHint')}
            </p>
          </>
        )}
        {unreadableHere(['computerTools'], 'automation-computer', '')}
        {ready('computerTools') && (
          <>
            <div aria-hidden="true" className="h-px bg-[var(--settings-theme-card-border)]" />
            <SettingsCard id="automation-computer">
              <ComputerAutomationHeader
                headingStatus={keptStatus(['computerTools'])}
                checked={bool(s('computerTools'), 'computer')}
                disabled={disabled}
                onChange={(next) => void attempt('computerTools', { computer: next })}
                reset={keyReset('computerTools', 'computer')}
              />
            </SettingsCard>
          </>
        )}
      </div>
    );
  if (tab === 'storage' && !ready('databaseWarning'))
    return unreadableHere(['databaseWarning'], 'settings-storage-database');
  if (tab === 'storage')
    return (
      <StorageSectionFrame description={t('cloudSettings.storageDescription')}>
        {/* The instance disk is fixed in size; the preview has none. */}
        {!trial && (
          <CloudStorageUsage
            deviceId={deviceId}
            name={name}
            thresholdGiB={Number(s('databaseWarning').value?.thresholdGiB) || 0}
            active
          />
        )}
        {unreadableHere(['databaseWarning'], 'settings-storage-database')}
        <div id="settings-storage-database">
          <StorageDatabaseSection headingStatus={keptStatus(['databaseWarning'])}>
            <div className={STORAGE_DATABASE_BODY_CLASS}>
              <Storage {...props} state={s('databaseWarning')} />
            </div>
          </StorageDatabaseSection>
        </div>
        <CloudDesktopFallback
          deviceId={deviceId}
          name={name}
          label={t('cloudSettings.storageCleanupTitle')}
          description={t('bots.remoteSettings.finishOnHost', { device: name })}
        />
      </StorageSectionFrame>
    );
  if (tab === 'about' && !(appVersion || ready('privacy') || ready('desktopNotifications') || ready('diagnostics')))
    return unreadableHere(['privacy', 'desktopNotifications', 'diagnostics'], 'settings-about');
  if (tab === 'about')
    return (
      <>
      {/* The rows share one card: its failure goes in the page heading, and the card fades. */}
      {unreadableHere(['privacy', 'desktopNotifications', 'diagnostics'], 'settings-about')}
      <div id="settings-about">
      <AboutSectionView
        headingStatus={keptStatus(['privacy', 'desktopNotifications', 'diagnostics'])}
        card={
          <>
            {appVersion && (
              <>
                <InfoRow label={t('settings.about.appVersionLabel')} value={appVersion} />
              </>
            )}
            {ready('privacy') && (
              <AnalyticsToggleView
                customized={c('privacy')}
                enabled={bool(s('privacy'), 'analyticsEnabled')}
                disabled={disabled}
                handleReset={() => attempt('privacy', {}, ['analyticsEnabled'])}
                handleToggle={(next) => attempt('privacy', { analyticsEnabled: next })}
              />
            )}
            {ready('desktopNotifications') && (
              <>
                <DebugLogToggleView
                  enabled={bool(s('desktopNotifications'), 'networkDebugEnabled')}
                  disabled={disabled}
                  onChange={(next) =>
                    void attempt('desktopNotifications', { networkDebugEnabled: next })
                  }
                  reset={keyReset('desktopNotifications', 'networkDebugEnabled')}
                />
              </>
            )}
            {ready('diagnostics') && (
              <CrashAutoUploadToggleView
                customized={c('diagnostics')}
                enabled={bool(s('diagnostics'), 'crashAutoUploadEnabled')}
                disabled={disabled}
                resetting={disabled}
                handleToggle={(next) => attempt('diagnostics', { crashAutoUploadEnabled: next })}
                handleReset={() => reset('diagnostics')}
              />
            )}
          </>
        }
      />
      </div>
      </>
    );
  return null;
}
