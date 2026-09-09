/**
 * 手机端语音词典展示模型(纯函数,不碰 UI 与网络)。
 *
 * 手机上的词典是**只读投影**:正本在电脑上,电脑之间用 CRDT 对等同步,手机拉一份
 * 快照用于润色。这里只负责「拿哪些电脑的词典」和「怎么排列词条」,让设置页那一层
 * 只剩渲染。
 */

import type { DeviceView, PresenceSnapshot } from '@cindy/device-link';
import { dictionaryTermKey } from '@cindy/voice-input-core';
import type { MobileVoiceCredentialSyncDictionaryEntry } from '@cindy/maker-shared/device-link-contract';

/** 桌面平台白名单:词典只存在于电脑上,手机之间不互相同步。 */
const DESKTOP_PLATFORMS = new Set(['darwin', 'win32', 'linux']);

export interface MobileVoiceDictionaryHost {
  deviceId: string;
  name: string;
  online: boolean;
}

/**
 * 从设备清单里筛出可能持有词典的电脑。
 *
 * 排除自己(手机没有词典正本)与非桌面平台;在线的排前面,便于用户先看到当前
 * 能拉到最新内容的那台。同名设备按 deviceId 兜底排序,保证顺序稳定。
 */
export function collectMobileVoiceDictionaryHosts(
  devices: readonly DeviceView[],
): MobileVoiceDictionaryHost[] {
  const mapped = devices
    .filter((device) => !device.isSelf && isDesktopDevice(device.platform))
    .map((device) => ({
      deviceId: device.deviceId,
      name: device.name?.trim() || device.deviceId.slice(0, 8),
      online: Boolean(device.online),
    }))
  ;
  return sortHosts(mapped);
}

/** 在线优先,其次按名称,最后用 deviceId 兜底 —— 顺序必须在多次渲染间稳定。 */
function sortHosts(hosts: MobileVoiceDictionaryHost[]): MobileVoiceDictionaryHost[] {
  return [...hosts].sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return a.name.localeCompare(b.name) || (a.deviceId < b.deviceId ? -1 : 1);
  });
}

/**
 * 用一条 presence 事件修正电脑清单。
 *
 * 设备清单来自打开页面那一刻的 REST 快照;presence 是之后的增量真相。没见过的
 * 电脑要补进来(上线后才注册的),已知设备只更新在线状态与名字。返回原数组表示
 * 没有变化,避免无谓重渲染。
 */
export function patchMobileVoiceDictionaryHosts(
  hosts: readonly MobileVoiceDictionaryHost[],
  snapshot: PresenceSnapshot,
): readonly MobileVoiceDictionaryHost[] {
  // 无变化时返回原引用:presence 事件很密集(手机、其它电脑的上下线都会来),
  // 每次都造新数组会让设置页无谓重渲染。
  if (!snapshot?.deviceId || !isDesktopDevice(snapshot.platform)) return hosts;
  const name = snapshot.deviceName?.trim() || snapshot.deviceId.slice(0, 8);
  const index = hosts.findIndex((host) => host.deviceId === snapshot.deviceId);
  if (index < 0) {
    return sortHosts([...hosts, { deviceId: snapshot.deviceId, name, online: Boolean(snapshot.online) }]);
  }
  const previous = hosts[index];
  if (previous.online === Boolean(snapshot.online) && previous.name === name) return hosts;
  const next = [...hosts];
  next[index] = { ...previous, name, online: Boolean(snapshot.online) };
  return sortHosts(next);
}

export function isDesktopDevice(platform: string | null | undefined): boolean {
  return typeof platform === 'string' && DESKTOP_PLATFORMS.has(platform);
}

export interface MobileVoiceDictionaryEntryView {
  /** React key:归一化文本在一份词典里唯一。 */
  key: string;
  text: string;
  /** 别名(误识别写法),已按观察次数降序;没有则为空数组。 */
  aliases: string[];
}

/** 一台电脑的词典快照 + 它的拉取时间。 */
export interface MobileVoiceDictionarySnapshot {
  entries: readonly MobileVoiceCredentialSyncDictionaryEntry[];
  /** 成功拉取的时间(unix ms);从未拉到过为 0。 */
  fetchedAt: number;
  /** 被控端上报的版本向量 `{nodeId: 最大 HLC}`;老版本被控端没有。 */
  stateVector?: Record<string, string>;
  /** 桌面生成投影的时间;有则优先于 fetchedAt 做并列时的先后判断。 */
  emittedAt?: number;
}

