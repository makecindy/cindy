// @vitest-environment jsdom
// 契约：手机端兑换面板与桌面端弹窗走同一套步骤（输入 → 看到卡 → 确认 → 到账），并且
// 「结果未知」时留在确认步骤、绝不显示成功。此前没有覆盖手机端兑换流程的用例。
// 组件层：原生容器、图片与接口换成替身，验证的是面板自己的状态机与文案选择，不是真机渲染。
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  sheet: null as any, input: null as any, face: null as any, printed: true, realm: 'global' as 'global' | 'cn', personal: true,
  preview: vi.fn(), redeem: vi.fn(), dismissKeyboard: vi.fn(),
}));
vi.mock('react-native', () => ({
  View: ({ children }: any) => <div>{children}</div>,
  ActivityIndicator: () => <i data-testid="progress" />,
  Keyboard: { dismiss: h.dismissKeyboard },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1, absoluteFill: {} },
}));
vi.mock('@/components/AppText', () => ({
  Text: ({ children, testID }: any) => <span data-testid={testID}>{children}</span>,
  TextInput: (props: any) => { h.input = props; return <input data-testid={props.testID} value={props.value} readOnly />; },
}));
vi.mock('@/components/MobilePrimitives', () => ({
  MainWindowActionButton: ({ action }: any) => <button data-testid={action.testID} data-busy={action.busy ? 'true' : undefined}
    disabled={!!action.disabled || !!action.busy} onClick={action.onPress}>{action.label}</button>,
}));
vi.mock('@/session/CompanionSheet', () => ({
  CompanionSheet: (props: any) => { h.sheet = props; return props.visible ? <div><h1>{props.title}</h1>{props.children}{props.footer}</div> : null; },
}));
vi.mock('@/theme', () => ({ useTheme: () => ({ colors: {} }), useThemedStyles: (make: (colors: object) => unknown) => make({}), monoFont: 'mono' }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({
  i18n: { language: 'en' },
  t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
}) }));
vi.mock('@/gift-card/GiftCardFace', () => ({
  GiftCardFace: (props: any) => { h.face = props; return <div data-testid="face" aria-label={props.label} />; },
  giftCardFaceShowsAmount: () => h.printed,
}));
vi.mock('@/gift-card/useGiftCardClient', () => ({
  useGiftCardClient: () => ({ owner: 'owner', realm: h.realm, personal: h.personal, current: () => true, preview: h.preview, redeem: h.redeem }),
}));
import { GiftCardSheet, type GiftCardSheetProps } from '@/gift-card/GiftCardSheet';

const CODE = 'G0123456789ABCDE';
const card = {
  status: 'AVAILABLE' as const, amount: '20.000000000', faceCode: 'cat', senderName: 'Cindy Team', message: 'Enjoy',
  claimDeadline: '2026-12-31T16:00:00.000Z', validityDays: 90, claimedAt: null,
};
let root: Root, host: HTMLDivElement, props: GiftCardSheetProps;
const render = () => act(async () => root.render(createElement(GiftCardSheet, props)));
const node = (id: string) => host.querySelector(`[data-testid="giftCard.${id}"]`) as HTMLButtonElement | null;
const click = (id: string) => act(async () => node(id)!.click());
const type = (value: string) => act(async () => h.input.onChangeText(value));

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks(); h.printed = true; h.realm = 'global'; h.personal = true; h.face = null; h.input = null;
  host = document.createElement('div'); root = createRoot(host);
  props = { visible: true, onClose: vi.fn(), onBusyChange: vi.fn() };
});
afterEach(() => act(() => root.unmount()));

it('shows the card for a linked code, redeems only after confirmation and reports the credit', async () => {
  h.preview.mockResolvedValue({ ok: true, card });
  let settle: (value: unknown) => void = () => {};
  h.redeem.mockReturnValue(new Promise(resolve => { settle = resolve; }));
  props = { ...props, code: CODE }; await render();

  expect(h.preview).toHaveBeenCalledWith(CODE, expect.anything());
  expect(host.querySelector('h1')!.textContent).toBe('giftCard.confirmTitle');
  // 金额印在卡面上：面板把面额与本区域币种交给卡面，下方只写来源、留言与条款。
  expect(h.face).toMatchObject({ faceCode: 'cat', amount: '20.000000000', currency: 'USD', label: 'giftCard.cardLabel:{"amount":"$20"}' });
  expect(host.textContent).toContain('giftCard.from:{"sender":"Cindy Team"}');
  expect(host.textContent).toContain('Enjoy');
  expect(host.textContent).toContain('giftCard.fields.validityValue:{"count":90}');
  expect(host.textContent).not.toContain('$20');
  expect(h.redeem).not.toHaveBeenCalled();

  await click('primary');
  expect(h.redeem).toHaveBeenCalledWith(CODE, expect.anything());
  // 领取在途：不可关闭、不可重复提交，也不接收另一张卡。
  expect(props.onBusyChange).toHaveBeenLastCalledWith(true);
  expect(h.sheet.preventDismiss).toBe(true);
  expect(node('primary')!.disabled).toBe(true);
  expect(node('close')!.disabled).toBe(true);
  h.sheet.onClose();
  expect(props.onClose).not.toHaveBeenCalled();

  await act(async () => settle({ ok: true, card: { ...card, status: 'CLAIMED_BY_YOU' }, credit: { state: 'APPLIED', amount: '20.000000000', expiresAt: '2027-02-14T12:00:00.000Z' } }));
  expect(props.onBusyChange).toHaveBeenLastCalledWith(false);
  expect(host.querySelector('h1')!.textContent).toBe('giftCard.doneTitle:{"amount":"$20"}');
  expect(node('result')!.textContent).toMatch(/^giftCard\.doneDescription:/);
  expect(node('close')).toBeNull();
  await click('primary');
  expect(props.onClose).toHaveBeenCalledOnce();
});

