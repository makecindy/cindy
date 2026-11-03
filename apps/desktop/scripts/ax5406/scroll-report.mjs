import fs from 'node:fs/promises';
import path from 'node:path';
const roots=process.argv.slice(2);
if(roots.length!==4)throw new Error('Expected original, full-mount control, fixed-500, fixed-1000 roots');
const reports=await Promise.all(roots.map(async root=>JSON.parse(await fs.readFile(path.join(root,'scroll-audit.json'),'utf8'))));
const names=['初版视口挂载：500 条','全量挂载对照：500 条','滚动事件同步挂载：500 条','滚动事件同步挂载：1000 条'];
const escape=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;');
const rows=reports.map((report,i)=>{
  const samples=report.samples.filter(s=>!s.phase.endsWith('-jumps'));
  const forced=report.samples.filter(s=>s.phase.endsWith('-jumps'));
  const other=report.failures.filter(s=>!/blank \/|overlapping frame/.test(s));
  return `<tr><td>${names[i]}</td><td>${samples.length}</td><td>${samples.filter(s=>s.blank.length).length}</td><td>${samples.filter(s=>s.overlaps).length}</td><td>${forced.filter(s=>s.blank.length).length} / ${forced.length}</td><td>${other.length?escape(other.join('；')):'无'}</td></tr>`;
});
const figures=[];
for(const [index,file,title] of [
  [2,'paint-1000x760-light-fast-up-12.png','修正后：高速滚轮，浅色'],
  [2,'paint-1000x760-light-thumb-drag-10.png','修正后：真实拖动滚动条'],
  [3,'620x1000-dark-reading.png','1000 条历史：窄窗深色，停止后阅读'],
  [2,'paint-620x1000-dark-jumps-12.png','边界压力：绘制回调直接改 scrollTop，仍可能出现一帧空白'],
  [1,'paint-620x1000-dark-jumps-12.png','全量挂载对照：同类强制位置跳跃'],
]){
  const data=await fs.readFile(path.join(roots[index],file));
  figures.push(`<figure><figcaption>${escape(title)}</figcaption><img src="data:image/png;base64,${data.toString('base64')}" alt="${escape(title)}"></figure>`);
}
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>消息视口挂载：增强滚动验证</title><style>body{font:16px/1.7 system-ui,sans-serif;background:#f3f4f6;color:#17202a;max-width:1000px;margin:auto;padding:20px}h1{font-size:24px}table{border-collapse:collapse;font-size:14px;width:100%;background:white}th,td{padding:10px;border:1px solid #ddd;text-align:left}figure{margin:24px 0;background:white;border-radius:12px;overflow:hidden}figcaption{padding:14px;font-weight:600}img{width:100%;display:block}aside{border-left:4px solid #c67c00;padding:12px;background:#fff4d5}.table{overflow-x:auto}</style>
<h1>消息视口挂载：增强滚动验证</h1><p>2026-10-03，Windows Electron，真实 MessageStream 与正式样式，合成 500 / 1000 条消息。保持无障碍开启。测试窗口为 1000×420、1000×760、620×1000，覆盖浅色和深色。</p>
<p>发现并修正了初版快速滚动闪空：滚动事件不再等下一次 requestAnimationFrame 才挂载正文，而是在事件中同步完成挂载。正常缓慢滚动、快速滚动、来回滚动、真实滚动条拖动、键盘翻页、搜索跳转、回底按钮均参与检查。</p>
<aside>整体结果不是“全部通过”。真实滚轮与拖动闪空已补修，但搜索落点仍有失败；直接在绘制回调中强制改 scrollTop 的诊断负载也仍产生空帧。脚本保留失败退出码与原始记录。当前不能作为完整安装版客户端验收通过的证据。</aside>
<div class="table"><table><thead><tr><th>版本</th><th>其他阶段采样</th><th>空占位</th><th>行重叠</th><th>直接强制跳跃：空 / 总采样</th><th>其他未通过检查</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>
<p>采样在 rAF 后的任务中读取几何和占位状态；高速阶段同时使用 Electron beginFrameSubscription 保存实际绘制帧。以下原图未编辑，位置与消息内容受调度影响，不做逐像素黄金图比较。</p>${figures.join('')}
<p>阅读位置在停止滚动后再次检查，允许 2px 误差。原始 scroll-audit.json、PNG、report.json 和构建来源哈希保留在各产物目录。</p></html>`;
const out=path.join(roots.at(-1),'scroll-report.html');await fs.writeFile(out,html);console.log(out);