/**
 * 从各台电脑的缓存里挑出用户该看到的**那一份**词典。
 *
 * ## 为什么是「取最新」而不是「取并集」
 *
 * 所有电脑收敛到同一份词典,所以任意一份新鲜快照就是完整答案。而并集是错的:
 * 一台电脑离线、缓存停在三天前,另一台在线且刚同步过——如果这期间删掉或改名了
 * 某个词,并集会把那个旧词永久加回列表(频次取 max 更让旧值直接赢)。用户在电脑
 * 上删了词,手机上却怎么刷新都还在。
 *
 * 取最新那份则天然表达了删除:新快照里没有,就是没有。
 *
 * 新鲜度按被控端上报的**版本向量**判断:一份状态的向量逐节点 ≥ 另一份,才说明它
 * 已经见过对方的全部事件、可以放心替代对方。用响应到达时间是错的(并发请求里慢的
 * 那个反而显得"更新"),只比最大 HLC 也是错的 —— 两台电脑各自加了不同的词、还没
 * 互相同步时谁都不包含谁,按最大值挑会漏掉另一份里的词。
 *
 * 真正并发(互不包含)时没有"正确答案":两份都不完整。此时退回按拉取时间取较新的
 * 那份,并依赖桌面之间 8 秒内的自动交换收敛 —— 下次刷新就能拿到合并后的完整状态。
 */
/**
 * 两份快照谁更适合作为"那一份"。
 *
 * 带版本向量的一律优先于不带的(老版本被控端不上报,不该压过一个能证明自己更完整
 * 的快照)。两份都带时:一方包含另一方就选包含者;互不包含(真并发)时没有正确答案,
 * 退回按拉取时间取较新的。
 */
export function isFresherMobileVoiceDictionarySnapshot(
  candidate: MobileVoiceDictionarySnapshot,
  best: MobileVoiceDictionarySnapshot,
): boolean {
  return compareSnapshotFreshness(candidate, best, (left, right) => left.fetchedAt > right.fetchedAt);
}

/** 同一 host 入站防倒灌:并列时比桌面发出时间,不用手机到达时间。 */
export function isFresherSameHostMobileVoiceDictionarySnapshot(
  candidate: MobileVoiceDictionarySnapshot,
  best: MobileVoiceDictionarySnapshot,
): boolean {
  return compareSnapshotFreshness(candidate, best, isLaterByEmittedAt);
}

function compareSnapshotFreshness(
  candidate: MobileVoiceDictionarySnapshot,
  best: MobileVoiceDictionarySnapshot,
  isLater: (
    candidate: MobileVoiceDictionarySnapshot,
    best: MobileVoiceDictionarySnapshot,
  ) => boolean,
): boolean {
  if (candidate.stateVector && best.stateVector) {
    const candidateDominates = dominates(candidate.stateVector, best.stateVector);
    const bestDominates = dominates(best.stateVector, candidate.stateVector);
    if (candidateDominates !== bestDominates) return candidateDominates;
    return isLater(candidate, best);
  }
  if (candidate.stateVector) return true;
  if (best.stateVector) return false;
  return isLater(candidate, best);
}

function isLaterByEmittedAt(
  candidate: MobileVoiceDictionarySnapshot,
  best: MobileVoiceDictionarySnapshot,
): boolean {
  if (candidate.emittedAt !== undefined && best.emittedAt !== undefined) {
    return candidate.emittedAt > best.emittedAt;
  }
  if (candidate.emittedAt !== undefined) return true;
  if (best.emittedAt !== undefined) return false;
  return candidate.fetchedAt > best.fetchedAt;
}

/** `a` 是否已经见过 `b` 的全部事件(逐节点 ≥)。HLC 定长前缀,字符串比较即时间序。 */
function dominates(a: Record<string, string>, b: Record<string, string>): boolean {
  for (const [nodeId, stamp] of Object.entries(b)) {
    const mine = a[nodeId];
    if (mine === undefined || mine < stamp) return false;
  }
  return true;
}

export function buildMobileVoiceDictionaryEntryViews(
  snapshots: ReadonlyArray<MobileVoiceDictionarySnapshot>,
  options?: { maxAliases?: number },
): MobileVoiceDictionaryEntryView[] {
  const maxAliases = options?.maxAliases ?? 3;
  const freshest = snapshots.reduce<MobileVoiceDictionarySnapshot | null>((best, snapshot) => {
    if (!snapshot || snapshot.fetchedAt <= 0) return best;
    return !best || isFresherMobileVoiceDictionarySnapshot(snapshot, best) ? snapshot : best;
  }, null);
  if (!freshest) return [];

  const seen = new Set<string>();
  const views: Array<MobileVoiceDictionaryEntryView & { frequency: number }> = [];
  for (const entry of freshest.entries ?? []) {
    const text = entry?.text?.trim();
    if (!text) continue;
    // 直接用桌面 CRDT 那支主键函数,而不是自己 toLowerCase:它还做了空白归一等
    // 处理,自己写一份迟早会和桌面漂移 —— 那样只差一个空格的两条会在手机上重复
    // 显示,React key 也跟着不稳。
    const key = dictionaryTermKey(text);
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    views.push({
      key,
      text,
      frequency: readPositive(entry.frequency),
      aliases: [...(entry.aliases ?? [])]
        .filter((alias) => alias?.text?.trim())
        .sort((a, b) => readPositive(b.count) - readPositive(a.count) || a.text.localeCompare(b.text))
        .slice(0, maxAliases)
        .map((alias) => alias.text.trim()),
    });
  }

  return views
    .sort((a, b) => b.frequency - a.frequency || a.text.localeCompare(b.text))
    .map(({ key, text, aliases }) => ({ key, text, aliases }));
}

function readPositive(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
}
