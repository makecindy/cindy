import { useCallback, useEffect, useRef, useState } from 'react';

import { getDataOwnerGeneration, isDataOwnerIdCurrent } from '@/contexts/dataOwnerGeneration';
import { createLogger } from '@/lib/logger';

const log = createLogger('useDiscordChannelAccess');

export type DiscordChannelAccess = import('../../shared/botImConnection').BotImDiscordChannelAccess;
export type DiscordGuilds = DiscordBotChannelListing['guilds'];

/** 对端电脑太旧：读到的白名单形状不是这一版能安全编辑的（不能静默放大或写丢）。 */
export class DiscordChannelAccessUnsupportedError extends Error {
  constructor() {
    super('discord channel access version unsupported');
  }
}

/** 数据来源：个人 bot（设置页 IPC）或某位伙伴的某条 Discord 连接（连接设置 IPC / 远程操作）。 */
export interface DiscordChannelAccessSource {
  load(): Promise<{ guilds: DiscordGuilds; access: DiscordChannelAccess; online?: boolean }>;
  save(access: DiscordChannelAccess): Promise<DiscordChannelAccess>;
}

/** 设置 → IM 机器人 里那份个人 bot：白名单只含主人。 */
export const personalDiscordChannelAccessSource: DiscordChannelAccessSource = {
  async load() {
    const [listing, access] = await Promise.all([
      window.electronAPI.discordBot.listChannels(),
      window.electronAPI.discordBot.getChannelAccess(),
    ]);
    return { guilds: listing.guilds, access, online: listing.status.kind === 'connected' };
  },
  save: (access) => window.electronAPI.discordBot.setChannelAccess(access),
};

export type DiscordChannelAccessError = 'load' | 'save' | 'unsupported';

export interface UseDiscordChannelAccessReturn {
  /** null = 尚未读到（首次加载中）。 */
  guilds: DiscordGuilds | null;
  /** 当前白名单；null = 尚未读到。 */
  access: DiscordChannelAccess | null;
  /** 机器人当前是否连着（来源没给就按连着算）。 */
  online: boolean;
  loading: boolean;
  error: DiscordChannelAccessError | null;
  /** 用一个纯变换改白名单（乐观更新、串行保存、失败回滚）。 */
  update: (transform: (access: DiscordChannelAccess) => DiscordChannelAccess) => void;
  reload: () => void;
}

/**
 * 「服务器频道」的数据层：清单来自机器人当前连接，白名单即改即存。
 * 写入按点击顺序串行，最后一次返回的结果为准；任何一次写失败，等队列排空后按主进程里
 * 真实保存的白名单回滚并报错，界面不会停在没保存的勾选上。`sourceKey`（连接 id）变化等同于
 * 断开：清空旧连接的清单与未发出的写入，绝不把一条连接的白名单写到另一条上。
 */
