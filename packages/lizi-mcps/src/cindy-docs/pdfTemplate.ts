/**
 * cindy-docs/pdfTemplate.ts —— 无样式 HTML 的内置报告模板。
 *
 * render_pdf 的目标是「不装插件也体面」:模型如果只丢过来一段裸 <h1>/<p>/<table>,
 * 没有 <style> 也没有外链 CSS,就自动套这套打印样式。已经自己写了样式的 HTML
 * 原样透传,绝不覆盖。
 *
 * 纯配置:色板来自 themes.ts,字体只声明系统字体族,不捆 webfont、不捆图片。
 */

import { decodeHTML } from 'entities';

import { themeToCssHex, type DocsTheme } from './themes.js';

export const PDF_TEMPLATE_MARK = 'data-cindy-docs-template="report"';

const RELATIVE_RESOURCE_RE =
  /\b(?:src|href)\s*=\s*["'](?!https?:|data:|#|\/\/|file:)[^"']+/i;
const HTML_RAW_TEXT_TAGS = new Set([
  'iframe',
  'noembed',
  'noframes',
  'noscript',
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
]);
const HTML_HEAD_CONTENT_TAGS = new Set([
  'base',
  'basefont',
  'bgsound',
  'head',
  'html',
  'link',
  'meta',
  'noframes',
  'noscript',
  'script',
  'style',
  'template',
  'title',
]);
const HTML_ATTRIBUTE_PATTERN =
  /(\s+)([A-Za-z_:][\w:.-]*)(\s*=\s*)(?:(['"])([\s\S]*?)\4|([^\s"'=<>`]+))/gi;

export function htmlLooksUnstyled(html: string): boolean {
  if (html.includes(PDF_TEMPLATE_MARK)) return false;
  return !htmlHasStylesheetElement(html);
}

export function htmlHasRelativeResources(html: string): boolean {
  return RELATIVE_RESOURCE_RE.test(html);
}

function stripTags(raw: string): string {
  return raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function extractHtmlTitle(html: string): string | undefined {
  const title = findHtmlElementRange(html, 'title');
  if (title) {
    const value = decodeHTML(html.slice(title.contentStart, title.contentEnd))
      .replace(/\s+/g, ' ')
      .trim();
    if (value.length > 0) return value;
  }
  const heading = findHtmlElementRange(html, 'h1');
  if (heading) {
    const value = decodeHTML(
      stripTags(html.slice(heading.contentStart, heading.contentEnd)),
    );
    if (value.length > 0) return value;
  }
  return undefined;
}

function findHtmlTagEnd(html: string, start: number): number {
  let quote: '"' | "'" | undefined;
  for (let index = start + 1; index < html.length; index += 1) {
    const current = html[index]!;
    if (quote) {
      if (current === quote) quote = undefined;
      continue;
    }
    if (current === '"' || current === "'") quote = current;
    else if (current === '>') return index;
  }
  return -1;
}

function readHtmlAttribute(tag: string, attributeName: string): string | undefined {
  const wanted = attributeName.toLowerCase();
  for (const match of tag.matchAll(HTML_ATTRIBUTE_PATTERN)) {
    if (match[2]!.toLowerCase() === wanted) return match[4] ? match[5] : match[6];
  }
  return undefined;
}

interface HtmlElementRange {
  start: number;
  contentStart: number;
  contentEnd: number;
  end: number;
}

function findRawTextClosing(
  html: string,
  name: string,
  contentStart: number,
): { start: number; end: number } | undefined {
  const closing = new RegExp(`<\\/\\s*${name}\\s*>`, 'ig');
  closing.lastIndex = contentStart;
  const match = closing.exec(html);
  return match ? { start: match.index, end: match.index + match[0].length } : undefined;
}

/** Find one real HTML element while ignoring comments, raw-text contents and template subtrees. */
function findHtmlElementRange(html: string, wantedName: string): HtmlElementRange | undefined {
  const wanted = wantedName.toLowerCase();
  let opening: { start: number; contentStart: number } | undefined;
  let templateDepth = 0;
  let index = 0;
  while (index < html.length) {
    const tagStart = html.indexOf('<', index);
    if (tagStart < 0) {
      if (wanted === 'head' && opening && templateDepth === 0) {
        const trailingText = html.slice(index).search(/[^\t\n\f\r ]/);
        if (trailingText >= 0) {
          const implicitEnd = index + trailingText;
          return {
            start: opening.start,
            contentStart: opening.contentStart,
            contentEnd: implicitEnd,
            end: implicitEnd,
          };
        }
      }
      break;
    }
    if (wanted === 'head' && opening && templateDepth === 0) {
      const textBeforeTag = html.slice(index, tagStart).search(/[^\t\n\f\r ]/);
      if (textBeforeTag >= 0) {
        const implicitEnd = index + textBeforeTag;
        return {
          start: opening.start,
          contentStart: opening.contentStart,
          contentEnd: implicitEnd,
          end: implicitEnd,
        };
      }
    }
    if (html.startsWith('<!--', tagStart)) {
      const commentEnd = html.indexOf('-->', tagStart + 4);
      index = commentEnd < 0 ? html.length : commentEnd + 3;
      continue;
    }
    const tagEnd = findHtmlTagEnd(html, tagStart);
    if (tagEnd < 0) break;
    const tag = html.slice(tagStart, tagEnd + 1);
    const closingName = tag.match(/^<\s*\/\s*([A-Za-z][\w:-]*)\s*>/)?.[1]?.toLowerCase();
    if (closingName === 'template' && templateDepth > 0) {
      templateDepth -= 1;
      index = tagEnd + 1;
      continue;
    }
    if (closingName === wanted && opening && templateDepth === 0) {
      return {
        start: opening.start,
        contentStart: opening.contentStart,
        contentEnd: tagStart,
        end: tagEnd + 1,
      };
    }
    if (
      wanted === 'head' &&
      opening &&
      templateDepth === 0 &&
      closingName &&
      (closingName === 'body' || closingName === 'html' || closingName === 'br')
    ) {
      return {
        start: opening.start,
        contentStart: opening.contentStart,
        contentEnd: tagStart,
        end: tagStart,
      };
    }
    const name = tag.match(/^<\s*([A-Za-z][\w:-]*)\b/)?.[1]?.toLowerCase();
    if (!name) {
      index = tagEnd + 1;
      continue;
    }
    if (wanted === 'head' && opening && templateDepth === 0 && !HTML_HEAD_CONTENT_TAGS.has(name)) {
      return {
        start: opening.start,
        contentStart: opening.contentStart,
        contentEnd: tagStart,
        end: tagStart,
      };
    }
    if (name === 'template' && !/\/\s*>$/.test(tag)) {
      templateDepth += 1;
      index = tagEnd + 1;
      continue;
    }
    if (templateDepth === 0 && name === wanted && !opening) {
      if (HTML_RAW_TEXT_TAGS.has(name)) {
        const rawClosing = findRawTextClosing(html, name, tagEnd + 1);
        return rawClosing
          ? {
              start: tagStart,
              contentStart: tagEnd + 1,
              contentEnd: rawClosing.start,
              end: rawClosing.end,
            }
          : {
              start: tagStart,
              contentStart: tagEnd + 1,
              contentEnd: html.length,
              end: html.length,
            };
      }
      opening = { start: tagStart, contentStart: tagEnd + 1 };
    }
    if (HTML_RAW_TEXT_TAGS.has(name)) {
      const rawClosing = findRawTextClosing(html, name, tagEnd + 1);
      index = rawClosing?.end ?? html.length;
      continue;
    }
    index = tagEnd + 1;
  }
  return opening
    ? {
        start: opening.start,
        contentStart: opening.contentStart,
        contentEnd: html.length,
        end: html.length,
      }
    : undefined;
}

function htmlHasStylesheetElement(html: string): boolean {
  let templateDepth = 0;
  let index = 0;
  while (index < html.length) {
    const tagStart = html.indexOf('<', index);
    if (tagStart < 0) break;
    if (html.startsWith('<!--', tagStart)) {
      const commentEnd = html.indexOf('-->', tagStart + 4);
      index = commentEnd < 0 ? html.length : commentEnd + 3;
      continue;
    }
    const tagEnd = findHtmlTagEnd(html, tagStart);
    if (tagEnd < 0) break;
    const tag = html.slice(tagStart, tagEnd + 1);
    const closing = tag.match(/^<\s*\/\s*([A-Za-z][\w:-]*)\s*>/);
    if (closing?.[1]?.toLowerCase() === 'template' && templateDepth > 0) {
      templateDepth -= 1;
      index = tagEnd + 1;
      continue;
    }
    const opening = tag.match(/^<\s*([A-Za-z][\w:-]*)\b/);
    const name = opening?.[1]?.toLowerCase();
    if (!name) {
      index = tagEnd + 1;
      continue;
    }
    if (name === 'template' && !/\/\s*>$/.test(tag)) {
      templateDepth += 1;
      index = tagEnd + 1;
      continue;
    }
    if (templateDepth === 0) {
      if (name === 'style') return true;
      if (name === 'link') {
        const rel = readHtmlAttribute(tag, 'rel');
        if (
          rel &&
          decodeHTML(rel)
            .split(/\s+/)
            .some((token) => token.toLowerCase() === 'stylesheet')
        ) {
          return true;
        }
      }
    }
    if (HTML_RAW_TEXT_TAGS.has(name)) {
      const rawTextEnd = new RegExp(`<\\/\\s*${name}\\s*>`, 'ig');
      rawTextEnd.lastIndex = tagEnd + 1;
      const closingMatch = rawTextEnd.exec(html);
      index = closingMatch ? closingMatch.index + closingMatch[0].length : html.length;
      continue;
    }
    index = tagEnd + 1;
  }
  return false;
}

/**
 * Locate the real body element without treating tag-shaped text in comments or
 * HTML raw-text elements as markup. A lightweight scanner is enough here: the
 * template only needs the byte range, while Chromium remains the HTML parser.
 */
function findHtmlBodyRange(html: string): { start: number; end: number } | undefined {
  const body = findHtmlElementRange(html, 'body');
  return body ? { start: body.contentStart, end: body.contentEnd } : undefined;
}

/** 只剥扫描器确认的文档包装节点；raw-text 中的标签形状字符串必须原样保留。 */
function stripHtmlDocumentWrappers(html: string): string {
  let output = '';
  let cursor = 0;
  let index = 0;
  let templateDepth = 0;

  while (index < html.length) {
    const tagStart = html.indexOf('<', index);
    if (tagStart < 0) break;
    if (html.startsWith('<!--', tagStart)) {
      const commentEnd = html.indexOf('-->', tagStart + 4);
      index = commentEnd < 0 ? html.length : commentEnd + 3;
      continue;
    }
    const tagEnd = findHtmlTagEnd(html, tagStart);
    if (tagEnd < 0) break;
    const tag = html.slice(tagStart, tagEnd + 1);
    const closingName = tag.match(/^<\s*\/\s*([A-Za-z][\w:-]*)\s*>/)?.[1]?.toLowerCase();
    const openingName = tag.match(/^<\s*([A-Za-z][\w:-]*)\b/)?.[1]?.toLowerCase();

    if (closingName === 'template' && templateDepth > 0) {
      templateDepth -= 1;
    } else if (openingName === 'template' && !/\/\s*>$/.test(tag)) {
      templateDepth += 1;
    }

    const isDoctype = templateDepth === 0 && /^<!doctype\b/i.test(tag);
    const isHtmlWrapper = templateDepth === 0 && (openingName === 'html' || closingName === 'html');
    if (isDoctype || isHtmlWrapper) {
      output += html.slice(cursor, tagStart);
      cursor = tagEnd + 1;
    }

    if (openingName && HTML_RAW_TEXT_TAGS.has(openingName)) {
      const rawClosing = findRawTextClosing(html, openingName, tagEnd + 1);
      index = rawClosing?.end ?? html.length;
      continue;
    }
    index = tagEnd + 1;
  }

  return `${output}${html.slice(cursor)}`;
}

export function extractHtmlBody(html: string): string {
  const body = findHtmlBodyRange(html);
  if (body) return html.slice(body.start, body.end).trim();
  const head = findHtmlElementRange(html, 'head');
  const withoutHead = head ? `${html.slice(0, head.start)}${html.slice(head.end)}` : html;
  return stripHtmlDocumentWrappers(withoutHead).trim();
}

export function reportTemplateCss(theme: DocsTheme): string {
  const ink = themeToCssHex(theme.title);
  const body = themeToCssHex(theme.body);
  const muted = themeToCssHex(theme.muted);
  const line = themeToCssHex(theme.line);
  const accent = themeToCssHex(theme.accent);
  const wash = themeToCssHex(theme.surface);
  const paper = themeToCssHex(theme.background);
  const zebra = themeToCssHex(theme.zebra);
  return `
@page { size: A4; margin: 18mm 16mm; }
:root {
  --ink: ${ink}; --body: ${body}; --muted: ${muted}; --line: ${line};
  --accent: ${accent}; --wash: ${wash}; --paper: ${paper}; --zebra: ${zebra};
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  color: var(--body); background: var(--paper);
  font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei",
    -apple-system, "Helvetica Neue", Arial, sans-serif;
  font-size: 11pt; line-height: 1.7;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
h1, h2, h3, h4, h5, h6 {
  color: var(--ink); break-after: avoid; page-break-after: avoid;
}
h1 { font-size: 22pt; line-height: 1.3; margin: 0 0 10pt; }
h2 {
  font-size: 15pt; margin: 18pt 0 7pt; padding-left: 8pt;
  border-left: 3px solid var(--accent);
}
h3 { font-size: 12.5pt; margin: 13pt 0 5pt; }
h4, h5, h6 { font-size: 11pt; margin: 10pt 0 4pt; }
p { margin: 0 0 8pt; }
ul, ol { margin: 0 0 8pt 1.4em; }
li { margin: 0 0 3pt; }
blockquote {
  margin: 10pt 0; padding: 6pt 12pt; color: var(--muted);
  border-left: 3px solid var(--line); background: var(--wash);
}
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 9.5pt; }
code { padding: 0 2pt; background: var(--wash); border-radius: 3pt; }
pre {
  padding: 8pt 10pt; background: var(--wash); border: 1px solid var(--line);
  border-radius: 4pt; overflow-wrap: anywhere;
}
pre code { background: none; padding: 0; }
table { width: 100%; border-collapse: collapse; margin: 10pt 0; font-size: 10pt; }
th, td { border: 1px solid var(--line); padding: 5pt 7pt; text-align: left; vertical-align: top; }
thead th { background: var(--wash); font-weight: 600; color: var(--ink); }
tbody tr:nth-child(even) td { background: var(--zebra); }
table, figure, pre, blockquote { break-inside: avoid; page-break-inside: avoid; }
thead { display: table-header-group; }
img { max-width: 100%; height: auto; }
figcaption { font-size: 9pt; color: var(--muted); margin-top: 3pt; }
header.cover { border-bottom: 2px solid var(--accent); padding-bottom: 10pt; margin-bottom: 18pt; }
header.cover h1 { font-size: 20pt; margin: 0 0 6pt; }
header.cover .meta { font-size: 9.5pt; color: var(--muted); }
.page-break { break-before: page; page-break-before: always; }
footer, footer.note {
  margin-top: 20pt; padding-top: 8pt; border-top: 1px solid var(--line);
  font-size: 9pt; color: var(--muted);
}
`.trim();
}

export function wrapInReportTemplate(html: string, theme: DocsTheme): string {
  const title = extractHtmlTitle(html);
  const body = extractHtmlBody(html) || '<p></p>';
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8" />',
    `<title>${title ? escapeHtml(title) : ''}</title>`,
    `<style ${PDF_TEMPLATE_MARK}>`,
    reportTemplateCss(theme),
    '</style>',
    '</head>',
    '<body>',
    body,
    '</body>',
    '</html>',
  ].join('\n');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface ApplyReportTemplateResult {
  html: string;
  applied: boolean;
}

export function applyReportTemplate(
  html: string,
  theme: DocsTheme,
  mode: 'auto' | 'report' | 'none' = 'auto',
): ApplyReportTemplateResult {
  if (mode === 'none') return { html, applied: false };
  if (mode === 'auto' && !htmlLooksUnstyled(html)) return { html, applied: false };
  if (mode === 'report' && html.includes(PDF_TEMPLATE_MARK)) return { html, applied: false };
  if (mode === 'report' && !htmlLooksUnstyled(html)) {
    // 已经有自己的样式:只标记「未覆盖」,不二次包裹。
    return { html, applied: false };
  }
  return { html: wrapInReportTemplate(html, theme), applied: true };
}
