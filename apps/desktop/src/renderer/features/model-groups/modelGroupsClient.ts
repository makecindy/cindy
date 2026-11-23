/**
 * 模型组在界面这一侧的读写：设置页改完后，选择器不用重开就能看到；新任务发出前把选中的一项解析成具体模型，
 * 并在第一条消息下方写一行用了谁、为什么。配置的事实源在主进程(main/model-groups)。
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import type { ProviderView } from '@cindy/model-providers';

import { remoteAgentProviders } from '@/components/new-chat/unifiedModelSelection';
import type { PluginModelRouteNote } from '@/lib/ccAgent.types';
import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { useProviderShareAgentDevices } from '@/features/provider-share/useProviderShareAgentDevices';
import { useSelectableDevices } from '@/hooks/useControllableDevices';
import { useDevicesProviders } from '@/hooks/useDevicesProviders';
import { useProviders } from '@/hooks/useProviders';
import { deviceDisplayName } from '@/lib/deviceName';
import { createLogger } from '@/lib/logger';
import {
  buildModelGroupRouteNote,
  modelGroupSourceLabel,
  type ModelGroupLocationName,
} from '../../../shared/modelGroupRouteNoteText';

import {
  MODEL_GROUPS_DEFAULTS,
  type ModelGroupAppliedException,
  type ModelGroupCandidate,
  type ModelGroupResolveRequest,
  type ModelGroupResolveResult,
  type ModelGroupRouteNote,
  type ModelGroupSelection,
  type ModelGroupsConfig,
  type ModelGroupSwitchOffer,
  type ModelGroupTraceEntry,
} from '../../../shared/modelGroups';

const log = createLogger('model-groups');

/**
 * 缓存按账号分开：换账号只重新挂载页面，这个模块还在。上一个账号的配置不给新账号看，
 * 上一个账号迟到的读取或排队中的保存也不落到新账号上。
 */
let cached: { owner: string | null; config: ModelGroupsConfig } | null = null;
let loading: { owner: string | null; promise: Promise<void> } | null = null;
const listeners = new Set<() => void>();

const ownerNow = (): string | null => getDataOwnerGeneration().dataOwnerId;
const currentConfig = (): ModelGroupsConfig => (cached && cached.owner === ownerNow() ? cached.config : MODEL_GROUPS_DEFAULTS);

function publish(owner: string | null, next: ModelGroupsConfig): void {
  if (owner !== ownerNow()) return;
  cached = { owner, config: next };
  for (const listener of listeners) listener();
}

export function refreshModelGroups(): Promise<void> {
  const owner = ownerNow();
  if (loading?.owner === owner) return loading.promise;
  // 读不到(含桥接还没有这个接口)只记日志：选择器照常显示其余内容，不让挂载它的页面报错。
  const promise = Promise.resolve()
    .then(() => window.electronAPI.modelGroups.get())
    .then((next) => publish(owner, next))
    .catch((err: unknown) => log.warn('model groups unavailable', err))
    .finally(() => { if (loading?.promise === promise) loading = null; });
  loading = { owner, promise };
  return promise;
}

let saving: Promise<unknown> = Promise.resolve();

/**
 * 保存排队执行，每次都在上一次保存的结果上改：连点两次「上移」或改名后马上再改别的，
 * 后一次不会用旧的一份把前一次盖掉。
 */
export function saveModelGroups(change: (latest: ModelGroupsConfig) => ModelGroupsConfig): Promise<ModelGroupsConfig> {
  const owner = ownerNow();
  const run = saving.then(async () => {
    if (owner !== ownerNow() || cached?.owner !== owner) throw new Error('model groups are not loaded for this account');
    const saved = await window.electronAPI.modelGroups.set(change(cached.config));
    publish(owner, saved);
    return saved;
  });
  saving = run.catch(() => undefined);
  return run;
}

/** 当前账号的模型组；每次挂载重新读一次，覆盖换账号和别的窗口里的修改。 */
export function useModelGroups(enabled = true): { config: ModelGroupsConfig; loaded: boolean } {
  const config = useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    currentConfig,
  );
  useEffect(() => { if (enabled) void refreshModelGroups(); }, [enabled]);
  return { config: enabled ? config : MODEL_GROUPS_DEFAULTS, loaded: cached?.owner === ownerNow() };
}

export async function resolveModelGroup(
  selection: ModelGroupSelection,
  context?: ModelGroupResolveRequest['context'],
  /** 进行中的任务：只在它所在的运行位置里选。 */
  location?: ModelGroupResolveRequest['location'],
): Promise<ModelGroupResolveResult | null> {
  try {
    return await window.electronAPI.modelGroups.resolve({ selection, ...(context ? { context } : {}), ...(location ? { location } : {}) });
  } catch (err) {
    log.warn('model group resolve failed', err);
    return null;
  }
}

