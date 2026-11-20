/**
 * 礼品卡的跨端契约（Desktop 与 Mobile 共用）：兑换码的客户端侧规则、
 * model-access-server `/api/gift-cards/*` 响应的投影，以及失败原因的归类。
 * 服务端仍是权威校验；这里只负责把用户输入整理成可提交的形式，并把响应
 * 收敛成界面可以放心渲染的结构。
 */

import type { GiftCardAmountLayout } from './giftCardAmount.js';

export type GiftCardRegion = 'cn' | 'global';

/**
 * 礼品卡状态。CLAIMED_BY_YOU 只在领取人是当前账号时出现；别人领走的卡只是
 * CLAIMED，不透露领取人。
 */
export type GiftCardStatus = 'AVAILABLE' | 'CLAIMED' | 'CLAIMED_BY_YOU' | 'EXPIRED' | 'VOIDED';

/**
 * 领取后的到账去向。PROMOTIONAL：后台发放的卡，进赠送余额，带领取截止与有效天数；
 * PURCHASED：用户自己买的卡，进充值余额，永久有效，没有领取截止。
 */
export type GiftCardDestination = 'PROMOTIONAL' | 'PURCHASED';

/**
 * 服务端下发的卡面：不含金额的底图（1200 × 757）与金额印法，以及各语言的卡面名称。
 * 新卡面只在服务端登记，客户端不用发版就能显示；本版本内置的四张卡面只在服务端没给、
 * 给得不合法或图片取不到时兜底。
 */
export type GiftCardFaceStyle = {
  code: string;
  /** 卡面名称，键是语言标签（如 zh-CN、en），按界面语言用 `giftCardFaceName` 挑。 */
  names: Readonly<Record<string, string>>;
  imageUrl: string;
  amount: GiftCardAmountLayout;
};

export type GiftCard = {
  status: GiftCardStatus;
  /** 面额，按当前区域的计费币种计量（与余额同口径）。 */
  amount: string;
  faceCode: string;
  /** 服务端下发的卡面；旧服务端没有、或不合法时为 null，按 faceCode 用内置卡面。 */
  face: GiftCardFaceStyle | null;
  senderName: string;
  message: string | null;
  destination: GiftCardDestination;
  /** 领取截止；PURCHASED 的卡不过期，为 null。 */
  claimDeadline: string | null;
  /** 到账后的有效天数，从领取时起算；PURCHASED 的卡永久有效，为 null。 */
  validityDays: number | null;
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

/**
 * 去掉字符串末尾的 0。用循环而不是 /0+$/：后者遇到一长串 0 时匹配耗时随长度平方增长
 * （CodeQL「对不受控数据使用多项式正则」）。
 */
function trimTrailingZeros(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 48) end -= 1;
  return value.slice(0, end);
}

/**
 * 礼品卡金额（卡面与到账额度）：大于 0 的十进制，去掉小数末尾的 0 后最多两位小数。服务端发卡也限两位，
 * 卡面按分印；比分更细的金额卡面与文字会对不上，按坏响应处理。
 */
function amount(value: unknown): string {
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value)) invalid();
  if (trimTrailingZeros(value.split('.')[1] ?? '').length > 2) invalid();
  // 卡面与到账额度必须大于 0：0 元的卡或「成功兑换 0 元」是自相矛盾的响应。
  if (!/[1-9]/.test(value)) invalid();
  return value;
}

function validityDaysOf(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_VALIDITY_DAYS
  ) {
    invalid();
  }
  return value;
}

/** 卡的来源与它兑换后进哪一种余额一一对应：后台发的进赠送余额，用户买的进充值余额。 */
const DESTINATION_BY_SOURCE: Record<string, GiftCardDestination> = {
  PLATFORM: 'PROMOTIONAL',
  PURCHASE: 'PURCHASED',
};

/**
 * 旧服务端不下发 destination，它发出的卡都是后台发放、进赠送余额。用户买的卡
 * 没有领取截止和有效天数；后台发的卡这两项必须齐全，缺一项就不能告诉用户条款。
 * 同时给了来源时两者必须对得上：去向决定两端承诺的到账条款，自相矛盾的响应直接拒绝。
 */
function destinationOf(value: Record<string, unknown>): GiftCardDestination {
  const { destination, source } = value;
  if (source !== undefined && (typeof source !== 'string' || !Object.hasOwn(DESTINATION_BY_SOURCE, source))) invalid();
  if (destination === undefined) {
    if (source === 'PURCHASE') invalid();
    return 'PROMOTIONAL';
  }
  if (destination !== 'PROMOTIONAL' && destination !== 'PURCHASED') invalid();
  if (source !== undefined && DESTINATION_BY_SOURCE[source as string] !== destination) invalid();
  return destination;
}

/** 两个十进制金额是否相等（去掉小数末尾的 0 再比，如 100 与 100.000000000）。 */
function sameAmount(left: string, right: string): boolean {
  const normalize = (value: string) => {
    if (!value.includes('.')) return value;
    const trimmed = trimTrailingZeros(value);
    return trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
  };
  return normalize(left) === normalize(right);
}

