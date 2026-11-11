/**
 * sidebarInstallVintage —— 判定「这份安装是升级上来的老用户,还是全新安装」。
 * ---------------------------------------------------------------------------
 * 为什么需要:侧边栏重设计给新用户定了一套新默认(列表视图),但**老用户升级后
 * 侧栏观感应尽量不变**(2026-08-12 用户裁决)。老用户里有一类最难办——从没动过
 * 显示模式设置的人:他们的 `sidebar.cardMode` 是空的,与全新安装的用户在
 * localStorage 上无法区分,若直接吃新默认就会升级后突然跳成列表视图。
 *
 * 判据:renderer 侧没有「安装时间 / 上次运行版本」这类现成信号(main 也没有持久化
 * 版本号),因此用**一组只有用过旧版才会留下的 localStorage 痕迹**取并集来判定。
 * 这些 key 全部在本次重设计之前就存在(见下方 LEGACY_USAGE_KEYS 的来源注释):
 *   - 只要用户在旧版里打开过会话 / 用过侧栏筛选 / 折叠过项目,就至少命中一个;
 *   - 全新安装在首帧读取时一个都不会有。
 *
 * 判定结果**一次性固化**到 INSTALL_VINTAGE_KEY:此后不再重新推断。原因是这些痕迹
 * 会随用户使用自然出现(新用户用几分钟后也会写 lastChatView),不固化的话「新装」
 * 会在某一刻悄悄变成「老用户」,默认值随之漂移——用户会看到侧栏莫名其妙换了样子。
 * 固化后即使痕迹被清理(换账号 / 清缓存),判定也不再翻转。
 *
 * 边界:这是启发式,不是精确考古。误判的代价是有限且对称的——把老用户误判成新装
 * (他清过缓存)会让他看到列表视图;把新装误判成老用户(极罕见)会让他看到文字
 * 视图。两者都只是显示密度差异,用户在「侧边栏显示设置 → 显示」里一键可改,且改完就
 * 落盘、此后与本模块无关。
 */

/** 固化判定结果;值为 'legacy' | 'fresh'。 */
const INSTALL_VINTAGE_KEY = 'cc-agent.sidebar.installVintage.v1';

/**
 * 「用过旧版」的痕迹 key。全部早于侧边栏重设计存在,且都不需要用户主动改设置:
 *   - lastChatView / lastDocView:打开过任意会话 / 文件视图就写(最强信号)。
 *   - collapsedProjects / collapsedAutomationGroups:折叠过任意分组。
 *   - pinnedSessionOrder / filter.projects / filter.manualProjectOrder:置顶拖拽、
 *     项目筛选与手动排序(owner-scoped 前的历史裸 key,老安装才会有)。
 *   - sidebar.cardMode:显式改过显示模式(这类用户本就能被 cardMode 自身识别,
 *     列在这里是为了让判定对「只改过显示模式」的人同样成立)。
 * 注:owner-scoped 之后这些 key 会带 owner 后缀(sidebarOwnerStorage 的格式是
 * `<base>.owner.<ownerId>`),故除全等外再做该前缀匹配。
 *
 * ⚠️ identityOwnerClaim **不在**本表(2026-08-13 review 修正):它由
 * sidebarOwnerStorage 在**任何**首次 owner-scoped 读取时建账写入——全新安装
 * 首帧 useSidebarFilter 就会触发,且发生在首次读显示模式之前。按「存在即痕迹」
 * 判会把所有新装都误判成老装,恰好打穿唯一的新老分叉(新装列表视图)。它只在
 * 信封里**捕获到非空旧数据**时才构成旧版证据,见 claimEnvelopeCapturedLegacyData。
 */
const LEGACY_USAGE_KEYS = [
  'cc-agent.lastChatView.v1',
  'cc-agent.lastDocView.v1',
  'cc-agent.sidebar.collapsedProjects',
  'cc-agent.sidebar.collapsedAutomationGroups',
  'cc-agent.sidebar.pinnedSessionOrder',
  'cc-agent.sidebar.filter.projects',
  'cc-agent.sidebar.filter.manualProjectOrder',
  'sidebar.cardMode',
] as const;

/** sidebarOwnerStorage 的建账 key(格式见该模块;这里只读不写)。 */
const OWNER_CLAIM_KEY = 'cc-agent.sidebar.identityOwnerClaim.v1';

