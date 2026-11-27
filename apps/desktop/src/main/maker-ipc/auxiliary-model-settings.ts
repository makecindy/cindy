import { registerRuntimeSettingsSection } from '../app-settings/runtime.js';
import type { AppSettingsWriteGuard } from '../app-settings/service.js';
import { z } from 'zod';
/** Settings IPC for the shared auxiliary-model chain. */

import { ipcMain } from 'electron';
import type { Catalog, ModelDisableOverrides } from '@cindy/model-providers';

import {
  isValidAuxiliaryModelListInput,
  type AuxiliaryModelOption,
  type AuxiliaryModelSettings,
  type AuxiliaryModelSettingsPatch,
  type AuxiliaryModelSettingsState,
} from '../../shared/auxiliaryModelSettings.js';
import { decodeCatalogModelPin } from '../../shared/catalogModelPin.js';
import { isIpcError } from '../../shared/ipc-errors.js';
import {
  getUtilityModelProfile,
  isUtilityModelProviderKind,
  utilityTransportLabel,
} from '../../shared/utilityModelProfiles.js';
import { createLogger } from '../logger.js';
import { getDesktopSelectableCatalog } from '../maker-host/createDesktopProviderService.js';
import { getCindyAiProviderName } from '../cindyAiProviderName.js';
import { readModelDisableOverrides } from '../maker-host/model-disable-store.js';
import { readProviderOrder } from '../maker-host/provider-order-store.js';
import {
  readAuxiliaryModelSettings,
  readAuxiliaryModelSettingsState,
  writeAuxiliaryModelSettingsPatch,
} from '../utility-model/auxiliary-model-settings-store.js';
import { refreshAuxiliaryModelHealth, registerAuxiliaryModelHealthIpc } from '../utility-model/auxiliaryModelHealthService.js';
import { hasOneshotProviderCredential } from '../utility-model/oneshotProviderUsability.js';
import {
  buildTextOneshotPinOptions,
  type OneshotCredentialProbe,
  type TextOneshotPinOption,
} from '../utility-model/textOneshotPinOptions.js';
import {
  isUtilityRouteDisabled,
  isUtilityRoutePaymentRequired,
} from '../utility-model/oneShotCandidates.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { MAKER_INVOKE } from './channels.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { trustedHttpError } from '../utility-model/auxiliaryUpstreamError.js';
import { auxiliaryFailureReason } from '../../shared/auxiliaryModelHealth.js';
import { validateTitleOutput } from '../maker-host/title-output-validation.js';
import { captureAuxiliaryRoutes, requestUtilityText } from '../utility-model/oneShotCandidates.js';
import { auxiliaryRouteRefId, parseAuxiliaryModelRef } from '../../shared/auxiliaryModelChain.js';
import { buildAuxiliaryRouteOptions, expandAuxiliaryRouteRef } from '../utility-model/auxiliaryRouteRefs.js';
import type { AuxiliaryModelSettingsTestResult } from '../../shared/auxiliaryModelSettings.js';
import { getEffectiveAuxiliaryModelChain } from '../utility-model/resolveAuxiliaryModelChain.js';
import { dismissAuxiliaryModelNotice, getAuxiliaryModelHealthSnapshot, observeAuxiliarySettingsReads, recoverTestedAuxiliaryRoutes, retainAuxiliaryModelRoutes } from '../utility-model/auxiliary-model-health.js';

const log = createLogger('maker-ipc/auxiliary-model-settings');

function toWireOption(option: TextOneshotPinOption, available: boolean): AuxiliaryModelOption {
  if (
    option.agentKind !== 'codex' &&
    option.agentKind !== 'claude-code' &&
    option.agentKind !== 'pi'
  ) {
    throw new Error(`unsupported auxiliary model agent: ${option.agentKind}`);
  }
  return {
    ...option,
    agentKind: option.agentKind,
    available,
  };
}