function projectCard(value: unknown): GiftCard {
  if (!isRecord(value)) invalid();
  const { status, faceCode, senderName, message } = value;
  if (
    typeof status !== 'string' ||
    !STATUSES.has(status as GiftCardStatus) ||
    typeof faceCode !== 'string' ||
    !FACE_PATTERN.test(faceCode) ||
    typeof senderName !== 'string' ||
    senderName.length === 0 ||
    senderName.length > MAX_SENDER_LENGTH ||
    (message !== null && (typeof message !== 'string' || message.length > MAX_MESSAGE_LENGTH))
  ) {
    invalid();
  }
  const destination = destinationOf(value);
  const purchased = destination === 'PURCHASED';
  // 买来的卡永久有效、没有领取截止，两端都直接这样告诉用户：带了截止或有效天数、或状态是
  // 「已过期」的「买来的卡」是自相矛盾的响应，拒绝，不能悄悄隐去条款或告诉用户永久卡过期了。
  if (purchased && (status === 'EXPIRED' || value.claimDeadline !== null || value.validityDays !== null)) invalid();
  return {
    status: status as GiftCardStatus,
    amount: amount(value.amount),
    faceCode,
    face: projectGiftCardFaceStyle(value.face, faceCode),
    senderName,
    message: message === null ? null : message,
    destination,
    claimDeadline: purchased ? null : time(value.claimDeadline),
    validityDays: purchased ? null : validityDaysOf(value.validityDays),
    claimedAt: nullableTime(value.claimedAt),
  };
}

const CANVAS_WIDTH = 1200;
const CANVAS_HEIGHT = 757;
const MAX_FACE_IMAGE_URL_LENGTH = 2_048;
const MAX_FACE_NAMES = 32;
const MAX_FACE_NAME_LENGTH = 40;
const MAX_FACE_CATALOG = 64;
const LANGUAGE_TAG_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,4}$/;
const COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 卡面底图只接受 https；本机开发的服务端（localhost）可以是 http。不接受带账号密码的地址。 */
function faceImageUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_FACE_IMAGE_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const allowed = url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname));
  return allowed ? url.href : null;
}

/** 金额印法必须落在卡面里：起点、基线、字号与可占宽度都在 1200 × 757 之内，颜色是 #RRGGBB。 */
function faceAmountLayout(value: unknown): GiftCardAmountLayout | null {
  if (!isRecord(value)) return null;
  const { x, baseline, size, maxWidth, color } = value;
  if (
    !finite(x) || x < 0 || x >= CANVAS_WIDTH ||
    !finite(baseline) || baseline <= 0 || baseline > CANVAS_HEIGHT ||
    !finite(size) || size <= 0 || size > CANVAS_HEIGHT ||
    !finite(maxWidth) || maxWidth <= 0 || maxWidth > CANVAS_WIDTH - x ||
    typeof color !== 'string' || !COLOR_PATTERN.test(color)
  ) {
    return null;
  }
  return { x, baseline, size, maxWidth, color };
}

function faceNames(value: unknown): Readonly<Record<string, string>> | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > MAX_FACE_NAMES) return null;
  for (const [tag, name] of entries) {
    if (!LANGUAGE_TAG_PATTERN.test(tag) || typeof name !== 'string') return null;
    const length = Array.from(name.trim()).length;
    if (length < 1 || length > MAX_FACE_NAME_LENGTH) return null;
  }
  return Object.fromEntries(entries.map(([tag, name]) => [tag, (name as string).trim()]));
}

/**
 * 服务端下发的一个卡面。不合法时返回 null：调用方按 faceCode 用内置卡面，绝不因为卡面信息
 * 不对就把整张卡或整个列表当成坏响应。给了 faceCode 时卡面代号必须与它相同。
 */
export function projectGiftCardFaceStyle(value: unknown, faceCode?: string): GiftCardFaceStyle | null {
  if (!isRecord(value)) return null;
  const { code } = value;
  if (typeof code !== 'string' || !FACE_PATTERN.test(code)) return null;
  if (faceCode !== undefined && code !== faceCode) return null;
  const names = faceNames(value.names);
  const imageUrl = faceImageUrl(value.imageUrl);
  const amount = faceAmountLayout(value.amount);
  if (!names || !imageUrl || !amount) return null;
  return { code, names, imageUrl, amount };
}

/**
 * 购买规则里可选卡面的详细信息（`faceCatalog`）：只留下合法、在 `faces` 里、不重复的项。
 * 旧服务端没有这个字段时返回空数组，界面按内置卡面处理。
 */
export function projectGiftCardFaceCatalog(value: unknown, faces: readonly string[]): GiftCardFaceStyle[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set(faces);
  const seen = new Set<string>();
  const catalog: GiftCardFaceStyle[] = [];
  for (const item of value.slice(0, MAX_FACE_CATALOG)) {
    const face = projectGiftCardFaceStyle(item);
    if (!face || !allowed.has(face.code) || seen.has(face.code)) continue;
    seen.add(face.code);
    catalog.push(face);
  }
  return catalog;
}

/**
 * 按界面语言挑卡面名称：完全一致 → 中文按繁简挑 zh-TW / zh-CN → 同一语言 → en → 第一项。
 * 没有名称时返回 null，调用方用本地文案。
 */
export function giftCardFaceName(names: Readonly<Record<string, string>>, locale: string): string | null {
  const tags = Object.keys(names);
  if (tags.length === 0) return null;
  const find = (tag: string) => tags.find((candidate) => candidate.toLowerCase() === tag.toLowerCase());
  const wanted = locale.toLowerCase();
  const language = wanted.split('-')[0];
  const chinese = language === 'zh'
    ? (/^zh-(hant|tw|hk|mo)\b/.test(wanted) ? find('zh-TW') : find('zh-CN'))
    : undefined;
  const tag =
    find(locale) ??
    chinese ??
    tags.find((candidate) => candidate.toLowerCase().split('-')[0] === language) ??
    find('en') ??
    tags[0];
  return names[tag] ?? null;
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
  const card = projectCard(value.card);
  const credit = projectCredit(value.credit);
  // 买来的卡进充值余额、永久有效，到账额度就是卡面金额：带过期时间或金额对不上同样自相矛盾，拒绝。
  if (card.destination === 'PURCHASED' && (credit.expiresAt !== null || !sameAmount(card.amount, credit.amount))) invalid();
  return { card, credit };
}
