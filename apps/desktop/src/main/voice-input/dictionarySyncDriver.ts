/**
 * 词典在本账号桌面设备之间的对等同步驱动。
 *
 * 传输走 device-link 的 push 帧:relay 只按 dst 转发,不解析、不落盘,所以词典内容
 * (含人名、内部项目名、代号)全程不进服务端存储。push 不在 relay 的 CONTROL_KINDS
 * 里,因此桌面之间交换词典**不要求**对方打开「允许被控」。
 *
 * ## 为什么可以不管丢帧
 *
 * relay 不暂存离线消息,目标不在线就直接失败。这里完全不做重试、ack 或补偿 ——
 * 交换的是整份 CRDT 状态,合并幂等且可交换,这次没送到,下次任一触发时机再送一次
 * 就收敛。为此触发点铺了三层:对端上线、本地变更(去抖)、以及长周期兜底。
 *
 * 手机不参与这条通道:移动端在后台不维持 WebSocket,收不到 push。它改用
 * `device-link:voice:dictionary:get` 主动向在线桌面拉一份只读快照。
 */

import { MAX_FRAME_BYTES } from '@cindy/device-link';
import { buildStateVersionVector, type VoiceDictionarySyncState } from '@cindy/voice-input-core';

import { createLogger } from '../logger.js';
import { voiceDictionarySyncStore } from './VoiceDictionarySyncStore.js';
import { voiceInputDataStore } from './VoiceInputDataStore.js';

const log = createLogger('voice-input:dictionary-sync-driver');

/** push 帧 channel。payload 形状见 {@link DictionarySyncFramePayload}。 */
export const DL_VOICE_DICTIONARY_SYNC_CHANNEL = 'device-link:voice:dictionary:sync-state';

/** 本地变更后的去抖窗口:连续学习/编辑合并成一次广播。 */
const BROADCAST_DEBOUNCE_MS = 8_000;
/** 兜底心跳:即便没有任何本地变更,也定期交换一次,收敛因丢帧错过的状态。 */
const BROADCAST_INTERVAL_MS = 30 * 60 * 1000;
/** 桌面平台白名单:手机(ios/android)不参与 push 同步。 */
const DESKTOP_PLATFORMS = new Set(['darwin', 'win32', 'linux']);
/**
 * 单帧状态的字节上限,留出信封与编码余量。
 *
 * relay 对超过 {@link MAX_FRAME_BYTES} 的帧直接拒绝,而 `sendEnvelope` 是抛错的 ——
 * 词典一旦大到越线,此后每一次广播都抛,同步会永久静默停摆。1000 条词条 × 8 个
 * 别名 × 120 字符,加上 CRDT 的化身、计数器、墓碑元数据,中文按 3 字节算完全可能
 * 越线,所以必须在发送前自己把关。
 */
const MAX_STATE_FRAME_BYTES = Math.floor(MAX_FRAME_BYTES * 0.9);

export interface DictionarySyncFramePayload {
  /** 帧结构版本;收到不认识的版本直接忽略,不猜着解析。 */
  frameVersion: 1;
  state: VoiceDictionarySyncState;
  /**
   * 请求对端无条件回发一次自己的状态。
   *
   * 平时只在「合并引入了新信息」时回发,省掉无谓的往返。但有一种情形必须显式索取:
   * 发送方自己落后了(比如同步关了一段时间,期间对端学了新词)。这时对端合并完
   * 发现自己已是超集、`changed === false`,就不会回发,发送方要一直等到对端下次
   * 编辑或半小时兜底才追得上。
   */
  requestReply?: boolean;
}

export interface DictionarySyncTransport {
  /** 发一帧状态给指定设备(尽力而为,失败只记日志)。 */
  sendState(deviceId: string, payload: DictionarySyncFramePayload): void;
  /** 当前在线的同账号**桌面**设备。 */
  listOnlineDesktopDevices(): string[];
}

