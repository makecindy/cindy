import type { RemoteResourceAvatar } from '@cindy/device-link';

/**
 * 桌面入口（App Widget）的纯模型。
 *
 * 桌面上的「新建任务」与每位伙伴各是一份组件，组件自己不联网、不读登录态：目标 ID、
 * 深链 URL 与白名单、卡片标题、图标签名都由这里收口，`useEntryWidgetSync` 把它算成一份
 * 快照交给原生。工作区里没有「已添加」列表 —— 桌面有哪些组件只由系统 `appWidgetId` 决定。
 */

/** 一位伙伴 = 电脑 + 伙伴集合 + 伙伴 ID。同一伙伴在两台电脑上是两个可绑定目标。 */
export interface CompanionDesktopEntryTarget {
  kind: 'companion';
  deviceId: string;
  collectionId: string;
  companionId: string;
}

export type DesktopEntryTarget = { kind: 'new-task' } | CompanionDesktopEntryTarget;

/** 带会话 ID 的伙伴目标：组件的深链直接落到那位伙伴的对话。 */
export interface CompanionDesktopEntryLink extends CompanionDesktopEntryTarget {
  sessionId: string;
}

export const NEW_TASK_DESKTOP_ENTRY_ID = 'cindy.desktop-entry.new-task';
const COMPANION_DESKTOP_ENTRY_ID_PREFIX = 'cindy.desktop-entry.companion.';
/** 身份字段分隔符。控制字符不会出现在正常的电脑 / 集合 / 伙伴 ID 里。 */
const IDENTITY_SEPARATOR = '\u001f';
/** 深链上的标记参数；路由拦截据此区分「来自桌面入口」的链接。 */
export const DESKTOP_ENTRY_MARKER = 'desktopEntry';
/** 桌面上只显示一行；超出时截断成「…」。 */
export const DESKTOP_ENTRY_TITLE_MAX = 12;
type GraphemeSegmenter = { segment(input: string): Iterable<{ segment: string }> };
const SegmenterConstructor = (Intl as unknown as {
  Segmenter?: new (locales?: string, options?: { granularity: 'grapheme' }) => GraphemeSegmenter;
}).Segmenter;
const graphemeSegmenter = SegmenterConstructor
  ? new SegmenterConstructor(undefined, { granularity: 'grapheme' })
  : null;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ID_PART_MAX = 256;

/** 稳定 ID：只由身份组成，组件换版式、换尺寸或系统恢复后仍能认回同一位伙伴。 */
export function desktopEntryId(target: DesktopEntryTarget): string {
  if (target.kind === 'new-task') return NEW_TASK_DESKTOP_ENTRY_ID;
  const identity = [target.deviceId, target.collectionId, target.companionId].join(IDENTITY_SEPARATOR);
  // encodeURIComponent 只留下 ASCII；原生把它当 SharedPreferences 的键用。
  return `${COMPANION_DESKTOP_ENTRY_ID_PREFIX}${encodeURIComponent(identity)}`;
}

export function newTaskDesktopEntryUrl(scheme: string): string {
  return `${scheme}://sessions/new?${DESKTOP_ENTRY_MARKER}=1`;
}

/**
 * 伙伴入口的深链：沿用会话页的既有参数（设备、伙伴集合、伙伴 ID），
 * 外加「来自桌面入口」标记。伙伴名不进 URL —— 它会跟着组件一起留在系统那边。
 */
export function companionDesktopEntryUrl(link: CompanionDesktopEntryLink, scheme: string): string {
  const query = [
    `${DESKTOP_ENTRY_MARKER}=1`,
    `deviceId=${encodeURIComponent(link.deviceId)}`,
    `resourceCollectionId=${encodeURIComponent(link.collectionId)}`,
    `resourceId=${encodeURIComponent(link.companionId)}`,
    'resourceKind=bot',
  ].join('&');
  return `${scheme}://sessions/${encodeURIComponent(link.sessionId)}?${query}`;
}

/** 组件快照共用的深链选择：新任务走固定页，伙伴走会话页。 */
export function desktopEntryDestinationUrl(
  target: DesktopEntryTarget,
  sessionId: string,
  scheme: string,
): string {
  return target.kind === 'new-task'
    ? newTaskDesktopEntryUrl(scheme)
    : companionDesktopEntryUrl({ ...target, sessionId }, scheme);
}

