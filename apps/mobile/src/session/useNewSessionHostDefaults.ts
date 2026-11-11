import { useCallback, useEffect, useRef, useState } from 'react';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent, type MobileAuthOwnerGeneration } from '@/auth/authOwnerGeneration';
import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';
import { withTransientRemoteRetry } from '@/device-link/remoteRetry';
import { NEW_SESSION_AGENT_OPTIONS, hostDraftRuntimeFromDefaults, isHostDraftDefaultsReady, type NewSessionDraft, type NewSessionAgentKind, type NewSessionRuntime } from './newSession';
import { cacheNewSessionHostDefaults, getNewSessionHostDefaults, rememberNewSessionHostRuntime, type NewSessionHostDefaults } from './newSessionHostDefaultsCache';

export function useNewSessionHostDefaults({
  selectedDeviceId, deviceLinkStatus, maker, openLink, outboxOwner, remoteAgentChoice, draft
}: {
  selectedDeviceId: string;
  deviceLinkStatus: string;
  maker: Pick<MobileMakerTransport, 'getNewMakerDefaults' | 'applyNewMakerDraftPref'>;
  openLink: (deviceId: string) => Promise<unknown>;
  outboxOwner: MobileAuthOwnerGeneration;
  remoteAgentChoice: unknown;
  draft: NewSessionDraft;
}) {
  const selectedDeviceRef = useRef(selectedDeviceId);
  selectedDeviceRef.current = selectedDeviceId;
  const [hostDraftDefaults, setHostDraftDefaults] = useState<NewSessionHostDefaults | null>(
    () => getNewSessionHostDefaults(selectedDeviceId),
  );
  const hostDraftDefaultsRef = useRef(hostDraftDefaults);
  hostDraftDefaultsRef.current = hostDraftDefaults;
  // 在途读取:切 agent 时等它读完再选模型,避免先落目录默认、又因已手动切换而再也补不回来。
  const hostDraftDefaultsLoadRef = useRef<{
    deviceId: string;
    byAgent: Partial<Record<NewSessionAgentKind, Promise<void>>>;
  } | null>(null);
  useEffect(() => {
    const deviceId = selectedDeviceId;
    const owner = getMobileAuthOwner();
    const cached = getNewSessionHostDefaults(deviceId);
    hostDraftDefaultsRef.current = cached;
    setHostDraftDefaults(cached);
    if (!deviceId || deviceLinkStatus !== 'online' || !owner.accountKey) return undefined;
    let cancelled = false;
    const successfulAgents = new Set<NewSessionAgentKind>();
    const isCurrent = () => !cancelled && isMobileAuthOwnerCurrent(owner);
    const readAgent = async (agentKind: NewSessionAgentKind) => {
      for (let attempt = 0; ; attempt += 1) {
        const defaults = await withTransientRemoteRetry(async () => {
          await openLink(deviceId);
          return maker.getNewMakerDefaults(agentKind);
        }, { maxAttempts: 2 }).catch(() => undefined);
        if (!isCurrent()) return null;
        // 被控端刚启动、渲染进程还没推来草稿时回 {}:稍后重读,不把它当成「从未选过模型」;
        // 有限次后(含不带该字段的旧被控端)按无默认处理。读取失败不重读。
        if (defaults === undefined || isHostDraftDefaultsReady(defaults) || attempt >= 2) {
          if (!isHostDraftDefaultsReady(defaults)) {
            if (cached) return cached.byAgent[agentKind] ?? null;
          } else {
            successfulAgents.add(agentKind);
          }
          return hostDraftRuntimeFromDefaults(defaults, agentKind);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 1_500));
        if (!isCurrent()) return null;
      }
    };
    const byAgent = Object.fromEntries(NEW_SESSION_AGENT_OPTIONS.map(({ kind }) => [kind, readAgent(kind).then((runtime) => {
      if (!isCurrent()) return;
      // Publish each engine as soon as it settles. Leaving this page while an
      // unrelated engine is slow must not discard a successful default.
      const snapshot = {
        deviceId,
        byAgent: { ...hostDraftDefaultsRef.current?.byAgent, [kind]: runtime, ...hostChoiceOverridesRef.current.get(deviceId) },
      };
      // A failed optional engine must not discard another engine's successful read.
      // Unknown engines stay absent from the cross-page cache; this visit may still
      // fall back after the read has failed, as before.
      const cacheable = {
        deviceId,
        byAgent: {
          ...cached?.byAgent,
          [kind]: runtime,
          ...hostChoiceOverridesRef.current.get(deviceId),
        },
      };
      const remembered = successfulAgents.has(kind) ? cacheNewSessionHostDefaults(cacheable, cached) : getNewSessionHostDefaults(deviceId);
      const next = { ...snapshot, byAgent: { ...snapshot.byAgent, ...remembered?.byAgent, ...hostChoiceOverridesRef.current.get(deviceId) } };
      // 同步更新镜像:等待中的切 agent 回调在下一次渲染前就要读到结果。
      hostDraftDefaultsRef.current = next;
      setHostDraftDefaults(next);
    })]));
    hostDraftDefaultsLoadRef.current = { deviceId, byAgent };
    return () => {
      cancelled = true;
    };
  }, [deviceLinkStatus, maker, openLink, selectedDeviceId, outboxOwner]);
  // 只等目标 agent 的默认读完(读完、失败都算);没有在途读取(离线 / 未选设备)时不等,
  // 按目录默认继续。effect 重跑会换一份新的在途读取,跟着等新的那份(有限次)。
  const waitHostDraftDefaults = useCallback(async (deviceId: string, agentKind: NewSessionAgentKind) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (hostDraftDefaultsRef.current?.deviceId === deviceId
        && agentKind in hostDraftDefaultsRef.current.byAgent) return;
      const load = hostDraftDefaultsLoadRef.current;
      if (!load || load.deviceId !== deviceId) return;
      await load.byAgent[agentKind];
    }
  }, []);
  const hostDefaultsSettled = !!selectedDeviceId && hostDraftDefaults?.deviceId === selectedDeviceId
    && draft.agentKind in hostDraftDefaults.byAgent;
  // 本页已写回被控电脑的选择(按设备、agent):优先于读取结果,避免选择前发出的读取
  // 晚到后把旧模型带回来(切到别的 agent 再切回时)。
  const hostChoiceOverridesRef = useRef(new Map<string, Partial<Record<NewSessionAgentKind, NewSessionRuntime>>>());
  const hostChoiceOwnerRef = useRef(outboxOwner);
  if (hostChoiceOwnerRef.current !== outboxOwner) {
    hostChoiceOwnerRef.current = outboxOwner;
    hostChoiceOverridesRef.current.clear();
  }
  const hostRuntimeFor = useCallback(
    (agentKind: NewSessionAgentKind): NewSessionRuntime | null => {
      const deviceId = selectedDeviceRef.current;
      const chosen = hostChoiceOverridesRef.current.get(deviceId)?.[agentKind];
      if (chosen) return chosen;
      const current = hostDraftDefaultsRef.current;
      return current && current.deviceId === deviceId
        ? current.byAgent[agentKind] ?? null
        : null;
    },
    [],
  );
  // 在新建任务页选的模型 / 档位写回被控电脑的新建任务默认(与桌面远程新建同一写法
  // maker:apply-new-maker-draft-pref active=true),下次在这台电脑上新建任务——不论手机、
  // 桌面还是远程桌面——默认都是它。由选择入口发请求,本 effect 在草稿提交后读最终值写出;
  // 写失败不打扰,本页草稿照常生效。远程 Agent(模型属于另一台电脑)不写回被控电脑。
  const [hostChoiceRequest, setHostChoiceRequest] = useState<{ seq: number; markModelChoice: boolean } | null>(null);
  const hostChoiceSentSeqRef = useRef(0);
  const requestHostChoiceWrite = useCallback((markModelChoice: boolean) => {
    setHostChoiceRequest((current) => ({ seq: (current?.seq ?? 0) + 1, markModelChoice }));
  }, []);
  useEffect(() => {
    if (!hostChoiceRequest || hostChoiceRequest.seq === hostChoiceSentSeqRef.current) return;
    hostChoiceSentSeqRef.current = hostChoiceRequest.seq;
    if (!selectedDeviceId || remoteAgentChoice || !draft.model) return;
    const { agentKind, model, providerId, effort, fastMode } = draft;
    void maker.applyNewMakerDraftPref({
      agent: agentKind,
      providerId: providerId ?? '',
      modelId: model,
      active: true,
      markModelChoice: hostChoiceRequest.markModelChoice,
      ...(effort ? { effort } : {}),
      fast: fastMode,
    }).catch(() => undefined);
    // 记下本页选择:切到别的 agent 再切回时取到它,不被在途或更早的读取结果覆盖。
    const overrides = hostChoiceOverridesRef.current;
    overrides.set(selectedDeviceId, {
      ...overrides.get(selectedDeviceId),
      [agentKind]: { agentKind, model, effort, providerId },
    });
    rememberNewSessionHostRuntime(selectedDeviceId, { agentKind, model, effort, providerId });
  }, [draft, hostChoiceRequest, maker, remoteAgentChoice, selectedDeviceId]);
  return { hostDraftDefaults, hostDefaultsSettled, hostRuntimeFor, waitHostDraftDefaults, requestHostChoiceWrite };
}