function syntheticProfileOption(
  id: string,
  args: {
    catalog: Catalog;
    hasCredential?: OneshotCredentialProbe;
  },
): AuxiliaryModelOption {
  const profile = getUtilityModelProfile(id as Parameters<typeof getUtilityModelProfile>[0]);
  const providerId = profile.transport === 'codex-responses' ? 'openai' : 'xd';
  const provider = args.catalog.providers.find((item) => item.id === providerId);
  const available = Boolean(
    provider &&
    args.hasCredential?.(provider, 'codex') &&
    !isUtilityRouteDisabled(profile) &&
    !isUtilityRoutePaymentRequired(profile),
  );
  return {
    id,
    label: `${profile.model} · ${utilityTransportLabel(profile.transport)}`,
    group: providerId,
    providerId,
    agentKind: 'codex',
    modelId: profile.model,
    modelName: profile.model,
    budget: false,
    subscription: profile.transport === 'codex-responses',
    agentSuffix: 'Codex',
    available,
  };
}

/**
 * Return currently usable choices plus any persisted-but-unavailable selections.
 * The latter remain visible and removable without becoming selectable elsewhere.
 */
export function buildAuxiliaryModelOptions(args: {
  settings: AuxiliaryModelSettings;
  catalog: Catalog;
  overrides: ModelDisableOverrides | undefined;
  providerOrder?: readonly string[];
  hasCredential?: OneshotCredentialProbe;
}): AuxiliaryModelOption[] {
  const available = buildTextOneshotPinOptions(
    args.catalog,
    args.overrides,
    args.providerOrder,
    args.hasCredential,
    'auxiliary',
  );
  const availableIds = new Set(available.map((option) => option.id));
  const result = available.map((option) => toWireOption(option, true));

  const allRoutable = buildTextOneshotPinOptions(
    args.catalog,
    args.overrides,
    args.providerOrder,
    undefined,
    'auxiliary',
  );
  const allById = new Map(allRoutable.map((option) => [option.id, option]));
  for (const pin of args.settings.models) {
    if (availableIds.has(pin)) continue;
    const known = allById.get(pin);
    if (known) {
      result.push(toWireOption(known, false));
      continue;
    }
    if (isUtilityModelProviderKind(pin)) {
      result.push(
        syntheticProfileOption(pin, {
          catalog: args.catalog,
          hasCredential: args.hasCredential,
        }),
      );
      continue;
    }
    const decoded = decodeCatalogModelPin(pin);
    if (!decoded) continue;
    result.push({
      id: pin,
      label: `${decoded.agentKind === 'codex' ? 'Codex' : decoded.agentKind === 'pi' ? 'Pi' : 'Claude Code'} · ${decoded.model} · ${decoded.providerId}`,
      group: decoded.providerId,
      providerId: decoded.providerId,
      agentKind: decoded.agentKind,
      modelId: decoded.model,
      modelName: decoded.model,
      budget: false,
      subscription: false,
      agentSuffix:
        decoded.agentKind === 'codex' ? 'Codex' : decoded.agentKind === 'pi' ? 'Pi' : 'Claude Code',
      available: false,
    });
  }
  return result;
}

function settingsWire(): AuxiliaryModelSettingsState {
  const state = readAuxiliaryModelSettingsState();
  const models = Array.isArray(state.value.models) ? state.value.models : [];
  const settings = { models };
  const catalog = getDesktopSelectableCatalog();
  const modelOptions = buildAuxiliaryModelOptions({
    settings,
    catalog: {
      ...catalog,
      providers: catalog.providers.map((provider) =>
        provider.id === 'xd' ? { ...provider, name: getCindyAiProviderName() } : provider,
      ),
    },
    overrides: readModelDisableOverrides(),
    providerOrder: readProviderOrder(),
    hasCredential: hasOneshotProviderCredential,
  });
  const usable = new Map(modelOptions.filter((option) => option.available).map((option) => [option.id, option]));
  return {
    models,
    isCustomized: state.isCustomized,
    customizedKeys: state.customizedKeys,
    defaults: state.defaults ?? { models: [] },
    // 智能路由排在具体模型前面，与选模型面板一致。
    options: [...buildAuxiliaryRouteOptions(usable, models), ...modelOptions],
  };
}

