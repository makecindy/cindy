// Package real Electron capturePage screenshots into a portable, offline report.
import fs from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(process.argv[2]);
const report = JSON.parse(await fs.readFile(path.join(root, 'report.json'), 'utf8'));
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const captions = {
  '01-light-bottom': '浅色：首次进入，显示尾部消息',
  '02-light-middle': '浅色：滚动到历史消息',
  '04-async-image': '异步图片加载完成；黄色为原有搜索定位高亮',
  '08-dark-narrow': '深色窄窗：长回复换行；棕色为原有定位高亮',
  '13-expanded-return': '展开长消息，滚走后返回：展开状态保留',
  '14-dark-bottom': '深色：回到底部，显示最新消息',
  '15-follow-new-message': '深色：新消息到达，继续贴底',
};
const cards = [];
for (const [name, caption] of Object.entries(captions)) {
  const step = report.visual.steps.find(step => step.name === name);
  const png = await fs.readFile(path.join(root, `${name}.png`));
  cards.push(`<figure><figcaption>${escape(caption)}<small>正文挂载 ${step.mounted} 条；可见占位 ${step.visible.filter(row => row.placeholder).length} 条；行重叠 ${step.overlaps}</small></figcaption><img src="data:image/png;base64,${png.toString('base64')}" alt="${escape(caption)}"></figure>`);
}
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>#5406 视口挂载截图验收</title>
<style>body{font:16px/1.65 system-ui,sans-serif;max-width:1000px;margin:auto;padding:20px;background:#f3f4f6;color:#17202a}h1{font-size:24px}p{max-width:760px}figure{margin:24px 0;background:white;border:1px solid #ddd;border-radius:12px;overflow:hidden}figcaption{padding:16px;font-weight:600}small{display:block;font-weight:400;color:#525b65}img{width:100%;height:auto;display:block}code{overflow-wrap:anywhere}li{margin:8px 0}</style>
<h1>#5406 视口挂载截图验收</h1><p>这是 Windows Electron 中运行真实 MessageStream、UserMessage、AssistantMessage 和正式样式后直接截取的画面。消息内容为合成测试数据，未连接账号或后端；不代表完整安装版客户端验收。</p>
<p>自动布局检查：${report.visual.failures.length ? escape(report.visual.failures.join('；')) : '全部通过'}。覆盖快速滚动、正文增高、图片加载、搜索定位、窄窗、浅深色、重挂载、阅读时新增消息、展开状态保留、回底跟随和键盘选择。</p>
<p>正常浏览只挂载视口附近正文。工具卡、正在输出及已交互的消息保留；分享或键盘全选时恢复逻辑窗口内全部正文。下列截图原样嵌入，可放大查看；未进行图像编辑。</p>${cards.join('')}
<p>截图来源：<code>${escape(root)}</code>。原始断言与逐行坐标保存在同目录 visual-steps.json。</p></html>`;
await fs.writeFile(path.join(root, 'visual-report.html'), html);
console.log(path.join(root, 'visual-report.html'));
