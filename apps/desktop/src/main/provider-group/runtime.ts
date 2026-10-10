/**
 * 供应商组的运行期单例：组内电脑目录与分配器。设置页(IPC)与任务生命周期(register)共用同一份，
 * 这样设置页看到的「正在运行 / 冷却中」与实际分配一致。
 *
 * 目录缓存、冷却、轮询位置都属于当前账号：换账号后另起一份，旧账号还在路上的远端读取只落进旧的那份，
 * 新账号看不到旧账号的电脑与冷却。调用方拿到的是固定的门面，每次调用按当前账号转发。
 */
import type { ProviderView } from '@cindy/model-providers';

import { activeOwnerScopeKey } from '../appSessionState.js';
import { readProviderGroupSummary } from '../../shared/providerGroup.js';
import { getReceivedShares } from '../device-link/providerShareGuest.js';
import { handleListDevices, defaultDeps as deviceDirectoryDeps } from '../device-link/ipc.js';
import { remoteBackgroundInvoke } from '../device-link/index.js';
import { isMobilePlatform } from '../device-link/controllerPlatform.js';
import { deviceName } from '../device-link/deviceName.js';
import { getDesktopProviderService } from '../maker-host/createDesktopProviderService.js';
import { readDeviceProviderViews } from '../remote-agent/controller/deviceCatalog.js';
import { listProviderGroupBindings } from './bindings.js';
import { createProviderGroupDirectory, type ProviderGroupDirectory } from './directory.js';
import { createProviderGroupExternalLoad, type ProviderGroupExternalLoad } from './externalLoad.js';
import { createProviderGroupRemoteClient, type ProviderGroupRemoteClient } from './remoteClient.js';
import { createProviderGroupRouter, type ProviderGroupRouter } from './router.js';
import type { ProviderGroupRemoteGroups } from './service.js';
import { readProviderGroup } from './store.js';

interface OwnerRuntime {
  owner: string;
  directory: ProviderGroupDirectory;
  router: ProviderGroupRouter;
  externalLoad: ProviderGroupExternalLoad;
}

let current: OwnerRuntime | null = null;
let isTurnRunning: (sessionId: string) => boolean = () => false;
let localLoad: (() => Promise<ReadonlyMap<string, number>>) | null = null;

function runtimeForActiveOwner(): OwnerRuntime {
  const owner = activeOwnerScopeKey();
  if (current?.owner === owner) return current;
  const directory = createProviderGroupDirectory({
    listLocalProviders: () => getDesktopProviderService().listProviders({ allowSideEffects: false }),
    localDeviceName: () => deviceName(),
    listDevices: async () => (await handleListDevices(deviceDirectoryDeps())).devices,
    readDeviceProviders: (agentDeviceId) => readDeviceProviderViews(remoteBackgroundInvoke, agentDeviceId),
    listReceivedShares: () => getReceivedShares(),
    isMobilePlatform: (platform) => isMobilePlatform(platform),
    localRunning: async (providerId) => (await readProviderRunningTurnsByProvider())?.get(providerId) ?? null,
    now: () => Date.now(),
  });
  const externalLoad = createProviderGroupExternalLoad({ now: () => Date.now() });
  const router = createProviderGroupRouter({
    directory,
    readGroup: readProviderGroup,
    listBindings: listProviderGroupBindings,
    isTurnRunning: (sessionId) => isTurnRunning(sessionId),
    externalRunning: (providerId, memberKey) => externalLoad.running(providerId, memberKey),
    now: () => Date.now(),
    random: () => Math.random(),
  });
  current = { owner, directory, router, externalLoad };
  return current;
}

const directoryFacade: ProviderGroupDirectory = {
  resolveMembers: (providerId, config) => runtimeForActiveOwner().directory.resolveMembers(providerId, config),
  listCandidates: (providerId, config) => runtimeForActiveOwner().directory.listCandidates(providerId, config),
  readDeviceCatalog: (agentDeviceId) => runtimeForActiveOwner().directory.readDeviceCatalog(agentDeviceId),
  probe: (agentDeviceId, providerId) => runtimeForActiveOwner().directory.probe(agentDeviceId, providerId),
  memberLabel: (member) => runtimeForActiveOwner().directory.memberLabel(member),
  invalidate: (agentDeviceId) => runtimeForActiveOwner().directory.invalidate(agentDeviceId),
};


