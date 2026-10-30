/**
 * 远程 Agent 执行器的 WebFetch(控制端)。
 *
 * 供应商分享的受邀者任务里，Claude Code 自带的 WebFetch 会从分享者的网络发出请求、能访问分享者
 * 的内网，已对受邀者关闭；这里改在本机(受邀者电脑)用本机网络抓取：
 *  - 经 Desktop 的出站通道(系统代理)，不带 Cindy 的 Cookie 与登录态；按 DNS 解析结果拦下内网
 *    地址，只有本机用户批准过(或任务是全权)时才放行；
 *  - 只发一跳：同一网站内的跳转最多跟 5 次，跳到其它网站时把新地址交还给 Agent，由它重新调用
 *    (重新过权限上限与本机确认)；
 *  - 只返回文本：HTML 转成纯文本(保留标题、链接、列表、代码块)，其它文本类原样返回；长页面分段读取。
 */
import { SsrFBlockedError } from '@cindy/browser-control-runtime/ssrf-runtime';

import { textResult, type ToolResult } from './files';

/** Desktop 出站通道(maker-host/outbound-fetch 的 guardedOutboundFetch)。 */
export type GuardedFetch = (
  url: string,
  init: RequestInit,
  beforeDispatch: () => void | Promise<void>,
  approval?: { targetUrl: string; allowHttp?: boolean; allowPrivateNetwork?: boolean },
) => Promise<{ response: Response; release: () => Promise<void> }>;

const TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
/** 读取的响应体上限；超出部分丢弃并在结果里注明。 */
const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** 每次返回的字符数，更长的页面用 start_index 分段读。 */
export const WEB_FETCH_PAGE_CHARS = 40_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface WebFetchRequest {
  url: URL;
  startIndex: number;
  /** 本机用户批准过这个地址(或全权)：内网地址与 http 可用。 */
  allowPrivateNetwork: boolean;
  signal?: AbortSignal;
}

/** 同一网站：主机名去掉开头的 www. 后相同(端口也要相同)。 */
function sameSite(a: URL, b: URL): boolean {
  const host = (url: URL) => url.hostname.replace(/^www\./i, '').toLowerCase();
  return host(a) === host(b) && a.port === b.port;
}

/** 未经批准的地址一律用 https(与 Claude Code 自带 WebFetch 一致)。 */
function upgraded(url: URL, allowHttp: boolean): URL {
  if (allowHttp || url.protocol !== 'http:') return url;
  const next = new URL(url.href);
  next.protocol = 'https:';
  return next;
}

async function readBody(response: Response): Promise<{ bytes: Buffer; cut: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { bytes: Buffer.alloc(0), cut: false };
  const chunks: Buffer[] = [];
  let size = 0;
  let cut = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = MAX_BODY_BYTES - size;
      if (value.byteLength > room) {
        chunks.push(Buffer.from(value.subarray(0, room)));
        size += room;
        cut = true;
        break;
      }
      chunks.push(Buffer.from(value));
      size += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return { bytes: Buffer.concat(chunks, size), cut };
}

function mediaType(contentType: string | null): { type: string; charset: string | null } {
  if (!contentType) return { type: '', charset: null };
  const [type, ...params] = contentType.split(';');
  const charset = params
    .map((param) => /^\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(param)?.[1] ?? null)
    .find((value) => value !== null) ?? null;
  return { type: type.trim().toLowerCase(), charset };
}

function isTextType(type: string): boolean {
  return type.startsWith('text/')
    || /^application\/(?:json|xml|javascript|ecmascript|x-javascript|x-sh|x-yaml|yaml|toml|x-www-form-urlencoded)$/.test(type)
    || /\+(?:json|xml)$/.test(type);
}

function decode(bytes: Buffer, charset: string | null): string {
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** HTML 没在响应头里写编码时，从开头的 <meta> 里找。 */
function htmlCharset(bytes: Buffer): string | null {
  const head = bytes.subarray(0, 4096).toString('latin1');
  return /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1] ?? null;
}

// ─── HTML → 文本 ───────────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–', minus: '−',
  lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„', laquo: '«', raquo: '»',
  bull: '•', middot: '·', times: '×', divide: '÷', plusmn: '±', deg: '°', micro: 'µ', para: '¶',
  sect: '§', euro: '€', pound: '£', yen: '¥', cent: '¢', larr: '←', rarr: '→', uarr: '↑', darr: '↓',
  harr: '↔', le: '≤', ge: '≥', ne: '≠', asymp: '≈', infin: '∞', frac12: '½', frac14: '¼', frac34: '¾',
  szlig: 'ß', oslash: 'ø', Oslash: 'Ø', aelig: 'æ', AElig: 'Æ', eth: 'ð', ETH: 'Ð', thorn: 'þ', THORN: 'Þ',
};

/** 带重音的拉丁字母(&eacute; &Uuml; &ccedil; …)：字母加组合附加符号。 */
const ACCENT_MARKS: Record<string, string> = {
  acute: '\u0301', grave: '\u0300', circ: '\u0302', uml: '\u0308', tilde: '\u0303', ring: '\u030a', cedil: '\u0327',
};