let transport: DictionarySyncTransport | null = null;
let debounceTimer: NodeJS.Timeout | null = null;
let intervalTimer: NodeJS.Timeout | null = null;

export function isDesktopPlatform(platform: string | undefined | null): boolean {
  return typeof platform === 'string' && DESKTOP_PLATFORMS.has(platform);
}

/**
 * 是否与某台设备交换词典。
 *
 * 判定收敛成这一个函数,因为它有三个独立入口(presence 上线即发、入站帧受理、
 * 广播时的对端列表),分散写条件必然漏——最初就漏在 presence 那条上,导致词典
 * 会推给用户明确撤销过的设备。
 *
 * - 必须在线:relay 不暂存离线消息,发了也白发;
 * - 必须是电脑:手机在后台收不到 push,走主动拉取;
 * - 撤销过的设备一律排除:撤销的意图是「不再跟这台设备交换数据」,不只是
 *   「不许它操作我」。
 */
export function shouldExchangeDictionaryWith(device: {
  online: boolean;
  platform: string | undefined | null;
  revoked: boolean;
}): boolean {
  return device.online && !device.revoked && isDesktopPlatform(device.platform);
}

export function initVoiceDictionarySync(next: DictionarySyncTransport): void {
  transport = next;
  if (intervalTimer) clearInterval(intervalTimer);
  intervalTimer = setInterval(() => broadcastToAllPeers('interval'), BROADCAST_INTERVAL_MS);
  // 定时器不该让 app 因为它而活着(Electron main 里 unref 是良好习惯)。
  intervalTimer.unref?.();
}

export function stopVoiceDictionarySync(): void {
  transport = null;
  if (debounceTimer) clearTimeout(debounceTimer);
  if (intervalTimer) clearInterval(intervalTimer);
  debounceTimer = null;
  intervalTimer = null;
}

/** 对端桌面上线:立刻单发一次,让它尽快拿到本机状态(它也会回发自己的)。 */
export function handleDesktopPeerOnline(deviceId: string): void {
  if (!isSyncEnabled()) return;
  // 对端刚上线,它离线期间本机的状态可能已经落后于它 —— 一并索取回发。
  sendStateTo(deviceId, 'peer-online', { requestReply: true });
}

/**
 * 立即广播一次当前状态,不走去抖。
 *
 * 用于用户刚打开同步开关这类显式操作:此时对端可能早就在线,既不会有 presence
 * 事件也不会有词典变更,不立刻发一次就要干等到兜底心跳(半小时)才收敛。
 */
export function broadcastDictionaryNow(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  // 索取回发:本机可能在关闭同步期间落后了,而对端不会主动告诉我们。
  broadcastToAllPeers('sync-enabled', { requestReply: true });
}

/** 本地词典变更:去抖后广播。连续学习事件不会打出一连串帧。 */
export function notifyLocalDictionaryChanged(): void {
  if (!isSyncEnabled()) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    broadcastToAllPeers('local-change');
  }, BROADCAST_DEBOUNCE_MS);
  debounceTimer.unref?.();
}

/**
 * 处理对端送来的状态帧。
 *
 * 合并后若本机状态比对方更全(合并引入了新信息),回发一次自己的状态,让对方也收敛
 * —— 两轮之内双方一致,不需要版本协商。
 */