const routerFacade: ProviderGroupRouter = {
  pick: (input) => runtimeForActiveOwner().router.pick(input),
  view: (providerId) => runtimeForActiveOwner().router.view(providerId),
  running: (providerId, memberKey) => runtimeForActiveOwner().router.running(providerId, memberKey),
  markCooling: (providerId, memberKey, until) => runtimeForActiveOwner().router.markCooling(providerId, memberKey, until),
  coolingUntil: (providerId, memberKey) => runtimeForActiveOwner().router.coolingUntil(providerId, memberKey),
  markTried: (sessionId, memberKey) => runtimeForActiveOwner().router.markTried(sessionId, memberKey),
  triedThisTurn: (sessionId) => runtimeForActiveOwner().router.triedThisTurn(sessionId),
  resetTurn: (sessionId) => runtimeForActiveOwner().router.resetTurn(sessionId),
};

export function getProviderGroupDirectory(): ProviderGroupDirectory {
  return directoryFacade;
}

export function getProviderGroupRouter(): ProviderGroupRouter {
  return routerFacade;
}

/**
 * 一次分配用的当前账号运行期(不经按调用时账号转发的门面)：选电脑要等目录，等待期间换了账号时，记占用仍
 * 落在这次分配所属账号的那份里，不会记进新账号；`isCurrent()` 为 false 时调用方丢弃这次结果。
 */
export interface ProviderGroupOwnerScope {
  router: ProviderGroupRouter;
  externalLoad: ProviderGroupExternalLoad;
  isCurrent(): boolean;
}

export function getProviderGroupOwnerScope(): ProviderGroupOwnerScope {
  const runtime = runtimeForActiveOwner();
  return {
    router: runtime.router,
    externalLoad: runtime.externalLoad,
    isCurrent: () => activeOwnerScopeKey() === runtime.owner,
  };
}

let remoteClient: ProviderGroupRemoteClient | null = null;

/** 问其他电脑上的组(无状态，按调用时的账号经设备互联发出)。 */
export function getProviderGroupRemoteClient(): ProviderGroupRemoteClient {
  remoteClient ??= createProviderGroupRemoteClient(remoteBackgroundInvoke);
  return remoteClient;
}

/**
 * 任务生命周期用的「另一台电脑上的组」：组设置读那台目录里的组摘要(与组内电脑状态共用同一份短时缓存)，
 * 选电脑、冷却与状态经 `provider-group:remote` 问那台。
 */
export function getProviderGroupRemoteGroups(): ProviderGroupRemoteGroups {
  const client = getProviderGroupRemoteClient();
  return {
    async readGroup(ownerDeviceId, providerId) {
      let views: ProviderView[];
      try {
        views = await directoryFacade.readDeviceCatalog(ownerDeviceId);
      } catch {
        return undefined;
      }
      const view = views.find((candidate) => candidate.id === providerId);
      return view ? readProviderGroupSummary((view as { group?: unknown }).group, providerId) : null;
    },
    pick: (ownerDeviceId, input) => client.pick(ownerDeviceId, input),
    cool: (ownerDeviceId, input) => client.cool(ownerDeviceId, input),
    view: (ownerDeviceId, providerId) => client.view(ownerDeviceId, providerId),
    invalidate: (ownerDeviceId) => directoryFacade.invalidate(ownerDeviceId),
  };
}

/** register 装配会话表后注入：分配器据此统计「正在运行」。 */
export function setProviderGroupTurnProbe(probe: (sessionId: string) => boolean): void {
  isTurnRunning = probe;
}

/** register 装配会话表后注入：这台电脑上每个供应商正在运行一轮的任务数(localLoad.ts)。 */
export function setProviderGroupLocalLoad(probe: (() => Promise<ReadonlyMap<string, number>>) | null): void {
  localLoad = probe;
}

/** 这台电脑上每个供应商正在运行一轮的任务数；还没装配或读不到时返回 null(调用方照旧只算经组的)。 */
export async function readProviderRunningTurnsByProvider(): Promise<ReadonlyMap<string, number> | null> {
  if (!localLoad) return null;
  try {
    return await localLoad();
  } catch {
    return null;
  }
}
