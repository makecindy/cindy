/**
 * fallbackRunner —— 把一条已存的备用链变成真正的自动改道。
 *
 * 之前的状态：decideFallbackStep 等决策函数写完也测完了，但全库没有任何
 * 调用方 —— 链只活在选择器的 UI 里，一次真实失败也不会改变任何路由。
 * 本模块是那条缺失的链路。
 *
 * 分层理由：这里只做**纯决策**（下一步是重试、改道还是停，改道到哪一项），
 * 不碰 IPC、不碰 React。副作用（setModel / switchSessionAgent / retry）留给调用方，
 * 这样决策规则可以被逐条测，而不用架一整个会话运行时。
 */

import {
  decideFallbackStep,
  initialFallbackChainState,
  isFallbackChainActive,
  type FallbackChain,
  type FallbackChainEntry,
  type FallbackChainState,
  type FallbackFailure,
} from '@cindy/maker-shared/fallback-chain';

/** 一次失败后要执行的动作。 */
export type FallbackPlan =
  /** 原模型再试一次（不改任何路由）。 */
  | { kind: 'retry'; state: FallbackChainState }
  /** 改道到 target，然后重试。 */
  | { kind: 'switch'; target: FallbackChainEntry; from: FallbackChainEntry; state: FallbackChainState }
  /** 什么都不做，把错误原样交给用户。 */
  | { kind: 'stop'; reason: 'chain-exhausted' | 'fatal' | 'inactive' | 'not-on-chain' };

/**
 * 当前正在跑的配置处于链里的哪一步。
 *
 * 不能只信内存里的游标：用户可能在两次失败之间手动换了模型，那时候
 * 继续拿旧游标往下走会把他刚选的模型跳过去。按**实际跑着的身份**重新定位。
 */
export function locateChainPosition(
  chain: FallbackChain,
  current: { providerId: string; modelId: string; agent: string },
): number {
  return chain.entries.findIndex(
    (entry) =>
      entry.providerId === current.providerId &&
      entry.modelId === current.modelId &&
      entry.agent === current.agent,
  );
}

/**
 * 失败发生时算下一步。
 *
 * 两道门先走：链不生效（停用 / 只有主模型）直接不管；正在跑的配置不在链上
 也不管 —— 用户手动换到了链外的模型，那是他的选择，不该被一条旧链拖走。
 */
export function planNextFallbackStep(args: {
  chain: FallbackChain | null;
  current: { providerId: string; modelId: string; agent: string };
  failure: FallbackFailure;
  /** 本轮已花掉的重试次数（同一项上）。 */
  retries: number;
  /**
   * 还在冷却期里的项（已知没额度）。改道时直接跳过它们 —— 撑到一个已知
   * 会失败的模型只是白白多花一轮往返。
   */
  isCoolingDown?: ((entry: FallbackChainEntry) => boolean) | undefined;
}): FallbackPlan {
  const { chain, current, failure, retries, isCoolingDown } = args;
  if (!isFallbackChainActive(chain) || !chain) return { kind: 'stop', reason: 'inactive' };
  const index = locateChainPosition(chain, current);
  if (index < 0) return { kind: 'stop', reason: 'not-on-chain' };

  const state: FallbackChainState = { index, retries };
  const decision = decideFallbackStep(chain, state, failure);
  if (decision.action === 'stop') return { kind: 'stop', reason: decision.reason };
  if (decision.action === 'retry') return { kind: 'retry', state: decision.state };

  // 改道目标已知没额度时继续往后找，直到找到一个可用的。
  let cursor = decision.state.index;
  while (isCoolingDown?.(chain.entries[cursor] as FallbackChainEntry)) {
    cursor += 1;
    if (!chain.entries[cursor]) return { kind: 'stop', reason: 'chain-exhausted' };
  }
  const target = chain.entries[cursor] as FallbackChainEntry;
  return {
    kind: 'switch',
    target,
    from: decision.from,
    state: { index: cursor, retries: 0 },
  };
}

/**
 * 发送前选路：跳过链首那些**已知在冷却期**的项，返回第一个可用的。
 *
 * 这条路径只看已记录的**真实失败**，不看用量百分比：Luna 之类的保留额度会
 * 显示 0% 但仍然能跑，凭百分比跳过会误伤它。
 *
 * 全链都在冷却时返回 null：调用方该按原样发出去（也许额度已经回来了），
 * 而不是拒发。
 */
export function selectStartEntry(args: {
  chain: FallbackChain | null;
  isCoolingDown: (entry: FallbackChainEntry) => boolean;
}): FallbackChainEntry | null {
  const { chain, isCoolingDown } = args;
  if (!isFallbackChainActive(chain) || !chain) return null;
  const available = chain.entries.find((entry) => !isCoolingDown(entry));
  // 全部在冷却 = 没有更好的选择，交回给调用方按主模型跑。
  if (!available) return null;
  // 第一项就可用 = 无需改道。
  return available.uid === chain.entries[0]?.uid ? null : available;
}

export { initialFallbackChainState };
