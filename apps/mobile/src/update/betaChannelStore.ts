/**
 * Mobile beta 测试渠道的**设备级**本地快照。
 *
 * 与 canaryChannelStore 的关键区别:
 *   - canary 是账号级、服务端下发(login 后 feature-flags → 本地持久化 → 登出清);
 *   - beta 是设备级、客户端本地设置(设置页开关),登出/换号都不清。
 *
 * 所以这里没有 clearBetaChannel(登出清理):开关只随设备走,不随账号生命周期。
 * 其余机制(AsyncStorage 快照 + hydrate 门 + mutation 队列)与 canaryChannelStore 一致,
 * 保证「冷启动任何更新请求前先恢复本地快照」、损坏 fail-safe 到 stable。
 *
 * 标记不敏感(只选择公开 CDN 指针),AsyncStorage 即可。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'cindy.mobile.update.beta';

let beta = false;
/** 磁盘确认态:最近一次成功落盘的值。回滚一律回到它,而非上一次调用的乐观值。 */
let committed = false;
let hydrated = false;
let hydratePromise: Promise<boolean> | null = null;
let mutationEpoch = 0;
let mutationQueue: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // ignore listener failures
    }
  }
}

function enqueueMutation(operation: () => Promise<void>): Promise<void> {
  const run = mutationQueue.then(operation, operation);
  mutationQueue = run.catch(() => undefined);
  return run;
}

/** 冷启动时调用一次；损坏/不可读一律 fail-safe 到 false(不启用 beta)。 */
export function hydrateBetaChannel(): Promise<boolean> {
  if (hydrated) return Promise.resolve(beta);
  if (hydratePromise) return hydratePromise;
  const epoch = mutationEpoch;
  hydratePromise = AsyncStorage.getItem(STORAGE_KEY)
    .then((raw) => {
      if (epoch === mutationEpoch) {
        const next = raw === 'true';
        committed = next;
        if (beta !== next || !hydrated) {
          beta = next;
          notifyListeners();
        }
      }
      hydrated = true;
      return beta;
    })
    .catch(() => {
      if (epoch === mutationEpoch) {
        committed = false;
        if (beta || !hydrated) {
          beta = false;
          notifyListeners();
        }
      }
      hydrated = true;
      return beta;
    })
    .finally(() => {
      hydratePromise = null;
    });
  return hydratePromise;
}

/** 启动 gate 完成后可同步读取。未 hydrate 时按 false(不启用 beta)。 */
export function isBetaChannel(): boolean {
  return hydrated && beta;
}

/** 订阅开关变化；返回取消订阅函数。 */
export function subscribeBetaChannel(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * 设置页开关写入；内存态先行、串行落盘。落盘失败回滚内存态并重新抛错。
 *
 * 与 canaryChannelStore.syncCanaryChannel 的差异：canary 是服务端下发、落盘失败
 * 下次登录会重新同步；beta 是**用户可见**的设置开关，若不回滚会出现「设置页显示已开、
 * 本次运行按 beta 检查更新、重启后却回 release」的漂移，所以这里额外做失败回滚。
 *
 * 回滚目标是 `committed`(磁盘确认态)而非「本次调用前的内存态」:连续两次落盘都失败时,
 * 后一次的「调用前内存态」是前一次尚未落盘的乐观值,回滚到它会得到错误结果
 * (例如 release→开→关 都失败,内存反而停在「已开」)。回滚到磁盘真实值总是安全的。
 */
export function syncBetaChannel(next: boolean): Promise<void> {
  const value = next === true;
  mutationEpoch += 1;
  const epoch = mutationEpoch;
  hydrated = true;
  beta = value;
  notifyListeners();
  return enqueueMutation(async () => {
    if (value) await AsyncStorage.setItem(STORAGE_KEY, 'true');
    else await AsyncStorage.removeItem(STORAGE_KEY);
  }).then(
    () => {
      committed = value;
    },
    (err) => {
      // 只有自己仍是最新 mutation 时才回滚:若有更新的 mutation 已乐观设置了
      // beta(它自己负责成功/失败),这里回滚 committed 会把它的乐观值覆盖掉,
      // 造成「内存 release、磁盘 beta」的漂移。更新 mutation 会处理它自己的结果。
      if (epoch === mutationEpoch) {
        beta = committed;
        notifyListeners();
      }
      throw err;
    },
  );
}

export const __testing = {
  storageKey: STORAGE_KEY,
  async resetMemory(): Promise<void> {
    await mutationQueue.catch(() => undefined);
    beta = false;
    committed = false;
    hydrated = false;
    hydratePromise = null;
    mutationEpoch = 0;
    mutationQueue = Promise.resolve();
    listeners.clear();
  },
};
