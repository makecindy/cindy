/**
 * Batfree feedback / manual iOS e2e feasibility fixture. Existing native cells
 * cannot share a range; this tests the existing HTML builder and WebView menu
 * before changing any production message carrier. Use real system handles,
 * Copy/Paste and quote; no script may create or replace a selection.
 */
import { withHtmlPreviewCsp } from '@/session/htmlPreviewCsp';
import { buildSelectableMarkdownHtml, type SelectableMarkdownHtmlOptions } from '@/session/selectableMarkdownHtml';

export const TABLE_SELECTION_MARKDOWN = [
  '表前开始：保留 中文 空格。',
  '',
  '| 名称 | 内容 | 说明 | 末列 |',
  '| --- | --- | --- | --- |',
  '| 项目甲 Alpha | 中文 空格 42 | 长格开始：这段中文包含 空格，单元格内自然换行，选区必须经过整张表格。长格结束 | 右端 Alpha |',
  '| 项目乙 Beta | | 末行 Final | 隐藏 终格 |',
  '',
  '表后结束：完整终点。',
].join('\n');

/** Fixed local content only. No links, media, remote fonts or model HTML. */
export function buildTableSelectionFixtureHtml(options: SelectableMarkdownHtmlOptions): string {
  const html = buildSelectableMarkdownHtml(TABLE_SELECTION_MARKDOWN, {
    ...options,
    tableCellMinWidth: 160,
  });
  return withHtmlPreviewCsp(html
    .replace('</head>', '<style>th,td{width:160px;max-width:160px}</style></head>')
    .replace('</body>', `<script>
(()=>{
  const table=document.querySelector('table');let pending=false;
  const report=()=>{pending=false;window.ReactNativeWebView?.postMessage(JSON.stringify({
    kind:'table-selection-observation',text:String(getSelection()||'').slice(0,4096),
    scrollLeft:table?.scrollLeft||0,scrollWidth:table?.scrollWidth||0,
    viewportWidth:table?.clientWidth||0
  }));};
  const queue=()=>{if(!pending){pending=true;setTimeout(report,60);}};
  document.addEventListener('selectionchange',queue);
  table?.addEventListener('scroll',queue,{passive:true});
  window.addEventListener('load',queue);queue();
})();
</script></body>`));
}