export function handleIncomingDictionaryState(src: string, payload: unknown): void {
  if (!isSyncEnabled()) return;
  const frame = payload as Partial<DictionarySyncFramePayload> | undefined;
  if (!frame || frame.frameVersion !== 1 || !frame.state) return;

  let changed = false;
  try {
    changed = voiceInputDataStore.mergeRemoteDictionaryState(frame.state);
  } catch (error) {
    log.warn('merging remote dictionary state failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  // 回发条件:本机合并出了新东西(对端未必有),或者对端明确索取(它可能落后于我们
  // 而自己并不知道)。requestReply 的回发不再索取,避免两端来回弹球。
  if (changed || frame.requestReply === true) {
    if (changed) log.info(`merged dictionary state from ${src.slice(0, 8)}`);
    sendStateTo(src, changed ? 'merge-reply' : 'reply-requested');
  }
}

/**
 * 供 mobile 拉取的只读投影。
 *
 * 内容是词条文本 + 频次 + 别名,外加一个 `stateVector`(版本向量)—— 手机同时拉
 * 多台电脑时靠它判断哪份快照包含了另一份。除此之外不外泄任何同步内部结构:化身、
 * 墓碑、抑制项、时钟都不出去,手机也不参与合并。
 *
 * 同样受「在我的设备之间同步」开关约束:用户关掉之后,词典就不该再离开这台电脑 ——
 * 只让电脑之间停下、却继续把整份词典交给手机,与开关的承诺不符。关闭时返回空表
 * (而不是报错),手机侧照常降级到无词典,不打断语音输入。
 */
export function readDictionaryProjectionForMobile(): {
  entries: Array<{ text: string; frequency: number; aliases: Array<{ text: string; count: number }> }>;
  stateVector?: Record<string, string>;
} {
  if (!isSyncEnabled()) return { entries: [] };
  const entries = voiceDictionarySyncStore.materialize().entries.map((entry) => ({
    text: entry.text,
    frequency: entry.frequency,
    aliases: entry.aliases.map((alias) => ({ text: alias.text, count: alias.count })),
  }));
  // 版本向量对合并单调(逐节点取 max),所以「逐节点 ≥」等价于「已经见过对方的
  // 全部事件」—— 这才是手机可以拿一份替代另一份的条件,而不是谁的时间戳大。
  const vector = buildStateVersionVector(voiceDictionarySyncStore.getState());
  return Object.keys(vector).length > 0 ? { entries, stateVector: vector } : { entries };
}

function broadcastToAllPeers(reason: string, options?: { requestReply?: boolean }): void {
  if (!isSyncEnabled() || !transport) return;
  const peers = transport.listOnlineDesktopDevices();
  if (peers.length === 0) return;
  const payload = buildFrame(options);
  if (!payload) return;
  for (const deviceId of peers) {
    try {
      transport.sendState(deviceId, payload);
    } catch (error) {
      // 丢一帧无所谓:状态合并幂等,下一次触发会补上。
      log.warn(`dictionary state push failed (${reason}) to ${deviceId.slice(0, 8)}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function sendStateTo(deviceId: string, reason: string, options?: { requestReply?: boolean }): void {
  if (!transport) return;
  const payload = buildFrame(options);
  if (!payload) return;
  try {
    transport.sendState(deviceId, payload);
  } catch (error) {
    log.warn(`dictionary state push failed (${reason}) to ${deviceId.slice(0, 8)}`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function buildFrame(options?: { requestReply?: boolean }): DictionarySyncFramePayload | null {
  const state = voiceDictionarySyncStore.getState();
  const payload: DictionarySyncFramePayload = { frameVersion: 1, state };
  if (options?.requestReply) payload.requestReply = true;
  const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (bytes <= MAX_STATE_FRAME_BYTES) return payload;
  // 超限:发出去只会被 relay 拒绝并抛错,且此后每次广播都一样。宁可这一轮不发,
  // 也要让日志把原因说清楚 —— 否则表现是「同步无声无息地不工作了」。
  log.error(
    `dictionary state frame is too large to sync (${bytes} bytes > ${MAX_STATE_FRAME_BYTES}); `
    + 'peers will not receive updates until the dictionary shrinks',
  );
  return null;
}

function isSyncEnabled(): boolean {
  try {
    return voiceInputDataStore.getSettings().dictionarySyncEnabled;
  } catch {
    return false;
  }
}

export const __testing = {
  reset(): void {
    stopVoiceDictionarySync();
  },
  flushDebounce(): void {
    if (!debounceTimer) return;
    clearTimeout(debounceTimer);
    debounceTimer = null;
    broadcastToAllPeers('test-flush');
  },
};
