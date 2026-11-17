/**
 * 礼品卡的跨端契约（Desktop 与 Mobile 共用）：兑换码的客户端侧规则、
 * model-access-server `/api/gift-cards/*` 响应的投影，以及失败原因的归类。
 * 服务端仍是权威校验；这里只负责把用户输入整理成可提交的形式，并把响应
 * 收敛成界面可以放心渲染的结构。
 */

export type GiftCardRegion = 'cn' | 'global';

/**
 * 礼品卡状态。CLAIMED_BY_YOU 只在领取人是当前账号时出现；别人领走的卡只是
 * CLAIMED，不透露领取人。
 */
export type GiftCardStatus = 'AVAILABLE' | 'CLAIMED' | 'CLAIMED_BY_YOU' | 'EXPIRED' | 'VOIDED';

export type GiftCard = {
  status: GiftCardStatus;
  /** 面额，按当前区域的计费币种计量（与余额同口径）。 */
  amount: string;
  faceCode: string;
  senderName: string;
  message: string | null;
  claimDeadline: string;
  /** 到账后的有效天数，从领取时起算。 */
  validityDays: number;
  claimedAt: string | null;
};

/**
 * APPLIED = 已入账；PENDING = 领取已记录、仍在入账途中（服务端自动续投，
 * 不需要用户重新领取）。
 */
export type GiftCardCredit = {
  state: 'APPLIED' | 'PENDING';
  amount: string;
  expiresAt: string | null;
};

/**
 * 服务端明确给出的不可领取原因；网络或服务故障不在此列。
 * PERSONAL_REQUIRED：礼品卡的钱进个人账户，组织身份不能领取，需要切换到个人身份。
 */
export type GiftCardFailure =
  | 'NOT_FOUND' | 'WRONG_REGION' | 'ALREADY_CLAIMED' | 'EXPIRED' | 'VOIDED' | 'RATE_LIMITED'
  | 'PERSONAL_REQUIRED';

const CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{16}$/;

/**
 * 归一成 16 位规范形式（Crockford Base32，不含 I / L / O / U，首位是区域标记）：
 * 容忍小写、空白与连字符，把 O 当 0、I 与 L 当 1。与服务端的归一规则一致。
 */
export function normalizeGiftCardCode(input: string): string | null {
  const compact = input
    .replace(/[\s-]/g, '')
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return CODE_PATTERN.test(compact) ? compact : null;
}

/** 展示形式：XXXX-XXXX-XXXX-XXXX。 */
export function formatGiftCardCode(code: string): string {
  return code.replace(/(.{4})(?=.)/g, '$1-');
}

export function giftCardCodeRegion(code: string): GiftCardRegion | null {
  return code[0] === 'C' ? 'cn' : code[0] === 'G' ? 'global' : null;
}

/**
 * 从用户粘贴的内容里取兑换码：裸兑换码、礼品卡网页链接（兑换码在 `#` 之后）
 * 或 `cindy://gift/<code>` 唤起链接。认不出来时返回 null。
 */
