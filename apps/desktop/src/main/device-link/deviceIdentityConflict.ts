/**
 * 识别「另一台电脑在用这台电脑的设备身份」。
 *
 * 设备身份取自硬件身份(Windows 为 MachineGuid)。同一系统镜像装机、没重新生成
 * MachineGuid 的两台电脑算出同一个身份：中转只认后连上的那条连接，两台每十几秒互相
 * 顶掉一次，登录续期凭证也互相作废(2026-11-23 现场；issue #9095、#8898)。
 *
 * 两个条件同时成立才确认冲突：
 *  1. 最近 10 分钟内至少 2 次被同一设备身份的另一条连接顶替(DeviceLinkClient.onReplaced)；
 *  2. 同一时间窗内，设备目录里本机这一行的上报名(selfName)不是这台电脑报过的名字。
 * 同一台电脑上的另一个 Cindy 上报同样的名字，不会被当成冲突；没被反复顶替的用户
 * 不会额外读目录。确认只用于提示和被顶替后的重连冷却，设备身份只在用户点击后更换。
 */

export interface DeviceIdentityConflict {
  /** 另一台电脑上报的名字(它的主机名)。 */
  otherDeviceName: string;
  /** unix ms */
  detectedAt: number;
}

/** 设备目录(GET /api/device-link/devices)里判断冲突用得到的字段。 */
export interface DeviceIdentityDirectoryRow {
  deviceId: string;
  isSelf?: boolean;
  selfName?: string | null;
}

export interface DeviceIdentityConflictMonitorDeps {
  selfDeviceId(): string;
  /** 这台电脑在本进程里可能报过的名字(deviceName.ts localDeviceNameCandidates)。 */
  localDeviceNames(): readonly string[];
  /** 读一次设备目录；限频由本模块负责。 */
  readDirectory(): Promise<readonly DeviceIdentityDirectoryRow[]>;
  onChange(conflict: DeviceIdentityConflict | null): void;
  log?: { info(message: string): void; warn(message: string): void };
  now?: () => number;
}

export interface DeviceIdentityConflictMonitor {
  noteReplaced(readDirectory?: DeviceIdentityConflictMonitorDeps['readDirectory']): void;
  current(): DeviceIdentityConflict | null;
  /** 换账号、登出或连接拆除：清掉证据与已确认状态。 */
  reset(): void;
}

export const DEVICE_IDENTITY_CONFLICT_WINDOW_MS = 10 * 60_000;
const MIN_REPLACEMENTS = 2;
/** 间隔不到这么久的两次顶替算同一次(同一条新连接同时顶掉本机的几条连接)。 */
const SAME_REPLACEMENT_MS = 2_000;
/** 自己发起的目录读取间隔；只在被反复顶替时才读。 */
const DIRECTORY_SAMPLE_INTERVAL_MS = 60_000;
/** 这么久没再被顶替就撤销确认(另一台电脑关了 Cindy，或已经换了身份)。 */
export const DEVICE_IDENTITY_CONFLICT_QUIET_MS = 15 * 60_000;
/** 名字超过这个长度时，服务端截断后的前缀也算同名，避免把自己的长名字误判成别人的。 */
const TRUNCATION_SAFE_LENGTH = 64;

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

function sameReportedName(reported: string, local: string): boolean {
  const a = normalizeName(reported), b = normalizeName(local);
  if (!a || !b) return false;
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= TRUNCATION_SAFE_LENGTH && longer.startsWith(shorter);
}

export function createDeviceIdentityConflictMonitor(
  deps: DeviceIdentityConflictMonitorDeps,
): DeviceIdentityConflictMonitor {
  const now = deps.now ?? Date.now;
  let replacedAt: number[] = [];
  let foreignName: { name: string; at: number } | null = null;
  let conflict: DeviceIdentityConflict | null = null;
  let lastSampleAt = Number.NEGATIVE_INFINITY;
  let sampling = false;
  let generation = 0;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;

  const prune = (at: number) => {
    replacedAt = replacedAt.filter((t) => at - t <= DEVICE_IDENTITY_CONFLICT_WINDOW_MS);
    if (foreignName && at - foreignName.at > DEVICE_IDENTITY_CONFLICT_WINDOW_MS) foreignName = null;
  };

  const setConflict = (next: DeviceIdentityConflict | null) => {
    if (conflict === next) return;
    if (conflict && next && conflict.otherDeviceName === next.otherDeviceName) return;
    conflict = next;
    if (next) deps.log?.warn('another computer is using this device identity; asking the user to give this computer a new one');
    else deps.log?.info('device identity conflict no longer observed');
    deps.onChange(next);
  };

  const evaluate = () => {
    const at = now();
    prune(at);
    if (!foreignName) return;
    if (conflict) {
      if (conflict.otherDeviceName !== foreignName.name) {
        setConflict({ otherDeviceName: foreignName.name, detectedAt: conflict.detectedAt });
      }
      return;
    }
    if (replacedAt.length >= MIN_REPLACEMENTS) setConflict({ otherDeviceName: foreignName.name, detectedAt: at });
  };

  const noteDirectory = (rows: readonly DeviceIdentityDirectoryRow[]) => {
    // 服务端按本次请求的登录设备标出 isSelf；自建中转上本机的设备 ID 与账号设备 ID 不同。
    const selfId = deps.selfDeviceId();
    const row = rows.find((candidate) => candidate.isSelf === true)
      ?? rows.find((candidate) => candidate.deviceId === selfId);
    const reported = typeof row?.selfName === 'string' ? row.selfName.trim() : '';
    if (!reported) return;
    if (deps.localDeviceNames().some((local) => sameReportedName(reported, local))) return;
    foreignName = { name: reported, at: now() };
    evaluate();
  };

  const maybeSample = (readDirectory: DeviceIdentityConflictMonitorDeps['readDirectory']) => {
    const at = now();
    if (conflict || sampling || replacedAt.length < MIN_REPLACEMENTS) return;
    if (at - lastSampleAt < DIRECTORY_SAMPLE_INTERVAL_MS) return;
    lastSampleAt = at;
    sampling = true;
    const started = generation;
    // 被顶替的这一刻，目录里本机这一行刚被另一台电脑的连接改写，读取要赶在本机重连之前。
    void readDirectory().then(
      (rows) => { if (started === generation) noteDirectory(rows); },
      () => { /* 目录读不到只少一次取样，下一次被顶替再读。 */ },
    ).finally(() => { if (started === generation) sampling = false; });
  };

  const armQuietClear = () => {
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      quietTimer = null;
      replacedAt = [];
      foreignName = null;
      setConflict(null);
    }, DEVICE_IDENTITY_CONFLICT_QUIET_MS);
    (quietTimer as { unref?: () => void }).unref?.();
  };

  return {
    noteReplaced(readDirectory = deps.readDirectory) {
      const at = now();
      // 同一次顶替可能同时关掉主连接和兼容连接，算一次。
      const last = replacedAt[replacedAt.length - 1];
      if (last === undefined || at - last >= SAME_REPLACEMENT_MS) replacedAt.push(at);
      prune(at);
      armQuietClear();
      evaluate();
      maybeSample(readDirectory);
    },
    current: () => conflict,
    reset() {
      generation += 1;
      sampling = false;
      lastSampleAt = Number.NEGATIVE_INFINITY;
      replacedAt = [];
      foreignName = null;
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = null;
      setConflict(null);
    },
  };
}
