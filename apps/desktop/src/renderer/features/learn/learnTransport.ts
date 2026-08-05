/**
 * learnTransport —— learn 功能的 device-link 透明传输层(makerTransport 同范式)。
 *
 * learn run 的事实源在「会话归属设备」的 learn-host(runs.json / staging / apply
 * 全在那台机器):本机会话直接走 window.electronAPI.learn;device-link 远程会话
 * 经 deviceLink.invoke 隧道到被控端同名 channel,事件流经 onRemotePush 消费。
 * 上层组件(状态卡 / 审查面板 / hooks)拿 contextSessionId(所在会话视图的
 * sessionId)路由,其余逻辑零改动。
 *
 * 归属解析是**惰性 + 粘滞**的(Codex review #548):
 *  - 惰性:每次调用 / 事件绑定时才解析 sessionId→deviceId,而不是构造适配器时
 *    快照 —— 刚建的远程蒸馏会话要等 `sessions:created` push 触发的异步重拉才会
 *    注册 origin,快照会把适配器永久钉死在本机 learn-host 上;
 *  - 粘滞:一旦解析到过 deviceId,后续解析出 undefined(relay 瞬时重连会 clear()
 *    镜像)时沿用最后已知值,绝不把远程会话的 learn 操作降级回本机(apply 落错
 *    机器比隧道失败严重得多)。与 CCAgentSessionView 的 sticky remoteDeviceId 同语义。
 *
 * 被控端 handler 抛的 throwIpcError `[CODE] message` 经隧道原样透传为 reject,
 * 上层既有的 mapIpcErrorToI18nKey 继续解码,错误协议免改。
 */

import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';

import type { LearnEventPayload } from '../../../shared/learnTypes';

type FullLearn = typeof window.electronAPI.learn;

/** 状态卡 / 审查面板消费的 learn 操作子集(start 不在此:/learn 统一走 desktop 命令路径)。 */
export interface RoutableLearn {
  listRuns: FullLearn['listRuns'];
  getProposalDiff: FullLearn['getProposalDiff'];
  apply: FullLearn['apply'];
  discard: FullLearn['discard'];
  cancel: FullLearn['cancel'];
}

/** 惰性 + 粘滞的归属解析:粘滞状态在模块级缓存(stickySessionOrigin),
 *  跨适配器重建 / effect 重跑存活 —— relay 重连清镜像触发的重建不会丢掉归属。 */
function resolveDeviceId(contextSessionId: string | null | undefined): string | undefined {
  return getStickySessionDeviceId(contextSessionId);
}

/**
 * 按上下文会话来源返回 learn 操作入口:本机 → 真 window.electronAPI.learn;
 * 远程 → 隧道到归属设备。contextSessionId 是组件所在会话视图的 sessionId
 * (触发会话或蒸馏会话皆可 —— 两者同设备)。每次方法调用时重新解析归属。
 */
export function learnApiFor(contextSessionId: string | null | undefined): RoutableLearn {
  const t =
    (channel: string, local: (...args: never[]) => unknown) =>
    (...args: unknown[]): Promise<unknown> => {
      const deviceId = resolveDeviceId(contextSessionId);
      if (!deviceId) return Promise.resolve(local(...(args as never[])));
      return window.electronAPI.deviceLink.invoke(deviceId, channel, args);
    };
  const localApi = window.electronAPI.learn;
  return {
    listRuns: t('learn:list-runs', localApi.listRuns) as FullLearn['listRuns'],
    getProposalDiff: t('learn:get-proposal-diff', localApi.getProposalDiff) as FullLearn['getProposalDiff'],
    apply: t('learn:apply', localApi.apply) as FullLearn['apply'],
    discard: t('learn:discard', localApi.discard) as FullLearn['discard'],
    cancel: t('learn:cancel', localApi.cancel) as FullLearn['cancel'],
  };
}

/**
 * 订阅 learn run 状态机事件并回调:
 *  - 本机上下文 → 本机 learn:event IPC fan-out;
 *  - 远程上下文 → device-link 远程推送(被控端 learn:event 账号级并入 sessions
 *    topic,设备在线且被镜像订阅时即达),按 deviceId + channel 过滤。
 * 归属在订阅期间可能变化(origin 注入 / 重连恢复)—— 内部监听 remoteProjectsStore,
 * 解析结果变化时自动拆旧绑新,调用方无需感知。返回 unsubscribe。
 */
export function subscribeLearnEvents(
  contextSessionId: string | null | undefined,
  cb: (payload: LearnEventPayload) => void,
): () => void {
  const bind = (deviceId: string | undefined): (() => void) => {
    if (!deviceId) {
      return window.electronAPI.learn.onEvent(cb);
    }
    return (
      window.electronAPI.deviceLink?.onRemotePush?.((push) => {
        if (push.deviceId !== deviceId || push.channel !== 'learn:event') return;
        cb(push.payload as LearnEventPayload);
      }) ?? (() => {})
    );
  };

  let current = resolveDeviceId(contextSessionId);
  let offInner = bind(current);
  // origin 注入 / 重连恢复时重绑(粘滞解析保证不会降级回本机)。
  const offStore = remoteProjectsStore.subscribe(() => {
    const next = resolveDeviceId(contextSessionId);
    if (next === current) return;
    current = next;
    offInner();
    offInner = bind(next);
  });
  return () => {
    offStore();
    offInner();
  };
}
