#!/usr/bin/env node
// interaction-gate.mjs — 自定义交互门(门 A-F 之外的交互断言):
//  1. dismiss:completed 态点「我知道了」气泡从 DOM 消失(四端)
//  2. 浮层覆盖:elementFromPoint(气泡中心)命中气泡(四端×双模式)
//  3. 不推挤:面板示意 rect 在气泡消失前后逐 px 不变
//  4. 间距:正文↔我知道了 = 22、我知道了↔气泡底 = 20(completed + 长文案压力态,底距恒定)
//  5. 桌面 clamp:宽度 @800=670 / @717=669 / @600=552,top 恒 72
//  6. 压力态:气泡撑高 > completed、间距仍 22/20、copy 居中(text-align)
//  7. 热区:dismiss 命中区 ≥44×44(desk py 扩张 45)
//  8. 多语言:共享 SUPPORTED_LOCALES 的每个语言在 desk/phone、light/dark、三态均
//     有文案、可换行且不裁切;completed 底距仍满足产品几何。
// 用法:node interaction-gate.mjs(在 demo 目录)。exit 2 = FAIL。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

// Playwright 解析(可移植,不含任何本机绝对路径):
//  1) 正常 Node resolution(createRequire,沿 demo 目录向上找 node_modules)
//  2) 仓库根 node_modules(demo 目录向上三级 ../../..)
//  3) QA_HIFI_MODULE_ROOT 环境变量显式指定(兜底;skill 标准入口)
const demoDir = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(join(demoDir, 'noop.js'));
const candidates = [
  () => require_('playwright'),
  () => require_(join(demoDir, '..', '..', '..', 'node_modules', 'playwright')),
];
if (process.env.QA_HIFI_MODULE_ROOT) {
  candidates.push(() => require_(join(process.env.QA_HIFI_MODULE_ROOT, 'node_modules', 'playwright')));
  candidates.push(() => require_(join(process.env.QA_HIFI_MODULE_ROOT, 'playwright')));
}
let chromium;
for (const load of candidates) {
  try { ({ chromium } = load()); break; } catch {}
}
if (!chromium) {
  console.error('playwright 未解析到(尝试过: node resolution / 仓库根 node_modules / QA_HIFI_MODULE_ROOT)');
  process.exit(2);
}

const PLATS = ['desk', 'phone', 'pad-landscape', 'pad-portrait'];

