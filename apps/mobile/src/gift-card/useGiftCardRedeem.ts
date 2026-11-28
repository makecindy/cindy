import { useEffect, useRef, useState } from 'react';
import {
  formatGiftCardCode,
  giftCardCodeFromInput,
  type GiftCard,
  type GiftCardCredit,
  type GiftCardFailure,
} from '@cindy/maker-shared/gift-card';
import { useGiftCardClient } from './useGiftCardClient';

export type GiftCardStep =
  | { kind: 'input' }
  | { kind: 'reading' }
  | { kind: 'confirm'; code: string; card: GiftCard }
  | { kind: 'redeeming'; code: string; card: GiftCard }
  /** credit 为 null 表示这张卡早先已被当前账号领取，本次没有新入账。 */
  | { kind: 'done'; card: GiftCard; credit: GiftCardCredit | null };

/**
 * INVALID 是没认出兑换码（没有问过服务端）；FAILED 是网络或服务故障；
 * 其余是服务端给出的卡片状态。
 */
/** purchased：已知这是用户买的卡——它作废可能只是退款或拒付还在处理，之后还会恢复，所以只说目前不能领取。 */
export type GiftCardProblem = { reason: GiftCardFailure | 'INVALID' | 'FAILED'; code: string | null; purchased?: boolean };

type State = { owner: string; step: GiftCardStep; problem: GiftCardProblem | null };

function unavailable(card: GiftCard): GiftCardFailure | null {
  if (card.status === 'CLAIMED') return 'ALREADY_CLAIMED';
  if (card.status === 'EXPIRED') return 'EXPIRED';
  if (card.status === 'VOIDED') return 'VOIDED';
  return null;
}

export interface GiftCardRedeemOptions {
  visible: boolean;
  /** 链接带来的兑换码：打开后直接查询，跳过手动输入。 */
  code?: string;
  invalidLink?: boolean;
  /** 领取请求在途：面板不可关闭，也不接收另一张卡。 */
  onBusyChange?(busy: boolean): void;
}

/** 兑换流程：输入 → 查询 → 确认 → 领取。与桌面端弹窗同一套步骤与失败处理。 */
export function useGiftCardRedeem({ visible, code, invalidLink, onBusyChange }: GiftCardRedeemOptions) {
  const api = useGiftCardClient();
  // 组织身份不能领取：打开面板或提交时直接说明，不发请求。
  const personal = api.personal !== false;
  const [input, setInput] = useState('');
  const [state, setState] = useState<State>({ owner: api.owner, step: { kind: 'input' }, problem: null });
  const epoch = useRef(0);
  const request = useRef<AbortController | null>(null);
  const busyCallback = useRef(onBusyChange); busyCallback.current = onBusyChange;
  const cancel = () => { epoch.current += 1; request.current?.abort(); request.current = null; };
  const begin = () => {
    cancel();
    const controller = new AbortController();
    request.current = controller;
    const id = epoch.current;
    return { signal: controller.signal, current: () => epoch.current === id && api.current() };
  };

  const preview = async (raw: string) => {
    const parsed = giftCardCodeFromInput(raw);
    if (!parsed) {
      cancel();
      setState({ owner: api.owner, step: { kind: 'input' }, problem: { reason: 'INVALID', code: null } });
      return;
    }
    if (!personal) {
      cancel();
      setState({ owner: api.owner, step: { kind: 'input' }, problem: { reason: 'PERSONAL_REQUIRED', code: parsed } });
      return;
    }
    const { signal, current } = begin();
    setState({ owner: api.owner, step: { kind: 'reading' }, problem: null });
    const fail = (reason: GiftCardProblem['reason'], purchased?: boolean) =>
      setState({ owner: api.owner, step: { kind: 'input' }, problem: { reason, code: parsed, purchased } });
    try {
      const result = await api.preview(parsed, signal);
      if (!current()) return;
      if (!result.ok) { fail(result.reason); return; }
      if (result.card.status === 'CLAIMED_BY_YOU') {
        setState({ owner: api.owner, step: { kind: 'done', card: result.card, credit: null }, problem: null });
        return;
      }
      const reason = unavailable(result.card);
      if (reason) fail(reason, result.card.destination === 'PURCHASED');
      else setState({ owner: api.owner, step: { kind: 'confirm', code: parsed, card: result.card }, problem: null });
    } catch {
      if (current()) fail('FAILED');
    }
  };

  const redeem = async () => {
    const step = state.step;
    if (step.kind !== 'confirm' || state.owner !== api.owner) return;
    const { signal, current } = begin();
    setState({ owner: api.owner, step: { kind: 'redeeming', code: step.code, card: step.card }, problem: null });
    busyCallback.current?.(true);
    try {
      const result = await api.redeem(step.code, signal);
      if (!current()) return;
      // 确认期间卡片状态变了（被别人领走、作废或过期）：回到输入并说明原因。
      if (!result.ok) {
        const purchased = step.card.destination === 'PURCHASED';
        setState({ owner: api.owner, step: { kind: 'input' }, problem: { reason: result.reason, code: step.code, purchased } });
      } else setState({ owner: api.owner, step: { kind: 'done', card: result.card, credit: result.credit }, problem: null });
    } catch {
      // 结果未知：留在确认步骤。领取是幂等的，再点一次不会重复入账。
      if (current()) setState({ owner: api.owner, step: { kind: 'confirm', code: step.code, card: step.card }, problem: { reason: 'FAILED', code: step.code } });
    } finally {
      busyCallback.current?.(false);
    }
  };

  // 打开、换卡或换账号时从头开始；预览与入账结果不跨账号保留。
  useEffect(() => {
    cancel();
    // 关闭动画期间保留面板上的内容。
    if (!visible) return;
    setInput(code ? formatGiftCardCode(code) : '');
    if (code) void preview(code);
    else {
      // 组织身份：一打开就提示「仅限个人用户领取」，不等用户输完兑换码才知道领不了。
      const problem: GiftCardProblem | null = !personal ? { reason: 'PERSONAL_REQUIRED', code: null }
        : invalidLink ? { reason: 'INVALID', code: null } : null;
      setState({ owner: api.owner, step: { kind: 'input' }, problem });
    }
    return cancel;
    // 接口对象按账号与区域稳定；回调变化不应重启在途的查询。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.owner, visible, code, invalidLink, personal]);

  const shown = state.owner === api.owner ? state : { owner: api.owner, step: { kind: 'reading' } as GiftCardStep, problem: null };
  return {
    step: shown.step,
    problem: shown.problem,
    input,
    realm: api.realm,
    setInput: (value: string) => {
      if (shown.step.kind !== 'input') return;
      setInput(value);
      if (shown.problem) setState({ owner: api.owner, step: { kind: 'input' }, problem: null });
    },
    submit: () => { if (shown.step.kind === 'input' && input.trim()) void preview(input); },
    redeem: () => { void redeem(); },
  };
}

export type GiftCardRedeemModel = ReturnType<typeof useGiftCardRedeem>;