/**
 * claim 是否构成「装过旧版本」的证据。形态分类**对齐 sidebarOwnerStorage 的
 * parseClaimState**(2026-08-13 复核修正:上一版把 bare 想象成裸字符串,而生产
 * 的 bare 形态是 `{"version":1,"ownerId":"..."}` 无 legacy 字段的 JSON 对象,
 * 导致真实 bare 迁移用户被误判 fresh;catch 分支又与注释相反地返回 true):
 *   - envelope(v1 + ownerId + legacy.values):任一捕获值非 null → 建账那一刻
 *     裸根键还有真实旧数据 = 老安装;全 null = 新装建的空账,不算痕迹。
 *   - bare(v1 + ownerId、无 legacy 字段):未发布中间版本写的占位——能出现
 *     就说明装过旧版本,算老安装。
 *   - 其余(非 JSON / 非对象 / 缺 version、ownerId 的残缺对象)= malformed →
 *     不算痕迹。证据不明时倾向 fresh:误给新默认的代价是显示密度差异、一键
 *     可改;误判成 legacy 则新装永远拿不到新默认。
 */
function claimEnvelopeCapturedLegacyData(raw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
    const record = parsed as {
      version?: unknown;
      ownerId?: unknown;
      legacy?: { values?: unknown };
    };
    if (record.version !== 1 || typeof record.ownerId !== 'string' || record.ownerId.length === 0) {
      return false; // malformed:不是任何已知版本写的形态
    }
    if (!Object.hasOwn(record, 'legacy')) return true; // bare v1 占位
    const values = record.legacy?.values;
    if (values == null || typeof values !== 'object') return false;
    return Object.values(values).some((value) => value != null);
  } catch {
    return false; // 非 JSON = malformed,不算痕迹
  }
}

export type SidebarInstallVintage = 'legacy' | 'fresh';

/** 模块级缓存:同一次运行内判定只做一遍(读 localStorage 的 key 遍历不必重复)。 */
let memoized: SidebarInstallVintage | null = null;

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function hasLegacyUsageTrace(storage: Storage): boolean {
  // owner-scoped key 形如 `<base>.owner.<ownerId>`(sidebarOwnerStorageKey),
  // 按该前缀匹配整张表。(2026-08-13 复查修正:此前误写成 `<base>:` 前缀,
  // 与真实键格式不符,scoped 痕迹永远匹配不上——靠裸根键与 claim key 兜着
  // 没出实际误判,但按错误格式匹配的分支等于死码。)
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key == null) continue;
    if (LEGACY_USAGE_KEYS.some((base) => key === base || key.startsWith(`${base}.owner.`))) {
      return true;
    }
  }
  // claim key 单独判(不看存在、只看内容),原因见 LEGACY_USAGE_KEYS 头注。
  try {
    const claim = storage.getItem(OWNER_CLAIM_KEY);
    if (claim != null && claimEnvelopeCapturedLegacyData(claim)) return true;
  } catch {
    // 读不到按无痕迹处理。
  }
  return false;
}

/**
 * 本安装是升级上来的老用户(legacy)还是全新安装(fresh)。
 * 首次调用时推断并固化;此后直接读固化值。localStorage 不可用时按 fresh 处理
 * (读不到痕迹也写不了标记,给新默认是更合理的兜底)。
 */
export function getSidebarInstallVintage(): SidebarInstallVintage {
  if (memoized !== null) return memoized;
  const storage = safeStorage();
  if (!storage) return (memoized = 'fresh');

  try {
    const stored = storage.getItem(INSTALL_VINTAGE_KEY);
    if (stored === 'legacy' || stored === 'fresh') return (memoized = stored);
  } catch {
    return (memoized = 'fresh');
  }

  const vintage: SidebarInstallVintage = hasLegacyUsageTrace(storage) ? 'legacy' : 'fresh';
  try {
    storage.setItem(INSTALL_VINTAGE_KEY, vintage);
  } catch {
    // 写不进去也不影响本次判定;下次启动会重新推断(痕迹只增不减,结论稳定)。
  }
  return (memoized = vintage);
}

export const __testing = {
  INSTALL_VINTAGE_KEY,
  LEGACY_USAGE_KEYS,
  OWNER_CLAIM_KEY,
  resetMemo(): void {
    memoized = null;
  },
};
