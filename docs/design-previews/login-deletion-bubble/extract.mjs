#!/usr/bin/env node
// extract.mjs — 注销提示气泡(修复后)QA demo 真值提取器。机械提取,不手抄:
//  - desktop:LoginPage.tsx 气泡 class 串/结构事实/渲染位置(根层浮层、LoginStage 之外)、
//    colors.ts registerColor 值(login-deletion-bubble-bg 的 var 链解析:chat-input-bg/surface
//    /chat-input-border/login-control-text/login-secondary-text)、4×common.json 注销四语。
//  - mobile:loginSkinLayout.ts LOGIN_DELETION_BUBBLE 常量 + resolveDeletionBubbleFrame 结构
//    事实(esbuild 编译后 import 作 adaptive oracle)、tokens.ts loginPalettes 双色板
//    (deletionBubbleBg/Border/controlText/secondaryText)、login.tsx 气泡样式块+渲染结构、
//    loginMessages.ts 注销四语。
//  - adaptive.samples:产品纯函数 resolveLoginSurface + resolveDeletionBubbleFrame 对
//    spec.adaptive.sampleSizes 预计算期望几何(oracle = 产品公式本身,验收侧不重写)。
// stdout 输出 truth JSON。

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const demoDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(demoDir, '..', '..', '..');
const R = (p) => resolve(repoRoot, p);
const rel = (p) => `../../../${p}`;

const hashes = new Map();
function fileHash(absPath) {
  if (!hashes.has(absPath)) {
    hashes.set(absPath, createHash('sha256').update(readFileSync(absPath)).digest('hex'));
  }
  return hashes.get(absPath);
}
function leaf(value, srcRelRepo, locator) {
  return {
    value,
    provenance: { source: rel(srcRelRepo), locator, hash: `sha256:${fileHash(R(srcRelRepo))}` },
  };
}
function readSrc(p) {
  return readFileSync(R(p), 'utf8');
}
function leafFields(obj, srcRelRepo, prefix, locators = {}) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = leaf(v, srcRelRepo, locators[k] ?? `${prefix}.${k}`);
  return out;
}
function extractConstObject(src, name) {
  const start = src.indexOf(`export const ${name}`);
  if (start === -1) throw new Error(`未找到 export const ${name}`);
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(braceStart, i + 1);
    }
  }
  throw new Error(`${name} 对象体未闭合`);
}
function numField(objSrc, key) {
  const m = new RegExp(`\\b${key}:\\s*(-?[\\d.]+)`).exec(objSrc);
  if (!m) throw new Error(`字段 ${key} 未命中`);
  return Number(m[1]);
}
function extractRegisterColor(src, name) {
  const re = new RegExp(`registerColor\\('${name}',\\s*\\{\\s*light:\\s*'([^']+)',\\s*dark:\\s*'([^']+)'`, 's');
  const m = re.exec(src);
  if (!m) throw new Error(`registerColor('${name}') 未命中`);
  return { light: m[1], dark: m[2] };
}

/* ══ desktop ══ */
const P = {
  loginPage: 'apps/desktop/src/renderer/components/login/LoginPage.tsx',
  designTokens: 'apps/desktop/src/renderer/components/login/loginDesignTokens.ts',
  loginScale: 'apps/desktop/src/renderer/components/login/loginScale.ts',
  colors: 'apps/desktop/src/renderer/themes/colors.ts',
  commonJson: (loc) => `apps/desktop/src/renderer/i18n/locales/${loc}/common.json`,
};
const loginPageSrc = readSrc(P.loginPage);
const colorsSrc = readSrc(P.colors);