it('accepts a pasted gift page link, and rejects other text without asking the server', async () => {
  h.preview.mockResolvedValue({ ok: true, card });
  await render();
  expect(host.querySelector('h1')!.textContent).toBe('giftCard.title');
  expect(node('primary')!.disabled).toBe(true);

  await type('not a code'); await click('primary');
  expect(h.preview).not.toHaveBeenCalled();
  expect(node('problem')!.textContent).toBe('giftCard.errors.notFound');
  // 改动输入即清掉上一次的提示。
  await type('https://share.cindy.app/gift?face=cat#G012-3456-789A-BCDE');
  expect(node('problem')).toBeNull();
  await act(async () => h.input.onSubmitEditing());
  expect(h.preview).toHaveBeenCalledWith(CODE, expect.anything());
  expect(host.querySelector('h1')!.textContent).toBe('giftCard.confirmTitle');
});

it('explains which edition a card belongs to and keeps the input for another try', async () => {
  h.preview.mockResolvedValue({ ok: false, reason: 'WRONG_REGION' });
  await render();
  await type('C012-3456-789A-BCDE'); await click('primary');
  expect(node('problem')!.textContent).toBe('giftCard.errors.wrongRegionCn');
  expect(node('input')).not.toBeNull();
  expect(h.redeem).not.toHaveBeenCalled();
});

// 规则：礼品卡的钱进个人账户，组织身份领不了。此前组织身份输入兑换码后只看到「暂时无法兑换，
// 请稍后重试」，重试多少次都不会成功。
it('tells an organization identity that gift cards are for personal accounts, without asking the server', async () => {
  h.personal = false;
  await render();
  // 一打开就能看到。
  expect(node('problem')!.textContent).toBe('giftCard.errors.personalRequired');
  await type(CODE); await click('primary');
  expect(node('problem')!.textContent).toBe('giftCard.errors.personalRequired');
  expect(h.preview).not.toHaveBeenCalled();

  // 从礼品卡链接进来也一样。
  props = { ...props, code: CODE }; await render();
  expect(node('problem')!.textContent).toBe('giftCard.errors.personalRequired');
  expect(h.preview).not.toHaveBeenCalled();

  // 服务端也会拒绝组织身份（比如身份在途中切换）：同样的提示，而不是「稍后重试」。
  h.personal = true; h.preview.mockResolvedValue({ ok: false, reason: 'PERSONAL_REQUIRED' });
  props = { ...props, code: undefined }; await render();
  await type(CODE); await click('primary');
  expect(node('problem')!.textContent).toBe('giftCard.errors.personalRequired');
});

it('names the state of a card that can no longer be redeemed', async () => {
  for (const [status, key] of [['CLAIMED', 'alreadyClaimed'], ['EXPIRED', 'expired'], ['VOIDED', 'voided']] as const) {
    h.preview.mockResolvedValue({ ok: true, card: { ...card, status } });
    props = { ...props, code: CODE, visible: false }; await render();
    props = { ...props, visible: true }; await render();
    expect(node('problem')!.textContent).toBe(`giftCard.errors.${key}`);
    expect(node('face')).toBeNull();
  }
});

it('stays on confirmation when the redeem outcome is unknown, so retrying is safe', async () => {
  h.preview.mockResolvedValue({ ok: true, card });
  h.redeem.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({
    ok: true, card: { ...card, status: 'CLAIMED_BY_YOU' }, credit: { state: 'PENDING', amount: '20', expiresAt: null },
  });
  props = { ...props, code: CODE }; await render();
  await click('primary');
  expect(host.querySelector('h1')!.textContent).toBe('giftCard.confirmTitle');
  expect(node('problem')!.textContent).toBe('giftCard.errors.failed');
  expect(props.onBusyChange).toHaveBeenLastCalledWith(false);

  await click('primary');
  // 入账仍在途中：说明已领取、无需重复领取，而不是报失败。
  expect(host.querySelector('h1')!.textContent).toBe('giftCard.pendingTitle');
  expect(node('result')!.textContent).toBe('giftCard.pendingDescription:{"amount":"$20"}');
});

it('returns to the input with the reason when the card was taken during confirmation', async () => {
  h.preview.mockResolvedValue({ ok: true, card });
  h.redeem.mockResolvedValue({ ok: false, reason: 'ALREADY_CLAIMED' });
  props = { ...props, code: CODE }; await render();
  await click('primary');
  expect(host.querySelector('h1')!.textContent).toBe('giftCard.title');
  expect(node('problem')!.textContent).toBe('giftCard.errors.alreadyClaimed');
});

it('tells the owner a card is already theirs without redeeming again', async () => {
  h.preview.mockResolvedValue({ ok: true, card: { ...card, status: 'CLAIMED_BY_YOU', claimedAt: '2026-11-16T12:00:00.000Z' } });
  props = { ...props, code: CODE }; await render();
  expect(node('result')!.textContent).toBe('giftCard.alreadyYours');
  expect(h.redeem).not.toHaveBeenCalled();
});

it('reports a gift link without a usable code, uses the account region currency, and falls back to text when the face cannot print the amount', async () => {
  props = { ...props, invalidLink: true }; await render();
  expect(node('problem')!.textContent).toBe('giftCard.errors.notFound');
  expect(h.preview).not.toHaveBeenCalled();

  h.realm = 'cn'; h.printed = false;
  h.preview.mockResolvedValue({ ok: true, card: { ...card, amount: '100' } });
  await type('C012-3456-789A-BCDE'); await click('primary');
  expect(h.face).toMatchObject({ currency: 'CNY' });
  expect(host.textContent).toContain(`${String.fromCodePoint(0xa5)}100`);
});