export function giftCardCodeFromInput(input: string): string | null {
  const text = input.trim();
  const direct = normalizeGiftCardCode(text);
  if (direct) return direct;
  const fragment = text.includes('#') ? text.slice(text.lastIndexOf('#') + 1) : '';
  if (fragment) {
    let decoded = fragment;
    try {
      decoded = decodeURIComponent(fragment);
    } catch {
      // 非法转义按原文尝试。
    }
    const fromFragment = normalizeGiftCardCode(decoded);
    if (fromFragment) return fromFragment;
  }
  const path = /\/\/gift\/([^/?#]+)/i.exec(text)?.[1];
  return path ? normalizeGiftCardCode(path) : null;
}

/**
 * 礼品卡业务码：只表达卡片状态或「当前身份不能领取」，不含上游消息、兑换码或账号
 * 信息，可以交给界面分支呈现。
 */
export const GIFT_CARD_ERROR_CODES = [
  'GIFT_CARD_NOT_FOUND',
  'GIFT_CARD_WRONG_REGION',
  'GIFT_CARD_ALREADY_CLAIMED',
  'GIFT_CARD_EXPIRED',
  'GIFT_CARD_VOIDED',
  'RATE_LIMITED',
  'PERSONAL_ACCOUNT_REQUIRED',
] as const;

const FAILURE_BY_CODE: Record<string, GiftCardFailure> = {
  GIFT_CARD_NOT_FOUND: 'NOT_FOUND',
  GIFT_CARD_WRONG_REGION: 'WRONG_REGION',
  GIFT_CARD_ALREADY_CLAIMED: 'ALREADY_CLAIMED',
  GIFT_CARD_EXPIRED: 'EXPIRED',
  GIFT_CARD_VOIDED: 'VOIDED',
  RATE_LIMITED: 'RATE_LIMITED',
  PERSONAL_ACCOUNT_REQUIRED: 'PERSONAL_REQUIRED',
};

/**
 * 服务端明确给出的卡片状态、或明确说明当前身份不能领取时返回对应原因；其它失败
 * （网络、5xx、登录失效）返回 null，由调用方按「暂时无法兑换」处理。
 */
export function giftCardFailureForError(code: string, status: number): GiftCardFailure | null {
  if (status === 429) return 'RATE_LIMITED';
  return Object.hasOwn(FAILURE_BY_CODE, code) ? FAILURE_BY_CODE[code] : null;
}

const STATUSES = new Set<GiftCardStatus>(['AVAILABLE', 'CLAIMED', 'CLAIMED_BY_YOU', 'EXPIRED', 'VOIDED']);
const DECIMAL_PATTERN = /^(0|[1-9]\d{0,14})(?:\.\d{1,9})?$/;
const FACE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const ISO_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const MAX_SENDER_LENGTH = 80;
const MAX_MESSAGE_LENGTH = 240;
const MAX_VALIDITY_DAYS = 3_650;

function invalid(): never {
  throw new Error('gift card response is invalid');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function time(value: unknown): string {
  if (typeof value !== 'string' || !ISO_TIME_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    invalid();
  }
  return value;
}

function nullableTime(value: unknown): string | null {
  return value === null ? null : time(value);
}

function amount(value: unknown): string {
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value)) invalid();
  return value;
}

function projectCard(value: unknown): GiftCard {
  if (!isRecord(value)) invalid();
  const { status, faceCode, senderName, message, validityDays } = value;
  if (
    typeof status !== 'string' ||
    !STATUSES.has(status as GiftCardStatus) ||
    typeof faceCode !== 'string' ||
    !FACE_PATTERN.test(faceCode) ||
    typeof senderName !== 'string' ||
    senderName.length === 0 ||
    senderName.length > MAX_SENDER_LENGTH ||
    (message !== null && (typeof message !== 'string' || message.length > MAX_MESSAGE_LENGTH)) ||
    typeof validityDays !== 'number' ||
    !Number.isInteger(validityDays) ||
    validityDays < 1 ||
    validityDays > MAX_VALIDITY_DAYS
  ) {
    invalid();
  }
  return {
    status: status as GiftCardStatus,
    amount: amount(value.amount),
    faceCode,
    senderName,
    message: message === null ? null : message,
    claimDeadline: time(value.claimDeadline),
    validityDays,
    claimedAt: nullableTime(value.claimedAt),
  };
}

function projectCredit(value: unknown): GiftCardCredit {
  if (!isRecord(value) || (value.state !== 'APPLIED' && value.state !== 'PENDING')) invalid();
  return {
    state: value.state,
    amount: amount(value.amount),
    expiresAt: nullableTime(value.expiresAt),
  };
}

/** `POST /api/gift-cards/preview` 的响应；结构不符时抛错，调用方按服务故障处理。 */
export function projectGiftCardPreview(value: unknown): { card: GiftCard } {
  if (!isRecord(value)) invalid();
  return { card: projectCard(value.card) };
}

/** `POST /api/gift-cards/redeem` 的响应；结构不符时抛错，调用方按结果未知处理。 */
export function projectGiftCardRedemption(value: unknown): { card: GiftCard; credit: GiftCardCredit } {
  if (!isRecord(value)) invalid();
  return { card: projectCard(value.card), credit: projectCredit(value.credit) };
}
