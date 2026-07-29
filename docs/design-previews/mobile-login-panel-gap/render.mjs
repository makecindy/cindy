/**
 * 从 truth.json 生成手机登录页「字标底↔面板顶」间距的**两列**对照图:
 * ① origin/main 现状(已含 #697,有问题) vs ② 本 PR 修复后。figma 稿值不单独成列,
 * 只作为 ✓稿 判定的参照(truth.json 的 figmaGap / figBottomGap)。
 * 坐标 = 750 stage 设计 px,统一按 S 缩放显示;资产走真图 + contain(与
 * MobileLoginHandoffStage 的 resizeMode="contain" 同口径);深色底 #1F1F1E、
 * 面板 #FBFBFB(DESIGN.md §16 新稿帧底与面板色)。
 *
 * 页面三块(全部由 truth.json 驱动,无手抄数字):
 *  ① 两档基准屏并排对照(核心:红斜纹 = 主干多出的空白);
 *  ② 全形态覆盖矩阵(12 种真机形态,标出"已修 / 未变自洽 / 既有问题");
 *  ③ 窄屏落位公式曲线(main dh-640 / 被否 dh-712 / 采纳钳制式 vs 被压缩的字标底)。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const REPO = process.argv[2];
const DEMO = 'docs/design-previews/mobile-login-panel-gap';
const T = JSON.parse(readFileSync(path.join(REPO, DEMO, 'truth.json'), 'utf8'));
const A = (f) => `./assets/${f}`; // demo 自包含(assets/ 为 apps/mobile/assets/login 的 @2x 副本)
const S = 0.62; // 显示缩放(两列并排)
const px = (v) => `${v * S}px`;

const P = T.panel;

/** 一块面板(680×560 设计系)的内部结构,按真值绝对定位。 */
function panelHtml() {
  return `
  <div class="panel" style="left:${px(P.group.x)};width:${px(P.group.width)};height:${px(440)}">
    <div class="p-title" style="top:${px(P.title.y)};height:${px(P.title.height)};font-size:${px(P.title.font)}">登录 Cindy</div>
    <div class="p-sub" style="left:${px(P.subtitle.x)};top:${px(P.subtitle.y)};width:${px(P.subtitle.width)};font-size:${px(P.subtitle.font)};line-height:${px(P.subtitle.height)}">使用手机号登录</div>
    <div class="p-input" style="left:${px(P.control.x)};top:${px(P.control.inputY)};width:${px(P.control.width)};height:${px(P.control.height)};border-radius:${px(P.control.radius)};font-size:${px(P.control.font)};padding-left:${px(P.control.textPadLeft)}">请输入手机号</div>
    <div class="p-btn" style="left:${px(P.control.x)};top:${px(P.control.buttonY)};width:${px(P.control.width)};height:${px(P.control.height)};border-radius:${px(P.control.radius)};font-size:${px(P.control.font)}">继续</div>
  </div>`;
}

/** 圆钮行 + 协议行(在 Log_in 组坐标系内,组顶 = loginY)。 */
function belowPanelHtml() {
  const n = 3, size = P.social.size, gap = P.social.gap;
  const totalW = n * size + (n - 1) * gap;
  const startX = P.group.x + (P.group.width - totalW) / 2;
  const dots = Array.from({ length: n }, (_, i) =>
    `<div class="social" style="left:${px(startX + i * (size + gap))};top:${px(P.social.y)};width:${px(size)};height:${px(size)}"></div>`).join('');
  return dots + `<div class="consent" style="left:${px(P.group.x)};top:${px(P.consent.y)};width:${px(P.group.width)};height:${px(P.consent.height)};font-size:${px(P.consent.font)}"><span class="radio"></span>已阅读并同意《用户协议》《隐私政策》</div>`;
}