/** 只看此刻会选谁：不推进「轮流」，也没有选路凭据(伙伴等保存设置时用，实际选路在主进程)。 */
export async function previewModelGroup(selection: ModelGroupSelection): Promise<ModelGroupResolveResult | null> {
  try {
    return await window.electronAPI.modelGroups.resolve({ selection, dryRun: true });
  } catch (err) {
    log.warn('model group preview failed', err);
    return null;
  }
}

/**
 * 实际采用后提交选路记录，并记下任务用着哪个候选。取消或失败的调用方不进入这里。
 * 沿用原模型也提交选择记录；撞配额提议没有选路凭据，只更新绑定。
 * 失败只记日志：没有记录时撞配额就不提议换来源，其余一切照旧。
 */
export function commitModelGroupDecision(result: ModelGroupResolveResult | null): void {
  if (result?.decisionId) void window.electronAPI.modelGroups.commit(result.decisionId)
    .catch((err: unknown) => log.warn('model group decision commit failed', err));
}

export async function bindModelGroupSession(
  sessionId: string,
  selection: ModelGroupSelection,
  result: ModelGroupResolveResult | Pick<ModelGroupSwitchOffer, 'agentKind' | 'providerId' | 'model'> | null,
): Promise<void> {
  const route: { agentKind: ModelGroupCandidate['agentKind']; providerId: string; model: string; agentDeviceId?: string } | null =
    !result ? null : 'outcome' in result ? (result.outcome === 'routed' ? result.route : null) : result;
  if (result && 'outcome' in result) commitModelGroupDecision(result);
  if (!route) return;
  await window.electronAPI.modelGroups.bindSession({
    sessionId,
    selection,
    route: {
      agentKind: route.agentKind, providerId: route.providerId, model: route.model,
      // 记录带上运行位置：同一个模型在另一台电脑上是另一个来源。
      ...(route.agentDeviceId ? { agentDeviceId: route.agentDeviceId } : {}),
    },
  }).catch((err: unknown) => log.warn('model group session binding failed', err));
}

/** 一个运行位置(另一台电脑或分享来的供应商)显示成什么名字。 */
/**
 * 按已知的电脑与分享名单取位置的名字，与模型选择器里远程那几行同一份名字；分享写「来自 X 的分享」，
 * 名单里没有(已解除配对等)时写「另一台电脑」，不显示 id。
 */
export function modelGroupLocationNameFrom(
  devices: readonly { deviceId: string; name?: string | null }[],
  shareName?: (agentDeviceId: string) => string | null,
): ModelGroupLocationName {
  return (agentDeviceId) => shareName?.(agentDeviceId) ?? deviceDisplayName(agentDeviceId, undefined, devices);
}

/** 本账号的电脑(含离线的)与收到的分享：设置页显示路线里各来源在哪里运行。 */
export function useModelGroupLocationName(): ModelGroupLocationName {
  const { devices } = useSelectableDevices();
  const { nameFor } = useProviderShareAgentDevices();
  return useMemo(() => modelGroupLocationNameFrom(devices, nameFor), [devices, nameFor]);
}

type CandidateRef = Pick<ModelGroupCandidate, 'agentKind' | 'providerId' | 'model' | 'agentDeviceId'>;

export interface ModelGroupCandidateNames {
  provider: ProviderView | undefined;
  modelName: string;
  sourceName: string;
  /** 来源连同运行位置：modelGroupSourceLabel。 */
  sourceLabel: string;
  /** 在它所在位置的目录里找到了这个供应商。 */
  known: boolean;
  /** 供应商已连接、模型在目录里；不在本机的还要求那里允许远程调用。那边的目录还在读时按已连接。 */
  connected: boolean;
}

/**
 * 设置页里各来源的名字与连接状态：本机的看本机目录；另一台电脑或分享来的看那个位置允许远程调用的目录
 * (与模型选择器远程那几行同一份)，只订阅路线里实际用到的位置。
 */
export function useModelGroupCandidateNames(
  candidates: readonly CandidateRef[],
): (candidate: CandidateRef, fallback?: { modelName?: string; sourceName?: string }) => ModelGroupCandidateNames {
  const { t } = useTranslation();
  const { providers } = useProviders();
  const locationName = useModelGroupLocationName();
  const remoteKey = [...new Set(candidates.flatMap((candidate) => (candidate.agentDeviceId ? [candidate.agentDeviceId] : [])))].sort().join('\n');
  const remoteIds = useMemo(() => (remoteKey ? remoteKey.split('\n') : []), [remoteKey]);
  const catalogs = useDevicesProviders(remoteIds);
  // fallback：目录里找不到时用的名字(如选路结果里带回的)，再找不到才显示 id。
  return useCallback((candidate: CandidateRef, fallback?: { modelName?: string; sourceName?: string }) => {
    const agent = candidate.agentKind === 'cc' ? 'claude-code' : candidate.agentKind;
    const catalog = candidate.agentDeviceId ? catalogs.get(candidate.agentDeviceId) : undefined;
    const list = candidate.agentDeviceId ? remoteAgentProviders(catalog?.providers ?? []) : providers;
    const provider = list.find((item) => item.id === candidate.providerId);
    const model = provider?.models[agent]?.find((item) => item.id === candidate.model);
    const sourceName = provider?.name ?? (fallback?.sourceName || candidate.providerId);
    return {
      provider,
      modelName: model?.name ?? (fallback?.modelName || candidate.model),
      sourceName,
      sourceLabel: modelGroupSourceLabel({ sourceName, agentDeviceId: candidate.agentDeviceId }, locationName, t),
      known: !!provider,
      connected: catalog?.loading === true || (!!provider?.connected && !provider.suspended && !!model),
    };
  }, [catalogs, locationName, providers, t]);
}