// 期望值一律「设计单位 × 该端 scale」现算(2026-07-26 比例修正:几何是设计单位,
// 与登录组同缩放;旧版把设计单位当物理 px 写死,所以这里不留任何物理常量)。
const TRUTH = JSON.parse(readFileSync(join(demoDir, 'truth.json'), 'utf8'));
const tv = (o) => (o && typeof o === 'object' && 'value' in o ? o.value : o);
const SUPPORTED_LOCALES = (TRUTH.supportedLocales ?? []).map(tv);
if (!SUPPORTED_LOCALES.length) throw new Error('truth.supportedLocales 为空');
const DESK_G = Object.fromEntries(Object.entries(TRUTH.desktop.geometry).map(([k, v]) => [k, tv(v)]));
const MOB_G = Object.fromEntries(Object.entries(TRUTH.mobile.geometry).map(([k, v]) => [k, tv(v)]));
const MOB_S = Object.fromEntries(Object.entries(TRUTH.mobile.surface).map(([k, v]) => [k, tv(v)]));
const deskK = DESK_G.scale;
const phoneK = (w) => w / MOB_S.phoneStageWidth;
const results = [];
let failures = 0;
const check = (id, ok, detail) => {
  results.push({ id, pass: ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}${detail ? '  ' + detail : ''}`);
};

// 收尾落盘抽成函数 + 顶层异常兜底(Copilot 审查):任一 page.evaluate 里的 selector
// 缺失都会抛异常,若直接崩掉就既没有结构化 FAIL、也不落 evidence,排查无从下手。
// 这里把「记一条 harness 失败 + 照常落盘 + exit 2」做成兜底,覆盖全部取元素点位。
let evidenceWritten = false;
function writeEvidence() {
  if (evidenceWritten) return;
  evidenceWritten = true;
  const evidenceDir = join(demoDir, 'evidence');
  if (!existsSync(evidenceDir)) mkdirSync(evidenceDir, { recursive: true });
  const out = {
    gate: 'interaction',
    pass: failures === 0,
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    failures,
    generatedAt: new Date().toISOString(),
    results,
  };
  writeFileSync(join(evidenceDir, 'interaction-gate.json'), JSON.stringify(out, null, 1) + '\n');
  console.log(`\n交互门: ${out.passed}/${out.total} pass,evidence → evidence/interaction-gate.json`);
}
function bail(err) {
  check('harness', false, `门执行中断:${err && err.message ? err.message : String(err)}(DOM 结构变了?selector 未命中?)`);
  writeEvidence();
  process.exit(2);
}
process.on('uncaughtException', bail);
process.on('unhandledRejection', bail);

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 960 } })).newPage();
const base = pathToFileURL(join(demoDir, 'index.html')).href;

async function gotoCase(plat, mode = 'light', lang = 'zh-CN', state = 'deletion-completed') {
  await page.goto(base);
  await page.waitForFunction(() => window.__qa && window.__qa.current() != null, null, { timeout: 8000 });
  await page.evaluate(() => localStorage.clear());
  for (const [k, v] of [['plat', plat], ['mode', mode], ['lang', lang]]) {
    const el = await page.$(`[data-qa-pref="${k}:${v}"]`);
    if (!el) throw new Error(`缺少偏好按钮 ${k}:${v}`);
    await el.click();
  }
  await page.click(`[data-qa-state-btn="${state}"]`);
  await page.waitForFunction((id) => window.__qa.current() === id, state, { timeout: 5000 });
}

// 1+2+3:dismiss / 浮层覆盖 / 不推挤(四端)
for (const plat of PLATS) {
  await gotoCase(plat);
  const m = await page.evaluate(() => {
    const frame = document.getElementById('frame');
    const bubble = frame.querySelector('.db-bubble');
    const br = bubble.getBoundingClientRect();
    const hit = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2);
    const panel = frame.querySelector('.prop-panel');
    const pr = panel ? panel.getBoundingClientRect() : null;
    return {
      hitIsBubble: hit === bubble || bubble.contains(hit),
      panelRect: pr ? { x: pr.x, y: pr.y, w: pr.width, h: pr.height } : null,
    };
  });
  check(`overlay:${plat}`, m.hitIsBubble, 'elementFromPoint(气泡中心)命中气泡');
  await page.click('.db-dismiss');
  await page.waitForTimeout(250);
  const after = await page.evaluate(() => {
    const frame = document.getElementById('frame');
    const gone = !frame.querySelector('.db-bubble');
    const panel = frame.querySelector('.prop-panel');
    const pr = panel ? panel.getBoundingClientRect() : null;
    return { gone, panelRect: pr ? { x: pr.x, y: pr.y, w: pr.width, h: pr.height } : null };
  });
  check(`dismiss:${plat}`, after.gone, '点击「我知道了」气泡消失');
  const sameRect = JSON.stringify(m.panelRect) === JSON.stringify(after.panelRect);
  check(`no-push:${plat}`, sameRect, '气泡消失后面板示意 rect 逐 px 不变(不占布局流)');
}

// 4+6+7:间距 / 压力态 / 热区(desk + phone,completed + stress)
for (const plat of ['desk', 'phone']) {
  for (const state of ['deletion-completed', 'deletion-stress']) {
    await gotoCase(plat, 'light', 'zh-CN', state);
    const g = await page.evaluate(() => {
      const bubble = document.querySelector('.db-bubble');
      const br = bubble.getBoundingClientRect();
      const copyR = bubble.querySelector('.db-copy').getBoundingClientRect();
      const dismiss = bubble.querySelector('.db-dismiss');
      const dr = (dismiss.querySelector('.db-dismiss-text') ?? dismiss).getBoundingClientRect();
      const btnR = dismiss.getBoundingClientRect();
      const align = getComputedStyle(bubble.querySelector('.db-copy')).textAlign;
      return {
        bubbleH: br.height,
        gapLink: dr.top - copyR.bottom,
        gapBottom: br.bottom - 1 - dr.bottom,
        hitW: btnR.width,
        hitH: btnR.height,
        align,
      };
    });
    const tag = `${plat}:${state.replace('deletion-', '')}`;
    // 该端 设计→物理 系数:desk 恒 PANEL_FIXED_SCALE;phone 随帧宽
    const k = plat === 'desk' ? deskK : phoneK(await page.evaluate(() => window.__qa.metrics([]).frame.w));
    const G = plat === 'desk' ? DESK_G : MOB_G;
    const wantLink = G.bodyLinkGap * k;
    const wantBottom = G.padding * k;
    check(
      `gap-link:${tag}`,
      Math.abs(g.gapLink - wantLink) <= 1,
      `正文↔我知道了=${g.gapLink.toFixed(1)}(期望 ${wantLink.toFixed(1)} = ${G.bodyLinkGap}×${k.toFixed(4)})`,
    );
    check(
      `gap-bottom:${tag}`,
      Math.abs(g.gapBottom - wantBottom) <= 1.5,
      `我知道了↔气泡底=${g.gapBottom.toFixed(1)}(期望 ${wantBottom.toFixed(1)} = padding ${G.padding}×${k.toFixed(4)},含 1px 描边容差)`,
    );
    check(`copy-center:${tag}`, g.align === 'center', `text-align=${g.align}`);
    if (plat === 'desk') {
      // 桌面是鼠标指针:热区 = 行高 + 上下 linkHitPadding(设计单位)× k,不套 44 触摸下限
      const wantHit = (G.lineHeight + 2 * G.linkHitPadding) * k;
      check(
        `hit-area:${tag}`,
        Math.abs(g.hitH - wantHit) <= 1.5 && g.hitW > g.hitH,
        `命中区 ${g.hitW.toFixed(0)}×${g.hitH.toFixed(0)}(期望高 ${wantHit.toFixed(1)} = (${G.lineHeight}+2×${G.linkHitPadding})×${k.toFixed(4)})`,
      );
    } else {
      // 触摸端:hitSlop 按气泡内可用空间钳制(RN 不越父边界,虚标无效)——
      // 期望高 = 行高×k + min(18, bodyLinkGap×k) + min(18, padding×k)
      const wantHit =
        G.lineHeight * k + Math.min(18, G.bodyLinkGap * k) + Math.min(18, G.padding * k);
      check(
        `hit-area:${tag}`,
        Math.abs(g.hitH - wantHit) <= 1.5 && g.hitW > g.hitH,
        `命中区 ${g.hitW.toFixed(0)}×${g.hitH.toFixed(1)}(期望高 ${wantHit.toFixed(1)},边界内取最大;整个登录 stage 同缩放)`,
      );
    }
    if (state === 'deletion-stress') {
      await gotoCase(plat, 'light', 'zh-CN', 'deletion-completed');
      const h0 = await page.evaluate(() => document.querySelector('.db-bubble').getBoundingClientRect().height);
      // 压力态(文案 ×8)必须显著撑高:阈值按行高 × k 折算(旧版写死 40 物理 px)
      const minGrow = G.lineHeight * k * 1.5;
      check(
        `stress-grows:${plat}`,
        g.bubbleH > h0 + minGrow,
        `压力态撑高 ${g.bubbleH.toFixed(0)} > completed ${h0.toFixed(0)} + ${minGrow.toFixed(1)}`,
      );
    }
  }
}

// 8:当前支持语言全集——三态长文案在 desk/phone × light/dark 中均真实进入布局。
for (const plat of ['desk', 'phone']) {
  const G = plat === 'desk' ? DESK_G : MOB_G;
  for (const mode of ['light', 'dark']) {
    for (const lang of SUPPORTED_LOCALES) {
      for (const state of ['deletion-pending', 'deletion-processing', 'deletion-completed']) {
        await gotoCase(plat, mode, lang, state);
        const m = await page.evaluate(() => {
          const bubble = document.querySelector('.db-bubble');
          const title = bubble?.querySelector('.db-title');
          const copy = bubble?.querySelector('.db-copy');
          if (!bubble || !title || !copy) return null;
          const br = bubble.getBoundingClientRect();
          const tr = title.getBoundingClientRect();
          const cr = copy.getBoundingClientRect();
          const copyStyle = getComputedStyle(copy);
          const dismiss = bubble.querySelector('.db-dismiss');
          let gapBottom = null;
          if (dismiss) {
            const dr = (dismiss.querySelector('.db-dismiss-text') ?? dismiss).getBoundingClientRect();
            gapBottom = br.bottom - 1 - dr.bottom;
          }
          return {
            title: title.textContent?.trim() ?? '',
            copy: copy.textContent?.trim() ?? '',
            bubbleH: br.height,
            noClip:
              title.scrollWidth <= title.clientWidth + 1 &&
              title.scrollHeight <= title.clientHeight + 1 &&
              copy.scrollWidth <= copy.clientWidth + 1 &&
              copy.scrollHeight <= copy.clientHeight + 1,
            wrappedByLayout: copyStyle.whiteSpace === 'normal' && copyStyle.textAlign === 'center',
            titleH: tr.height,
            copyH: cr.height,
            gapBottom,
            scale: window.__qa.scale(),
          };
        });
        const tag = `${plat}:${mode}:${lang}:${state.replace('deletion-', '')}`;
        check(
          `locale-layout:${tag}`,
          Boolean(m && m.title && m.copy && m.bubbleH > 0 && m.titleH > 0 && m.copyH > 0 && m.noClip && m.wrappedByLayout),
          m
            ? `title=${JSON.stringify(m.title)} copy=${m.copy.length}字 noClip=${m.noClip} centerWrap=${m.wrappedByLayout}`
            : '气泡/标题/正文缺失',
        );
        if (state === 'deletion-completed' && m) {
          const wantBottom = G.padding * m.scale;
          check(
            `locale-bottom-gap:${tag}`,
            typeof m.gapBottom === 'number' && Math.abs(m.gapBottom - wantBottom) <= 1.5,
            `我知道了↔气泡底=${m.gapBottom?.toFixed(1)}(期望 ${wantBottom.toFixed(1)})`,
          );
        }
      }
    }
  }
}

// 5:桌面 clamp —— 可视宽 = min(设计宽 × k, 帧宽−24);顶距恒 = 设计 top × k
await gotoCase('desk');
for (const w of [800, 717, 600]) {
  const want = Math.min(DESK_G.width * deskK, w - 24);
  const m = await page.evaluate(({ w }) => {
    window.__qa.resize(w, 600);
    const b = document.querySelector('.db-bubble').getBoundingClientRect();
    const f = document.getElementById('frame').getBoundingClientRect();
    return { w: b.width, top: b.top - f.top, left: b.left - f.left };
  }, { w });
  check(
    `desk-clamp:${w}`,
    Math.abs(m.w - want) <= 1,
    `宽=${m.w.toFixed(1)}(期望 ${want.toFixed(1)}=min(${DESK_G.width}×${deskK}, ${w}-24))`,
  );
  check(
    `desk-top:${w}`,
    Math.abs(m.top - DESK_G.top * deskK) <= 1,
    `top=${m.top.toFixed(1)}(恒定 ${DESK_G.top}×${deskK}=${(DESK_G.top * deskK).toFixed(1)})`,
  );
  check(`desk-center:${w}`, Math.abs(m.left - (w - m.w) / 2) <= 1, `left=${m.left.toFixed(1)}(水平居中)`);
}

// phone 宽度随屏缩放:可视宽 = 设计宽 670 × (屏宽/750);边距 = 设计 x 40 × k
await gotoCase('phone');
for (const w of [390, 374, 335]) {
  const k = phoneK(w);
  const want = MOB_G.phoneWidth * k;
  const m = await page.evaluate(({ w }) => {
    window.__qa.resize(w, 700);
    const b = document.querySelector('.db-bubble').getBoundingClientRect();
    const f = document.getElementById('frame').getBoundingClientRect();
    return { w: b.width, left: b.left - f.left };
  }, { w });
  check(
    `phone-clamp:${w}`,
    Math.abs(m.w - want) <= 1,
    `宽=${m.w.toFixed(1)}(期望 ${want.toFixed(1)} = ${MOB_G.phoneWidth}×${k.toFixed(4)})`,
  );
  check(
    `phone-margin:${w}`,
    Math.abs(m.left - MOB_G.phoneX * k) <= 1,
    `左边距=${m.left.toFixed(1)}(期望 ${(MOB_G.phoneX * k).toFixed(1)} = 设计 ${MOB_G.phoneX}×${k.toFixed(4)})`,
  );
  check(`phone-center:${w}`, Math.abs(m.left - (w - m.w) / 2) <= 1, `left=${m.left.toFixed(1)}(水平居中)`);
}

await browser.close();

writeEvidence();
process.exit(failures === 0 ? 0 : 2);