export type ParsedDesktopEntryLink = { kind: 'new-task' } | CompanionDesktopEntryLink;

/**
 * 白名单：只放行伙伴对话与新任务。标记、会话 ID 形态、伙伴参数任一不符就丢弃，
 * 被篡改的链接不会落到别的页面。返回 null 表示「是桌面入口链接，但不能打开」。
 */
export function parseDesktopEntryLink(input: string): ParsedDesktopEntryLink | null {
  const raw = input.trim();
  if (!raw) return null;
  const withoutScheme = raw.replace(/^[a-zA-Z][\w+.-]*:\/\//, '');
  const withoutFragment = withoutScheme.split('#')[0];
  const queryIndex = withoutFragment.indexOf('?');
  const rawPath = queryIndex < 0 ? withoutFragment : withoutFragment.slice(0, queryIndex);
  const query = queryIndex < 0 ? '' : withoutFragment.slice(queryIndex + 1);
  const params = parseQuery(query);
  if (params.get(DESKTOP_ENTRY_MARKER) !== '1') return null;
  const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  if (path === '/sessions/new') return { kind: 'new-task' };
  const match = /^\/sessions\/([^/]+)$/.exec(path);
  if (!match) return null;
  const sessionId = safeDecode(match[1]);
  if (!sessionId || !SESSION_ID.test(sessionId)) return null;
  const deviceId = params.get('deviceId');
  const collectionId = params.get('resourceCollectionId');
  const companionId = params.get('resourceId');
  if (params.get('resourceKind') !== 'bot') return null;
  if (!validIdentityPart(deviceId) || !validIdentityPart(collectionId) || !validIdentityPart(companionId)) return null;
  return { kind: 'companion', sessionId, deviceId, collectionId, companionId };
}

function validIdentityPart(value: string | undefined): value is string {
  return !!value && value.length <= ID_PART_MAX;
}

function parseQuery(query: string): Map<string, string> {
  const params = new Map<string, string>();
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const equals = pair.indexOf('=');
    const key = safeDecode(equals < 0 ? pair : pair.slice(0, equals));
    const value = safeDecode(equals < 0 ? '' : pair.slice(equals + 1));
    if (!key || value === null) continue;
    // 同名参数以第一次为准：不让人用重复键覆盖白名单已经接受的值。
    if (!params.has(key)) params.set(key, value);
  }
  return params;
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

/** 组件上的标题：压成一行，过长截断；空标题退到调用方给的兜底文案。 */
export function desktopEntryTitle(value: string | null | undefined, fallback: string): string {
  const normalized = (value ?? '').replace(/\s+/g, ' ').trim();
  const source = normalized || fallback.replace(/\s+/g, ' ').trim() || 'Cindy';
  const points = graphemes(source);
  if (points.length <= DESKTOP_ENTRY_TITLE_MAX) return source;
  return `${points.slice(0, DESKTOP_ENTRY_TITLE_MAX - 1).join('').trimEnd()}…`;
}

/** 按用户看到的字符切分：不把 ZWJ emoji / 国旗拆成两半；旧运行时退回码点。 */
function graphemes(value: string): string[] {
  return graphemeSegmenter
    ? Array.from(graphemeSegmenter.segment(value), (part) => part.segment)
    : Array.from(value);
}

/** 头像只取图标需要的字段，字段来源仍是 `@cindy/device-link` 的 RemoteResourceAvatar。 */
export type DesktopEntryAvatar = Partial<Pick<RemoteResourceAvatar, 'kind' | 'value' | 'fallbackText' | 'color'>>;

/** 头像取不到时原生画的字：emoji 原样，其余取首个字符。 */
export function desktopEntryGlyph(
  avatar: DesktopEntryAvatar | null | undefined,
  name: string,
): string {
  const emoji = avatar?.kind === 'emoji' ? avatar.value?.trim() : '';
  if (emoji) return graphemes(emoji)[0] ?? '';
  const fallback = avatar?.fallbackText?.trim();
  if (fallback) return graphemes(fallback)[0] ?? '';
  const first = graphemes(name.trim())[0] ?? '';
  return first.toUpperCase();
}

/** 头像内容签名：换了头像就要重新取图，但没换时不重算 base64。 */
export function desktopEntryAvatarSignature(
  avatar: DesktopEntryAvatar | null | undefined,
): string {
  return avatar ? `${avatar.kind ?? ''}:${avatar.value ?? ''}` : '';
}
