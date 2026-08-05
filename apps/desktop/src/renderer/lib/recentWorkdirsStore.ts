/**
 * recentWorkdirsStore — "最近工作目录"列表的模块级单例 store
 * ---------------------------------------------------------------------------
 * 跟 sessionsStore 的设计同源(remount 命中 cache,避免空白帧),但只有单一
 * 数据视图(不分桶),所以实现简化:一个 cache 数组 + subscribe + ensure + refresh。
 *
 * 写入语义在 main 侧:每次成功创建一个 source='desktop' 且 workspaceKind='project'
 * 的 session 都会 upsert 一条。renderer 侧唯一的写操作是 remove(用户在项目
 * 选择器里手动移除条目),删除后本地 patch cache,不整表重拉。
 *
 * 刷新时机:
 *  - 模块加载时自订阅 sessionsPush.onCreated → forceRefresh
 *    (main 端 session 创建广播 = 可能新增了 recent_workdirs row)
 *  - 调用方 (hook) 也可以主动调 forceRefresh
 *
 * 不订阅 sessionsPush.onPatched —— 字段变更 (rename / pin / archive) 不影响
 * recent_workdirs 表。
 */

export interface RecentWorkdirEntry {
  /** 绝对路径(写入时已 trim,跟 sessions.workingDir 形态一致)。 */
  path: string;
  /** ISO 8601 字符串,IPC 边界已转换。 */
  lastUsedAt: string;
  /** 目录是否仍在磁盘上(main 侧 list 时探测);false → UI 置灰提示已迁移/删除。 */
  exists: boolean;
}

let cache: RecentWorkdirEntry[] | null = null;
let inflight: Promise<RecentWorkdirEntry[]> | null = null;
const subs = new Set<() => void>();

function notify(): void {
  subs.forEach((fn) => fn());
}

async function fetchList(): Promise<RecentWorkdirEntry[]> {
  // window.electronAPI 在 SSR / 测试 / preload 未就绪场景可能不存在 —— 直接返回空。
  const api = (typeof window !== 'undefined'
    ? window.electronAPI?.localDb?.recentWorkdirs
    : undefined);
  if (!api) return [];
  return api.list();
}

export const recentWorkdirsStore = {
  subscribe(fn: () => void): () => void {
    subs.add(fn);
    return () => {
      subs.delete(fn);
    };
  },

  /** 当前快照;null 表示尚未加载过(hook 据此决定 isLoading 初值)。 */
  get(): RecentWorkdirEntry[] | null {
    return cache;
  },

  /** 命中即 noop,dedupe 并发请求。 */
  async ensure(): Promise<void> {
    if (cache) return;
    if (!inflight) {
      inflight = fetchList()
        .then((data) => {
          cache = data;
          inflight = null;
          notify();
          return data;
        })
        .catch((e) => {
          inflight = null;
          throw e;
        });
    }
    await inflight;
  },

  /** 强制重拉(drop cache 后 ensure)。 */
  async forceRefresh(): Promise<RecentWorkdirEntry[]> {
    cache = null;
    inflight = null;
    await this.ensure();
    return cache ?? [];
  },

  /**
   * 从最近列表移除一条(用户在项目选择器 hover 删除)。
   * 先乐观 patch 本地 cache(行消失零延迟),再发 IPC;IPC 失败时重拉一次
   * 恢复真实状态。目录下再次创建 session 会自动重新入列,语义自愈。
   */
  async remove(path: string): Promise<void> {
    if (cache) {
      cache = cache.filter((e) => e.path !== path);
      notify();
    }
    const api = (typeof window !== 'undefined'
      ? window.electronAPI?.localDb?.recentWorkdirs
      : undefined);
    if (!api) return;
    try {
      await api.remove({ path });
    } catch {
      // 删除失败(极少:DB 忙等)→ 重拉恢复,别让 UI 停留在假状态。
      void this.forceRefresh().catch(() => {});
    }
  },

  /** 仅供测试 / 登出清理。 */
  reset(): void {
    cache = null;
    inflight = null;
    notify();
  },
};

/* ============================== 自订阅 ============================== */

if (typeof window !== 'undefined') {
  // session 新建 = 可能新增一条 recent_workdirs(只在 source='desktop' &&
  // workspaceKind='project' 且 workingDir 非空时 main 端真的写),无脑重拉一次
  // 最便宜可靠 —— 表只有几行,IPC 开销可忽略。
  const sessionsPush = window.electronAPI?.localDb?.sessionsPush;
  if (sessionsPush) {
    sessionsPush.onCreated(() => {
      void recentWorkdirsStore.forceRefresh().catch(() => {
        /* 静默:下次 ensure / 用户主动操作会再尝试 */
      });
    });
  }
  // 删除广播:别的窗口(或 device-link 远程调用)移除条目时,本窗口的模块级
  // 缓存也要跟上,否则删掉的项目在这里仍可选。发起删除的窗口自己已乐观 patch,
  // 重拉一次幂等无害。
  const recentApi = window.electronAPI?.localDb?.recentWorkdirs;
  if (recentApi?.onChanged) {
    recentApi.onChanged(() => {
      void recentWorkdirsStore.forceRefresh().catch(() => {
        /* 静默:同上 */
      });
    });
  }
}