function namedEntity(name: string): string | undefined {
  const known = NAMED_ENTITIES[name];
  if (known !== undefined) return known;
  const accented = /^([A-Za-z])(acute|grave|circ|uml|tilde|ring|cedil)$/.exec(name);
  if (accented) return (accented[1] + ACCENT_MARKS[accented[2]]).normalize('NFC');
  // &AMP; &LT; 之类的大写写法。
  return /^(?:AMP|LT|GT|QUOT)$/.test(name) ? NAMED_ENTITIES[name.toLowerCase()] : undefined;
}

function decodeEntities(text: string): string {
  return text.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      // 控制字符(换行、制表除外)与非法码点不还原。
      if (!Number.isFinite(code) || code > 0x10ffff || (code < 0x20 && code !== 0x0a && code !== 0x09)) return '';
      return String.fromCodePoint(code);
    }
    return namedEntity(body) ?? whole;
  });
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return match ? decodeEntities(match[1] ?? match[2] ?? match[3] ?? '') : null;
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ''));
}

// 链接与代码块用控制字符做占位，逐段线性处理，避免对未闭合标签的回溯。
const LINK_OPEN = '\u0001';
const LINK_HREF_END = '\u0002';
const LINK_CLOSE = '\u0003';
const PRE_MARK = '\u0004';

const BLOCK_TAGS = 'p|div|section|article|header|footer|nav|main|aside|table|thead|tbody|tfoot|tr|ul|ol|dl|dt|dd|blockquote|figure|figcaption|form|fieldset|details|summary|address|center';