function stageHtml(v, key, loginY, gap, caption, flag) {
  const s = v[key];
  const dh = s.designHeight;
  const wordBottom = s.wordBottom;
  const bottomGap = Number((dh - (loginY + T.contentBelowLoginY)).toFixed(2));
  const figBottom = T.figBottomGap[key];
  const bottomOk = Math.abs(bottomGap - figBottom) < 0.5;
  const gapOk = Math.abs(gap - T.figmaGap[key]) < 0.5;
  return `
  <div class="col">
    <div class="cap ${flag}">${caption}</div>
    <div class="metrics">
      <span class="m ${gapOk ? 'good' : 'warn'}">字标↔面板 ${gap}${gapOk ? ' ✓稿' : ''}</span>
      <span class="m ${bottomOk ? 'good' : 'warn'}">底部留白 ${bottomGap}${bottomOk ? ' ✓稿' : ''}</span>
      <span class="m">立绘顶 ${s.cindy.y}</span>
    </div>
    <div class="stage" style="width:${px(750)};height:${px(dh)}">
      <img class="hero" src="${A('hero.png')}" style="left:${px(s.cindy.x)};top:${px(s.cindy.y)};width:${px(s.cindy.w)};height:${px(s.cindy.h)}">
      <img class="asset" src="${A('slogan-dark.png')}" style="left:${px(s.slogan.x)};top:${px(s.slogan.y)};width:${px(s.slogan.w)};height:${px(s.slogan.h)}">
      <img class="asset" src="${A('wordmark-dark.png')}" style="left:${px(s.word.x)};top:${px(s.word.y)};width:${px(s.word.w)};height:${px(s.word.h)}">
      <div class="gapzone ${flag}" style="left:0;top:${px(wordBottom)};width:${px(750)};height:${px(gap)}">
        <span>${gap}</span>
      </div>
      <div class="group" style="top:${px(loginY)};height:${px(P.group.height)}">
        ${panelHtml()}
        ${belowPanelHtml()}
      </div>
      <div class="botzone ${bottomOk ? 'ok' : 'warn'}" style="top:${px(loginY + T.contentBelowLoginY)};height:${px(bottomGap)}"><span>底 ${bottomGap}</span></div>
    </div>
  </div>`;
}

const variants = [
  ['① origin/main 现状（有问题）', T.main, (k) => T.main[k].loginY, (k) => T.main[k].gap, 'bad'],
  ['② 本 PR 修复后', T.current, (k) => T.current[k].loginY, (k) => T.current[k].gap, 'pick'],
];

function row(key, title) {
  return `<div class="rowwrap"><h2>① 基准屏对照 · ${title}（stage 750×${T.current[key].designHeight}）</h2><div class="row">
  ${variants.map(([cap, v, ly, gp, flag]) => stageHtml(v, key, ly(key), gp(key), cap, flag)).join('')}
  </div></div>`;
}

