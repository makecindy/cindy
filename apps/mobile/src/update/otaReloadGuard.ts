/**
 * 启动热更 reload 的跨重启闸门状态。
 *
 * 冷启动热更门(useStartupOtaGate)的 `started` ref 只防同一个 JS 实例内重复检查;
 * `Updates.reloadAsync()` 之后是全新的 JS 实例,内存状态全部归零。一旦某台机器进入
 * 「下载下来的 update 装不上、每次 check 又照样报有新版」的状态,那道门就会无休止地
 * check → fetch → reload,表现为启动页无限转圈并每隔几秒闪一次,用户无法进入 App,
 * 且不会自愈(实测某台设备累计重启 33 次仍在循环)。
 *
 * 因此把「上一次是为了装哪个 update 才 reload、已经试了几次」持久化到本机:
 * - reload 之前记一次(必须落盘成功才允许 reload,否则闸门等于不存在);
 * - 同一个 update 连续试满 MAX_OTA_RELOAD_ATTEMPTS 次仍未装上 → 判定为循环,
 *   本次启动放弃热更、直接进 App(热更不生效 好于 进不去 App);
 * - 启动链真正走完后,只有当前正在运行的 update 就是当次目标时才清记录
 *   —— reload 后仍跑着旧 bundle 说明目标没装上,这条记录必须留到下次冷启动继续计数。
 *
 * 标记不敏感(只有一个 update id 和次数),与 canaryChannelStore 一样用 AsyncStorage。
 * 本模块无内存缓存:每次冷启动只读一次,读写失败一律 fail-safe(见各函数说明)。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'cindy.mobile.update.reloadGuard';

/**
 * 同一个 update 允许的 reload 次数上限。正常路径下一次就够:reload 后新 bundle 生效,
 * 下一次 check 即 up-to-date,记录随启动成功被清掉。留 2 次是给「reload 恰好被系统
 * 杀进程/息屏打断」这类偶发一次重试机会;到达上限说明是装不上,不是运气差。
 */
export const MAX_OTA_RELOAD_ATTEMPTS = 2;

export interface OtaReloadGuardState {
  /** 上次 reload 想装上的 update id;无记录为 null。 */
  targetUpdateId: string | null;
  /** 针对该 update id 已经 reload 过的次数。 */
  reloadCount: number;
}

const EMPTY_STATE: OtaReloadGuardState = { targetUpdateId: null, reloadCount: 0 };

function parseState(raw: string | null): OtaReloadGuardState {
  if (!raw) return EMPTY_STATE;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return EMPTY_STATE;
    const { targetUpdateId, reloadCount } = parsed as Record<string, unknown>;
    if (typeof targetUpdateId !== 'string' || !targetUpdateId) return EMPTY_STATE;
    // 次数非法(缺失/负数/小数/NaN)时不猜:按已试 1 次处理,宁可少挡一次也不误挡。
    const count =
      typeof reloadCount === 'number' && Number.isInteger(reloadCount) && reloadCount > 0
        ? reloadCount
        : 1;
    return { targetUpdateId, reloadCount: count };
  } catch {
    return EMPTY_STATE;
  }
}

/**
 * 读取闸门状态。
 *
 * **读失败会抛出**,不能吞成「无记录」:那样计数会被重置成 1,间歇性失败白放一次
 * reload,持续失败则永远到不了上限、闸门彻底失效——正是本模块要防的循环。与写失败
 * 同一口径:存储不可用时本次启动放弃热更(调用方 fail-open 放行进 App)。
 *
 * 坏值(非 JSON / 缺 id)不算故障:那是没有可信记录,按「无记录」处理,下一次写入即覆盖。
 */
export async function readOtaReloadGuard(): Promise<OtaReloadGuardState> {
  return parseState(await AsyncStorage.getItem(STORAGE_KEY));
}

/** 已经为这个 update 试满次数 → 本次启动不再 reload。 */
export function shouldBlockOtaReload(
  state: OtaReloadGuardState,
  targetUpdateId: string,
): boolean {
  return (
    state.targetUpdateId === targetUpdateId && state.reloadCount >= MAX_OTA_RELOAD_ATTEMPTS
  );
}

/**
 * 记一次 reload 尝试(同一 update 累加,换 update 从 1 重新计数)。
 *
 * **失败会抛出**:调用方必须在 `await` 成功后才 reload。写不进去就 reload,下一轮启动
 * 读到的还是旧计数,闸门永远合不上——那正是这个模块要防的死循环。
 */
export async function recordOtaReload(targetUpdateId: string): Promise<void> {
  const previous = await readOtaReloadGuard();
  const reloadCount =
    previous.targetUpdateId === targetUpdateId ? previous.reloadCount + 1 : 1;
  await AsyncStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ targetUpdateId, reloadCount } satisfies OtaReloadGuardState),
  );
}

/**
 * 启动链走完后调用:只有当次目标确实成为当前运行的 update 才清记录。
 *
 * 不能改成「进了 App 就清」——被闸门放行也算进了 App,那样每次冷启动都会重新放开一次
 * reload,循环变成「每次启动闪一轮」而不是被真正掐断。
 *
 * 读写失败都只吞掉:这里在启动链末端跑,清不掉的代价只是下一次冷启动少做一次热更,
 * 不影响进入 App;而向启动链抛异常没有任何人能处理。
 */
export async function clearOtaReloadGuardIfLaunched(
  currentUpdateId: string | null,
): Promise<void> {
  if (!currentUpdateId) return;
  try {
    const state = await readOtaReloadGuard();
    if (state.targetUpdateId !== currentUpdateId) return;
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore: 记录残留只会让下次冷启动保守一点
  }
}

export const __testing = { storageKey: STORAGE_KEY };
