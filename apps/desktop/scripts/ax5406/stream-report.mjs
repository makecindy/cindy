import fs from 'node:fs/promises';
import path from 'node:path';
const roots=process.argv.slice(2);
if(roots.length!==4)throw new Error('Expected four stream-test artifact directories');
const audits=await Promise.all(roots.map(async root=>JSON.parse(await fs.readFile(path.join(root,'stream-audit.json'),'utf8'))));
const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;');
const samples=audits.flatMap(a=>a.samples);
const gaps=samples.filter(s=>/-follow$|-resume$|-finish$/.test(s.phase)&&s.distance>2);
const cards=audits.map((a,i)=>`<section><h2>${i>=2?'1000 条历史'+(i===3?'，加密截帧':''):'500 条历史'+(i===1?'，重复':'')}</h2><p>${escape(path.basename(roots[i]))}：${a.samples.length} 次采样；${a.failures.length?'检查未通过：'+escape(a.failures.join('；')):'本轮所有检查通过'}</p><table><tr><th>窗口</th><th>分片</th><th>阅读偏移</th><th>结束离底</th></tr>${a.cases.map(c=>`<tr><td>${c.label}</td><td>${c.tokenCount}/400</td><td>${c.after.rows.find(r=>r.key===c.before.anchor?.key)?.top-c.before.anchor.top}px</td><td>${c.finished.distance}px</td></tr>`).join('')}</table></section>`).join('');
const images=[];
for(const [i,file,title]of [
  [0,'1000x760-light-follow.png','浅色：持续出字，跟随底部'],
  [0,'620x1000-dark-reading-before.png','深色：上翻接管后的阅读位置'],
  [0,'620x1000-dark-reading-after.png','深色：继续输出后仍停在原阅读位置'],
  [1,'1000x760-light-resume.png','重复测试：回到底部并加速输出'],
  [2,'620x1000-dark-finish.png','1000 条历史：输出结束后的完整尾段'],
  [3,'stream-1000x760-light-resume-1.png','恢复输出：原始绘制帧 1'],
  [3,'stream-1000x760-light-resume-2.png','恢复输出：原始绘制帧 2'],
])images.push(`<figure><figcaption>${title}</figcaption><img src="data:image/png;base64,${(await fs.readFile(path.join(roots[i],file))).toString('base64')}" alt="${title}"></figure>`);
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>流式输出专项测试</title><style>body{max-width:920px;margin:auto;padding:18px;background:#f3f4f6;color:#17202a;font:16px/1.65 system-ui}h1{font-size:24px}h2{font-size:18px}section,figure{background:white;margin:16px 0;padding:14px;border-radius:12px;overflow:auto}figure{padding:0}figcaption{padding:14px}img{display:block;width:100%}table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;padding:8px;border-bottom:1px solid #ddd}aside{background:#fff4d5;padding:14px}</style><h1>流式输出专项测试</h1>
<p>2026-10-03，Windows Electron 41.10.3。实际 MessageStream 与样式，合成分片输入，独立测试窗口；没有调用模型或服务端，也不等同于整个安装版客户端验收。</p>
<p>500 条历史两轮、1000 条两轮（最后一轮加密截取恢复输出的首八张绘制帧）；每轮覆盖宽窗、窄窗深色、矮窗。每个尺寸累计 400 个有序分片，包含中英文与基础 Markdown，先每 30ms 追加，再每 10ms 追加。覆盖贴底跟随、输出中滚轮接管、上翻停留、End 回底、继续输出及结束。</p>
<p>总采样 ${samples.length} 次；含空占位 ${samples.filter(s=>s.blank).length} 次；行重叠 ${samples.filter(s=>s.overlap).length} 次。最终按标记检查 ${audits.flatMap(a=>a.cases).reduce((s,c)=>s+c.tokenCount,0)} 个分片。</p>
<aside>贴底阶段仍保留 ${gaps.length} 次距离底部超过 2px 的采样，最大 ${Math.max(0,...gaps.map(s=>s.distance))}px。几何读数可能处于 Markdown 异步提交与下一次高度补偿之间；仅凭读数无法断言这一状态已被绘制。失败记录保留，不能宣称所有帧均无异常。</aside>
${cards}<p>下方为未经编辑的真实组件截图。截图目检和几何采样互补，未逐像素审查每次显示器刷新。</p>${images.join('')}</html>`;
const file=path.join(roots.at(-1),'stream-report.html');await fs.writeFile(file,html);console.log(file);