/** ② 全形态覆盖矩阵:12 种形态的 main vs 本 PR 间距,含状态判定。 */
function surfaceMatrix() {
  const rows = T.surfaces.map((s) => {
    const overlap = s.current.gap < 0;
    const state = s.changed
      ? ['fixed', '已修']
      : overlap
        ? ['preexist', '既有问题（main 同值）']
        : ['intact', '未变 · 自洽'];
    const modeLabel = { phone: 'phone', 'pad-portrait': 'pad 竖', 'pad-landscape': 'pad 横' }[s.mode];
    return `<tr class="${state[0]}">
      <td>${s.name}<span class="dim"> ${s.w}×${s.h}</span></td>
      <td class="mono">${modeLabel}</td>
      <td class="mono num">${s.main.gap}</td>
      <td class="mono num">${s.current.gap}</td>
      <td class="st">${state[1]}</td>
    </tr>`;
  }).join('');
  return `<div class="rowwrap">
    <h2>② 全形态覆盖矩阵（12 种形态，<code>resolveLoginSurface()</code> 实算）</h2>
    <div class="note">「字标底 → 面板顶」间距（设计px）。<b>已修</b> = 本 PR 改变了该形态的间距；
      <b>未变 · 自洽</b> = 两版同值且为健康正间距（pad 两档品牌簇未换稿、与自己的 loginY 同源；
      窄屏压缩段沿用 main 的紧凑底距）；<b>既有问题</b> = 负间距（面板盖住字标）且 main 逐值相同，
      非本 PR 引入，属「功能区优先」在极扁视口下的既定结果。</div>
    <table class="matrix">
      <thead><tr><th>形态</th><th>mode</th><th>main 间距</th><th>本 PR 间距</th><th>状态</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

/** ③ 窄屏分支(dh<1334)三种落位公式 vs 被压缩字标底的折线图(纯静态 SVG,无动画)。 */
function narrowChart() {
  const sm = T.narrowBranch.samples;
  const W = 760, H = 320, PL = 52, PR2 = 16, PT = 20, PB = 48;
  const x0 = sm[0].dh, x1 = sm[sm.length - 1].dh;
  // y 上限由数据决定,不写死 —— main 的 dh-640 在 dh=1334 处到 694,写死 640 会把它裁出图外
  const yMax = Math.ceil(Math.max(...sm.flatMap((d) => [d.wordBottom, d.main640, d.rejected712, d.adopted])) / 20) * 20 + 20;
  const sx = (dh) => PL + ((dh - x0) / (x1 - x0)) * (W - PL - PR2);
  const sy = (v) => PT + (1 - v / yMax) * (H - PT - PB);
  const line = (key) => sm.map((d, i) => `${i ? 'L' : 'M'}${sx(d.dh).toFixed(1)},${sy(d[key]).toFixed(1)}`).join('');
  // 被否公式压盖字标的区间(rejected712 < wordBottom)
  const bad = sm.filter((d) => d.rejected712 < d.wordBottom);
  const badFrom = bad.length ? bad[0].dh : null;
  const badTo = bad.length ? bad[bad.length - 1].dh : null;
  const xTicks = [600, 712, 822, 1000, 1334];
  const yTicks = [0, 200, 400, T.narrowBranch.clampTo]; // 622 比 600 更有意义,不并列避免标签压叠
  // 钳制生效点:adopted 首次触达上限的 dh(不写死 1262,由数据自己找)
  const clampAt = (sm.find((d) => d.adopted >= T.narrowBranch.clampTo) || {}).dh ?? null;
  return `<div class="rowwrap">
    <h2>③ 窄屏分支 <code>dh&lt;1334</code>：三种落位公式 vs 被压缩后的字标底</h2>
    <div class="note">纵轴 = stage 设计px，横轴 = <code>designHeight</code>。
      <b>面板顶（loginY）落到字标底之下即发生遮挡</b>（不透明面板盖住字标）。
      被否的 <code>dh-712</code>（红）在 <b>dh∈[${badFrom},${badTo}]</b> 全段位于字标底之下 ——
      这正是评审实算否掉它的依据（dh=1000 处压 40 设计px）；采纳的钳制式（黄虚线）与 main 的
      <code>dh-640</code>（蓝）在 dh&lt;${clampAt ?? '—'} <b>完全重合</b>（窄屏行为与 main 逐值一致），
      自 dh=${clampAt ?? '—'} 起钳在 ${T.narrowBranch.clampTo} 不再上移，并在 dh→1334⁻ 与短屏档连续。
      左端 <code>dh&lt;822</code> 处字标底高于三条落位线 = 字标本就与面板交叠（main 既有行为，本 PR 未恶化）。</div>
    <svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img"
      aria-label="窄屏分支三种落位公式与字标底的对比折线图">
      ${badFrom !== null ? `<rect x="${sx(badFrom).toFixed(1)}" y="${PT}" width="${(sx(badTo) - sx(badFrom)).toFixed(1)}" height="${H - PT - PB}" class="band"/>` : ''}
      ${yTicks.map((v) => `<line x1="${PL}" x2="${W - PR2}" y1="${sy(v).toFixed(1)}" y2="${sy(v).toFixed(1)}" class="grid"/><text x="${PL - 8}" y="${(sy(v) + 3.5).toFixed(1)}" class="ax ar">${v}</text>`).join('')}
      ${xTicks.map((v) => `<line y1="${PT}" y2="${H - PB}" x1="${sx(v).toFixed(1)}" x2="${sx(v).toFixed(1)}" class="grid"/><text y="${H - PB + 15}" x="${sx(v).toFixed(1)}" class="ax mid">${v}</text>`).join('')}
      <line x1="${PL}" x2="${W - PR2}" y1="${sy(T.narrowBranch.clampTo).toFixed(1)}" y2="${sy(T.narrowBranch.clampTo).toFixed(1)}" class="ref"/>
      <text x="${PL + 6}" y="${(sy(T.narrowBranch.clampTo) - 5).toFixed(1)}" class="ax lab">钳制上限 ${T.narrowBranch.clampTo}（= 短屏档 loginY）</text>
      ${clampAt !== null ? `<line x1="${sx(clampAt).toFixed(1)}" x2="${sx(clampAt).toFixed(1)}" y1="${PT}" y2="${H - PB}" class="ref"/><text x="${(sx(clampAt) - 6).toFixed(1)}" y="${PT + 12}" class="ax ar lab">dh=${clampAt} 起钳制生效</text>` : ''}
      <path d="${line('wordBottom')}" class="c-word"/>
      <path d="${line('rejected712')}" class="c-rej"/>
      <path d="${line('main640')}" class="c-main"/>
      <path d="${line('adopted')}" class="c-adopt"/>
      <text x="${(PL + (W - PL - PR2) / 2).toFixed(1)}" y="${H - 4}" class="ax mid dim2">designHeight（设计px）</text>
    </svg>
    <div class="legend">
      <span><i class="k-word"></i>字标底（被 v 压缩后）</span>
      <span><i class="k-rej"></i>被否 <code>dh-712</code></span>
      <span><i class="k-main"></i>main <code>dh-640</code></span>
      <span><i class="k-adopt"></i>本 PR 钳制式（与 main 重合至 dh=${clampAt ?? '—'}）</span>
      <span><i class="k-band"></i><code>dh-712</code> 压盖字标区</span>
    </div>
  </div>`;
}

const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#141414;color:#EDEDED;font:14px/1.5 -apple-system,"PingFang SC",sans-serif;padding:28px 24px 36px}
  h1{font-size:22px;margin-bottom:4px}
  .lead{color:#9A9A9A;font-size:13px;margin-bottom:22px}
  .lead b{color:#FF8A80}
  h2{font-size:15px;color:#C9C9C9;margin:22px 0 10px;font-weight:600}
  .row{display:flex;gap:20px}
  .col{flex:0 0 auto}
  .cap{font-size:12.5px;margin-bottom:7px;display:flex;align-items:center;gap:8px;color:#B9B9B9}
  .cap.bad{color:#FF6F60;font-weight:700}
  .cap.pick{color:#F3C969;font-weight:700}
  .metrics{display:flex;gap:5px;margin-bottom:7px;flex-wrap:wrap}
  .m{font-family:ui-monospace,Menlo,monospace;font-size:10px;padding:1px 5px;border-radius:3px;background:#242424;color:#B5B5B5}
  .m.good{background:#1E3A22;color:#9FE0A6}
  .m.warn{background:#4A2A1A;color:#FFC79A}
  .botzone{position:absolute;left:0;width:100%;display:flex;align-items:center;justify-content:center}
  .botzone.ok{background:rgba(120,220,140,.10);border-top:1px dashed rgba(150,230,170,.45)}
  .botzone.warn{background:repeating-linear-gradient(45deg,rgba(255,170,60,.20),rgba(255,170,60,.20) 7px,rgba(255,170,60,.08) 7px,rgba(255,170,60,.08) 14px);border-top:1px dashed #FFAA3C}
  .botzone span{font-family:ui-monospace,Menlo,monospace;font-size:9.5px;color:#E9E9E9;background:rgba(0,0,0,.55);padding:0 5px;border-radius:3px}
  .stage{position:relative;background:#1F1F1E;overflow:hidden;border-radius:10px;outline:1px solid #333}
  .stage img,.stage .group,.stage .gapzone{position:absolute}
  .asset,.hero{object-fit:contain}
  .group{left:0;width:100%}
  .panel{position:absolute;top:0;background:#FBFBFB;border-radius:18px;box-shadow:inset 0 0 0 1px rgba(0,0,0,.06)}
  .panel>div{position:absolute;color:#1A1A1A}
  .p-title{left:0;width:100%;text-align:center;font-weight:700}
  .p-sub{color:#6F6F6F}
  .p-input{background:#EFEFEF;color:#9A9A9A;display:flex;align-items:center}
  .p-btn{background:#1F1F1E;color:#FBFBFB;display:flex;align-items:center;justify-content:center;font-weight:600}
  .social{position:absolute;border-radius:50%;background:#FBFBFB;opacity:.92}
  .consent{position:absolute;display:flex;align-items:center;justify-content:center;gap:5px;color:#CFCFCF;font-size:10px}
  .radio{width:9px;height:9px;border-radius:50%;border:1.2px solid #CFCFCF;display:inline-block}
  .gapzone{display:flex;align-items:center;justify-content:center;font-family:ui-monospace,Menlo,monospace;font-size:11px}
  .gapzone.bad{background:repeating-linear-gradient(45deg,rgba(255,80,60,.30),rgba(255,80,60,.30) 7px,rgba(255,80,60,.13) 7px,rgba(255,80,60,.13) 14px);border-top:1px dashed #FF6F60;border-bottom:1px dashed #FF6F60}
  .gapzone.bad span{color:#FFD9D2;background:rgba(120,25,15,.85);padding:1px 7px;border-radius:4px}
  .note{color:#9A9A9A;font-size:12px;line-height:1.65;margin:0 0 12px;max-width:1020px}
  .note b{color:#DADADA}
  .matrix{border-collapse:collapse;font-size:12.5px}
  .matrix th,.matrix td{border:1px solid #2E2E2E;padding:5px 11px;text-align:left}
  .matrix th{background:#1E1E1E;color:#B9B9B9;font-weight:600}
  .matrix td{color:#D6D6D6}
  .matrix .num{text-align:right;font-variant-numeric:tabular-nums}
  .matrix .dim{color:#7A7A7A;font-size:11px}
  .matrix .st{font-weight:600}
  .matrix tr.fixed .st{color:#F3C969}
  .matrix tr.fixed td:nth-child(4){color:#9FE0A6;font-weight:700}
  .matrix tr.fixed td:nth-child(3){color:#FF8A7A}
  .matrix tr.intact .st{color:#8FBF95}
  .matrix tr.preexist .st{color:#FFAA6A}
  .matrix tr.preexist td:nth-child(3),.matrix tr.preexist td:nth-child(4){color:#FFC79A}
  .mono{font-family:ui-monospace,Menlo,monospace}
  .chart{display:block;background:#161616;border:1px solid #2A2A2A;border-radius:8px}
  .chart .grid{stroke:#2A2A2A;stroke-width:1}
  .chart .ax{fill:#7E7E7E;font-size:10px;font-family:ui-monospace,Menlo,monospace}
  .chart .ar{text-anchor:end}.chart .mid{text-anchor:middle}.chart .end{text-anchor:end}
  .chart .band{fill:rgba(255,80,60,.11)}
  .chart .ref{stroke:#6E6E6E;stroke-width:1;stroke-dasharray:3 3}
  .chart .lab{fill:#9C9C9C;font-size:9.5px}
  .chart .dim2{fill:#6E6E6E}
  .chart path{fill:none;stroke-width:2}
  .chart .c-word{stroke:#E8E8E8;stroke-dasharray:5 3}
  .chart .c-rej{stroke:#FF6F60}
  .chart .c-main{stroke:#6C8FC7;stroke-width:3;opacity:.75}
  .chart .c-adopt{stroke:#F3C969;stroke-dasharray:7 4}
  .legend{display:flex;gap:16px;flex-wrap:wrap;margin-top:9px;font-size:11.5px;color:#A8A8A8}
  .legend i{display:inline-block;width:16px;height:3px;margin-right:6px;vertical-align:middle;border-radius:2px}
  .legend .k-word{background:#E8E8E8}.legend .k-rej{background:#FF6F60}
  .legend .k-main{background:#6C8FC7}.legend .k-adopt{background:#F3C969}
  .legend .k-band{background:rgba(255,80,60,.35);height:11px;border-radius:2px}
  .gapzone.pick{background:rgba(120,220,140,.16);border-top:1px dashed rgba(150,230,170,.55);border-bottom:1px dashed rgba(150,230,170,.55)}
  .gapzone.pick span{color:#DFF5E4;background:rgba(20,70,35,.85);padding:1px 7px;border-radius:4px;font-size:10px}
</style></head><body>
<h1>手机登录页：字标底 → 登录面板顶 的间距（主干现状 vs 本 PR 修复）</h1>
<div class="lead">两列几何都从 <code>apps/mobile/src/auth/loginSkinLayout.ts</code> 真值渲染：① 取 <code>git show origin/main</code> 的同一文件，② 取本分支工作树。资产为仓库真图、<code>contain</code> 适配同 <code>MobileLoginHandoffStage</code> 的 <code>resizeMode</code>。<b>红斜纹 = 多出来的空白</b>；✓稿 = 与 figma 新稿标注一致。
<br><b>① 就是当前主干的实际状态</b>（PR #697 已于 2026-07-29 合并）：品牌簇已换 figma 新稿基准（<code>705:915</code> / <code>705:799</code>），但功能区落位 <code>loginY</code> 仍是配旧品牌簇的 694 / 933，两半拼接使字标底↔面板顶空出 <b>92 / 131.65 设计px</b>（实机 ≈38pt / 57pt）—— 该值在 main 改版前（18.98 / 22）和新稿（20 / 25.65）里都不存在。
<br>② 本 PR 把 <code>loginY</code> 取回新稿标注值 <b>622 / 827</b>，间距回到稿内的 20 / 25.65。底部留白 90 / 175 比稿内的 30 / 115 各多 60（新稿手机帧面板 500 高含「跳过登录」栏，手机端已剥离该入口、面板回 440，少掉的 60 落到底部）—— 审图拍板「方案 B」，已在 <code>DESIGN.md §16.2</code> 就地记录。</div>
${row('short', '短屏 iPhone 750×1334')}
${row('long', '长屏 iPhone 750×1624')}
${surfaceMatrix()}
${narrowChart()}
</body></html>`;

writeFileSync(path.join(REPO, DEMO, 'index.html'), html, 'utf8');
console.log('written');