/** HTML 转成纯文本：标题写成 #，列表写成 -，链接写成 [文字](地址)，<pre> 写成代码块。 */
export function htmlToText(html: string, baseUrl?: URL): { title: string | null; text: string } {
  let source = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|iframe|object|canvas|math)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(source);
  const title = titleMatch ? stripTags(titleMatch[1]).replace(/\s+/g, ' ').trim() || null : null;
  // 标题单独返回；没有 <head> 的页面里 <title> 也不进正文。
  source = source
    .replace(/<head\b[\s\S]*?<\/head\s*>/gi, ' ')
    .replace(/<title\b[^>]*>[\s\S]*?<\/title\s*>/gi, ' ');

  // 代码块先取出(保留原样的换行与缩进)，占位放进独立的一行。
  const blocks: string[] = [];
  source = source.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_whole, inner: string) => {
    blocks.push(stripTags(inner.replace(/<br\s*\/?>/gi, '\n')).replace(/^\n+|\s+$/g, ''));
    return `<div>${PRE_MARK}${blocks.length - 1}${PRE_MARK}</div>`;
  });

  source = source
    .replace(/\s+/g, ' ')
    .replace(/<a\b[^>]*>/gi, (tag) => {
      const href = attribute(tag, 'href');
      if (!href || /^\s*(?:javascript|data|vbscript):/i.test(href) || href.startsWith('#')) return LINK_OPEN + LINK_HREF_END;
      let resolved = href.trim();
      try {
        resolved = new URL(resolved, baseUrl).href;
      } catch {
        // 无法解析时保留原样。
      }
      return `${LINK_OPEN}${resolved.replace(/[\u0001-\u0004]/g, '')}${LINK_HREF_END}`;
    })
    .replace(/<\/a\s*>/gi, LINK_CLOSE)
    .replace(/<h([1-6])\b[^>]*>/gi, (_tag, level: string) => `\n\n${'#'.repeat(Number(level))} `)
    .replace(/<\/h[1-6]\s*>/gi, '\n\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\b[^>]*>/gi, '\n\n---\n\n')
    .replace(/<\/(?:td|th)\s*>/gi, ' | ')
    .replace(new RegExp(`</?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n')
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const alt = attribute(tag, 'alt')?.trim();
      return alt ? ` [image: ${alt}] ` : ' ';
    });
  let text = stripTags(source)
    .replace(new RegExp(`${LINK_OPEN}([^${LINK_HREF_END}]*)${LINK_HREF_END}([^${LINK_OPEN}${LINK_CLOSE}]*)${LINK_CLOSE}`, 'g'),
      (_whole, href: string, label: string) => {
        const shown = label.trim();
        if (!href) return label;
        return shown ? `[${shown}](${href})` : href;
      })
    // 没有闭合的链接：丢掉地址，只留文字。
    .replace(new RegExp(`${LINK_OPEN}[^${LINK_HREF_END}]*${LINK_HREF_END}`, 'g'), '')
    .replace(/[\u0001-\u0003]/g, '');
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .replace(new RegExp(`${PRE_MARK}(\\d+)${PRE_MARK}`, 'g'), (_whole, index: string) => `\`\`\`\n${blocks[Number(index)] ?? ''}\n\`\`\``);
  return { title, text };
}

// ─── 抓取 ──────────────────────────────────────────────────────

function pageOf(text: string, startIndex: number): { body: string; note: string } {
  const total = text.length;
  if (startIndex >= total && total > 0) {
    return { body: '', note: `start_index ${startIndex} is past the end of the page (${total} characters).` };
  }
  const end = Math.min(total, startIndex + WEB_FETCH_PAGE_CHARS);
  const body = text.slice(startIndex, end);
  if (startIndex === 0 && end === total) return { body, note: '' };
  const more = end < total ? ` Call WebFetch again with start_index=${end} to read more.` : '';
  return { body, note: `Characters ${startIndex}–${end} of ${total}.${more}` };
}

/** 抓取一个网页并返回文本。网络与内容问题以错误结果返回，不抛出。 */
export async function fetchWebPage(fetchImpl: GuardedFetch, request: WebFetchRequest): Promise<ToolResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  timer.unref?.();
  const signal = request.signal ? AbortSignal.any([controller.signal, request.signal]) : controller.signal;
  const allowHttp = request.allowPrivateNetwork;
  const original = request.url;
  let current = upgraded(original, allowHttp);
  const visited = new Set<string>();
  try {
    for (let hop = 0; ; hop += 1) {
      visited.add(current.href);
      const { response, release } = await fetchImpl(
        current.href,
        {
          method: 'GET',
          redirect: 'manual',
          credentials: 'omit',
          signal,
          headers: {
            accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.5',
            'user-agent': 'Mozilla/5.0 (compatible; Cindy WebFetch)',
          },
        },
        () => signal.throwIfAborted(),
        { targetUrl: current.href, allowHttp, allowPrivateNetwork: request.allowPrivateNetwork },
      );
      try {
        if (REDIRECT_STATUSES.has(response.status)) {
          const location = response.headers.get('location');
          if (!location) return textResult(`${current.href} returned HTTP ${response.status} without a redirect address.`, true);
          let next: URL;
          try {
            next = new URL(location, current);
          } catch {
            return textResult(`${current.href} redirected to an invalid address: ${location}`, true);
          }
          if (next.protocol !== 'http:' && next.protocol !== 'https:') {
            return textResult(`${current.href} redirected to an unsupported address: ${next.href}`, true);
          }
          if (!sameSite(current, next) || next.username || next.password) {
            return textResult([
              `The URL redirected to a different host: ${next.href}`,
              'It was not followed. Call WebFetch again with this URL if you want its content.',
            ].join('\n'));
          }
          next = upgraded(next, allowHttp);
          if (visited.has(next.href)) return textResult(`${original.href} redirects in a loop.`, true);
          if (hop + 1 > MAX_REDIRECTS) return textResult(`${original.href} redirected more than ${MAX_REDIRECTS} times.`, true);
          current = next;
          continue;
        }
        if (!response.ok) {
          return textResult(`${current.href} returned HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}.`, true);
        }
        const { type, charset } = mediaType(response.headers.get('content-type'));
        const isHtml = type === 'text/html' || type === 'application/xhtml+xml';
        if (type && !isHtml && !isTextType(type)) {
          return textResult(`${current.href} is ${type}, not a text page. WebFetch returns text only; download it with a command if you need the file.`, true);
        }
        const { bytes, cut } = await readBody(response);
        const sniffedHtml = !type && /^\s*(?:<!doctype html|<html|<head|<body)/i.test(bytes.subarray(0, 512).toString('latin1'));
        let title: string | null = null;
        let text: string;
        if (isHtml || sniffedHtml) {
          const converted = htmlToText(decode(bytes, charset ?? htmlCharset(bytes)), current);
          title = converted.title;
          text = converted.text;
        } else {
          text = decode(bytes, charset);
        }
        const page = pageOf(text, request.startIndex);
        const header = [
          `URL: ${current.href}`,
          ...(title ? [`Title: ${title}`] : []),
          ...(cut ? [`Only the first ${MAX_BODY_BYTES / (1024 * 1024)} MB of the response was read.`] : []),
          ...(page.note ? [page.note] : []),
        ];
        return textResult(`${header.join('\n')}\n\n${page.body || '(The page has no text.)'}`);
      } finally {
        try {
          await response.body?.cancel().catch(() => undefined);
        } finally {
          await release();
        }
      }
    }
  } catch (error) {
    if (error instanceof SsrFBlockedError) {
      return textResult([
        `${current.href} is on the local or a private network.`,
        "Fetching it needs the user's confirmation on the computer where the task runs.",
      ].join(' '), true);
    }
    if (controller.signal.aborted && !request.signal?.aborted) {
      return textResult(`Fetching ${current.href} timed out after ${TIMEOUT_MS / 1000} seconds.`, true);
    }
    if (request.signal?.aborted) return textResult('The fetch was cancelled.', true);
    return textResult(`Could not fetch ${current.href}: ${(error as Error)?.message ?? String(error)}`, true);
  } finally {
    clearTimeout(timer);
  }
}