/** 现在能存的路由引用：智能路由里此刻列着的那些(不管成员能不能用，执行前还会再判断)。 */
function routeRefIds(): string[] {
  return buildAuxiliaryRouteOptions(new Map(), []).map((option) => option.id);
}

export function parseAuxiliaryModelSettingsPatch(
  raw: unknown,
  allowedPins: ReadonlySet<string>,
  persistedPins: ReadonlySet<string> = new Set(),
): AuxiliaryModelSettingsPatch {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throwIpcError('INVALID_PARAMS', 'auxiliary model settings patch required');
  }
  const input = raw as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length === 0 || keys.some((key) => key !== 'models')) {
    throwIpcError('INVALID_PARAMS', 'auxiliary model settings patch has invalid keys');
  }
  if (!isValidAuxiliaryModelListInput(input.models)) {
    throwIpcError('INVALID_PARAMS', 'models must be a unique list of at most 3 auxiliary refs');
  }
  for (const entry of input.models) {
    if (isUtilityModelProviderKind(entry)) continue;
    if (allowedPins.has(entry) || persistedPins.has(entry)) continue;
    throwIpcError('INVALID_PARAMS', 'models contains a catalog pin that is not currently routable');
  }
  return { models: input.models };
}

const AUXILIARY_MODEL_TEST_PROMPT =
  'Create a concise title for a connection test conversation about checking the model connection.';
const AUXILIARY_MODEL_TEST_INSTRUCTIONS =
  'Output only a short title, without quotation marks or ending punctuation.';

export async function testAuxiliaryModelSettings(
  rawPatch: unknown,
  allowedPins: ReadonlySet<string>,
  persistedPins: ReadonlySet<string> = new Set(),
  deps?: {
    maker?: Parameters<typeof requestUtilityText>[0];
    requestText?: typeof requestUtilityText;
    stillCurrent?: () => boolean;
  },
): Promise<AuxiliaryModelSettingsTestResult> {
  const owner = activeOwnerScopeKey();
  const current = () => !isAppSessionBoundaryPending() && owner === activeOwnerScopeKey() && (deps?.stillCurrent?.() ?? true);
  const requestText = deps?.requestText ?? requestUtilityText;
  const patch = parseAuxiliaryModelSettingsPatch(rawPatch, allowedPins, persistedPins);
  const maker = deps?.maker ?? (await import('../maker-host/index.js')).getMaker();
  const models = patch.models ?? [];
  for (const ref of models) {
    // 一格选的是路由：测路由此刻会先用的那个本机模型；本机一个能用的成员都没有就算这一格不可用。
    const routeId = auxiliaryRouteRefId(ref);
    const expanded = routeId !== null ? expandAuxiliaryRouteRef(routeId) : null;
    if (expanded && expanded.length === 0) return { ok: false, model: ref, reason: 'model_unavailable' };
    const parsed = parseAuxiliaryModelRef(expanded ? expanded[0]! : ref);
    if (!parsed || !current()) return { ok: false, model: ref, reason: 'request_failed' };
    if (parsed.kind === 'catalog' && parsed.route.agentDeviceId) return { ok: false, model: ref, reason: 'unsupported_transport' };
    const route = parsed.kind === 'profile' ? { pinnedProfileId: parsed.id } : parsed.route;
    const result = await requestText(maker, AUXILIARY_MODEL_TEST_PROMPT, {
      ...route,
      source: 'auxiliary-model-connection-test',
      maxTokens: 32, timeoutMs: 12_000, disableReasoning: true, reasoningEffort: 'minimal',
      responseInstructions: AUXILIARY_MODEL_TEST_INSTRUCTIONS,
      validateResponse: text => validateTitleOutput(text, 256) !== null,
      beforeDispatch: async () => current(),
      bypassAuxiliaryModelHealth: true,
    });
    if (!result.ok) {
      const attempt = result.attempts.find(item => item.status === 'failed') ?? result.attempts[0];
      const reason = attempt ? auxiliaryFailureReason(attempt)
        : result.reason === 'timeout' ? 'timeout' : 'request_failed';
      if (!current()) throwIpcError('INVALID_PARAMS', 'Session or settings changed');
      return { ok: false, model: ref, reason, ...trustedHttpError(attempt) };
    }
  }
  return { ok: true, tested: models };
}

