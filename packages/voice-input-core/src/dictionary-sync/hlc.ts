/**
 * 混合逻辑时钟(Hybrid Logical Clock)。
 *
 * 词典同步没有中心裁决者,LWW 字段(词条显示文本等)只能靠时间戳定序。裸
 * `Date.now()` 在这里是错的:一台设备的系统时钟往回拨(NTP 校正、用户改时间、
 * 虚拟机快照恢复)之后,它此后的每一次编辑都会永远输给自己之前的旧编辑,而且
 * 这种状态无法自愈。HLC 用「墙钟 + 逻辑计数器」保证本机产出的时间戳严格单调
 * 递增,同时在收到远端更大的时间戳时把自己抬上去,让因果先后跨设备也成立。
 *
 * 时间戳序列化成定长前缀的字符串,字典序即时间序,可以直接进 JSON、直接比较、
 * 直接当对象 key —— 化身 tag 用的就是它。
 */

/** 墙钟段:base36 定长 10 位,覆盖到公元 3 万年后,不会溢出变短破坏字典序。 */
const WALL_RADIX_LENGTH = 10;
/** 逻辑计数器段:base36 定长 4 位;同一毫秒内可容纳 36^4 ≈ 168 万次事件。 */
const COUNTER_RADIX_LENGTH = 4;
const COUNTER_MAX = 36 ** COUNTER_RADIX_LENGTH - 1;
/** `<wall36>.<counter36>.` 的长度 —— 定长前缀部分,nodeId 从这之后开始。 */
export const HLC_PREFIX_LENGTH = WALL_RADIX_LENGTH + 1 + COUNTER_RADIX_LENGTH + 1;

/**
 * 形如 `<wall36>.<counter36>.<nodeId>` 的时间戳。
 *
 * 前两段定长,所以字符串字典序 === (wall, counter) 字典序;nodeId 只在两者都
 * 相同时参与 tie-break,保证全序且全网一致。同一 nodeId 产出的时间戳互不重复,
 * 因此它同时可以直接当作全局唯一 id(化身 tag)。
 */
export type HlcTimestamp = string;

/** 单个节点的时钟状态。持久化在同步 sidecar 里,重启后继续单调。 */
export interface HlcClock {
  wallMs: number;
  counter: number;
  /** 本设备的同步身份;必须全网唯一且跨重启稳定。 */
  nodeId: string;
}

export function createHlcClock(nodeId: string, wallMs = 0): HlcClock {
  const normalizedNodeId = nodeId.trim();
  if (!normalizedNodeId) throw new Error('hlc nodeId is required');
  if (normalizedNodeId.includes('.')) throw new Error('hlc nodeId must not contain "."');
  return { wallMs: Math.max(0, Math.floor(wallMs)), counter: 0, nodeId: normalizedNodeId };
}

export function formatHlc(clock: HlcClock): HlcTimestamp {
  const wall = Math.max(0, Math.floor(clock.wallMs)).toString(36).padStart(WALL_RADIX_LENGTH, '0');
  const counter = Math.max(0, Math.floor(clock.counter)).toString(36).padStart(COUNTER_RADIX_LENGTH, '0');
  return `${wall}.${counter}.${clock.nodeId}`;
}

/**
 * 时间戳是否是本模块产出的规范形式。
 *
 * 定序靠的是**字符串字典序**,前提是所有参与比较的时间戳都符合定长格式。一个来自
 * 坏帧或恶意对端的 `~~~~`(`~` 的码位高于所有 base36 字符)会在每一次 LWW 比较里
 * 胜出,而且它是持久化的 —— 那个字段此后再也改不动了,用户在任何设备上改词条显示
 * 文本都会被这个假时间戳压回去。同时它解析出的墙钟是 0,墓碑 TTL 也会算错。
 *
 * 所以入站帧里的每一个 tag 与 stamp 都必须先过这一关。
 */
export function isCanonicalHlc(value: unknown): value is HlcTimestamp {
  if (typeof value !== 'string') return false;
  const wallEnd = WALL_RADIX_LENGTH;
  const counterEnd = wallEnd + 1 + COUNTER_RADIX_LENGTH;
  if (value.length < counterEnd + 2) return false;
  if (value[wallEnd] !== '.' || value[counterEnd] !== '.') return false;
  if (!isBase36(value.slice(0, wallEnd)) || !isBase36(value.slice(wallEnd + 1, counterEnd))) {
    return false;
  }
  const nodeId = value.slice(counterEnd + 1);
  // nodeId 不能含 '.',否则同一个字符串能被解析出多种切分。
  return nodeId.length > 0 && !nodeId.includes('.');
}