// 结构事实:定位/缩放 wrapper(设计单位 × PANEL_FIXED_SCALE)+ 气泡本体 class
const bubbleWrapM = /data-testid="login-deletion-bubble-scale"\s*\n\s*className="(absolute left-1\/2 z-30)"/.exec(loginPageSrc);
if (!bubbleWrapM) throw new Error('desktop 气泡缩放 wrapper(data-testid + className)未命中(源码已变?)');
const bubbleClassM = /className="(w-full break-words border border-\[var\(--login-deletion-bubble-border\)\] bg-\[var\(--login-deletion-bubble-bg\)\] text-center)"/.exec(loginPageSrc);
if (!bubbleClassM) throw new Error('desktop 气泡 section className 未命中(源码已变?)');
// wrapper 的定位/缩放全部由 LOGIN_DELETION_BUBBLE × PANEL_FIXED_SCALE 计算,断言表达式在位
for (const expr of [
  'top: B.top * PANEL_FIXED_SCALE',
  'transform: `translateX(-50%) scale(${PANEL_FIXED_SCALE})`',
  "transformOrigin: 'top center'",
]) {
  if (!loginPageSrc.includes(expr)) throw new Error(`desktop 气泡 wrapper 缺表达式:${expr}`);
}
// 内部几何消费设计常量(不再是 CSS px 字面量 class)
for (const expr of ['borderRadius: B.radius', 'padding: B.padding', 'fontSize: B.font', 'marginTop: B.titleBodyGap']) {
  if (!loginPageSrc.includes(expr)) throw new Error(`desktop 气泡内部几何缺表达式:${expr}`);
}
const deskTokensSrc = readSrc(P.designTokens);
const deskScaleSrc = readSrc(P.loginScale);
const deskBubbleObj = extractConstObject(deskTokensSrc, 'LOGIN_DELETION_BUBBLE');
const panelFixedScale = Number(/PANEL_FIXED_SCALE\s*=\s*([\d.]+)/.exec(deskScaleSrc)[1]);
if (!(panelFixedScale > 0 && panelFixedScale <= 1)) throw new Error('PANEL_FIXED_SCALE 提取异常');
// 渲染位置结构事实:气泡在 </LoginStage> 之后(根层,不在 stage 文档流)
const renderPosM = /<\/LoginStage>\s*\{\/\* 注销状态提示气泡[\s\S]{0,400}?<AccountDeletionStatusPanel/.exec(loginPageSrc);
if (!renderPosM) throw new Error('desktop 气泡根层渲染位置(</LoginStage> 之后)未命中');
// completed 才传 onDismiss(结构事实,沿用旧逻辑未改动)
const dismissGateM = /accountDeletionStatus\.status === 'completed'\s*\?\s*\(\) =>/.exec(loginPageSrc);
if (!dismissGateM) throw new Error('desktop dismiss 仅 completed 结构未命中');
// 「我知道了」热区:上下 linkHitPadding 撑开 + 等量负 margin 抵消(设计单位,随 wrapper 缩放)
for (const expr of [
  'marginTop: B.bodyLinkGap - B.linkHitPadding',
  'marginBottom: -B.linkHitPadding',
  'paddingTop: B.linkHitPadding',
]) {
  if (!loginPageSrc.includes(expr)) throw new Error(`desktop dismiss 热区缺表达式:${expr}`);
}

// 颜色 token:固定值(login skin 不随扩展主题,Fix A——弃用 var 链 alias,
// 与 mobile loginPalettes.deletionBubbleBg/Border 逐值一致)
const bubbleBg = extractRegisterColor(colorsSrc, 'login-deletion-bubble-bg');
const bubbleBorder = extractRegisterColor(colorsSrc, 'login-deletion-bubble-border');
if (bubbleBg.light.startsWith('var(') || bubbleBg.dark.startsWith('var('))
  throw new Error('login-deletion-bubble-bg 应为固定值(Fix A:login skin 不随扩展主题,禁 alias)');
if (bubbleBorder.light.startsWith('var(') || bubbleBorder.dark.startsWith('var('))
  throw new Error('login-deletion-bubble-border 应为固定值(Fix A 新增 token,禁 alias)');
const controlText = extractRegisterColor(colorsSrc, 'login-control-text');
const secondaryText = extractRegisterColor(colorsSrc, 'login-secondary-text');

const DESK_COPY_LOCALES = ['zh-CN', 'en', 'ja', 'ko'];
const deskCopy = {};
for (const loc of DESK_COPY_LOCALES) {
  const j = JSON.parse(readSrc(P.commonJson(loc)));
  const st = j.accountDeletion?.status;
  if (!st) throw new Error(`${loc} common.json 缺 accountDeletion.status`);
  deskCopy[loc] = {
    pendingTitle: st.pendingTitle,
    pendingCopy: st.pendingCopy,
    processingTitle: st.processingTitle,
    processingCopy: st.processingCopy,
    completedTitle: st.completedTitle,
    completedCopy: st.completedCopy,
    dismissButton: st.dismissButton,
  };
}

/* ══ mobile ══ */
const M = {
  skinLayout: 'apps/mobile/src/auth/loginSkinLayout.ts',
  tokens: 'apps/mobile/src/theme/tokens.ts',
  loginTsx: 'apps/mobile/app/(auth)/login.tsx',
  loginMessages: 'apps/mobile/src/auth/loginMessages.ts',
};
const mSkinSrc = readSrc(M.skinLayout);
const mTokensSrc = readSrc(M.tokens);
const mLoginSrc = readSrc(M.loginTsx);
const mMsgsSrc = readSrc(M.loginMessages);

const mBubbleObj = extractConstObject(mSkinSrc, 'LOGIN_DELETION_BUBBLE');
const copyLineHeight = Number(/LOGIN_COPY_LINE_HEIGHT\s*=\s*(\d+)/.exec(mSkinSrc)[1]);
// surface 断点与 pad stage 规格(气泡定位移植所需;resolveDeletionBubbleFrame 消费)
const padLandscapeMinW = Number(/PAD_LANDSCAPE_MIN_WIDTH\s*=\s*(\d+)/.exec(mSkinSrc)[1]);
const padLandscapeMinH = Number(/PAD_LANDSCAPE_MIN_HEIGHT\s*=\s*(\d+)/.exec(mSkinSrc)[1]);
const padPortraitMinW = Number(/PAD_PORTRAIT_MIN_WIDTH\s*=\s*(\d+)/.exec(mSkinSrc)[1]);
const padLandscapeMinScale = Number(/PAD_LANDSCAPE_MIN_SCALE\s*=\s*([\d.]+)/.exec(mSkinSrc)[1]);
const mPadPortraitStage = extractConstObject(mSkinSrc, 'LOGIN_PAD_PORTRAIT_STAGE');
const mPadLandscapeStage = extractConstObject(mSkinSrc, 'LOGIN_PAD_LANDSCAPE_STAGE');
const mStageWidth = Number(/LOGIN_STAGE_WIDTH\s*=\s*(\d+)/.exec(mSkinSrc)[1]);

// mobile 结构事实:气泡 position absolute + frame 行内注入;样式块无阴影/固定高
const mBubbleStyleBlock = /deletionBubble: \{([\s\S]*?)\}/.exec(mLoginSrc);
if (!mBubbleStyleBlock || !/position: 'absolute'/.test(mBubbleStyleBlock[1]))
  throw new Error('mobile deletionBubble 样式块 position:absolute 未命中');
if (/shadow|elevation|height:/.test(mBubbleStyleBlock[1]))
  throw new Error('mobile deletionBubble 出现了 shadow/elevation/固定高——规格前提变化,需复核');
for (const expr of ['left: frame.left', 'top: frame.top', 'width: frame.width']) {
  if (!mLoginSrc.includes(expr)) throw new Error(`mobile 气泡 frame 行内注入缺 ${expr}`);
}
// 内部几何按 frame.scale 折算(设计单位 → 物理 pt),不再写死物理值
for (const expr of [
  'const scaled = (designUnits: number) => designUnits * frame.scale',
  'borderRadius: scaled(B.radius)',
  'padding: scaled(B.padding)',
  'fontSize: scaled(B.font)',
  'lineHeight: scaled(B.lineHeight)',
]) {
  if (!mLoginSrc.includes(expr)) throw new Error(`mobile 气泡缺缩放表达式:${expr}`);
}
const mResolveCallM = /resolveDeletionBubbleFrame\(stage, insets\.top\)/.exec(mLoginSrc);
if (!mResolveCallM) throw new Error('mobile resolveDeletionBubbleFrame(stage, insets.top) 调用未命中');
if (!/hitSlop=\{resolveDeletionBubbleLinkHitSlop\(frame\.scale\)\}/.test(mLoginSrc))
  throw new Error('mobile dismiss hitSlop(resolveDeletionBubbleLinkHitSlop)未命中');
// 热区钳制函数结构断言:上=min(18, bodyLinkGap×scale)、下=min(18, padding×scale)
if (!/top: Math\.min\(18, bodyLinkGap \* scale\)/.test(mSkinSrc) || !/bottom: Math\.min\(18, padding \* scale\)/.test(mSkinSrc))
  throw new Error('resolveDeletionBubbleLinkHitSlop 钳制公式未命中');
// 入场门(PR #464 review):Animated.View opacity=panelEntrance.opacity + pointerEvents 仅 done。
// 按 opening tag 整段取(容纳后续追加的属性/注释,如 Android 无障碍隐藏),再逐项断言,
// 避免属性顺序或新增属性把单条长正则打断。
const mGateTag = /<Animated\.View\b[\s\S]*?>\s*<AccountDeletionStatusPanel/.exec(mLoginSrc);
if (!mGateTag) throw new Error('mobile 气泡浮层包装层(Animated.View + AccountDeletionStatusPanel)未命中');
const mEntranceGateM = [mGateTag[0]];
if (!/pointerEvents=\{handoffPhase === 'done' \? 'box-none' : 'none'\}/.test(mGateTag[0]))
  throw new Error("mobile 气泡入场门 pointerEvents(done → box-none)未命中");
// 全屏包装层禁止 'auto':RN 下 absoluteFill 的 View 即使透明也吃命中区,会挡住登录组
if (/\? 'auto' : 'none'/.test(mGateTag[0]))
  throw new Error("mobile 气泡包装层 pointerEvents 出现 'auto'——会挡住下方登录组命中(Greptile P1 回归)");
if (!/style=\{\[StyleSheet\.absoluteFill, \{ opacity: panelEntrance\.opacity \}\]\}/.test(mGateTag[0]))
  throw new Error('mobile 气泡入场门 opacity=panelEntrance.opacity 未命中');
// 读屏隔离(PR #464 codex):iOS + Android 双端属性,条件覆盖「弹窗打开」与「入场未完成」
if (!/accessibilityElementsHidden=\{deletionBubbleA11yHidden\}/.test(mGateTag[0]))
  throw new Error('mobile 气泡 iOS 读屏隐藏(accessibilityElementsHidden)未命中');
if (!/importantForAccessibility=\{\s*deletionBubbleA11yHidden \? 'no-hide-descendants' : 'auto'\s*\}/.test(mGateTag[0]))
  throw new Error('mobile 气泡 Android 读屏隐藏(importantForAccessibility)未命中');
if (!/const deletionBubbleA11yHidden = consentDialogOpen \|\| handoffPhase !== 'done';/.test(mLoginSrc))
  throw new Error('mobile 气泡读屏隐藏条件(弹窗打开 || 入场未完成)未命中');

// loginPalettes 双色板
const mPalettesObj = extractConstObject(mTokensSrc, 'loginPalettes');
function paletteVal(mode, key) {
  const modeBlock = new RegExp(`${mode}: \\{([\\s\\S]*?)\\n  \\}`).exec(mPalettesObj);
  if (!modeBlock) throw new Error(`loginPalettes.${mode} 块未命中`);
  const m = new RegExp(`\\b${key}:\\s*'([^']+)'`).exec(modeBlock[1]);
  if (!m) throw new Error(`loginPalettes.${mode}.${key} 未命中`);
  return m[1];
}

// loginMessages 四语(顺序 zh-CN/en/ja/ko)
const MSG_LOCALES = ['zh-CN', 'en', 'ja', 'ko'];
function msgValues(key) {
  const re = new RegExp(`\\b${key}:\\s*'((?:[^'\\\\]|\\\\.)*)'`, 'g');
  const hits = [...mMsgsSrc.matchAll(re)].map((m) => m[1]);
  if (hits.length !== 4) throw new Error(`loginMessages 键 ${key} 命中 ${hits.length} 次(预期 4)`);
  return hits;
}
const mCopy = {};
for (const [i, loc] of MSG_LOCALES.entries()) {
  mCopy[loc] = {
    pendingTitle: msgValues('accountDeletionPendingTitle')[i],
    pendingCopy: msgValues('accountDeletionPendingCopy')[i],
    processingTitle: msgValues('accountDeletionProcessingTitle')[i],
    processingCopy: msgValues('accountDeletionProcessingCopy')[i],
    completedTitle: msgValues('accountDeletionCompletedTitle')[i],
    completedCopy: msgValues('accountDeletionCompletedCopy')[i],
    dismissButton: msgValues('accountDeletionDismiss')[i],
  };
}

/* ══ oracle:esbuild 编译 loginSkinLayout.ts → resolveLoginSurface + resolveDeletionBubbleFrame ══ */
const require2 = createRequire(join(repoRoot, 'package.json'));
const esbuild = require2('esbuild');
const tmp = mkdtempSync(join(tmpdir(), 'deletion-bubble-extract-'));
let layoutMod;
try {
  const code = esbuild.transformSync(mSkinSrc, { loader: 'ts', format: 'esm' }).code;
  writeFileSync(join(tmp, 'loginSkinLayout.mjs'), code);
  layoutMod = await import(pathToFileURL(join(tmp, 'loginSkinLayout.mjs')).href);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
const { resolveLoginSurface, resolveDeletionBubbleFrame } = layoutMod;

// demo 的 safeTop 仿真常量(demo chrome;phone top = insets.top,产品运行时注入)
const DEMO_SAFE_TOP = 59;
// spec.adaptive.sampleSizes 的期望几何预计算(oracle = 产品纯函数)
const SAMPLE_SIZES = [
  [390, 844], [375, 812], [374, 812], [335, 700], [320, 680],
  [700, 1000], [699, 1000], [744, 1133],
  [1000, 690], [999, 690], [1000, 689], [1180, 820], [1440, 900],
];
const samples = SAMPLE_SIZES.map(([w, h]) => {
  const surface = resolveLoginSurface(w, h);
  const frame = resolveDeletionBubbleFrame(surface, DEMO_SAFE_TOP);
  return {
    w,
    h,
    probes: {
      bubble: { x: frame.left, y: frame.top, w: frame.width },
      surfaceMode: surface.mode,
    },
  };
});

/* ══ truth 组装 ══ */
const truth = {
  structure: {
    desktop: {
      renderPosition: leaf('LoginPage 根层(</LoginStage> 之后),不在 stage 文档流;absolute z-30 浮层', P.loginPage, 'LoginPage.tsx </LoginStage> 之后的 AccountDeletionStatusPanel 渲染点'),
      dismissGate: leaf("仅 completed 态传入 onDismiss(「我知道了」);pending/processing 无按钮", P.loginPage, "LoginPage.tsx accountDeletionStatus.status === 'completed' ? onDismiss : undefined"),
      bubbleClass: leaf(bubbleClassM[1], P.loginPage, 'AccountDeletionStatusPanel section className 全串'),
      wrapperClass: leaf(bubbleWrapM[1], P.loginPage, 'wrapper(定位+缩放层)className,几何走 inline style'),
      scaleContract: leaf(
        `几何为设计单位,wrapper 施加 translateX(-50%) scale(${panelFixedScale}) + transformOrigin top center;渲染值 = 设计单位 × ${panelFixedScale}(宽 ${numField(deskBubbleObj, 'width') * panelFixedScale} / 顶距 ${numField(deskBubbleObj, 'top') * panelFixedScale} CSS px)`,
        P.loginPage,
        'wrapper style: top/width/transform/transformOrigin',
      ),
      dismissHitArea: leaf(
        `上下各 ${numField(deskBubbleObj, 'linkHitPadding')} 设计单位 padding 撑热区 + 等量负 margin 抵消(视觉间距仍 上 ${numField(deskBubbleObj, 'bodyLinkGap')} / 下 ${numField(deskBubbleObj, 'padding')});缩放后约 ${(numField(deskBubbleObj, 'lineHeight') + 2 * numField(deskBubbleObj, 'linkHitPadding')) * panelFixedScale} CSS px 高(桌面鼠标指针)`,
        P.loginPage,
        'dismiss inline style marginTop/marginBottom/paddingTop/paddingBottom',
      ),
    },
    mobile: {
      renderPosition: leaf('position:absolute,left/top/width 由 resolveDeletionBubbleFrame(stage, insets.top) 行内注入;不参与布局流', M.loginTsx, 'login.tsx:1140-1197 deletionBubbleFrame + AccountDeletionStatusPanel frame prop'),
      styleFacts: leaf('不透明底+1px 描边;无 shadow/elevation/固定高(样式块守护断言)', M.loginTsx, 'login.tsx:1439-1449 makeStyles.deletionBubble'),
      dismissHitSlop: leaf("hitSlop 按气泡内可用空间钳制:top=min(18, bodyLinkGap×scale)、bottom=min(18, padding×scale)、左右 20——RN hitSlop 不越父边界,虚标无效(PR #494 codex);热区随整个登录 stage 同步缩放(320pt 窗口下主按钮本身 ≈34pt),不追未缩放 44pt 绝对值", M.skinLayout, 'resolveDeletionBubbleLinkHitSlop(scale)'),
      dismissGate: leaf('仅 completed 态渲染 dismiss Pressable(onDismiss 仅 completed 传入)', M.loginTsx, 'login.tsx:1315-1327 {onDismiss ? <Pressable/> : null}'),
      entranceGate: leaf("Animated.View 包装:opacity=panelEntrance.opacity(与登录组同一 Animated 值);pointerEvents 仅 handoffPhase==='done' 放行且取 box-none(全屏包装层不作触摸目标,避免挡住下方登录组命中;入场完成前 none = 不可见不可点)(PR #464 review)", M.loginTsx, 'login.tsx 气泡渲染点 Animated.View pointerEvents/style'),
      a11yModalGate: leaf("气泡对读屏隐藏 = 协议弹窗打开 || 入场未完成;iOS accessibilityElementsHidden + Android importantForAccessibility 双端都给(opacity/pointerEvents 不影响读屏,不隐藏则会念出不可见的注销状态)(PR #464 codex)", M.loginTsx, 'login.tsx 气泡渲染点 Animated.View importantForAccessibility'),
    },
  },
  desktop: {
    geometry: leafFields(
      {
        // 设计单位(1819×2098 的 2x 稿);渲染值 = 设计单位 × scale
        scale: panelFixedScale,
        top: numField(deskBubbleObj, 'top'),
        width: numField(deskBubbleObj, 'width'),
        radius: numField(deskBubbleObj, 'radius'),
        padding: numField(deskBubbleObj, 'padding'),
        fontSize: numField(deskBubbleObj, 'font'),
        lineHeight: numField(deskBubbleObj, 'lineHeight'),
        titleBodyGap: numField(deskBubbleObj, 'titleBodyGap'),
        bodyLinkGap: numField(deskBubbleObj, 'bodyLinkGap'),
        linkHitPadding: numField(deskBubbleObj, 'linkHitPadding'),
        borderWidth: 1,
        fontWeight: 400,
        zIndex: 30,
      },
      P.designTokens,
      'LOGIN_DELETION_BUBBLE(设计单位)',
      {
        scale: `loginScale.ts PANEL_FIXED_SCALE=${panelFixedScale}(面板恒定缩放,气泡同乘)`,
        borderWidth: 'LoginPage.tsx section style borderWidth=1/PANEL_FIXED_SCALE 设计单位(缩放补偿,渲染恰 1 物理 px;DESIGN.md §16.4)',
        fontWeight: 'LoginPage.tsx font-normal=400',
        zIndex: 'LoginPage.tsx wrapper z-30',
      },
    ),
    colors: {
      bubbleBg: {
        light: leaf(bubbleBg.light, P.colors, "registerColor('login-deletion-bubble-bg').light(固定值,Fix A 弃 alias)"),
        dark: leaf(bubbleBg.dark, P.colors, "registerColor('login-deletion-bubble-bg').dark(固定值)"),
      },
      bubbleBorder: {
        light: leaf(bubbleBorder.light, P.colors, "registerColor('login-deletion-bubble-border').light(Fix A 新增 token)"),
        dark: leaf(bubbleBorder.dark, P.colors, "registerColor('login-deletion-bubble-border').dark"),
      },
      titleText: {
        light: leaf(controlText.light, P.colors, "registerColor('login-control-text').light"),
        dark: leaf(controlText.dark, P.colors, "registerColor('login-control-text').dark"),
      },
      copyText: {
        light: leaf(secondaryText.light, P.colors, "registerColor('login-secondary-text').light"),
        dark: leaf(secondaryText.dark, P.colors, "registerColor('login-secondary-text').dark"),
      },
      bgBase: {
        light: leaf(extractRegisterColor(colorsSrc, 'login-bg-base').light, P.colors, "registerColor('login-bg-base').light"),
        dark: leaf(extractRegisterColor(colorsSrc, 'login-bg-base').dark, P.colors, "registerColor('login-bg-base').dark"),
      },
    },
    copy: Object.fromEntries(
      DESK_COPY_LOCALES.map((loc) => [
        loc,
        leafFields(deskCopy[loc], P.commonJson(loc), `accountDeletion.status(${loc})`),
      ]),
    ),
  },
  mobile: {
    geometry: leafFields(
      {
        radius: numField(mBubbleObj, 'radius'),
        padding: numField(mBubbleObj, 'padding'),
        borderWidth: numField(mBubbleObj, 'borderWidth'),
        fontSize: numField(mBubbleObj, 'font'),
        lineHeight: copyLineHeight,
        titleBodyGap: numField(mBubbleObj, 'titleBodyGap'),
        bodyLinkGap: numField(mBubbleObj, 'bodyLinkGap'),
        // hitSlop 名义上限(物理 pt;实际上/下按气泡内可用空间钳制,见 hitSlopRule)
        linkHitSlopMax: 18,
        linkHitSlopX: 20,
        // 各端落位(stage 设计单位)
        phoneWidth: numField(mBubbleObj, 'width'),
        phoneX: numField(mBubbleObj, 'x'),
        padLandscapeWidth: 556,
        padLandscapeX: 607,
        padPortraitWidth: 504,
        padTop: 72,
      },
      M.skinLayout,
      'LOGIN_DELETION_BUBBLE(stage 设计单位)',
      {
        lineHeight: 'LOGIN_DELETION_BUBBLE.lineHeight=LOGIN_COPY_LINE_HEIGHT',
        linkHitSlopMax: 'resolveDeletionBubbleLinkHitSlop 的 18 上限(物理 pt)',
        linkHitSlopX: 'resolveDeletionBubbleLinkHitSlop left/right=20(物理 pt)',
        phoneWidth: 'LOGIN_DELETION_BUBBLE.phone.width',
        phoneX: 'LOGIN_DELETION_BUBBLE.phone.x',
        padLandscapeWidth: 'LOGIN_DELETION_BUBBLE.padLandscape.width(= WORD_MARK 框宽)',
        padLandscapeX: 'LOGIN_DELETION_BUBBLE.padLandscape.x',
        padPortraitWidth: 'LOGIN_DELETION_BUBBLE.padPortrait.width',
        padTop: 'LOGIN_DELETION_BUBBLE.padLandscape.top / padPortrait.top',
      },
    ),
    colors: (() => {
      const out = {};
      for (const key of ['deletionBubbleBg', 'deletionBubbleBorder', 'controlText', 'secondaryText', 'bgBase']) {
        out[key] = {
          light: leaf(paletteVal('light', key), M.tokens, `loginPalettes.light.${key}`),
          dark: leaf(paletteVal('dark', key), M.tokens, `loginPalettes.dark.${key}`),
        };
      }
      return out;
    })(),
    surface: leafFields(
      {
        phoneStageWidth: mStageWidth,
        padLandscapeMinWidth: padLandscapeMinW,
        padLandscapeMinHeight: padLandscapeMinH,
        padPortraitMinWidth: padPortraitMinW,
        padLandscapeMinScale: padLandscapeMinScale,
        padPortraitStageWidth: numField(mPadPortraitStage, 'width'),
        padPortraitStageHeight: numField(mPadPortraitStage, 'height'),
        padLandscapeStageWidth: numField(mPadLandscapeStage, 'width'),
        padLandscapeStageHeight: numField(mPadLandscapeStage, 'height'),
        stageWidth: mStageWidth,
      },
      M.skinLayout,
      'surface 断点/stage 规格',
      {
        padLandscapeMinWidth: 'PAD_LANDSCAPE_MIN_WIDTH',
        padLandscapeMinHeight: 'PAD_LANDSCAPE_MIN_HEIGHT',
        padPortraitMinWidth: 'PAD_PORTRAIT_MIN_WIDTH',
        padLandscapeMinScale: 'PAD_LANDSCAPE_MIN_SCALE',
        padPortraitStageWidth: 'LOGIN_PAD_PORTRAIT_STAGE.width',
        padPortraitStageHeight: 'LOGIN_PAD_PORTRAIT_STAGE.height',
        padLandscapeStageWidth: 'LOGIN_PAD_LANDSCAPE_STAGE.width',
        padLandscapeStageHeight: 'LOGIN_PAD_LANDSCAPE_STAGE.height',
        stageWidth: 'LOGIN_STAGE_WIDTH',
      },
    ),
    copy: Object.fromEntries(
      MSG_LOCALES.map((loc) => [loc, leafFields(mCopy[loc], M.loginMessages, `accountDeletion*(${loc})`)]),
    ),
  },
  adaptive: {
    safeTop: leaf(DEMO_SAFE_TOP, M.loginTsx, 'demo chrome:safe-area 顶仿真常量(产品运行时 = insets.top)'),
    oracle: leaf('resolveLoginSurface + resolveDeletionBubbleFrame(esbuild 编译 loginSkinLayout.ts 后 import,产品纯函数)', M.skinLayout, 'loginSkinLayout.ts:302 resolveLoginSurface / :486 resolveDeletionBubbleFrame'),
    samples: leaf(samples, M.skinLayout, '产品纯函数对 spec.adaptive.sampleSizes 预计算(oracle 输出,非手算)'),
  },
};

process.stdout.write(JSON.stringify(truth, null, 1) + '\n');
