import { randomUUID } from 'node:crypto';
import { isModelVisible, type ProviderView } from '@cindy/model-providers';
import { defaultBotModelChain } from '../../shared/botDefaultModelChain.js';
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

export function availableAppDefaultModels(input: {
  providers: readonly ProviderView[];
  currentRoute?: BotModelRoute | null;
  tuning?: (agent: 'claude-code' | 'codex' | 'pi', providerId: string, model: string) => { effort?: string; fastMode?: boolean };
  availableAgents: ReadonlySet<'cc' | 'codex' | 'pi'>;
  enabled: NonNullable<Parameters<typeof defaultBotModelChain>[0]['isModelEnabled']>;
}) {
  const current = defaultBotModelChain({ providers: input.providers, providersLoading: false,
    availableAgents: input.availableAgents, availableAgentsLoaded: true,
    preferredRoute: input.currentRoute ?? undefined, isModelEnabled: input.enabled })[0];
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
      const valid = defaultBotModelChain({ providers: input.providers, providersLoading: false,
        availableAgents: input.availableAgents, availableAgentsLoaded: true,
        preferredRoute: route, isModelEnabled: input.enabled });
      return valid.length ? [{ id: JSON.stringify([route.harness, route.providerId, route.model]),
        route, efforts: model.efforts, supportsFastMode: model.supportsFastMode === true }] : [];
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
  const available = availableAppDefaultModels({ providers, currentRoute: current,
    tuning: (agent, providerId, model) => getNewMakerModelTuning(owner, agent, providerId, model),
    availableAgents: new Set((getMakerIfReady()?.listAvailableAgents() ?? []).map(agent => agent === 'claude-code' ? 'cc' : agent)),
    enabled: (agent, providerId, model) => isModelVisible(getModelVisibilityOverride(agent, providerId, model.id), model.defaultEnabled),
  });
  return { owner, assertOwner, current, available };
}

export async function inspectAppDefaultModel() {
  const { current, available } = await readSelection();
  return { current, available };
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