/** 读出产出该时间戳的 nodeId;不是规范形式时返回 null。 */
export function hlcNodeId(stamp: HlcTimestamp): string | null {
  if (!isCanonicalHlc(stamp)) return null;
  return stamp.slice(WALL_RADIX_LENGTH + 1 + COUNTER_RADIX_LENGTH + 1);
}

function isBase36(segment: string): boolean {
  for (const char of segment) {
    const isDigit = char >= '0' && char <= '9';
    const isLower = char >= 'a' && char <= 'z';
    if (!isDigit && !isLower) return false;
  }
  return segment.length > 0;
}

/** 解析出墙钟毫秒;只用于墓碑 TTL 与展示,不参与定序(定序一律用字符串比较)。 */
export function hlcWallMs(stamp: HlcTimestamp): number {
  const wall = stamp.slice(0, WALL_RADIX_LENGTH);
  const parsed = Number.parseInt(wall, 36);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 全序比较。定长前缀让朴素字符串比较就是正确的时间序。 */
export function compareHlc(a: HlcTimestamp, b: HlcTimestamp): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function maxHlc(a: HlcTimestamp, b: HlcTimestamp): HlcTimestamp {
  return compareHlc(a, b) >= 0 ? a : b;
}

export function minHlc(a: HlcTimestamp, b: HlcTimestamp): HlcTimestamp {
  return compareHlc(a, b) <= 0 ? a : b;
}

/**
 * 产出本机下一个时间戳。返回新时钟而不是就地改,便于调用方在写盘成功后才提交。
 *
 * 墙钟没有前进(同一毫秒内连续事件,或系统时钟回拨)时递增逻辑计数器,因此本机
 * 时间戳严格单调 —— 时钟回拨不会让新事件被判定为「旧」。
 */
export function tickHlc(clock: HlcClock, nowMs: number): { clock: HlcClock; stamp: HlcTimestamp } {
  const now = Math.max(0, Math.floor(nowMs));
  const next: HlcClock = now > clock.wallMs
    ? { wallMs: now, counter: 0, nodeId: clock.nodeId }
    : { wallMs: clock.wallMs, counter: clock.counter + 1, nodeId: clock.nodeId };
  if (next.counter > COUNTER_MAX) {
    // 同一毫秒挤满 168 万次事件:借下一毫秒继续,宁可让墙钟略微超前也不能让
    // 计数器进位破坏定长前缀(那会让字典序不再等于时间序)。
    return tickHlc({ wallMs: clock.wallMs + 1, counter: -1, nodeId: clock.nodeId }, now);
  }
  return { clock: next, stamp: formatHlc(next) };
}

/**
 * 收到远端时间戳后抬高本地时钟,让本机之后产出的时间戳一定大于已观察到的一切。
 * 每次合并远端状态后调用一次(传入该状态里最大的时间戳)。
 */
export function observeHlc(clock: HlcClock, remote: HlcTimestamp, nowMs: number): HlcClock {
  const remoteWall = hlcWallMs(remote);
  const remoteCounter = readCounter(remote);
  const now = Math.max(0, Math.floor(nowMs));
  const wallMs = Math.max(clock.wallMs, remoteWall, now);
  if (wallMs > clock.wallMs && wallMs > remoteWall) {
    return { wallMs, counter: 0, nodeId: clock.nodeId };
  }
  const counter = wallMs === clock.wallMs && wallMs === remoteWall
    ? Math.max(clock.counter, remoteCounter)
    : wallMs === remoteWall
      ? remoteCounter
      : clock.counter;
  return { wallMs, counter, nodeId: clock.nodeId };
}

function readCounter(stamp: HlcTimestamp): number {
  const start = WALL_RADIX_LENGTH + 1;
  const parsed = Number.parseInt(stamp.slice(start, start + COUNTER_RADIX_LENGTH), 36);
  return Number.isFinite(parsed) ? parsed : 0;
}
