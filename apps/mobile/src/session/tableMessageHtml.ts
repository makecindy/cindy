import type { MobileMarkdownBlock, MobileMarkdownInline } from './messageMarkdown';
import { mobileMarkdownTableToTsv } from './messageMarkdown';
import { buildMobileMarkdownTableColumnWidths } from './messageTableLayout';
import type { MessageContentLayout } from './messageContentLayout';
import { buildSelectableMarkdownBlockHtml, buildSelectableMarkdownCss } from './selectableMarkdownHtml';
import { withHtmlPreviewCsp } from './htmlPreviewCsp';
import { classifyInlineCodePathCandidate } from './chatPathCandidate';
import { isCindyDeepLinkUrl, parseProjectDeepLinkUrl, parseSessionDeepLinkUrl, projectDisplayName } from './sessionLinks';
import { parseSettingsNavigationUrl } from '@cindy/maker-shared/settings-navigation';
import { fontWeight, lineHeight, radius, spacing, typeScale, type ThemeColors } from '@/theme/tokens';

export interface TableMessageLink { id: string; inline: MobileMarkdownInline; text: string; code: boolean }
export interface TableMessageCopy { id: string; kind: 'code' | 'table'; text: string }
export interface TableMessageLinkState { text: string; lit: boolean; code?: boolean; longPress?: boolean }
export interface TableMessageDocument {
  revision: string; css: string; html: string; selectable: boolean;
  links: Record<string, TableMessageLinkState>;
}
export type TableMessageObservation =
  | { kind: 'height'; revision: string; height: number; width: number; slots: { id: string; top: number; height: number }[] }
  | { kind: 'selection'; revision: string; active: boolean }
  | { kind: 'link'; revision: string; id: string; action: 'open' | 'long-press' };

/** Media/cards retain their existing carrier; never replace them with static text. */
export function supportsTableMessageDocument(blocks: readonly MobileMarkdownBlock[]): boolean {
  return blocks.length > 0 && blocks.every(block => {
    if (block.type === 'mermaid' || block.type === 'math') return false;
    const inlines = block.type === 'table'
      ? [...block.header.flat(), ...block.rows.flatMap(row => row.cells.flat())]
      : block.type === 'code' ? [] : block.inlines;
    return inlines.every(inline => inline.type !== 'image' && inline.type !== 'math'
      && !(inline.type === 'link' && inline.managedMediaKind));
  });
}

export const escapeTableMessageText = (value: string) => value.replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

export function buildTableMessageContent(blocks: readonly MobileMarkdownBlock[], {
  width, layout, copyEnabled, streaming,
}: { width: number; layout: MessageContentLayout; copyEnabled: boolean; streaming?: boolean }): {
  html: string; tableStyles: string; links: TableMessageLink[]; copies: TableMessageCopy[];
} {
  const links: TableMessageLink[] = [], copies: TableMessageCopy[] = [];
  const tableStyles: string[] = [];
  const renderInline = (inline: MobileMarkdownInline): string | undefined => {
    if (inline.type !== 'link' && inline.type !== 'code') return undefined;
    if (inline.type === 'code' && !classifyInlineCodePathCandidate(inline.text)) return undefined;
    const text = inline.text;
    if (inline.type === 'link' && isCindyDeepLinkUrl(inline.url)
      && !parseSessionDeepLinkUrl(inline.url) && !parseSettingsNavigationUrl(inline.url)) {
      const explicit = inline.text.trim() && inline.text.trim() !== inline.url ? inline.text.trim() : null;
      const project = explicit ? null : parseProjectDeepLinkUrl(inline.url);
      return escapeTableMessageText(explicit ?? (project ? projectDisplayName(project.workingDir) : inline.url));
    }
    const id = String(links.length);
    const code = inline.type === 'code';
    links.push({ id, inline, text, code });
    const session = inline.type === 'link' && parseSessionDeepLinkUrl(inline.url);
    return `<span data-chat-link="${id}"${session ? ' data-session' : ''}${code ? ' class="doc-inline-code"' : ''}>${escapeTableMessageText(text)}</span>`;
  };
  const html = blocks.map((block, blockIndex) => {
    const widths = block.type === 'table' ? buildMobileMarkdownTableColumnWidths({
      header: block.header, rows: block.rows, availableWidth: width, minWidth: layout.markdownTableCellMinWidth,
    }) : [];
    // Native tables render the widest row's full grid, including omitted cells.
    const padded = block.type === 'table' ? { ...block,
      header: widths.map((_, index) => block.header[index] ?? []),
      rows: block.rows.map(row => ({ ...row, cells: widths.map((_, index) => row.cells[index] ?? []) })),
    } : block;
    const rendered = buildSelectableMarkdownBlockHtml(padded, { renderInline });
    const kind = block.type === 'table' ? 'table' : block.type === 'code' ? 'code' : null;
    const copy = kind && copyEnabled && (kind !== 'table' || !streaming)
      ? kind === 'table' ? mobileMarkdownTableToTsv(block as Extract<MobileMarkdownBlock, { type: 'table' }>)
        : (block as Extract<MobileMarkdownBlock, { type: 'code' }>).text : '';
    const id = copy.trim() ? String(copies.length) : null;
    if (id !== null) copies.push({ id, kind: kind!, text: copy });
    if (block.type === 'table') {
      // Resize the grid without replacing its selected text nodes.
      widths.forEach((width, column) => {
        tableStyles.push(`.doc-table[data-table-index="${blockIndex}"] tr > :nth-child(${column + 1}){width:${width}px;min-width:${width}px;max-width:${width}px}`);
      });
      return `<div class="doc-table" data-table-index="${blockIndex}">${rendered}${id !== null ? `<div data-copy-slot="${id}" class="doc-table-copy"></div>` : ''}</div>`;
    }
    if (block.type === 'code') return `<div class="doc-code${id !== null ? ' doc-code-copy' : ''}"${id !== null ? ` data-copy-slot="${id}"` : ''}>${rendered}</div>`;
    return rendered;
  }).join('');
  return { html, tableStyles: tableStyles.join('\n'), links, copies };
}

