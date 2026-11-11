import fs from 'node:fs/promises';
import path from 'node:path';
const roots=process.argv.slice(2);
if(roots.length!==6)throw new Error('Expected previous-search, previous-blank, previous-direct-write, candidate-500, repeat-500, candidate-1000 roots');
const audits=await Promise.all(roots.map(async root=>JSON.parse(await fs.readFile(path.join(root,'scroll-audit.json'),'utf8'))));
const esc=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;');
const names=['此前：搜索落点失败','此前：回底绘制空白','此前：逐帧跳转空白','当前：500 条','当前：500 条重复','当前：1000 条'];
const cards=audits.map((a,i)=>{
  const normal=a.samples.filter(s=>!s.phase.endsWith('-jumps'));
  const forced=a.samples.filter(s=>s.phase.endsWith('-jumps'));
  const other=a.failures.filter(f=>!/-jumps:/.test(f));
  return `<article><h2>${names[i]}</h2><p>产物：${esc(path.basename(roots[i]))}</p><dl><dt>其他阶段采样</dt><dd>${normal.length}</dd><dt>空占位 / 重叠</dt><dd>${normal.filter(s=>s.blank.length).length} / ${normal.filter(s=>s.overlaps).length}</dd><dt>搜索目标可见</dt><dd>${a.navigation.filter(n=>n.visible).length} / ${a.navigation.length}</dd><dt>强制跳跃空帧</dt><dd>${forced.filter(s=>s.blank.length).length} / ${forced.length}</dd></dl><p>${other.length?esc(other.join('；')):'其他检查未发现异常。'}</p></article>`;
});
const figures=[];
for(const [i,file,title] of [
  [0,'1000x760-light-search-420.png','修正前：搜索 420，画面停在 429 / 430'],
  [3,'1000x760-light-search-420.png','修正后：搜索 420，目标正文已在视口内'],
  [1,'paint-620x1000-dark-jump-button-1.png','修正前：回底时实际绘制的空白帧'],
  [3,'paint-620x1000-dark-jump-button-1.png','修正后：同类回底操作的第一张绘制帧'],
  [5,'620x1000-dark-search-420.png','1000 条、窄窗深色：搜索落点'],
  [5,'paint-1000x760-light-thumb-drag-10.png','1000 条：真实滚动条拖动中的绘制帧'],
  [2,'paint-620x1000-dark-jumps-4.png','修正前：脚本在 rAF 内改位置，绘制出空占位'],
  [3,'paint-620x1000-dark-jumps-4.png','修正后：同类逐帧跳转已挂载目标正文'],
]) {
  const png=await fs.readFile(path.join(roots[i],file));
  figures.push(`<figure><figcaption>${esc(title)}</figcaption><img loading="lazy" src="data:image/png;base64,${png.toString('base64')}" alt="${esc(title)}"></figure>`);
}
const totals=audits.slice(3).flatMap(a=>a.samples);
const searches=audits.slice(3).flatMap(a=>a.navigation);
const failures=audits.slice(3).flatMap(a=>a.failures);
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>消息滚动：定位与复测</title><style>body{margin:auto;padding:18px;max-width:920px;background:#f3f4f6;color:#17202a;font:16px/1.65 system-ui,sans-serif}h1{font-size:24px}h2{font-size:18px;margin-top:0}article,figure{background:white;padding:16px;margin:18px 0;border-radius:12px}figure{padding:0;overflow:hidden}figcaption{padding:14px;font-weight:600}img{display:block;width:100%}dl{display:grid;grid-template-columns:1fr 1fr;margin:0}dd{margin:0;text-align:right}aside{padding:14px;background:#fff4d5;border-left:4px solid #aa7100}code{overflow-wrap:anywhere}</style>
<h1>消息滚动：定位与复测</h1><p>2026-10-03，Windows Electron 41.10.3。实际 MessageStream 组件与样式、合成数据、独立测试窗口；无障碍开启。不是整个安装版客户端验收。</p>
<p>搜索与历史扩窗、自动跟随及通用滚动收尾之间存在控制权冲突；校准后还会收到晚到位移。回底路径另有旧阅读锚点覆盖新贴底意图、位置更新早于正文挂载的问题。当前已针对这些路径修正，保留浏览器自动锚定。</p>
<p>这次另外补齐 rAF 直接写 scrollTop 早于 scroll 事件的路径：只观察当前消息容器的赋值，在本轮绘制前的微任务中提交目标正文；保留原生赋值行为，卸载时还原。旧跟随标记不再吞掉主动跳转。未修改全局 DOM 原型。</p>
<p>当前三轮全部阶段合计 ${totals.length} 次采样，${totals.filter(s=>s.blank.length).length} 次含空占位，${totals.filter(s=>s.overlaps).length} 次行重叠；搜索目标可见 ${searches.filter(n=>n.visible).length} / ${searches.length}。失败检查：${failures.length}${failures.length?'（'+esc(failures.join('；'))+'）':''}。</p>
<aside>已增加强制跳转的实际位移和不同落点数量检查，避免“被拉回原处，因此没有空白”的假通过。此处验证的是实际组件的隔离窗口；没有原 issue 的现场转储，也没有在整个安装版客户端上完成验收。不能保证所有硬件／负载下绝无闪动。</aside>
<p>每轮覆盖三种窗口大小、浅色／深色、慢滚／快滚／反向滚、滚动条拖动、键盘翻页、搜索、搜索中途滚轮接管、回底、正文增长、图片和追加消息。DOM 几何采样配合真实绘制帧截图；并非对显示器每次刷新逐像素验收。</p>${cards.join('')}${figures.join('')}
<p>所有原图未经编辑，已内嵌在本 HTML。原始 JSON、截图及构建来源哈希保留在对应临时产物目录。代码尚未提交或发布。</p></html>`;
const out=path.join(roots.at(-1),'navigation-report.html');await fs.writeFile(out,html);console.log(out);
