import fs from 'node:fs/promises';
import path from 'node:path';
const roots=process.argv.slice(2);
if(roots.length!==3)throw new Error('Expected current-probe, HEAD-probe, final-verification');
const audits=await Promise.all(roots.map(async root=>JSON.parse(await fs.readFile(path.join(root,'stream-audit.json'),'utf8'))));
const names=['当前代码：定位轮','修改前 HEAD：对照轮','当前代码：修正判据后复测'];
const esc=x=>String(x).replaceAll('&','&amp;').replaceAll('<','&lt;');
const summaries=audits.map(a=>{
  const frames=a.paintAudit.filter(p=>/-follow$|-resume$|-finish$/.test(p.phase));
  return {frames:frames.length,missing:frames.filter(p=>!p.markerPixels).length,
    gaps:a.samples.filter(s=>/-follow$|-resume$|-finish$/.test(s.phase)&&s.distance>2).length,
    resize:a.timeline.filter(e=>e.kind==='resize-after-owner'&&e.distance>2).length,
    controls:a.paintAudit.filter(p=>p.phase.endsWith('-reading')&&!p.markerPixels).length};
});
const timeline=audits[0].timeline;
const start=timeline.findIndex(e=>e.kind==='mutation'&&e.distance>2);
const first=timeline[start];
const stages=timeline.slice(start,start+4);
const labels={'mutation':'文字 DOM 更新','rAF-before-layout':'绘制前动画帧回调','scroll-write':'高度补偿写入位置','resize-after-owner':'补偿后的尺寸观察'};
const figures=[];
for(const [i,file,title]of [
  [0,'stream-1000x760-light-resume-2.png','当前代码：浅色恢复输出，底边标记仍在窗口底部'],
  [0,'stream-620x1000-dark-resume-2.png','当前代码：深色恢复输出，底边标记仍在窗口底部'],
  [1,'stream-1000x760-light-resume-2.png','修改前代码：同类输出画面'],
  [2,'620x1000-dark-finish.png','最终复测：输出结束，最后分片完整'],
])figures.push(`<figure><figcaption>${title}</figcaption><img src="data:image/png;base64,${(await fs.readFile(path.join(roots[i],file))).toString('base64')}" alt="${title}"></figure>`);
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>流式输出：离底疑点定位</title><style>body{max-width:960px;margin:auto;padding:18px;background:#f3f4f6;color:#17202a;font:16px/1.7 system-ui}h1{font-size:24px}h2{font-size:18px}section,figure{background:white;margin:18px 0;padding:14px;border-radius:12px;overflow:auto}figure{padding:0}figcaption{padding:14px}img{display:block;width:100%}table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;padding:8px;border-bottom:1px solid #ddd}aside{padding:14px;background:#e7f3ed}code{overflow-wrap:anywhere}</style>
<h1>流式输出：离底疑点定位</h1><aside>此次复现的短暂离底读数位于 DOM 更新与绘制前补偿之间。当前版和修改前版都出现该读数，捕获到的实际贴底绘制帧均未出现离底。生产代码无需为这个中间状态新增补丁。</aside>
<p>2026-10-03，Windows Electron 41.10.3；实际 MessageStream、合成分片、独立窗口，AX 开启。1000 条历史、三种窗口尺寸、Light / Dark，每轮 1200 个有序分片。不是完整安装版或真实模型链路验收。</p>
<section><h2>真实时序示例</h2><table><tr><th>事件</th><th>相对时间</th><th>离底</th></tr>${stages.map(e=>`<tr><td>${labels[e.kind]||esc(e.kind)}</td><td>+${(e.time-first.time).toFixed(1)}ms</td><td>${e.distance}px</td></tr>`).join('')}</table><p>旧采样器用 rAF 后的 setTimeout 读取几何，可能与另一次 Markdown 异步提交交错。这个读数不代表屏幕已经画出了该状态。</p></section>
<section><h2>绘制帧与修改前对照</h2><table><tr><th>版本</th><th>中间态采样</th><th>贴底绘制帧</th><th>实际离底帧</th><th>补偿后离底</th></tr>${summaries.map((s,i)=>`<tr><td>${names[i]}<br>${path.basename(roots[i])}</td><td>${s.gaps}</td><td>${s.frames}</td><td>${s.missing}</td><td>${s.resize}</td></tr>`).join('')}</table><p>修改前来源为 HEAD <code>d656b0fc1ec3e04548cd018654cbd6486f6cf839</code> 的 MessageStream 与 CSS，由构建插件只读载入，未回退工作区。源码 SHA-256 已核对；对照版仍挂载 80 条正文并保留 content-visibility:auto。</p></section>
<p>紫色细线是仅测试窗口中的绝对定位标记，不参与布局，跟随内容底边。检测直接读取 Electron 输出帧的像素。主动上翻时标记移出屏幕，三轮分别捕获 ${summaries.map(s=>s.controls).join('、')} 帧，验证检测器能识别真正的离底。标记不进入生产 UI。</p>
<p>修正后的检查保留所有中间态读数；新增实际绘制离底、补偿后残留离底、九个阶段缺少绘制证据、正反对照无效的失败门槛。最终轮失败数：${audits[2].failures.length}。没有删除历史失败记录。</p>
${figures.join('')}<p>图片均为未经编辑的真实测试窗口截帧；只能说明本轮捕获帧与负载，没有证明所有平台、硬件和复杂消息组合绝无异常。未修改生产代码，未提交或发布。</p></html>`;
const file=path.join(roots.at(-1),'stream-diagnosis.html');await fs.writeFile(file,html);console.log(file);
