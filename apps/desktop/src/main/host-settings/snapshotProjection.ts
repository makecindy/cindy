import type { HostSettingState, HostSettingsSnapshot } from '../../shared/hostSettings.js';
import { NO_PUBLIC_SETTINGS_IDENTIFIERS, type SettingsPublicIdentifiers } from './snapshotProjectionV2.js';
import {
  settingsSnapshotDomainsSchema,
  settingsSnapshotIdentifierSchema,
  type SettingsSnapshotDomains,
} from '../../shared/settingsSnapshot.js';

const unavailable: SettingsSnapshotDomains = {
  newTaskDefaults: { status: 'unavailable', scope: 'owner', boundary: 'nextTask' },
  personalization: { status: 'unavailable', scope: 'owner', boundary: 'nextAgentStart' },
  databaseWarning: { status: 'unavailable', scope: 'profile', boundary: 'immediate' },
  appearance: { status: 'unavailable', scope: 'cloudDesktop', boundary: 'immediate' },
};
type Ready<T> = Extract<HostSettingState<T>, { status: 'ready' }>;
function field<T>(value: T, customized: boolean): { value: T; source: 'default' | 'override' } {
  return { value, source: customized ? 'override' : 'default' };
}
function customized<T>(state: Ready<T>, key: string): boolean {
  return state.customizedKeys.includes(key);
}
function validateDomain<K extends keyof SettingsSnapshotDomains>(key: K, value: unknown): SettingsSnapshotDomains[K] {
  const parsed = settingsSnapshotDomainsSchema.shape[key].safeParse(value);
  return (parsed.success ? parsed.data : { ...unavailable[key] }) as SettingsSnapshotDomains[K];
}

/** 从命名字段新建投影，不复制完整设置对象；坏领域只影响自身，不泄漏原始错误。 */
export function projectSettingsSnapshot(snapshot: HostSettingsSnapshot, publicIds: SettingsPublicIdentifiers = NO_PUBLIC_SETTINGS_IDENTIFIERS): SettingsSnapshotDomains {
  const next = snapshot.newTaskDefaults;
  let newTaskDefaults = { ...unavailable.newTaskDefaults };
  if (next.status === 'ready') {
    const fields: Extract<SettingsSnapshotDomains['newTaskDefaults'], { status: 'supported' }>['fields'] = {
      harness: field(next.value.harness, customized(next, 'harness')),
      fast: field(next.value.fast !== false, customized(next, 'fast')),
      thinking: field(next.value.thinking, customized(next, 'thinking')),
      worktree: field(next.value.worktree, customized(next, 'worktree')),
      plan: field(next.value.planMode, customized(next, 'planMode')),
    };
    const model = settingsSnapshotIdentifierSchema.safeParse(next.value.modelId);
    if (model.success && publicIds.models.has(model.data)) fields.modelId = field(model.data, customized(next, 'modelId'));
    const provider = settingsSnapshotIdentifierSchema.safeParse(next.value.providerId);
    if (provider.success && publicIds.providers.has(provider.data)) fields.providerId = field(provider.data, customized(next, 'providerId'));
    const effortSchema = settingsSnapshotDomainsSchema.shape.newTaskDefaults.options[0].shape.fields.shape.effort;
    const effort = effortSchema.safeParse(field(next.value.effort, customized(next, 'effort')));
    if (effort.success && effort.data) fields.effort = effort.data;
    newTaskDefaults = validateDomain('newTaskDefaults', {
      status: 'supported', scope: 'owner', boundary: 'nextTask', fields,
    });
  }

  const personal = snapshot.personalization;
  const personalization = personal.status === 'ready'
    ? validateDomain('personalization', { status: 'supported', scope: 'owner', boundary: 'nextAgentStart', fields: {
      customized: field(personal.value.isCustomized, personal.value.isCustomized),
    } }) : { ...unavailable.personalization };

  const warning = snapshot.databaseWarning;
  const databaseWarning = warning.status === 'ready'
    ? validateDomain('databaseWarning', { status: 'supported', scope: 'profile', boundary: 'immediate', fields: {
      thresholdGiB: field(warning.value.thresholdGiB, customized(warning, 'thresholdGiB')),
      disabled: field(warning.value.disabled, customized(warning, 'disabled')),
    } }) : { ...unavailable.databaseWarning };

  const appearance = snapshot.appearance;
  const appearanceDomain = appearance.status === 'ready'
    ? validateDomain('appearance', { status: 'supported', scope: 'cloudDesktop', boundary: 'immediate', fields: {
      uiFontSize: field(appearance.value.uiSize, customized(appearance, 'uiSize')),
      codeFontSize: field(appearance.value.codeSize, customized(appearance, 'codeSize')),
      zoomFactor: field(appearance.value.windowZoom, customized(appearance, 'windowZoom')),
      uiFontCustomized: field(customized(appearance, 'uiFamily'), customized(appearance, 'uiFamily')),
      codeFontCustomized: field(customized(appearance, 'codeFamily'), customized(appearance, 'codeFamily')),
    } }) : { ...unavailable.appearance };

  return { newTaskDefaults, personalization, databaseWarning, appearance: appearanceDomain };
}
