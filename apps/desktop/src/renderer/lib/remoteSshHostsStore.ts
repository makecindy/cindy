/**
 * remoteSshHostsStore — renderer 侧 SSH host registry 快照。
 *
 * 项目树、搜索和筛选都需要把 session 持久化的 remoteHostId 解析成可读机器
 * 身份。这里集中读取一次 remoteSsh.list(),并用状态推送增量更新,避免各 UI
 * surface 独立请求后出现短暂的不一致。读取失败时保留 null 快照,调用方继续用
 * remoteHostId 兜底,不引入 loading 或阻断界面。
 */

let cache: RemoteHostSnapshot[] | null = null;
let inflight: Promise<RemoteHostSnapshot[]> | null = null;
/** replace/remove/reset 每次推进版本,让更早发出的 list 结果不能写回覆盖新状态。 */
let revision = 0;
const subscribers = new Set<() => void>();

function notify(): void {
  subscribers.forEach((subscriber) => subscriber());
}

async function fetchHosts(): Promise<RemoteHostSnapshot[]> {
  const api = typeof window !== 'undefined' ? window.electronAPI?.remoteSsh : undefined;
  if (!api) return [];
  const result = await api.list();
  return result.hosts;
}

export const remoteSshHostsStore = {
  subscribe(subscriber: () => void): () => void {
    subscribers.add(subscriber);
    return () => {
      subscribers.delete(subscriber);
    };
  },

  get(): RemoteHostSnapshot[] | null {
    return cache;
  },

  /** Settings 已经拿到完整 list 时复用结果,避免 mutation 后再发一次重复 IPC。 */
  replace(hosts: readonly RemoteHostSnapshot[]): void {
    revision += 1;
    cache = [...hosts];
    inflight = null;
    notify();
  },

  /** Settings 删除 host 后同步移除共享快照,让项目身份立即回退到 remoteHostId。 */
  remove(id: string): void {
    revision += 1;
    inflight = null;
    if (cache === null) return;
    const next = cache.filter((host) => host.config.id !== id);
    if (next.length === cache.length) return;
    cache = next;
    notify();
  },

  async ensure(): Promise<void> {
    if (cache !== null) return;
    if (!inflight) {
      const requestRevision = revision;
      const request = fetchHosts();
      inflight = request;
      try {
        const hosts = await request;
        if (inflight === request && revision === requestRevision) {
          cache = hosts;
          notify();
        }
      } finally {
        if (inflight === request) inflight = null;
      }
      return;
    }
    await inflight;
  },

  reset(): void {
    revision += 1;
    cache = null;
    inflight = null;
    notify();
  },
};

if (typeof window !== 'undefined') {
  const api = window.electronAPI?.remoteSsh;
  if (api) {
    api.onHostsChanged?.((result) => remoteSshHostsStore.replace(result.hosts));
    api.onStatusChanged((snapshot) => {
      if (cache === null) return;
      const index = cache.findIndex((host) => host.config.id === snapshot.config.id);
      cache =
        index === -1
          ? [...cache, snapshot]
          : cache.map((host, hostIndex) => (hostIndex === index ? snapshot : host));
      notify();
    });
  }
}
