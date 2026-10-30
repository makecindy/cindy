import { randomUUID } from 'node:crypto';
import { effectiveSourceIdForModel, isModelVisible, type ProviderView } from '@cindy/model-providers';
import type { resolveNewMakerDefaultTuple } from '../../shared/newMakerDefaultTuple.js';
import type { BotModelRoute } from '../../shared/botModelChain.js';
import { sameModelRoute, type AppDefaultModelSelection } from '../../shared/appDefaultModelSelection.js';
import { activeOwnerScopeKey, getActiveDataOwnerPushStamp, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getDesktopProviderService } from '../maker-host/createDesktopProviderService.js';
import { getMakerIfReady } from '../maker-host/index.js';
import { getModelVisibilityOverride, waitForModelVisibilityMirror } from '../maker-host/model-visibility-mirror.js';
import { getNewMakerModelTuning, getSelectedNewMakerRoute, subscribeNewMakerDefaults } from '../maker-host/newMakerDefaultsCache.js';

/** A narrow bridge to the existing renderer-owned default, never a second settings file. */
let dispatchSelection: ((selection: AppDefaultModelSelection) => void) | null = null;
export function configureAppDefaultModelSelection(dispatch: typeof dispatchSelection): void {
  dispatchSelection = dispatch;
}

/** Validate exactly the requested model; recommendations belong to default
 * selection, never to admission of an explicit task or teammate route. */
function resolveAvailableLocalRoute(
  args: Parameters<typeof resolveNewMakerDefaultTuple>[0] & { preferredRoute?: BotModelRoute | null },
): BotModelRoute | null {
  const preferred = args.preferredRoute;
  // Remote routes are validated against their own authorized catalog below.
  if (!preferred || preferred.agentDeviceId || args.providersLoading || !args.availableAgentsLoaded) return null;
  const agent = preferred.harness === 'claude' ? 'claude-code' : preferred.harness;
  if (!args.availableAgents.has(agent === 'claude-code' ? 'cc' : agent)) return null;
  const providers = args.providers.filter(p => p.connected && !p.suspended && !p.modelDiscoveryFailure)
    .map(p => ({ ...p, models: { ...p.models, [agent]: (p.models[agent] ?? []).filter(m =>
      args.isModelEnabled?.(agent, p.id, m) ?? m.defaultEnabled !== false) } }));
  const providerId = effectiveSourceIdForModel(providers, preferred.providerId, preferred.model, agent);
  return providerId ? { ...preferred, providerId } : null;
}

export function availableAppDefaultModels(input: {
  providers: readonly ProviderView[];
  currentRoute?: BotModelRoute | null;
  tuning?: (agent: 'claude-code' | 'codex' | 'pi', providerId: string, model: string) => { effort?: string; fastMode?: boolean | 'ultrafast' };
  availableAgents: ReadonlySet<'cc' | 'codex' | 'pi'>;
  enabled: NonNullable<Parameters<typeof resolveAvailableLocalRoute>[0]['isModelEnabled']>;
}) {
  const current = resolveAvailableLocalRoute({ providers: input.providers, providersLoading: false,
    availableAgents: input.availableAgents, availableAgentsLoaded: true,
    preferredRoute: input.currentRoute ?? undefined, isModelEnabled: input.enabled });
  return input.providers.flatMap(provider => (['claude-code', 'codex', 'pi'] as const).flatMap(agent =>
    (provider.models[agent] ?? []).flatMap(model => {
      const remembered = input.tuning?.(agent, provider.id, model.id);
      const route: BotModelRoute = { harness: agent === 'claude-code' ? 'claude' : agent,
        providerId: provider.id, model: model.id,
        effort: model.defaultEffort && model.efforts.includes(model.defaultEffort) ? model.defaultEffort : '',
        fastMode: false };
      if (current && current.harness === route.harness && current.providerId === route.providerId
        && current.model === route.model) {
        if (model.efforts.some(effort => effort === current.effort)) route.effort = current.effort;
        route.fastMode = model.supportsFastMode === true && current.fastMode;
      }
      // The picker preference is authoritative for a remembered target, including false Fast.
      if (remembered?.effort !== undefined) route.effort = model.efforts.some(effort => effort === remembered.effort)
        ? remembered.effort : (model.defaultEffort && model.efforts.includes(model.defaultEffort) ? model.defaultEffort : '');
      if (remembered?.fastMode !== undefined) route.fastMode = model.supportsFastMode === true && remembered.fastMode;
      const valid = resolveAvailableLocalRoute({ providers: input.providers, providersLoading: false,
        availableAgents: input.availableAgents, availableAgentsLoaded: true,
        preferredRoute: route, isModelEnabled: input.enabled });
      return valid ? [{ id: JSON.stringify([route.harness, route.providerId, route.model]),
        route, efforts: model.efforts, supportsFastMode: model.supportsFastMode === true,
        supportsUltrafastMode: agent === 'codex' && model.supportsUltrafastMode === true }] : [];
    }),
  ));
}

async function readSelection() {
  const owner = activeOwnerScopeKey();
  const assertOwner = () => {
    if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== owner) throw new Error('账号已变化，请重新查询');
  };
  assertOwner();
  await waitForModelVisibilityMirror();
  const providers = await getDesktopProviderService().listProviders({ allowSideEffects: false });
  assertOwner();
  const current = getSelectedNewMakerRoute(owner) ?? null;
  const inputs = { providers, currentRoute: current,
    tuning: (agent, providerId, model) => getNewMakerModelTuning(owner, agent, providerId, model),
    availableAgents: new Set((getMakerIfReady()?.listAvailableAgents() ?? []).map(agent => agent === 'claude-code' ? 'cc' : agent)),
    enabled: (agent, providerId, model) => isModelVisible(getModelVisibilityOverride(agent, providerId, model.id), model.defaultEnabled),
  } satisfies Parameters<typeof availableAppDefaultModels>[0];
  const available = availableAppDefaultModels(inputs);
  return { owner, assertOwner, current, available, inputs };
}

