/** Development-only interactive trial client. Never connected to a real owner or disk. */
import { createTrialMcpAuthorization } from './trialMcpAuthorization';
import { createTrialAuthorization } from './trialAuthorization';
import type { CloudSettingsClient } from './client';
import {
  IM_SETTINGS_DOMAINS,
  type SettingsEditableValue,
} from '../../../shared/settingsEditableCatalog';
import { settingsWebUpdateSchema } from '../../../shared/settingsWeb';
import {
  CLOUD_SETTINGS_DOMAINS,
  cloudSettingsStateSchema,
  type CloudSettingsDomain,
  type CloudSettingsState,
} from '../../../shared/cloudSettings';

export function createTrialCloudSettingsClient(): CloudSettingsClient &
  Required<Pick<CloudSettingsClient, 'manage'>> {
  const binding = {
    deviceId: 'cloud-settings-trial',
    runtimeId: crypto.randomUUID(),
    ownerGeneration: 1,
  };
  const defaults: Record<CloudSettingsDomain, Record<string, SettingsEditableValue>> = {
    ...(Object.fromEntries(
      IM_SETTINGS_DOMAINS.map((domain) => [
        domain,
        {
          agentKind: 'claude-code',
          permissionMode: 'auto',
          claudeCode: { providerId: null, modelId: '', effort: 'high' },
          codex: { providerId: null, modelId: '', effort: 'high' },
          pi: { providerId: null, modelId: '', effort: 'high' },
          ...(domain === 'imFeishu' ? { groupPermissionMode: 'auto' } : {}),
        },
      ]),
    ) as unknown as Record<
      'imFeishu' | 'imDiscord' | 'imWechat' | 'imTelegram' | 'imDingtalk' | 'imWecom',
      Record<string, SettingsEditableValue>
    >),
    telegramBehavior: { emojiReactions: 'minimal', replyQuoteGroup: 'first', replyQuoteDm: 'off' },
    telegramGroups: { always: [] },
    wecomNotifications: { enabled: true },
    desktopNotifications: {
      notificationsEnabled: true,
      feishuNotificationsEnabled: false,
      swallowActivationClick: false,
      networkDebugEnabled: false,
    },
    agentResource: {
      maxConcurrentCommands: 4,
      processPriority: 'normal',
      capToolchainThreads: true,
    },
    collaboration: { workerSoftLimit: 4, workerHardLimit: 8, workerIdleReleaseMinutes: 10 },
    gitSafety: { autoSnapshotEnabled: true },
    personalization: { userPrompt: '' },
    desktopGeneral: {
      themeFamilyId: 'default',
      theme: 'system',
      locale: 'system',
      sidebarPinnedMode: 'text',
      sidebarMainMode: 'text',
      ghostPanelRestoreMode: 'bubble',
    },
    privacy: { analyticsEnabled: true },
    subagentModel: { claudeCode: null, codexSmartSubagentRouting: false },
    auxiliaryModel: { models: [] },
    browserBackend: { kind: 'external' },
    memory: { maker: true, claudeCode: false, codex: false, pi: true },
    chatEmbedding: { enabled: true },
    silentEncryptedRetry: { enabled: true },
    terminal: { defaultShellPref: 'auto' },
    builtinTools: {
      feishu_bot: true,
      wechat: true,
      slack: true,
      ssh: true,
      docs: true,
      collab: true,
    },
    lsp: { enabled: true },
    browserTools: { browser: true },
    computerTools: { computer: true },
    databaseWarning: { thresholdGiB: 10, disabled: false },
    diagnostics: { crashAutoUploadEnabled: true },
  };
  const states = new Map<CloudSettingsDomain, CloudSettingsState>(
    CLOUD_SETTINGS_DOMAINS.map<[CloudSettingsDomain, CloudSettingsState]>((domain) => [
      domain,
      {
        domain,
        status: 'ready',
        revision: '1',
        operationId: crypto.randomUUID(),
        value: { ...defaults[domain] },
        defaults: defaults[domain],
        isCustomized: false,
        customizedKeys: [],
        choices: (() => {
          const choices: NonNullable<CloudSettingsState['choices']> = {};
          if (domain.startsWith('im')) {
            choices.agentKind = ['claude-code', 'codex'].map((value) => ({ value, label: value }));
            choices.claudeCode = [
              {
                value: { providerId: 'fixture-provider', modelId: 'fixture-model', effort: 'high' },
                label: 'Cloud model',
                efforts: ['low', 'high'],
              },
            ];
          }
          if (domain === 'telegramGroups')
            choices.always = [{ value: '-100123', label: 'Cloud group' }];
          if (domain === 'desktopGeneral')
            choices.themeFamilyId = [
              { value: 'default', label: 'Classic' },
              { value: 'cindy', label: 'Cindy' },
            ];
          if (domain === 'terminal')
            choices.defaultShellPref = [
              { value: 'auto', label: 'Auto' },
              { value: 'bash', label: 'Bash' },
              { value: 'sh', label: 'sh' },
            ];
          return Object.keys(choices).length ? choices : undefined;
        })(),
      },
    ]),
  );
  const manage = createTrialAuthorization();
  const mcp = createTrialMcpAuthorization();
  let closed = false;
  const check = () => {
    if (closed) throw new Error('CLOSED');
  };
  return {
    async manage(command) {
      check();
      return mcp.owns(command) ? mcp.execute(command) : manage(command);
    },
    async connect() {
      check();
      return {
        version: 1,
        providerAuthorization: 1,
        botAuthorization: 1,
        mcpAuthorization: 1,
        cpuCount: 8,
        ...binding,
        domains: [...CLOUD_SETTINGS_DOMAINS],
      };
    },
    async reconnect() {
      check();
      return {
        version: 1,
        providerAuthorization: 1,
        botAuthorization: 1,
        mcpAuthorization: 1,
        cpuCount: 8,
        ...binding,
        domains: [...CLOUD_SETTINGS_DOMAINS],
      };
    },
    async read(domains) {
      check();
      return structuredClone(domains.map((domain) => states.get(domain)!));
    },
    async save(state, set, clear = []) {
      check();
      settingsWebUpdateSchema.parse({
        domain: state.domain,
        operationId: state.operationId,
        expectedRevision: state.revision,
        set,
        clear,
      });
      const current = states.get(state.domain)!;
      if (state.revision !== current.revision || state.operationId !== current.operationId)
        throw new Error('CONFLICT');
      const customizedKeys = [
        ...new Set([
          ...(current.customizedKeys ?? []).filter((key) => !clear.includes(key)),
          ...Object.keys(set),
        ]),
      ];
      const next = cloudSettingsStateSchema.parse({
        ...current,
        value: {
          ...current.value,
          ...Object.fromEntries(clear.map((key) => [key, current.defaults![key]])),
          ...set,
        },
        revision: String(Number(current.revision) + 1),
        operationId: crypto.randomUUID(),
        isCustomized: !!customizedKeys.length,
        customizedKeys,
      });
      states.set(state.domain, next);
      return { state: structuredClone(next), application: 'applied' };
    },
    close() {
      closed = true;
      states.clear();
    },
  };
}