/**
 * The persistence boundary owns the connection test. Runtime settings and
 * future IPC callers therefore cannot write a new model chain without first
 * exercising every selected route through the real one-shot dispatcher.
 */
let latestSave = 0;
export async function saveAuxiliaryModelSettings(
  rawPatch: unknown,
  allowedPins: ReadonlySet<string>,
  persistedPins: ReadonlySet<string> = new Set(),
  deps?: Parameters<typeof testAuxiliaryModelSettings>[3],
  guard?: AppSettingsWriteGuard,
): Promise<AuxiliaryModelSettingsTestResult> {
  const owner = activeOwnerScopeKey();
  const patch = parseAuxiliaryModelSettingsPatch(rawPatch, allowedPins, persistedPins);
  const revision = ++latestSave;
  const models = patch.models ?? [];
  const routesCurrent = captureAuxiliaryRoutes(models);
  if (models.length > 0) {
    const test = await testAuxiliaryModelSettings(rawPatch, allowedPins, persistedPins, { ...deps, stillCurrent: () => revision === latestSave && routesCurrent() });
    if (!test.ok) return test;
  }
  const assertCurrent = () => {
    if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== owner) throwIpcError('INVALID_PARAMS', 'Session changed');
    if (!routesCurrent()) throwIpcError('INVALID_PARAMS', 'The selected connection changed during testing');
    if (revision !== latestSave) throwIpcError('INVALID_PARAMS', 'A newer auxiliary model configuration was requested');
    // Also checked inside the store lock: a save from an earlier read must not replace a newer one.
    guard?.assertUnchanged();
  };
  assertCurrent();
  await writeAuxiliaryModelSettingsPatch(patch, assertCurrent);
  if (activeOwnerScopeKey() === owner && !isAppSessionBoundaryPending()) {
    const effective = getEffectiveAuxiliaryModelChain();
    if (effective.source === 'custom' && JSON.stringify(effective.refs) === JSON.stringify(models)) {
      recoverTestedAuxiliaryRoutes(models);
    }
    retainAuxiliaryModelRoutes(effective, true);
  }
  return { ok: true, tested: models };
}

