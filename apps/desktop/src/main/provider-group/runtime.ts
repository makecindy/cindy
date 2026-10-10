/**
 * 供应商组的运行期单例：组内电脑目录与分配器。设置页(IPC)与任务生命周期(register)共用同一份，
 * 这样设置页看到的「正在运行 / 冷却中」与实际分配一致。
 *
 * 目录缓存、冷却、轮询位置都属于当前账号：换账号后另起一份，旧账号还在路上的远端读取只落进旧的那份，
 * 新账号看不到旧账号的电脑与冷却。调用方拿到的是固定的门面，每次调用按当前账号转发。
 */
import { activeOwnerScopeKey } from '../appSessionState.js';
import { getReceivedShares } from '../device-link/providerShareGuest.js';
import { handleListDevices, defaultDeps as deviceDirectoryDeps } from '../device-link/ipc.js';
import { remoteBackgroundInvoke } from '../device-link/index.js';
import { isMobilePlatform } from '../device-link/controllerPlatform.js';
import { deviceName } from '../device-link/deviceName.js';
import { getDesktopProviderService } from '../maker-host/createDesktopProviderService.js';
import { readDeviceProviderViews } from '../remote-agent/controller/deviceCatalog.js';
import { listProviderGroupBindings } from './bindings.js';
import { createProviderGroupDirectory, type ProviderGroupDirectory } from './directory.js';
import { createProviderGroupRouter, type ProviderGroupRouter } from './router.js';
import { readProviderGroup } from './store.js';

interface OwnerRuntime {
  owner: string;
  directory: ProviderGroupDirectory;
  router: ProviderGroupRouter;
}

let current: OwnerRuntime | null = null;
let isTurnRunning: (sessionId: string) => boolean = () => false;

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
    now: () => Date.now(),
  });
  const router = createProviderGroupRouter({
    directory,
    readGroup: readProviderGroup,
    listBindings: listProviderGroupBindings,
    isTurnRunning: (sessionId) => isTurnRunning(sessionId),
    now: () => Date.now(),
    random: () => Math.random(),
  });
  current = { owner, directory, router };
  return current;
}

const directoryFacade: ProviderGroupDirectory = {
  resolveMembers: (providerId, config) => runtimeForActiveOwner().directory.resolveMembers(providerId, config),
  listCandidates: (providerId, config) => runtimeForActiveOwner().directory.listCandidates(providerId, config),
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

/** register 装配会话表后注入：分配器据此统计「正在运行」。 */
export function setProviderGroupTurnProbe(probe: (sessionId: string) => boolean): void {
  isTurnRunning = probe;
}
