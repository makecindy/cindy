/**
 * cindy-docs/pdfTemplate.ts —— 无样式 HTML 的内置报告模板。
 *
 * render_pdf 的目标是「不装插件也体面」:模型如果只丢过来一段裸 <h1>/<p>/<table>,
 * 没有 <style> 也没有外链 CSS,就自动套这套打印样式。已经自己写了样式的 HTML
 * 原样透传,绝不覆盖。
 *
 * 纯配置:色板来自 themes.ts,字体只声明系统字体族,不捆 webfont、不捆图片。
 */

import { themeToCssHex, type DocsTheme } from './themes.js';

export const PDF_TEMPLATE_MARK = 'data-cindy-docs-template="report"';

const RELATIVE_RESOURCE_RE =
  /\b(?:src|href)\s*=\s*["'](?!https?:|data:|#|\/\/|file:)[^"']+/i;

export function htmlLooksUnstyled(html: string): boolean {
  if (html.includes(PDF_TEMPLATE_MARK)) return false;
  if (/<style[\s>]/i.test(html)) return false;
  if (/<link\b[^>]*rel\s*=\s*["']?stylesheet/i.test(html)) return false;
  return true;
}

export function htmlHasRelativeResources(html: string): boolean {
  return RELATIVE_RESOURCE_RE.test(html);
}

function stripTags(raw: string): string {
  return raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function extractHtmlTitle(html: string): string {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title?.[1] && stripTags(title[1]).length > 0) return stripTags(title[1]);
  const heading = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (heading?.[1] && stripTags(heading[1]).length > 0) return stripTags(heading[1]);
  return '文档';
}

export function extractHtmlBody(html: string): string {
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  if (body?.[1]) return body[1].trim();
  return html
    .replace(/<!doctype[^>]*>/i, '')
    .replace(/<\/?html\b[^>]*>/gi, '')
    .replace(/<head\b[\s\S]*?<\/head>/i, '')
    .trim();
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
    `<title>${escapeHtml(title)}</title>`,
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
