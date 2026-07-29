/**
 * 从 truth.json 生成手机登录页三方对比高保真图(main / 本 PR / figma 新稿配套)。
 * 坐标 = 750 stage 设计 px,统一 ×0.5 显示;资产走真图 + contain(与
 * MobileLoginHandoffStage 的 resizeMode="contain" 同口径);深色底 #1F1F1E、
 * 面板 #FBFBFB(DESIGN.md §16 新稿帧底与面板色)。
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
  return `<div class="rowwrap"><h2>${title}（stage 750×${T.current[key].designHeight}）</h2><div class="row">
  ${variants.map(([cap, v, ly, gp, flag]) => stageHtml(v, key, ly(key), gp(key), cap, flag)).join('')}
  </div></div>`;
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
  .cap.ok{color:#8BC98B}
  .cap.ref{color:#7FB0E8}
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
  .gapzone.ok,.gapzone.ref{background:rgba(255,255,255,.10);border-top:1px dashed rgba(255,255,255,.35);border-bottom:1px dashed rgba(255,255,255,.35)}
  .gapzone.ok span,.gapzone.ref span{color:#E6E6E6;background:rgba(0,0,0,.55);padding:0 5px;border-radius:3px;font-size:9.5px}
</style></head><body>
<h1>手机登录页：字标底 → 登录面板顶 的间距（主干现状 vs 本 PR 修复）</h1>
<div class="lead">两列几何都从 <code>apps/mobile/src/auth/loginSkinLayout.ts</code> 真值渲染：① 取 <code>git show origin/main</code> 的同一文件，② 取本分支工作树。资产为仓库真图、<code>contain</code> 适配同 <code>MobileLoginHandoffStage</code> 的 <code>resizeMode</code>。<b>红斜纹 = 多出来的空白</b>；✓稿 = 与 figma 新稿标注一致。
<br><b>① 就是当前主干的实际状态</b>（PR #697 已于 2026-07-29 合并）：品牌簇已换 figma 新稿基准（<code>705:915</code> / <code>705:799</code>），但功能区落位 <code>loginY</code> 仍是配旧品牌簇的 694 / 933，两半拼接使字标底↔面板顶空出 <b>92 / 131.65 设计px</b>（实机 ≈38pt / 57pt）—— 该值在 main 改版前（18.98 / 22）和新稿（20 / 25.65）里都不存在。
<br>② 本 PR 把 <code>loginY</code> 取回新稿标注值 <b>622 / 827</b>，间距回到稿内的 20 / 25.65。底部留白 90 / 175 比稿内的 30 / 115 各多 60（新稿手机帧面板 500 高含「跳过登录」栏，手机端已剥离该入口、面板回 440，少掉的 60 落到底部）—— 审图拍板「方案 B」，已在 <code>DESIGN.md §16.2</code> 就地记录。</div>
${row('short', '短屏 iPhone 750×1334')}
${row('long', '长屏 iPhone 750×1624')}
</body></html>`;

writeFileSync(path.join(REPO, DEMO, 'index.html'), html, 'utf8');
console.log('written');