export async function inspectAppDefaultModel() {
  const { current, available } = await readSelection();
  return { current, available };
}

export interface TaskModelSelection {
  id: string;
  effort?: string;
  fastMode?: boolean | 'ultrafast';
}

/** Resolve one per-task selection from the live catalog; never mutate picker/default preferences. */
export async function resolveTaskModelSelection(selection: TaskModelSelection): Promise<BotModelRoute> {
  const { available } = await inspectAppDefaultModel();
  const option = available.find(entry => entry.id === selection.id);
  if (!option) throw new Error('任务模型已不可用，请重新查询可用模型');
  if (selection.effort !== undefined && !option.efforts.some(effort => effort === selection.effort)) {
    throw new Error('任务模型不支持所选思考深度，请重新选择');
  }
  if (selection.fastMode && (!option.supportsFastMode || (selection.fastMode === 'ultrafast' && !option.supportsUltrafastMode))) {
    throw new Error('任务模型不支持 Fast，请重新选择');
  }
  return { ...option.route,
    ...(selection.effort !== undefined ? { effort: selection.effort } : {}),
    ...(selection.fastMode !== undefined ? { fastMode: selection.fastMode } : {}),
  };
}

/** Resolve legacy implicit sources using the ordinary default policy, without persisting changes. */
export async function resolveAvailableTaskModels(routes: readonly BotModelRoute[]): Promise<Array<BotModelRoute | null>> {
  const owner = activeOwnerScopeKey();
  const local = routes.some(route => !route.agentDeviceId) ? await readSelection() : null;
  return Promise.all(routes.map(async route => {
    if (route.agentDeviceId) {
      const { readRemoteProviderRoute } = await import('../remote-agent/controller/deviceCatalog.js');
      // An unavailable saved source must leave the form open for reselection.
      // Owner changes still invalidate the whole read, including failed requests.
      const assertOwner = () => {
        if (activeOwnerScopeKey() !== owner || isAppSessionBoundaryPending()) throw new Error('账号已变化，请重新选择');
      };
      assertOwner();
      const resolved = await readRemoteProviderRoute({
        agentDeviceId: route.agentDeviceId, agentKind: route.harness === 'claude' ? 'claude-code' : route.harness,
        providerId: route.providerId, model: route.model,
      }).catch(() => { assertOwner(); return null; });
      assertOwner();
      if (!resolved) return null;
      const { provider, model } = resolved;
      if ((route.effort && !model.efforts.some(effort => effort === route.effort)) || (route.fastMode && !model.supportsFastMode)) return null;
      return { ...route, providerId: provider.id };
    }
    if (!local) return null;
    const { available, inputs } = local;
    const resolved = resolveAvailableLocalRoute({ providers: inputs.providers, providersLoading: false,
      availableAgents: inputs.availableAgents, availableAgentsLoaded: true,
      preferredRoute: route, isModelEnabled: inputs.enabled });
    if (!resolved) return null;
    const entry = available.find(item => item.route.harness === resolved.harness
      && item.route.model === resolved.model && item.route.providerId === resolved.providerId);
    return entry && (!resolved.effort || entry.efforts.some(effort => effort === resolved.effort))
      && (!resolved.fastMode || entry.supportsFastMode) ? resolved : null;
  }));
}

/** Check a saved full route without changing the application or teammate's primary model. */
export async function validateTaskModel(route: BotModelRoute): Promise<boolean> {
  return !!(await resolveAvailableTaskModels([route]))[0];
}

/** Wait for a fresh owner-fenced mirror after the real setter persisted the selected route. */
export async function changeAppDefaultModel(id: string, effort?: string, assertCaller: () => void = () => {}) {
  assertCaller();
  const state = await readSelection();
  assertCaller();
  const choice = state.available.find(item => item.id === id);
  if (!choice || (effort !== undefined && effort !== '' && !choice.efforts.some(value => value === effort)))
    throw new Error('该模型或思考档不可用，请重新查询已启用模型');
  const route = { ...choice.route, ...(effort !== undefined ? { effort } : {}) };
  if (!dispatchSelection) throw new Error('客户端默认模型设置入口尚未就绪');
  state.assertOwner();
  assertCaller();
  const dispatch = dispatchSelection;
  await new Promise<void>((resolve, reject) => {
    const requestId = randomUUID();
    const expiresAt = Date.now() + 5000;
    const timer = setTimeout(() => { off(); reject(new Error('未确认默认模型已保存，请查询当前设置后重试')); }, 5000);
    const off = subscribeNewMakerDefaults((confirmedRequestId) => {
      try {
        state.assertOwner();
        if (confirmedRequestId !== requestId) return;
        if (!sameModelRoute(getSelectedNewMakerRoute(state.owner), route)) return;
        clearTimeout(timer); off(); resolve();
      } catch (error) { clearTimeout(timer); off(); reject(error); }
    });
    try {
      dispatch({ requestId, route, expectedRoute: state.current, ownerStamp: getActiveDataOwnerPushStamp(), expiresAt });
    } catch (error) { clearTimeout(timer); off(); reject(error); }
  });
  state.assertOwner();
  assertCaller();
  const current = getSelectedNewMakerRoute(state.owner);
  if (!sameModelRoute(current, route)) throw new Error('默认模型已被其他操作改变，请重新查询');
  return { current: route };
}
