import type { MakerVendor } from '@/lib/ccAgent.types';
import type { AgentKind } from '@/hooks/useAgentCapabilities';

/**
 * 「到另一台电脑新建任务」时，引擎跟随那台电脑自己的新建任务选择。
 *
 * 远程草稿的模型、权限按被控端在**当前引擎**下记住的值播种；引擎却是控制端草稿共用的
 * vendor。控制端从没设过引擎(例如新装的电脑默认 Pi)时，远程草稿就会拿到被控端 Pi 那格
 * 的旧选择，和被控端自己新建任务时看到的完全不同。所以进入远程目标、拿到被控端的
 * selectedAgentKind 后切到同一引擎；回到本机时，用户期间没手动换过引擎就切回原来的。
 *
 * 状态放模块级而不是组件 ref：发送后草稿页会卸载，回到本机往往发生在下一次挂载。
 * 远程目标本身不跨重启持久化，这份记录也不需要。
 */
interface FollowEntry {
  ownerId: string | null;
  deviceId: string;
  /** 进入远程目标前本机草稿的引擎，回到本机时还原。 */
  localVendor: MakerVendor;
  /** 进入这台电脑时的引擎；拿到默认值前用户换过引擎就不再自动切。 */
  vendorAtEntry: MakerVendor;
  /** 这次自动切到的引擎；null = 没切过。 */
  followedVendor: MakerVendor | null;
  manuallySelected: boolean;
  settled: boolean;
}

let entry: FollowEntry | null = null;

function vendorForAgentKind(kind: AgentKind): MakerVendor {
  return kind === 'claude-code' ? 'cc' : kind;
}

function sameEngine(vendor: MakerVendor, kind: AgentKind): boolean {
  // orca 是 Claude Code 上的协同形态，与 cc 同一引擎。
  return vendorForAgentKind(kind) === (vendor === 'orca' ? 'cc' : vendor);
}

/**
 * 每次草稿目标、引擎或被控端默认值变化时调用；返回需要切到的引擎，null 表示不动。
 * 调用方只在返回非空时 switchVendor(系统切换，不标记用户自定义)。
 */
export function nextRemoteDraftEngine(args: {
  ownerId: string | null;
  /** 当前远程目标；null = 本机草稿。 */
  deviceId: string | null;
  currentVendor: MakerVendor;
  /** 本次请求/推送已确认默认值；旧缓存不算就绪，旧端无字段仍算确认。 */
  defaultsReady: boolean;
  selectedAgentKind: AgentKind | undefined;
}): MakerVendor | null {
  const { ownerId, deviceId, currentVendor } = args;
  if (entry && entry.ownerId !== ownerId) entry = null;

  if (!deviceId) {
    const leaving = entry;
    entry = null;
    if (
      leaving?.followedVendor && !leaving.manuallySelected &&
      currentVendor === leaving.followedVendor &&
      leaving.localVendor !== currentVendor
    ) {
      return leaving.localVendor;
    }
    return null;
  }

  if (!entry || entry.deviceId !== deviceId) {
    const previous = entry;
    const stillFollowed = previous?.followedVendor != null && previous.followedVendor === currentVendor;
    entry = {
      ownerId,
      deviceId,
      localVendor: previous && !previous.manuallySelected ? previous.localVendor : currentVendor,
      vendorAtEntry: currentVendor,
      followedVendor: stillFollowed ? previous!.followedVendor : null,
      manuallySelected: false,
      settled: false,
    };
  }

  if (entry.settled || entry.manuallySelected || !args.defaultsReady) return null;
  entry.settled = true;
  // 默认值到之前用户自己换了引擎：尊重他的选择。
  if (currentVendor !== (entry.followedVendor ?? entry.vendorAtEntry)) {
    entry.manuallySelected = true;
    return null;
  }
  const target = args.selectedAgentKind;
  if (!target || sameEngine(currentVendor, target)) return null;
  const next = vendorForAgentKind(target);
  entry.followedVendor = next;
  return next;
}

/** 手动选择是事件，即使切回自动跟随值也不能恢复自动资格。 */
export function markRemoteDraftEngineManuallySelected(): void {
  if (entry) entry.manuallySelected = true;
}

/** 自动跟随仅影响当前窗口；本机偏好镜像和落盘始终使用原来的引擎。 */
export function persistedDraftVendor(ownerId: string | null, current: MakerVendor): MakerVendor {
  return entry?.ownerId === ownerId && entry.followedVendor && !entry.manuallySelected
    ? entry.localVendor : current;
}

/** A controller changed this computer's default while this window may be following another one. */
export function vendorAfterRemotePreferenceWrite(ownerId: string | null, selected: MakerVendor): MakerVendor {
  if (entry?.ownerId === ownerId && entry.followedVendor && !entry.manuallySelected) {
    entry.localVendor = selected;
    return entry.followedVendor;
  }
  return selected;
}

export function resetRemoteDraftEngineFollow(): void {
  entry = null;
}
