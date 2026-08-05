/**
 * useAvailableAgents — 当前会话上下文里**运行时已注册**的 agent 集合。
 *
 * 为什么需要:Pi 的二进制经 postinstall best-effort 下载,可能失败/开发环境未装/当前
 * 平台无资产 → `buildPiAgent()` 返回 null → maker 的 agent map 里没有 `pi`。但 provider
 * 模型目录仍会照常投影 Pi 模型,创建入口若只看目录就会让用户一路创建,最终在
 * `Maker.requireAgent()` 撞上 `Agent 'pi' is not registered`(codex review P2)。
 * 权威来源是 `maker:list-available-agents`(runtime 注册结果),不是模型目录。
 *
 * device-link:远程草稿的可用性以**被控端**为准 —— 传 deviceId 时走隧道 invoke
 * (channel 在 REMOTE_INVOKE_ALLOWLIST 内)。省略 = 本机。
 *
 * 加载语义:未加载完成时 `loaded=false` 且 `availableVendors` 为空;消费方必须把
 * "未加载" 当作 "先别隐藏任何入口"(避免异步 fetch 期间误隐藏合法 agent)。
 */
import { useEffect, useState } from 'react';

import type { MakerVendor } from '@/lib/ccAgent.types';
import { createLogger } from '@/lib/logger';

const log = createLogger('useAvailableAgents');

type RuntimeAgentKind = 'claude-code' | 'codex' | 'pi';

/** runtime agent id → NewMaker vendor(其余保持同名)。 */
function toVendor(agent: RuntimeAgentKind): MakerVendor {
  return agent === 'claude-code' ? 'cc' : agent;
}

interface MakerApiShape {
  listAvailableAgents: () => Promise<RuntimeAgentKind[]>;
}
interface DeviceLinkShape {
  invoke: (deviceId: string, channel: string, args: unknown[]) => Promise<unknown>;
}

function getMakerApi(): MakerApiShape | null {
  return (window as unknown as { electronAPI?: { maker?: MakerApiShape } }).electronAPI?.maker ?? null;
}
function getDeviceLink(): DeviceLinkShape | null {
  return (window as unknown as { electronAPI?: { deviceLink?: DeviceLinkShape } }).electronAPI?.deviceLink ?? null;
}

async function fetchAvailableAgents(deviceId?: string | null): Promise<RuntimeAgentKind[]> {
  if (deviceId) {
    const dl = getDeviceLink();
    if (!dl) throw new Error('device-link IPC not available');
    const raw = await dl.invoke(deviceId, 'maker:list-available-agents', []);
    return Array.isArray(raw) ? (raw.filter((v): v is RuntimeAgentKind =>
      v === 'claude-code' || v === 'codex' || v === 'pi') as RuntimeAgentKind[]) : [];
  }
  const api = getMakerApi();
  if (!api) throw new Error('maker IPC not available');
  return api.listAvailableAgents();
}

export interface UseAvailableAgentsResult {
  /** runtime 已注册的 vendor 集合(cc/codex/pi);loaded=false 时为空。 */
  availableVendors: ReadonlySet<MakerVendor>;
  /** 首次结果是否已返回。未加载完成时消费方不应据此隐藏任何入口。 */
  loaded: boolean;
}

/**
 * @param deviceId 省略/undefined = 本机;传值 = 该被控端(device-link)。
 */
export function useAvailableAgents(deviceId?: string | null): UseAvailableAgentsResult {
  const [availableVendors, setAvailableVendors] = useState<ReadonlySet<MakerVendor>>(new Set());
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setAvailableVendors(new Set());
    const run = (): void => {
      fetchAvailableAgents(deviceId)
        .then((agents) => {
          if (cancelled) return;
          setAvailableVendors(new Set(agents.map(toVendor)));
          setLoaded(true);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          // fail-open:查询失败时不隐藏任何入口(loaded 保持 false)——宁可多显示一个
          // 也不因一次 IPC 抖动把合法 agent 从创建入口里抹掉。真正的兜底是创建期 requireAgent。
          log.warn('listAvailableAgents failed; not gating agent entries this cycle', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    };
    run();
    // 会话期间 Pi 二进制可能被按需下载补齐:窗口重新聚焦时再拉一次,让入口及时出现。
    const onFocus = (): void => run();
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
    };
  }, [deviceId]);

  return { availableVendors, loaded };
}
