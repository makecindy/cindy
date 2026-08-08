// 整包更新发现 —— 纯逻辑(无 IO / 无 React,便于单测)。
//
// 背景:
// - expo-updates 只感知"我这个 runtimeVersion 有没有新 JS OTA",不会告知"有更高 runtimeVersion 的整包"。
// - 所以整包发现靠独立的 `/latest` 通道 + 客户端比对 runtimeVersion:
//     · latest.runtimeVersion === 当前 runtimeVersion → 无需整包(JS OTA 通道会处理);
//     · 不同 → 原生层变了,JS OTA 覆盖不到 → 引导用户打开 release record 的正常安装入口。
// - minVersion(可选)用于强制更新:当前 version 低于它则阻断使用、只留"去更新"。
//   强更判定**不经过 runtimeVersion 门闸**:门槛由服务端按 version 下发,同 runtimeVersion
//   的旧构建也必须能被强更(否则"发布链写了 minVersion 却对同指纹装机无效")。

/** mobile-update-server `/latest` 返回的整包版本记录(release.json 透传)。 */
export interface LatestReleaseRecord {
  version: string;
  buildNumber: string | number;
  runtimeVersion: string;
  installUrl: string;
  itmsUrl: string;
  releaseNotes?: string;
  /** 可选:低于此 version 强制更新。首期默认不下发。 */
  minVersion?: string;
}

export interface BundleUpdateEvaluation {
  /** 是否有整包更新(runtimeVersion 与当前不一致)。 */
  needsUpdate: boolean;
  /** 是否强制(needsUpdate 且当前 version < minVersion)。 */
  forced: boolean;
  /** 供 UI 使用的目标信息;needsUpdate=false 时为 null。 */
  target: {
    version: string;
    runtimeVersion: string;
    installUrl: string;
    itmsUrl: string;
    releaseNotes?: string;
  } | null;
}

export interface EvaluateBundleUpdateInput {
  /** 当前运行包的 runtimeVersion(取自 expo-updates Updates.runtimeVersion)。 */
  currentRuntimeVersion: string | null | undefined;
  /** 当前包的应用版本(原生真值 APP_BINARY_VERSION;不要传会被 OTA 覆盖的 expoConfig.version)。 */
  currentVersion: string | null | undefined;
  /** `/latest` 返回体(已解析)。无效/缺字段视为无更新。 */
  latest: unknown;
}

const NO_UPDATE: BundleUpdateEvaluation = { needsUpdate: false, forced: false, target: null };

/**
 * 整包更新只属于自建分发渠道。
 * Review 构建与 TestFlight 构建都不能展示外部安装入口；
 * TestFlight 的 JS OTA 由独立通道继续处理。
 */
export function shouldCheckBundleUpdate({
  isSelfHosted,
  isReviewMode,
  isTestFlightBuild,
}: {
  isSelfHosted: boolean;
  isReviewMode: boolean;
  isTestFlightBuild: boolean;
}): boolean {
  return isSelfHosted && !isReviewMode && !isTestFlightBuild;
}

/** 校验并收窄 `/latest` 响应为 LatestReleaseRecord;字段缺失即返回 null(宁可不提示,不误导)。 */
export function parseLatestRelease(value: unknown): LatestReleaseRecord | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const runtimeVersion = typeof v.runtimeVersion === 'string' ? v.runtimeVersion.trim() : '';
  const version = typeof v.version === 'string' ? v.version.trim() : '';
  const installUrl = typeof v.installUrl === 'string' ? v.installUrl.trim() : '';
  const itmsUrl = typeof v.itmsUrl === 'string' ? v.itmsUrl.trim() : '';
  // 至少要有 runtimeVersion(判定门闸)+ 一个可跳转的安装地址。
  if (!runtimeVersion || (!installUrl && !itmsUrl)) return null;
  const record: LatestReleaseRecord = {
    version,
    buildNumber: (typeof v.buildNumber === 'string' || typeof v.buildNumber === 'number') ? v.buildNumber : '',
    runtimeVersion,
    installUrl,
    itmsUrl,
  };
  if (typeof v.releaseNotes === 'string') record.releaseNotes = v.releaseNotes;
  if (typeof v.minVersion === 'string' && v.minVersion.trim()) record.minVersion = v.minVersion.trim();
  return record;
}

/** 语义化版本比较:a<b → -1,a==b → 0,a>b → 1。非数字段按 0 处理。 */
export function compareVersions(a: string, b: string): number {
  const pa = String(a).split('.').map((x) => Number(x));
  const pb = String(b).split('.').map((x) => Number(x));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const av = Number.isFinite(pa[i]) ? pa[i] : 0;
    const bv = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (av !== bv) return av > bv ? 1 : -1;
  }
  return 0;
}

/**
 * 判定是否需要引导整包更新。两条独立信号:
 * - runtimeVersion 不一致 → 有整包更新(可跳过的普通提示);
 * - 当前 version < minVersion → 强更,**与 runtimeVersion 是否一致无关**。
 *   服务端可以对某个已发布版本事后下发门槛,把同指纹的问题构建也挡住;
 *   反过来说,同 runtimeVersion 命中强更时 target.runtimeVersion 就等于当前值,
 *   消费方不得把它当作"换了指纹"的证据。
 * 拿不到当前 runtimeVersion(dev / expo-updates 未启用)、拿不到当前 version 或
 * `/latest` 无效 → 一律视为无更新(比不出来就不挡人,fail-open)。
 */
export function evaluateBundleUpdate({
  currentRuntimeVersion,
  currentVersion,
  latest,
}: EvaluateBundleUpdateInput): BundleUpdateEvaluation {
  const record = parseLatestRelease(latest);
  if (!record) return NO_UPDATE;

  const current = String(currentRuntimeVersion ?? '').trim();
  if (!current) return NO_UPDATE;

  // 强更要求这条记录本身**能被满足**:
  // - 带 version:拿不到目标版本就无法证明"装上它就能解除阻断"(阻断态自愈全靠这个
  //   可比较的版本,见 forcedUpdateRecheck 的新鲜度门);
  // - minVersion ≤ version:否则唯一提供的安装目标仍低于门槛,用户装完照旧被强更,
  //   阻断屏成了没有出口的死屋,只能等运维改指针。
  // 发布链侧 assertMinVersionUsable 已经保证这两条,这里是客户端兜底(手工改过的 / 历史
  // 遗留的指针也不能把人关死):记录不自洽时退化成可跳过的普通更新提示。
  const forced = Boolean(
    record.minVersion &&
    record.version &&
    currentVersion &&
    compareVersions(String(currentVersion), record.minVersion) < 0 &&
    compareVersions(record.version, record.minVersion) >= 0,
  );

  if (!forced && record.runtimeVersion === current) return NO_UPDATE;

  return {
    needsUpdate: true,
    forced,
    target: {
      version: record.version,
      runtimeVersion: record.runtimeVersion,
      installUrl: record.installUrl,
      itmsUrl: record.itmsUrl,
      releaseNotes: record.releaseNotes,
    },
  };
}

/** 引导安装时优先用 itms-apps/itms-services 直达入口,缺失回退网页安装页。 */
export function preferredInstallUrl(target: { itmsUrl?: string; installUrl?: string }): string | null {
  const itms = target.itmsUrl?.trim();
  if (itms) return itms;
  const web = target.installUrl?.trim();
  return web || null;
}