export function registerAuxiliaryModelSettingsIpc(): void {
  observeAuxiliarySettingsReads();
  registerAuxiliaryModelHealthIpc();
  ipcMain.handle(MAKER_INVOKE.AUXILIARY_MODEL_HEALTH_DISMISS, (event, sessionId: unknown, noticeId: unknown) => {
    assertTrustedAppRendererEvent(event);
    const args = z.tuple([z.string().min(1).max(200), z.number().int().positive()]).safeParse([sessionId, noticeId]);
    if (!args.success) throwIpcError('INVALID_PARAMS', 'Invalid auxiliary notice');
    dismissAuxiliaryModelNotice(...args.data);
  });
  ipcMain.handle(MAKER_INVOKE.AUXILIARY_MODEL_ROUTE_HEALTH_GET, (event, sessionId?: string) => {
    assertTrustedAppRendererEvent(event);
    return getAuxiliaryModelHealthSnapshot(sessionId);
  });
  ipcMain.handle(MAKER_INVOKE.AUXILIARY_MODEL_SETTINGS_GET, async (event) => {
    assertTrustedAppRendererEvent(event);
    try {
      // 合并整个供应商的路由按供应商目录合成：先让配置读取带上此刻的目录(一秒内的重复读取共用一次，不等别的电脑)。
      await import('../model-groups/desktopResolver.js').then(({ refreshAutoModelGroupRoutes }) => refreshAutoModelGroupRoutes()).catch(() => undefined);
      return settingsWire();
    } catch (error) {
      if (isIpcError(error)) throw error;
      log.warn('failed to read auxiliary model settings', { error });
      throwIpcError('INTERNAL', 'Failed to read auxiliary model settings');
    }
  });

  const updateAuxiliarySettings = async (rawPatch: unknown, guard?: AppSettingsWriteGuard) => {
    try {
      // Persisted intent ignores transient credential readiness, while execution
      // still validates credentials and fails closed immediately before dispatch.
      const allowedPins = new Set(
        buildTextOneshotPinOptions(
          getDesktopSelectableCatalog(),
          readModelDisableOverrides(),
          readProviderOrder(),
          undefined,
          'auxiliary',
        ).map((option) => option.id).concat(routeRefIds()),
      );
      const persistedPins = new Set(readAuxiliaryModelSettings().models);
      const result = await saveAuxiliaryModelSettings(rawPatch, allowedPins, persistedPins, undefined, guard);
      if (!result.ok) return result;
      refreshAuxiliaryModelHealth();
      return settingsWire();
    } catch (error) {
      if (isIpcError(error)) throw error;
      log.warn('failed to write auxiliary model settings', { error });
      throwIpcError('INTERNAL', 'Failed to save auxiliary model settings');
    }
  };
  const testAuxiliarySettings = async (
    rawPatch: unknown,
  ): Promise<AuxiliaryModelSettingsTestResult> => {
    try {
      const allowedPins = new Set(
        buildTextOneshotPinOptions(
          getDesktopSelectableCatalog(),
          readModelDisableOverrides(),
          readProviderOrder(),
          undefined,
          'auxiliary',
        ).map((option) => option.id).concat(routeRefIds()),
      );
      return await testAuxiliaryModelSettings(
        rawPatch,
        allowedPins,
        new Set(readAuxiliaryModelSettings().models),
      );
    } catch (error) {
      if (isIpcError(error)) throw error;
      log.warn('failed to test auxiliary model settings', { error });
      throwIpcError('INTERNAL', '辅助模型连接测试失败');
    }
  };
  ipcMain.handle(MAKER_INVOKE.AUXILIARY_MODEL_SETTINGS_TEST, async (event, rawPatch: unknown) => {
    assertTrustedAppRendererEvent(event);
    return testAuxiliarySettings(rawPatch);
  });
  ipcMain.handle(MAKER_INVOKE.AUXILIARY_MODEL_SETTINGS_SET, async (event, rawPatch: unknown) => {
    assertTrustedAppRendererEvent(event);
    return updateAuxiliarySettings(rawPatch);
  });
  const runtimeUpdate = async (patch: unknown, guard?: AppSettingsWriteGuard) => {
    const result = await updateAuxiliarySettings(patch, guard);
    if ('ok' in result) throwIpcError('INVALID_PARAMS', `Auxiliary model connection test failed (${result.reason})`);
    return result;
  };
  registerRuntimeSettingsSection({
    id: 'auxiliary-models',
    title: '辅助模型',
    description: '辅助任务的模型候选顺序。models 使用当前 options 的 id；空数组恢复自动选择。',
    effective: 'next-request',
    schema: z.strictObject({ models: z.array(z.string().min(1).max(1024)).max(3).optional() }),
    read: settingsWire,
    update: runtimeUpdate,
    reset: guard => runtimeUpdate({ models: [] }, guard),
  });
}