export function tableMessageCss(colors: ThemeColors, scale: number, layout: MessageContentLayout, borderWidth: number): string {
  return buildSelectableMarkdownCss({ fontSize: typeScale.bodyLarge * scale,
    lineHeight: lineHeight.bodyLarge * scale, horizontalPadding: 0,
    bodyGap: layout.markdownBodyGap, markerWidth: layout.markdownListMarkerWidth,
    textColor: colors.textPrimary, mutedColor: colors.textSecondary, borderColor: colors.border,
    chipColor: colors.surfaceChip, inlineCodeColor: colors.chatInlineCodeText,
    tableCellMinWidth: layout.markdownTableCellMinWidth,
    syntaxColors: { comment: colors.syntaxComment, function: colors.syntaxFunction, keyword: colors.syntaxKeyword,
      number: colors.syntaxNumber, property: colors.syntaxProperty, string: colors.syntaxString },
  }, false) + `
  html,body{height:auto;min-height:0}#xdt-content{min-width:0;white-space:pre-wrap}
  body{font-size:${typeScale.bodyLarge * scale}px;line-height:${lineHeight.bodyLarge * scale}px}
  h1{font-size:${typeScale.title * scale}px;line-height:${lineHeight.listTitle * scale}px}
  h2{font-size:${typeScale.subtitle * scale}px;line-height:${lineHeight.listTitle * scale}px}
  h3,h4,h5,h6{font-size:${typeScale.bodyLarge * scale}px;line-height:${lineHeight.bodyLarge * scale}px}
  .list-marker{color:inherit}.list-row{gap:${spacing.sm}px}
  blockquote{color:${colors.textPrimary};border-color:${colors.chatCodeBorder}}
  .doc-code{position:relative;background:${colors.chatCodeSurface};border:${borderWidth}px solid ${colors.chatCodeBorder};border-radius:${radius.container}px;overflow:hidden}
  .doc-code pre{border:0;background:transparent;margin:0;padding:${layout.codePaddingVertical}px ${layout.codePaddingHorizontal}px;white-space:pre-wrap;overflow-wrap:anywhere;overflow:visible}
  .doc-code-copy pre{padding-right:${spacing.sm + spacing.xxl + spacing.md}px;min-height:${spacing.sm + spacing.xxl + spacing.sm}px;box-sizing:border-box}
  pre,pre code{font-size:${typeScale.bodySmall * scale}px;line-height:${lineHeight.bodySmall * scale}px}
  code,.doc-inline-code{font-family:monospace;font-size:${typeScale.bodySmall * scale}px;line-height:${lineHeight.bodySmall * scale}px;background:transparent;color:${colors.chatInlineCodeText}}
  .doc-table table{box-sizing:border-box;display:block;max-width:100%;overflow-x:auto;border-spacing:0;border-collapse:collapse;margin:0}
  .doc-table th,.doc-table td{box-sizing:border-box;padding:${spacing.xs}px ${spacing.sm}px;border:${borderWidth}px solid ${colors.border};font-size:${typeScale.bodySmall * scale}px;line-height:${lineHeight.bodySmall * scale}px;overflow-wrap:anywhere}
  .doc-table th{background:${colors.surfaceElevated};color:${colors.textSecondary};font-weight:${fontWeight.medium}}
  .doc-table-copy{height:${spacing.xxl + spacing.xs * 2}px;user-select:none}
  [data-chat-link][role=link]{text-decoration:underline;cursor:pointer}
  [data-chat-link][data-session]{background:${colors.surfaceChip}}
  `;
}