/**
 * 撞配额横幅出现时问一次：这个任务的路线里还有没有别的来源能接着用。只在横幅挂上、换了任务、换了一个错误，
 * 或任务现在用的模型变了(用户自己换过模型，旧提议作废)时问，不轮询；enabled 变假(横幅消失)即清空。
 */
export function useModelGroupSwitchOffer(
  sessionId: string | null | undefined,
  enabled: boolean,
  errorKey: string | null,
  modelKey: string,
): ModelGroupSwitchOffer | null {
  const [offer, setOffer] = useState<{ key: string; value: ModelGroupSwitchOffer } | null>(null);
  const key = enabled && sessionId ? `${sessionId}\u0000${errorKey ?? ''}\u0000${modelKey}` : null;
  useEffect(() => {
    if (!key || !sessionId) return;
    let cancelled = false;
    window.electronAPI.modelGroups.switchOffer({ sessionId })
      .then((value) => { if (!cancelled) setOffer(value ? { key, value } : null); })
      .catch((err: unknown) => log.warn('model group switch offer unavailable', err));
    return () => { cancelled = true; };
  }, [key, sessionId]);
  return offer && offer.key === key ? offer.value : null;
}

/** 点「换来源」那一刻再核对一次：任务仍在这条路线上、下一个来源仍是提议的那个，才动手。 */
export async function isModelGroupSwitchOfferCurrent(sessionId: string, offer: ModelGroupSwitchOffer): Promise<boolean> {
  try {
    const latest = await window.electronAPI.modelGroups.switchOffer({ sessionId });
    return !!latest && latest.agentKind === offer.agentKind && latest.providerId === offer.providerId && latest.model === offer.model
      && latest.selection.type === offer.selection.type && latest.selection.id === offer.selection.id;
  } catch (err) {
    log.warn('model group switch offer recheck failed', err);
    return false;
  }
}

/**
 * 本机任务：第一条消息下方写一行说明(文字见 shared/modelGroupRouteNoteText 的 buildModelGroupRouteNote)。
 * 另一台电脑上的任务用 writeDeviceModelGroupRouteNote 请那台代写。组已被删除时不写。
 */
export function writeModelGroupRouteNote(
  sessionId: string,
  result: ModelGroupResolveResult | null,
  keptModelName: string,
  t: TFunction,
  locale: string,
  locationName: ModelGroupLocationName,
): void {
  const built = buildModelGroupRouteNote(result, keptModelName, t, locale, locationName);
  if (!built) return;
  const note: PluginModelRouteNote = built;
  const { messages } = window.electronAPI.localDb;
  void (async () => {
    // 首条消息由 main 在开跑时才落库：等到后把说明定在它之后 1ms，排在首条消息下面、回复上面。
    let createdAt: number | undefined;
    for (let attempt = 0; attempt < 40 && createdAt === undefined; attempt += 1) {
      const rows = await messages.list(sessionId, { limit: 10 }).catch(() => null);
      const user = Array.isArray(rows)
        ? (rows as Array<{ role?: unknown; createdAt?: unknown }>).find((row) => row.role === 'user')
        : undefined;
      const userAt = typeof user?.createdAt === 'string' ? Date.parse(user.createdAt) : Number.NaN;
      if (Number.isFinite(userAt)) createdAt = userAt + 1;
      else await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await messages.create(sessionId, {
      clientId: `model-group-route:${sessionId}`,
      role: 'assistant',
      content: '',
      agentMeta: { pluginModelRoute: note },
      ...(createdAt !== undefined ? { createdAt: new Date(createdAt).toISOString() } : {}),
    });
  })().catch((err: unknown) => log.warn('model group route note failed', err));
}

// 说明文字与主进程(定时任务)共用一份，见 shared/modelGroupRouteNoteText。
export {
  buildModelGroupRouteNote,
  modelGroupExceptionText,
  modelGroupSourceLabel,
  modelGroupWhyText,
  type ModelGroupLocationName,
} from '../../../shared/modelGroupRouteNoteText';
