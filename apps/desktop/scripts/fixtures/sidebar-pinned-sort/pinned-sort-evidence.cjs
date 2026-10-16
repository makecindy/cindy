// Optional, self-contained review surface around the unchanged interaction fixture.
const fs = require('node:fs');
const path = require('node:path');

function evidenceHtml(css, extraCss, javascript) {
  // Bundle the stylesheet's optional punctuation fonts as well as its JS/CSS so
  // opening the downloaded file never requires a server or dependency checkout.
  const standaloneCss = css.replace(
    /url\(['"]\.\.\/[^'"]*node_modules\/([^'"]+\.woff2)['"]\)/g,
    (_, modulePath) => {
      const fontPath = require.resolve
        .paths(modulePath)
        .map((directory) => path.join(directory, modulePath))
        .find((candidate) => fs.existsSync(candidate));
      if (!fontPath) throw new Error(`Missing stylesheet font: ${modulePath}`);
      return `url('data:font/woff2;base64,${fs.readFileSync(fontPath).toString('base64')}')`;
    },
  );
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:">
<title>置顶项目排序 · 组件交互证据</title>
<style>${standaloneCss}${extraCss}
.evidence-header{max-width:900px;margin-bottom:24px}
.evidence-header h1{font-size:24px;line-height:32px;font-weight:600;margin:0 0 8px}
.evidence-header p{font-size:14px;line-height:22px;margin:4px 0;color:var(--text-secondary)}
.evidence-controls{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin:16px 0}
.evidence-controls label{display:flex;align-items:center;gap:6px;font-size:14px}
.evidence-controls select,.evidence-controls button{background:var(--surface-elevated);color:var(--text-primary);border:1px solid var(--border-default);border-radius:9999px;padding:4px 12px;min-height:32px}
.evidence-controls :focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}
.evidence-controls button:hover{background:var(--surface-hover)}
body{overflow:auto}.fixture-list{margin-top:8px}
.fixture-header{flex-wrap:wrap}.fixture-header span{flex:1 1 100%}
.fixture-header input{width:64px;min-width:0;background:transparent}
#external{top:300px;padding:16px;border:1px dashed var(--border-default);border-radius:12px;color:var(--text-secondary)}
output[data-testid="order"]{display:block;font-size:14px;color:var(--text-secondary)}
output[data-testid="order"]::before{content:"当前回调顺序： "}
#ordinary-image{display:none}
</style></head><body>
<header class="evidence-header">
<h1>置顶项目排序 · 组件交互证据</h1>
<p>生产 SortableList / CardMasonry 与生产 CSS；项目内容和操作按钮为合成数据。此页不是完整 Electron 应用。</p>
<p>拖动 project-a / b / c 标题改变顺序；拖动中按 Escape 或放到右侧区域可检查恢复。排序仅保留在本页内存中。</p>
<form class="evidence-controls" method="get">
<label>主题 <select name="theme"><option value="light">Light · 浅色</option><option value="dark">Dark · 深色</option></select></label>
<label>容器 <select name="mode"><option value="text">Text · 文字</option><option value="list">List · 列表</option><option value="card">Card · 卡片</option></select></label>
<label>卡片列数 <select name="columns"><option>1</option><option>2</option><option>3</option></select></label>
<label><input type="checkbox" name="mixed">混合置顶任务</label>
<button type="submit">应用并重置</button>
</form>
<p>文字和列表都复用同一个 SortableList；此页不模拟完整项目外观、持久化、本地／远端设备或运行中任务。</p>
</header><main id="root"></main>
<script>
const evidenceParams = new URLSearchParams(location.search);
for (const name of ['theme', 'mode', 'columns']) {
  const control = document.querySelector('[name="' + name + '"]');
  if (evidenceParams.has(name)) control.value = evidenceParams.get(name);
}
document.querySelector('[name="mixed"]').checked = evidenceParams.has('mixed');
${javascript.replace(/<\/script/gi, '<\\/script')}
</script></body></html>`;
}

module.exports = { evidenceHtml };