/** Bridge messages only identify parser-owned nodes; no URL/path/clipboard execution. */
export function parseTableMessageObservation(data: string, revision: string, maxHeight: number): TableMessageObservation | null {
  if (data.length > 100_000) return null;
  try {
    const value = JSON.parse(data);
    if (value?.revision !== revision) return null;
    if (value.kind === 'selection' && typeof value.active === 'boolean') return value;
    if (value.kind === 'link' && typeof value.id === 'string' && /^\d{1,6}$/.test(value.id)
      && (value.action === 'open' || value.action === 'long-press')) return value;
    if (value.kind !== 'height' || !Number.isFinite(value.height) || value.height < 1 || value.height > maxHeight
      || !Number.isFinite(value.width) || value.width <= 0 || value.width > 10000 || !Array.isArray(value.slots)
      || value.slots.length > 1000) return null;
    if (!value.slots.every((slot: { id?: unknown; top?: unknown; height?: unknown }) =>
      typeof slot.id === 'string' && /^\d{1,6}$/.test(slot.id) && typeof slot.top === 'number'
      && Number.isFinite(slot.top) && slot.top >= 0 && slot.top <= value.height
      && typeof slot.height === 'number' && Number.isFinite(slot.height) && slot.height >= 0
      && slot.height <= value.height)) return null;
    return value;
  } catch { return null; }
}

/** Empty trusted shell. Every author string enters later as escaped parser output. */
export const TABLE_MESSAGE_SHELL = withHtmlPreviewCsp(`<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<style id="chat-style"></style><style id="chat-selection"></style></head><body><div id="xdt-content"></div>
<script>(()=>{const root=document.getElementById('xdt-content');let revision='',pending=false,markup='',links={};
const send=value=>window.ReactNativeWebView?.postMessage(JSON.stringify({...value,revision}));
const report=()=>{pending=false;const rect=root.getBoundingClientRect();send({kind:'height',width:rect.width,height:Math.ceil(rect.height),
slots:[...root.querySelectorAll('[data-copy-slot]')].map(el=>({id:el.dataset.copySlot,top:el.getBoundingClientRect().top-rect.top,height:el.getBoundingClientRect().height}))});};
// A layout read runs before paint. Give the covered WebView a rendering frame before promotion.
const queue=()=>{if(!pending){pending=true;requestAnimationFrame(()=>requestAnimationFrame(report));}};
const updateLinks=()=>{root.querySelectorAll('[data-chat-link]').forEach(el=>{const state=links[el.dataset.chatLink];if(!state)return;
if(el.textContent!==state.text){
  const selection=getSelection();
  if(selection?.rangeCount&&selection.getRangeAt(0).intersectsNode(el))selection.removeAllRanges();
  el.textContent=state.text;
}el.classList.toggle('doc-inline-code',!!state.code);el.toggleAttribute('data-long-press',!!state.longPress);
if(state.lit){el.setAttribute('role','link');el.tabIndex=0;}else{el.removeAttribute('role');el.removeAttribute('tabindex');}});};
window.__cindyTableMessageUpdate=next=>{if(next.revision!==revision){revision=next.revision;}
document.getElementById('chat-style').textContent=next.css;
document.getElementById('chat-selection').textContent='html,body,#xdt-content,#xdt-content *{-webkit-user-select:'+(next.selectable?'text':'none')+'!important;user-select:'+(next.selectable?'text':'none')+'!important}';
if(markup!==next.html){getSelection()?.removeAllRanges();markup=next.html;root.innerHTML=markup;}
links=next.links;updateLinks();queue();};
new ResizeObserver(queue).observe(root);window.addEventListener('resize',queue);
document.addEventListener('selectionchange',()=>{const s=getSelection();send({kind:'selection',active:!!s&&!s.isCollapsed&&!!String(s)});});
const link=event=>event.target.closest?.('[data-chat-link][role=link]');
document.addEventListener('click',event=>{const el=link(event);if(el){event.preventDefault();send({kind:'link',id:el.dataset.chatLink,action:'open'});}});
document.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){const el=link(event);if(el){event.preventDefault();send({kind:'link',id:el.dataset.chatLink,action:'open'});}}});
document.addEventListener('contextmenu',event=>{const el=link(event);if(el?.hasAttribute('data-long-press')){event.preventDefault();send({kind:'link',id:el.dataset.chatLink,action:'long-press'});}});
})();</script></body></html>`);

export function tableMessageUpdateScript(document: TableMessageDocument): string {
  // JSON string encoding keeps author quotes, backticks and newlines as data.
  return `window.__cindyTableMessageUpdate?.(${JSON.stringify(document)});true;`;
}