export function useDiscordChannelAccess(
  active: boolean,
  source: DiscordChannelAccessSource = personalDiscordChannelAccessSource,
  sourceKey = 'personal',
): UseDiscordChannelAccessReturn {
  const [guilds, setGuilds] = useState<DiscordGuilds | null>(null);
  const [access, setAccess] = useState<DiscordChannelAccess | null>(null);
  const [online, setOnline] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<DiscordChannelAccessError | null>(null);
  const desiredRef = useRef<DiscordChannelAccess | null>(null);
  const pendingWrites = useRef(0);
  const saveFailed = useRef(false);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const loadVersion = useRef(0);
  const mutationRevision = useRef(0);
  const mounted = useRef(true);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  /**
   * 写入代次：断开 / 重连 / 换连接 / 卸载都会作废。已排队但还没发出的写入带着旧代次，到点直接跳过，
   * 不把旧清单里算出来的整份白名单写进主进程。这只挡「还没发出」的写入；已经发给主进程的请求
   * 由主进程按当时的 owner 作用域落盘，渲染端无法也不声称撤回它。
   */
  const writeEpoch = useRef(0);

  const invalidateUnsupportedAccess = useCallback(() => {
    // 远端降级后旧 v2 快照不能再用于编辑，尚未发出的写入也必须失效。
    writeEpoch.current += 1;
    pendingWrites.current = 0;
    saveFailed.current = false;
    desiredRef.current = null;
    setGuilds(null);
    setAccess(null);
    setError('unsupported');
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      writeEpoch.current += 1;
    };
  }, []);

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    const owner = getDataOwnerGeneration();
    const revision = mutationRevision.current;
    setLoading(true);
    try {
      const loaded = await sourceRef.current.load();
      // 过期的加载、卸载后的加载、换了账号的加载、还有写入在途时的加载，都不覆盖用户刚点的勾选。
      if (!mounted.current || version !== loadVersion.current || !isDataOwnerIdCurrent(owner))
        return;
      setGuilds(loaded.guilds);
      setOnline(loaded.online !== false);
      // 请求发出后的保存即使已经结束，旧快照也不能再作为编辑基准。
      if (pendingWrites.current === 0 && revision === mutationRevision.current) {
        desiredRef.current = loaded.access;
        setAccess(loaded.access);
      }
      setError(null);
    } catch (err) {
      if (!mounted.current || version !== loadVersion.current || !isDataOwnerIdCurrent(owner)) return;
      log.error('load failed:', err instanceof Error ? err.message : String(err));
      if (err instanceof DiscordChannelAccessUnsupportedError) {
        invalidateUnsupportedAccess();
      } else {
        setError('load');
      }
    } finally {
      if (mounted.current && version === loadVersion.current) setLoading(false);
    }
  }, [invalidateUnsupportedAccess]);

  useEffect(() => {
    if (!active) {
      // 断开 / 未连接：丢掉旧清单，下次连上重新读，不展示别的账号 / 别的 bot 的服务器。
      loadVersion.current += 1;
      writeEpoch.current += 1;
      pendingWrites.current = 0;
      saveFailed.current = false;
      setGuilds(null);
      setAccess(null);
      setError(null);
      setLoading(false);
      desiredRef.current = null;
      return;
    }
    void load();
    return () => {
      // 换连接（sourceKey 变化）或断开：这一轮的清单和排队写入一并作废。
      loadVersion.current += 1;
      writeEpoch.current += 1;
      pendingWrites.current = 0;
      saveFailed.current = false;
      desiredRef.current = null;
      setGuilds(null);
      setAccess(null);
    };
  }, [active, load, sourceKey]);

  const enqueueSave = useCallback((next: DiscordChannelAccess) => {
    mutationRevision.current += 1;
    desiredRef.current = next;
    setAccess(next);
    setError(null);
    pendingWrites.current += 1;
    const epoch = writeEpoch.current;
    const owner = getDataOwnerGeneration();
    const writeSource = sourceRef.current;
    saveQueue.current = saveQueue.current.then(async () => {
      const stale = () => epoch !== writeEpoch.current || !isDataOwnerIdCurrent(owner);
      try {
        // 排队期间断开 / 换连接 / 换账号 / 卸载：这次写入属于过期的界面，不发给主进程，也不回填界面。
        if (stale()) return;
        const saved = await writeSource.save(next);
        // 只有队列里最后一次写入的结果才回填界面，前面的是中间态；发出期间界面已过期则不回填。
        if (mounted.current && !stale() && pendingWrites.current === 1) {
          desiredRef.current = saved;
          setAccess(saved);
        }
      } catch (err) {
        if (!stale()) saveFailed.current = true;
        log.error('save failed:', err instanceof Error ? err.message : String(err));
      } finally {
        // 代次作废时计数已被清零（见上），过期的写入不再参与计数。
        if (!stale()) pendingWrites.current -= 1;
        if (!stale() && pendingWrites.current === 0 && saveFailed.current) {
          saveFailed.current = false;
          try {
            const loaded = await writeSource.load();
            if (mounted.current && !stale() && pendingWrites.current === 0) {
              desiredRef.current = loaded.access;
              setAccess(loaded.access);
            }
          } catch (err) {
            if (mounted.current && !stale() && err instanceof DiscordChannelAccessUnsupportedError) {
              invalidateUnsupportedAccess();
            }
            // 其他补读错误保留当前显示，并提供重试。
          }
          if (mounted.current && !stale()) setError('save');
        }
      }
    });
  }, [invalidateUnsupportedAccess]);

  const update = useCallback(
    (transform: (access: DiscordChannelAccess) => DiscordChannelAccess) => {
      const base = desiredRef.current;
      if (!base) return;
      const next = transform(base);
      if (next === base) return;
      enqueueSave(next);
    },
    [enqueueSave],
  );

  const reload = useCallback(() => {
    void load();
  }, [load]);

  return {
    guilds,
    access,
    online,
    loading,
    error,
    update,
    reload,
  };
}
