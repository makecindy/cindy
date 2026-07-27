#!/usr/bin/env node
// extract.mjs — 账号注销横幅被登录面板覆盖 bug 复现 demo 的真值提取器。
// 机械提取,不手抄;stdout 输出 truth JSON。
//
// ⚠️ 本 demo 是「修复前证据」:truth 一律钉在 PINNED_SHA(本 PR 的 base commit)上,
// 源码读取全部走 `git show <PINNED_SHA>:<repo-relative-path>`(execFileSync,cwd=仓根),
// 不读工作区文件——工作区已是修复后代码,读了就不是「修复前」。
// drift-check 语义随之变为「提取器/ pinned 基线是否被改动」,恒定可复核。
//
// 提取面:
//  - desk:loginDesignTokens.ts(组/面板/社交行/consent 行/Global 徽标几何)、
//    loginScale.ts(PANEL_FIXED_SCALE)、themes/colors.ts(面板/横幅/文字/consent/
//    apple/徽标 token 双模式)、LoginPage.tsx(横幅 className 结构事实 + 渲染位置 +
//    社交行 count 公式 + global 徽标门)、LoginControls.tsx(LoginPanel absolute top-0 +
//    LoginSocialRow absolute y=480 + consent 行结构 + 徽标 fontSize 16 + 对勾 path)、
//    globals.css(--text-12/14)、legalLinks.ts(两区协议 URL)、
//    loginIdentifierMethod.ts(区域 identifier 形态)、assets/login/icons/*.svg(五图标全文)、
//    4×common.json(注销三态 + identifier + consent + social + footer 文案)。
//  - mobile:theme/tokens.ts(loginSizes/spacing/radius/typeScale/lineHeight/loginPalettes/
//    通用文字色)、auth/loginSkinLayout.ts(LOGIN_GROUP/LOGIN_TITLE/LOGIN_CONTROL/
//    LOGIN_SOCIAL/LOGIN_CONSENT_ROW/stage 档位常量)、app/(auth)/login.tsx(deletionStatus
//    样式块 + 渲染位置结构事实 + fullButton.minHeight)、LoginSkinControls.tsx(panel
//    absolute top-0 + socialRow absolute y=480 + 社交图标 SVG path + consent 行结构 +
//    对勾 path)、MobilePrimitives.tsx(compact 按钮样式)、cnPhone.ts(+86 前缀)、
//    auth-client/fixtures/loginScenarios.ts(默认 providers.social 两区)、
//    nativeSocial.ts(apple iOS-only)、loginIdentifierMethod.ts、legalLinks.ts、
//    loginMessages.ts(注销三态 + identifier + consent + social 四语)。
// 横幅 tailwind 类 → px 的解析在提取器内完成(spacing 1 单位 = 4px 为框架事实),
// locator 记录源 class 串,可复核。

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 修复前基线 = 本 PR 的 base commit(origin/main 分叉点;该 commit 的 main 源码即修复前状态)。
 *  钉死不随分支漂移:本 demo 复现的 bug 存在于且仅钉在这个基线上。 */
const PINNED_SHA = '75baac1ee';

const demoDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(demoDir, '..', '..', '..');
const pinnedDir = join(demoDir, '_pinned');

const hashes = new Map();
function fileHash(repoRelPath) {
  if (!hashes.has(repoRelPath)) {
    hashes.set(repoRelPath, createHash('sha256').update(readSrc(repoRelPath)).digest('hex'));
  }
  return hashes.get(repoRelPath);
}
function leaf(value, srcRelRepo, locator) {
  return {
    value,
    provenance: {
      source: `_pinned/${srcRelRepo}`,
      locator: `[pinned ${PINNED_SHA}] ${locator}`,
      hash: `sha256:${fileHash(srcRelRepo)}`,
    },
  };
}
/** 从 pinned commit 读源码文本(git show;不读工作区)。 */
function readSrc(p) {
  return execFileSync('git', ['show', `${PINNED_SHA}:${p}`], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}
/** 把本轮读到的全部 pinned 源文件落盘到 _pinned/(先清空再写,保证目录与提取严格一致)。
 *  本地缓存副作用说明(lead 裁决 A,2026-07-26):内容由 PINNED_SHA 经 git show 确定性再生,
 *  目录已 gitignore、**故意不入仓**——避免仓内出现产品源文件副本(被 grep 命中或被人误改
 *  错那份);skill 校验器(truth.mjs / verify.mjs 的 validateTruth)按磁盘文件复核
 *  provenance.source 与 hash,故落盘是各档检查开箱可用的前提;纯本地、可随时整目录删除。 */
function dumpPinnedSources() {
  rmSync(pinnedDir, { recursive: true, force: true });
  for (const repoRelPath of hashes.keys()) {
    const dest = join(pinnedDir, repoRelPath);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readSrc(repoRelPath));
  }
}
/** 把 {k: v} 逐字段包成 {k: leaf(v)}(locator = prefix.k)——门 D truth 路径按字段寻址。 */
function leafFields(obj, srcRelRepo, prefix, locators = {}) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = leaf(v, srcRelRepo, locators[k] ?? `${prefix}.${k}`);
  return out;
}
/** 从 TS 源码抠 `export const NAME = { ... } as const;` 对象体(单层花括号平衡)。 */
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
/** 抠对象体里的数字字段:KEY: <number>。 */
function numField(objSrc, key) {
  const m = new RegExp(`\\b${key}:\\s*(-?[\\d.]+)`).exec(objSrc);
  if (!m) throw new Error(`字段 ${key} 未命中`);
  return Number(m[1]);
}
/** 抠 colors.ts registerColor('name', { light, dark })。 */
function extractRegisterColor(src, name) {
  const re = new RegExp(`registerColor\\('${name}',\\s*\\{\\s*light:\\s*'([^']+)',\\s*dark:\\s*'([^']+)'`, 's');
  const m = re.exec(src);
  if (!m) throw new Error(`registerColor('${name}') 未命中`);
  return { light: m[1], dark: m[2] };
}
/** mobile tokens.ts 顶层色板字段(light 板在 loginPalettes 之前的 ThemeColors 定义块)。 */
function extractThemeColorPair(src, key) {
  // light 块在前(首个 'KEY: '#xxx''),dark 块在后(第二个);dark 值可能与 light 相同。
  const re = new RegExp(`\\b${key}:\\s*'([^']+)'`, 'g');
  const hits = [...src.matchAll(re)].map((m) => m[1]);
  if (hits.length < 2) throw new Error(`tokens.ts 字段 ${key} 未凑齐 light/dark 两值`);
  return { light: hits[0], dark: hits[1] };
}

/* ══ desk ══ */
const P = {
  tokens: 'apps/desktop/src/renderer/components/login/loginDesignTokens.ts',
  scale: 'apps/desktop/src/renderer/components/login/loginScale.ts',
  colors: 'apps/desktop/src/renderer/themes/colors.ts',
  loginPage: 'apps/desktop/src/renderer/components/login/LoginPage.tsx',
  loginControls: 'apps/desktop/src/renderer/components/login/LoginControls.tsx',
  globalsCss: 'apps/desktop/src/renderer/styles/globals.css',
  legalLinks: 'apps/desktop/src/shared/legalLinks.ts',
  identifierMethod: 'apps/desktop/src/shared/loginIdentifierMethod.ts',
  commonJson: (loc) => `apps/desktop/src/renderer/i18n/locales/${loc}/common.json`,
  iconSvg: (name) => `apps/desktop/src/renderer/assets/login/icons/${name}.svg`,
};
const tokensSrc = readSrc(P.tokens);
const scaleSrc = readSrc(P.scale);
const colorsSrc = readSrc(P.colors);
const loginPageSrc = readSrc(P.loginPage);
const loginControlsSrc = readSrc(P.loginControls);
const globalsSrc = readSrc(P.globalsCss);
const legalSrc = readSrc(P.legalLinks);
const idMethodSrc = readSrc(P.identifierMethod);

const loginGroupObj = extractConstObject(tokensSrc, 'LOGIN_GROUP');
const panelObj = extractConstObject(tokensSrc, 'PANEL');
const stageObj = extractConstObject(tokensSrc, 'STAGE');
const titleObj = extractConstObject(tokensSrc, 'TITLE');
const subtitleObj = extractConstObject(tokensSrc, 'SUBTITLE');
const controlObj = extractConstObject(tokensSrc, 'CONTROL');
const socialObj = extractConstObject(tokensSrc, 'SOCIAL');
const consentRowObj = extractConstObject(tokensSrc, 'CONSENT_ROW');
const globalPillObj = extractConstObject(tokensSrc, 'GLOBAL_PILL');
const localModeObj = extractConstObject(tokensSrc, 'LOGIN_LOCAL_MODE');

const panelFixedScale = Number(/PANEL_FIXED_SCALE\s*=\s*([\d.]+)/.exec(scaleSrc)[1]);

// desk 横幅 class 串(结构事实:static 文档流首子,无 absolute/z-index)
const bannerClassM = /className="(mb-5 w-full rounded-xl border border-\[var\(--border-default\)\] bg-\[var\(--surface-chip\)\] px-4 py-3)"/.exec(loginPageSrc);
if (!bannerClassM) throw new Error('desk 横幅 section className 未命中(源码已变?)');
const bannerTitleClassM = /<h2 className="(text-14 font-medium text-\[var\(--text-primary\)\])"/.exec(loginPageSrc);
const bannerCopyClassM = /<p className="(mt-1 text-12 leading-5 text-\[var\(--text-secondary\)\])"/.exec(loginPageSrc);
if (!bannerTitleClassM || !bannerCopyClassM) throw new Error('desk 横幅标题/正文 className 未命中');
// 渲染位置结构事实:横幅是 LoginStage children 首子,{node} 紧随其后
const renderOrderM = /\{accountDeletionStatus && \([\s\S]{0,600}?<AccountDeletionStatusPanel[\s\S]{0,600}?\)\}\s*\{node\}/.exec(loginPageSrc);
if (!renderOrderM) throw new Error('desk 渲染顺序(横幅→{node})结构未命中');
// LoginPanel:absolute left-0 top-0 + 不透明 panelBg
const panelClassM = /className="(absolute left-0 top-0 overflow-hidden)"/.exec(loginControlsSrc);
if (!panelClassM) throw new Error('desk LoginPanel absolute top-0 className 未命中');
// 社交行结构事实:LoginSocialRow absolute top SOCIAL.y;count=providers.social.length+2(SSO+guest)
const socialCountM = /<LoginSocialRow count=\{providers\.social\.length \+ 2\}>/.exec(loginPageSrc);
if (!socialCountM) throw new Error('desk 社交行 count=providers.social.length+2 未命中');
const socialRowStyleM = /className="absolute flex"\s*style=\{\{ left, top: SOCIAL\.y, height: SOCIAL\.size, gap: SOCIAL\.gap \}\}/.exec(loginControlsSrc);
if (!socialRowStyleM) throw new Error('desk LoginSocialRow absolute top=SOCIAL.y 结构未命中');
// global 徽标门(结构事实):isGlobalBuild ? t('login.globalRegion') : undefined
const pillGateM = /globalPill=\{isGlobalBuild \? t\('login\.globalRegion'\) : undefined\}/.exec(loginPageSrc);
if (!pillGateM) throw new Error('desk global 徽标门(isGlobalBuild)未命中');
// Global 徽标 fontSize 字面 16(LoginControls inline style)
const pillFontM = /fontSize: 16,\s*lineHeight: `\$\{GLOBAL_PILL\.height\}px`/.exec(loginControlsSrc);
if (!pillFontM) throw new Error('desk Global 徽标 fontSize:16 未命中');
// consent 行结构事实:absolute top CONSENT_ROW.y(LoginConsentRow)
const consentRowM = /top: CONSENT_ROW\.y,\s*width: CONSENT_ROW\.width,\s*height: CONSENT_ROW\.height,\s*gap: CONSENT_ROW\.gap/.exec(loginControlsSrc);
if (!consentRowM) throw new Error('desk LoginConsentRow absolute top=CONSENT_ROW.y 结构未命中');
// consent 对勾 path(ConsentCheckGlyph)
const checkPathM = /d="(M6\.6 10\.4 L9\.3 12\.9 L15 8\.2)"/.exec(loginControlsSrc);
if (!checkPathM) throw new Error('desk ConsentCheckGlyph path 未命中');
// footer 可见性结构事实:localMode 页脚仅 error 步
const footerGateM = /showLocalModeFooter = loginState\?\.step === 'error'/.exec(loginPageSrc);
if (!footerGateM) throw new Error('desk showLocalModeFooter=step===error 结构未命中');

// tailwind spacing → px(1 单位 = 4px,框架事实);locator 记源 class 串
const TW = (n) => n * 4;
const text12 = Number(/--text-12:\s*([\d.]+)px/.exec(globalsSrc)[1]);
const text14 = Number(/--text-14:\s*([\d.]+)px/.exec(globalsSrc)[1]);

// desk 协议链接(两区;legalLinks.ts CN/GLOBAL 块)
const cnLinksM = /CN_LEGAL_LINKS[^}]*termsOfService:\s*'([^']+)'[^}]*privacyPolicy:\s*'([^']+)'/.exec(legalSrc);
const globalLinksM = /GLOBAL_LEGAL_LINKS[^}]*termsOfService:\s*'([^']+)'[^}]*privacyPolicy:\s*'([^']+)'/.exec(legalSrc);
if (!cnLinksM || !globalLinksM) throw new Error('desk legalLinks 两区 URL 未命中');

// desk identifier 形态(区域首选;providers 双 true 仿真)
const idMethodM = /const preferred: IdentifierMethod = region === 'global' \? 'email' : 'phone'/.exec(idMethodSrc);
if (!idMethodM) throw new Error('desk resolveIdentifierMethod 区域首选规则未命中');

// desk 图标 SVG 资产全文(五图标 × 双模式)
function svgLeaf(name) {
  return leaf(readSrc(P.iconSvg(name)), P.iconSvg(name), 'svg 文件全文');
}

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
    identifierTitle: j.login.title,
    identifierSubtitle: j.login.subtitle,
    identifierPlaceholder: j.login.phonePlaceholder,
    emailPlaceholder: j.login.emailPlaceholder,
    identifierContinue: j.login.continue,
    consentStatement: j.login.consentStatement,
    globalRegion: j.login.globalRegion,
    ssoEntry: j.login.ssoEntry,
    socialButton: j.login.socialButton,
    socialApple: j.login.social.apple,
    socialGoogle: j.login.social.google,
    socialWechat: j.login.social.wechat,
    localModeEntry: j.login.localModeEntry,
    localModeDescription: j.login.localModeDescription,
  };
}

/* ══ mobile ══ */
const M = {
  tokens: 'apps/mobile/src/theme/tokens.ts',
  skinLayout: 'apps/mobile/src/auth/loginSkinLayout.ts',
  loginTsx: 'apps/mobile/app/(auth)/login.tsx',
  skinControls: 'apps/mobile/src/components/LoginSkinControls.tsx',
  primitives: 'apps/mobile/src/components/MobilePrimitives.tsx',
  loginMessages: 'apps/mobile/src/auth/loginMessages.ts',
  fixtures: 'packages/auth-client/fixtures/loginScenarios.ts',
  nativeSocial: 'apps/mobile/src/auth/nativeSocial.ts',
  cnPhone: 'apps/mobile/src/auth/cnPhone.ts',
  identifierMethod: 'apps/mobile/src/auth/loginIdentifierMethod.ts',
  legalLinks: 'apps/mobile/src/config/legalLinks.ts',
};
const mTokensSrc = readSrc(M.tokens);
const mSkinSrc = readSrc(M.skinLayout);
const mLoginSrc = readSrc(M.loginTsx);
const mSkinControlsSrc = readSrc(M.skinControls);
const mPrimSrc = readSrc(M.primitives);
const mMsgsSrc = readSrc(M.loginMessages);
const mFixturesSrc = readSrc(M.fixtures);
const mNativeSrc = readSrc(M.nativeSocial);
const mCnPhoneSrc = readSrc(M.cnPhone);
const mIdMethodSrc = readSrc(M.identifierMethod);
const mLegalSrc = readSrc(M.legalLinks);

const mLoginSizesObj = extractConstObject(mTokensSrc, 'loginSizes');
const mSpacingObj = extractConstObject(mTokensSrc, 'spacing');
const mRadiusObj = extractConstObject(mTokensSrc, 'radius');
const mTypeObj = extractConstObject(mTokensSrc, 'typeScale');
const mLineObj = extractConstObject(mTokensSrc, 'lineHeight');
const mGroupObj = extractConstObject(mSkinSrc, 'LOGIN_GROUP');
const mTitleObj = extractConstObject(mSkinSrc, 'LOGIN_TITLE');
const mControlObj = extractConstObject(mSkinSrc, 'LOGIN_CONTROL');
const mSocialObj = extractConstObject(mSkinSrc, 'LOGIN_SOCIAL');
const mConsentObj = extractConstObject(mSkinSrc, 'LOGIN_CONSENT_ROW');
const mShortObj = extractConstObject(mSkinSrc, 'LOGIN_STAGE_SHORT');
const mLongObj = extractConstObject(mSkinSrc, 'LOGIN_STAGE_LONG');
const mStageWidth = Number(/LOGIN_STAGE_WIDTH\s*=\s*(\d+)/.exec(mSkinSrc)[1]);

// mobile 横幅样式块(deletionStatus/title/copy)——结构事实:无 position、无 backgroundColor
const mBannerBlock = /deletionStatus: \{([\s\S]*?)\}/.exec(mLoginSrc);
if (!mBannerBlock) throw new Error('mobile deletionStatus 样式块未命中');
if (/position|zIndex|backgroundColor/.test(mBannerBlock[1]))
  throw new Error('mobile deletionStatus 样式块出现了 position/zIndex/backgroundColor——bug 前提变化,需重新复核');
const mRenderOrderM = /\{accountDeletionStatus \? \([\s\S]{0,700}?<AccountDeletionStatusPanel[\s\S]{0,700}?: null\}\s*\{stateContent\}/.exec(mLoginSrc);
if (!mRenderOrderM) throw new Error('mobile 渲染顺序(横幅→stateContent)结构未命中');
const mPanelBlock = /panel: \{([\s\S]*?)\}/.exec(mSkinControlsSrc);
if (!mPanelBlock || !/position: 'absolute'/.test(mPanelBlock[1]) || !/top: 0/.test(mPanelBlock[1]))
  throw new Error('mobile panel absolute top 0 结构未命中');
// mobile 社交行结构事实:absolute top LOGIN_SOCIAL.y;count=apple?+nonApple+1(SSO),无 guest
const mSocialRowBlock = /socialRow: \{([\s\S]*?)\}/.exec(mSkinControlsSrc);
if (!mSocialRowBlock || !/position: 'absolute'/.test(mSocialRowBlock[1]) || !/top: LOGIN_SOCIAL\.y/.test(mSocialRowBlock[1]))
  throw new Error('mobile socialRow absolute top=LOGIN_SOCIAL.y 结构未命中');
const mSocialCountM = /count=\{\s*\(socialProviders\.includes\('apple'\) \? 1 : 0\) \+\s*nonAppleProviders\.length \+\s*1\s*\}/.exec(mLoginSrc);
if (!mSocialCountM) throw new Error('mobile 社交行 count 公式(apple?+nonApple+1)未命中');
// mobile consent 行结构事实
const mConsentRowM = /top: LOGIN_CONSENT_ROW\.y - pressExpand/.exec(mSkinControlsSrc);
if (!mConsentRowM) throw new Error('mobile LoginConsentRow top=LOGIN_CONSENT_ROW.y-pressExpand 结构未命中');
// mobile consent 对勾 path(ConsentCheckGlyph,与桌面同 d)
const mCheckPathM = /d="(M6\.6 10\.4 L9\.3 12\.9 L15 8\.2)"/.exec(mSkinControlsSrc);
if (!mCheckPathM) throw new Error('mobile ConsentCheckGlyph path 未命中');

// loginPalettes 双模式 panel/panelBg/bgBase 等
const mPalettesObj = extractConstObject(mTokensSrc, 'loginPalettes');
function paletteVal(mode, key) {
  const modeBlock = new RegExp(`${mode}: \\{([\\s\\S]*?)\\n  \\}`).exec(mPalettesObj);
  if (!modeBlock) throw new Error(`loginPalettes.${mode} 块未命中`);
  const m = new RegExp(`\\b${key}:\\s*'([^']+)'`).exec(modeBlock[1]);
  if (!m) throw new Error(`loginPalettes.${mode}.${key} 未命中`);
  return m[1];
}

// loginMessages 四语(顺序 zh-CN/en/ja/ko = 文件内 message 块顺序)
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
    identifierTitle: msgValues('title')[i],
    identifierPlaceholder: msgValues('phonePlaceholder')[i],
    emailPlaceholder: msgValues('emailPlaceholder')[i],
    identifierContinue: msgValues('continue')[i],
    consentStatement: msgValues('consentStatement')[i],
    ssoEntry: msgValues('ssoEntry')[i],
    socialApple: msgValues('apple')[i],
    socialGoogle: msgValues('google')[i],
    socialWechat: msgValues('wechat')[i],
  };
}

// mobile compact 按钮(dismiss):fullButton 覆盖 minHeight 48,compact minHeight 38/paddingH md
const fullButtonMinHeight = Number(/fullButton: \{ minHeight: (\d+),/.exec(mLoginSrc)[1]);
const compactPadH = Number(/mainActionButtonCompact: \{[\s\S]*?paddingHorizontal: spacing\.(\w+)/.exec(mPrimSrc)[1] === 'md' ? numField(mSpacingObj, 'md') : 0);
if (!compactPadH) throw new Error('mainActionButtonCompact paddingHorizontal 未命中');
// MainWindowActionButton 基础样式(结构事实:无边距填充=透明底,secondary 默认 tone)
const mActionBtnBlock = /mainActionButton: \{([\s\S]*?)\}/.exec(mPrimSrc);
if (!mActionBtnBlock || !/borderColor: colors\.border/.test(mActionBtnBlock[1]) || !/borderRadius: radius\.pill/.test(mActionBtnBlock[1]))
  throw new Error('MainWindowActionButton 基础样式块(border/radius.pill)未命中');
if (/backgroundColor/.test(mActionBtnBlock[1]))
  throw new Error('MainWindowActionButton 出现了 backgroundColor——dismiss 按钮底色前提变化,需复核');
const pillRadius = numField(mRadiusObj, 'pill');

// mobile fixtures 默认 providers.social(两区)
const socialFixM = /social:\s*region === "cn" \? \[(.*?)\] : \[(.*?)\]/.exec(mFixturesSrc);
if (!socialFixM) throw new Error('loginScenarios.ts 默认 providers.social 未命中');
const parseSocial = (s) => [...s.matchAll(/"(\w+)"/g)].map((m) => m[1]);
// apple iOS-only(结构事实)
const appleIosM = /if \(provider === 'apple'\) return Platform\.OS === 'ios'/.exec(mNativeSrc);
if (!appleIosM) throw new Error('nativeSocial apple iOS-only 判定未命中');
// +86 前缀
const cnPrefixM = /CN_PHONE_PREFIX = '([^']+)'/.exec(mCnPhoneSrc);
if (!cnPrefixM) throw new Error('CN_PHONE_PREFIX 未命中');
// mobile identifier 形态(与桌面同规则)
const mIdMethodM = /region === 'global' \? 'email' : 'phone'/.exec(mIdMethodSrc);
if (!mIdMethodM) throw new Error('mobile resolveIdentifierMethod 区域首选规则未命中');
// mobile 协议链接(两区)
const mCnLinksM = /cn[^}]*terms[^'"]*['"]?(https?:\/\/protocol\.xd\.cn\/cindy\/agreement\.html)/s.exec(mLegalSrc) || /(https?:\/\/protocol\.xd\.cn\/cindy\/agreement\.html)/.exec(mLegalSrc);
const mPrivacyCnM = /(https?:\/\/protocol\.xd\.cn\/cindy\/privacy-1\.0\.html)/.exec(mLegalSrc);
const mTermsGlM = /(https?:\/\/protocol\.xd\.com\/cindy\/agreement-1\.0\.html)/.exec(mLegalSrc);
const mPrivacyGlM = /(https?:\/\/protocol\.xd\.com\/cindy\/privacy\.html)/.exec(mLegalSrc);
if (!mPrivacyCnM || !mTermsGlM || !mPrivacyGlM) throw new Error('mobile legalLinks 两区 URL 未命中');

// mobile 社交图标 SVG path(LoginSkinControls 逐函数;厂商品牌色为字面值)
function svgPathsOf(fnName) {
  const start = mSkinControlsSrc.indexOf(`function ${fnName}`);
  if (start === -1) throw new Error(`未找到 function ${fnName}`);
  const braceStart = mSkinControlsSrc.indexOf('{', start);
  let depth = 0, end = -1;
  for (let i = braceStart; i < mSkinControlsSrc.length; i++) {
    if (mSkinControlsSrc[i] === '{') depth++;
    else if (mSkinControlsSrc[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  const body = mSkinControlsSrc.slice(braceStart, end + 1);
  const paths = [...body.matchAll(/d="([^"]+)"/g)].map((m) => m[1]);
  if (!paths.length) throw new Error(`${fnName} 内未找到 svg path`);
  const fills = [...body.matchAll(/fill="(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1]);
  const vb = /viewBox="([^"]+)"/.exec(body)?.[1] ?? null;
  return { body, paths, fills, viewBox: vb };
}
const googleIco = svgPathsOf('GoogleIcon');
const wechatIco = svgPathsOf('WeChatIcon');
const ssoIco = svgPathsOf('SsoIcon');
const appleIco = svgPathsOf('AppleLogoGlyph');
const ssoFillTri = /const fill = mode === 'dark' \? '([^']+)' : '([^']+)';/.exec(ssoIco.body);
if (!ssoFillTri) throw new Error('SsoIcon fill 三元未命中');

/* ══ truth 组装 ══ */
const truth = {
  structure: {
    desk: {
      bannerParent: leaf('login-group(LoginStage children 首子,{node} 紧随其后)', P.loginPage, 'LoginPage.tsx:964-977 {accountDeletionStatus && <AccountDeletionStatusPanel/>}{node}'),
      bannerPosition: leaf('static(文档流内,无 absolute/z-index)', P.loginPage, `AccountDeletionStatusPanel section className="${bannerClassM[1]}"`),
      panelPosition: leaf('absolute left-0 top-0', P.loginControls, `LoginPanel className="${panelClassM[1]}"`),
      panelDomOrder: leaf('横幅在 DOM 上先于面板;面板 positioned 后绘制,叠于流内静态元素之上', P.loginPage, 'LoginPage.tsx:964-977 兄弟顺序'),
      threeSiblings: leaf('横幅 / 面板 / 社交行同为 login-group(680×560,scale 0.5)直接子节点:横幅流内 static,面板与社交行各自 absolute', P.loginPage, 'LoginPage.tsx:953-978 LoginStage children + renderIdentifier:369-486'),
      socialRowPosition: leaf('absolute top=SOCIAL.y=480(与面板顶 0 同一组坐标系)', P.loginControls, 'LoginControls.tsx:393-407 LoginSocialRow style top:SOCIAL.y'),
      socialCountFormula: leaf('count = providers.social.length + 2(企业 SSO 钮 + 游客钮)', P.loginPage, 'LoginPage.tsx:420 <LoginSocialRow count={providers.social.length + 2}>'),
      socialProvidersNote: leaf('providers.social 为服务端下发数据(非仓内常量);demo 按桌面基线服务端仿真口径:cn=[apple,wechat],global=[apple,google]', P.loginPage, 'LoginPage.tsx:1012-1015 注释(服务端 providers.social 驱动显隐)'),
      globalPillGate: leaf("仅 global 构建显示(isGlobalBuild=VITE_CINDY_AUTH_REGION==='global');cn 构建无徽标", P.loginPage, "LoginPage.tsx:378 globalPill={isGlobalBuild ? t('login.globalRegion') : undefined}"),
      footerGate: leaf("localMode 页脚仅 loginState.step==='error' 渲染;identifier 态无页脚", P.loginPage, "LoginPage.tsx:202 showLocalModeFooter = loginState?.step === 'error'"),
    },
    mobile: {
      bannerParent: leaf('680 宽设计 px 容器(position:absolute,top:0)首子,{stateContent} 紧随其后', M.loginTsx, 'login.tsx:1179-1189 {accountDeletionStatus ? <AccountDeletionStatusPanel/> : null}{stateContent}'),
      bannerPosition: leaf('relative(RN 默认,在流内);无 zIndex;无 backgroundColor', M.loginTsx, 'login.tsx:1419-1425 makeStyles.deletionStatus'),
      panelPosition: leaf("absolute, top: 0, left: 0", M.skinControls, 'LoginSkinControls.tsx:1314-1325 makeStyles.panel'),
      panelDomOrder: leaf('横幅先于面板;RN 后序兄弟绘制在上', M.loginTsx, 'login.tsx:1179-1189 兄弟顺序'),
      threeSiblings: leaf('横幅 / 面板 / 社交行同在 680 宽设计 px 缩放容器内:横幅流内,面板 absolute top:0,社交行 absolute top:480', M.loginTsx, 'login.tsx:1168-1190 缩放容器 children + renderIdentifier:442-581'),
      socialRowPosition: leaf('absolute top=LOGIN_SOCIAL.y=480(与桌面同 y、同 80×80、同 gap 70,两端同构)', M.skinControls, 'LoginSkinControls.tsx:1423-1429 makeStyles.socialRow'),
      socialCountFormula: leaf("count = (apple?1:0) + nonAppleProviders.length + 1(SSO);无游客钮(产品拍板 2026-07-24)", M.loginTsx, 'login.tsx:504-571 LoginSocialRow count'),
      dismissButton: leaf('MainWindowActionButton density=compact + fullButton(minHeight 48,minWidth 0);RN 列容器默认 stretch → 全宽;透明底(无 backgroundColor)+ border 描边 + radius.pill', M.loginTsx, 'login.tsx:1297-1307 + :1505 styles.fullButton + MobilePrimitives.tsx:975-989'),
    },
  },
  desk: {
    geometry: {
      stage: leafFields({ width: numField(stageObj, 'width'), height: numField(stageObj, 'height') }, P.tokens, 'STAGE'),
      group: leafFields({ x: numField(loginGroupObj, 'x'), yDefault: numField(loginGroupObj, 'yDefault'), width: numField(loginGroupObj, 'width'), height: numField(loginGroupObj, 'height') }, P.tokens, 'LOGIN_GROUP'),
      panel: leafFields(
        { width: numField(panelObj, 'width'), height: numField(panelObj, 'height'), radius: numField(panelObj, 'radius'), top: 0, left: 0 },
        P.tokens,
        'PANEL',
        { top: 'PANEL.top=0(由 LoginControls.tsx:48 absolute left-0 top-0)', left: 'PANEL.left=0(同左)' },
      ),
      panelFixedScale: leaf(panelFixedScale, P.scale, 'PANEL_FIXED_SCALE'),
      title: leafFields({ y: numField(titleObj, 'y'), height: numField(titleObj, 'height'), fontSize: numField(titleObj, 'fontSize') }, P.tokens, 'TITLE'),
      subtitle: leafFields({ x: numField(subtitleObj, 'x'), y: numField(subtitleObj, 'y'), width: numField(subtitleObj, 'width'), fontSize: numField(subtitleObj, 'fontSize'), lineHeight: numField(subtitleObj, 'lineHeight'), maxLines: numField(subtitleObj, 'maxLines') }, P.tokens, 'SUBTITLE'),
      control: leafFields({ x: numField(controlObj, 'x'), inputY: numField(controlObj, 'inputY'), buttonY: numField(controlObj, 'buttonY'), width: numField(controlObj, 'width'), height: numField(controlObj, 'height'), radius: numField(controlObj, 'radius'), fontSize: numField(controlObj, 'fontSize'), textPadLeft: numField(controlObj, 'textPadLeft') }, P.tokens, 'CONTROL'),
      social: leafFields({ y: numField(socialObj, 'y'), size: numField(socialObj, 'size'), gap: numField(socialObj, 'gap'), radius: numField(socialObj, 'radius'), iconSize: numField(socialObj, 'iconSize') }, P.tokens, 'SOCIAL'),
      consentRow: leafFields(
        {
          y: numField(consentRowObj, 'y'),
          width: numField(consentRowObj, 'width'),
          height: numField(consentRowObj, 'height'),
          gap: numField(consentRowObj, 'gap'),
          fontSize: numField(consentRowObj, 'fontSize'),
          lineHeight: 23,
          radioHitSize: numField(consentRowObj, 'hitSize'),
          radioRingSize: numField(consentRowObj, 'ringSize'),
          radioRingRadius: numField(consentRowObj, 'ringRadius'),
          radioRingStroke: numField(consentRowObj, 'ringStroke'),
        },
        P.tokens,
        'CONSENT_ROW',
        {
          lineHeight: 'CONSENT_ROW 文字行高 23(LoginControls.tsx:745 lineHeight:"23px")',
          radioHitSize: 'CONSENT_ROW.radio.hitSize',
          radioRingSize: 'CONSENT_ROW.radio.ringSize',
          radioRingRadius: 'CONSENT_ROW.radio.ringRadius',
          radioRingStroke: 'CONSENT_ROW.radio.ringStroke',
        },
      ),
      globalPill: leafFields(
        { width: numField(globalPillObj, 'width'), height: numField(globalPillObj, 'height'), radius: numField(globalPillObj, 'radius'), gap: numField(globalPillObj, 'gap'), fontSize: 16 },
        P.tokens,
        'GLOBAL_PILL',
        { fontSize: 'Global 徽标 fontSize:16(LoginControls.tsx:118 inline style 字面量)' },
      ),
      localMode: leafFields({ gap: numField(localModeObj, 'gap'), reservedHeight: numField(localModeObj, 'reservedHeight'), descriptionLineHeight: numField(localModeObj, 'descriptionLineHeight') }, P.tokens, 'LOGIN_LOCAL_MODE'),
      banner: leafFields(
        {
          marginBottom: TW(5), // mb-5
          radius: 12, // rounded-xl
          borderWidth: 1, // border
          padX: TW(4), // px-4
          padY: TW(3), // py-3
          titleFontSize: text14, // text-14
          titleWeight: 500, // font-medium
          copyMarginTop: TW(1), // mt-1
          copyFontSize: text12, // text-12
          copyLineHeight: TW(5), // leading-5
          dismissMarginTop: TW(2), // mt-2
          dismissFontSize: text12, // text-12
          dismissPadX: TW(2), // px-2
          dismissPadY: TW(1), // py-1
        },
        P.loginPage,
        'AccountDeletionStatusPanel(tailwind)',
        {
          marginBottom: 'mb-5=20(tailwind spacing×4)',
          radius: 'rounded-xl=12',
          borderWidth: 'border=1',
          padX: 'px-4=16',
          padY: 'py-3=12',
          titleFontSize: 'text-14(globals.css --text-14)',
          titleWeight: 'font-medium=500',
          copyMarginTop: 'mt-1=4',
          copyFontSize: 'text-12(globals.css --text-12)',
          copyLineHeight: 'leading-5=20',
          dismissMarginTop: 'mt-2=8',
          dismissFontSize: 'text-12',
          dismissPadX: 'px-2=8',
          dismissPadY: 'py-1=4',
        },
      ),
    },
    colors: (() => {
      const c = (name) => extractRegisterColor(colorsSrc, name);
      const out = {};
      for (const [key, token] of [
        ['bgBase', 'login-bg-base'],
        ['panelBg', 'login-panel-bg'],
        ['panelBorder', 'login-panel-border'],
        ['bannerBg', 'surface-chip'],
        ['bannerBorder', 'border-default'],
        ['titleText', 'login-title-text'],
        ['secondaryText', 'login-secondary-text'],
        ['controlBg', 'login-control-bg'],
        ['controlBorder', 'login-control-border'],
        ['controlText', 'login-control-text'],
        ['controlPlaceholder', 'login-control-placeholder'],
        ['primaryButtonBg', 'login-primary-button-bg'],
        ['primaryButtonBorder', 'login-primary-button-border'],
        ['primaryButtonText', 'login-primary-button-text'],
        ['bannerTitleText', 'text-primary'],
        ['bannerCopyText', 'text-secondary'],
        ['consentRadioBg', 'login-consent-radio-bg'],
        ['consentRadioBorder', 'login-consent-radio-border'],
        ['consentRadioCheckedBg', 'login-consent-radio-checked-bg'],
        ['consentRadioCheck', 'login-consent-radio-check'],
        ['appleCircleBg', 'login-apple-circle-bg'],
        ['brandAccent', 'login-brand-accent'],
        ['invertedButtonBorder', 'login-inverted-button-border'],
        ['linkText', 'login-link-text'],
      ]) {
        out[key] = {
          light: leaf(c(token).light, P.colors, `registerColor('${token}').light`),
          dark: leaf(c(token).dark, P.colors, `registerColor('${token}').dark`),
        };
      }
      return out;
    })(),
    icons: {
      apple: { light: svgLeaf('apple'), dark: svgLeaf('apple-dark') },
      google: { light: svgLeaf('google'), dark: svgLeaf('google') },
      wechat: { light: svgLeaf('wechat'), dark: svgLeaf('wechat') },
      sso: { light: svgLeaf('sso'), dark: svgLeaf('sso-dark') },
      guest: { light: svgLeaf('guest'), dark: svgLeaf('guest-dark') },
      consentCheck: {
        d: leaf(checkPathM[1], P.loginControls, 'ConsentCheckGlyph path d'),
        stroke: leaf(3, P.loginControls, 'ConsentCheckGlyph strokeWidth=3'),
      },
    },
    constants: {
      identifierMethod: {
        cn: leaf('phone', P.identifierMethod, "resolveIdentifierMethod:region!=='global'→phone(providers 双 true 仿真)"),
        global: leaf('email', P.identifierMethod, "resolveIdentifierMethod:region==='global'→email(providers 双 true 仿真)"),
      },
      legalLinks: {
        cn: leaf({ terms: cnLinksM[1], privacy: cnLinksM[2] }, P.legalLinks, 'CN_LEGAL_LINKS'),
        global: leaf({ terms: globalLinksM[1], privacy: globalLinksM[2] }, P.legalLinks, 'GLOBAL_LEGAL_LINKS'),
      },
    },
    copy: Object.fromEntries(
      DESK_COPY_LOCALES.map((loc) => [loc, leaf(deskCopy[loc], P.commonJson(loc), 'accountDeletion.status.* + login.{title,subtitle,phonePlaceholder,emailPlaceholder,continue,consentStatement,globalRegion,ssoEntry,socialButton,social.*,localMode*}')]),
    ),
  },
  mobile: {
    geometry: {
      stageWidth: leaf(mStageWidth, M.skinLayout, 'LOGIN_STAGE_WIDTH'),
      group: leafFields({ x: numField(mGroupObj, 'x'), width: numField(mGroupObj, 'width'), height: numField(mGroupObj, 'height') }, M.skinLayout, 'LOGIN_GROUP'),
      panel: leafFields(
        { width: numField(mLoginSizesObj, 'panelWidth'), height: numField(mLoginSizesObj, 'panelHeight'), radius: numField(mLoginSizesObj, 'panelRadius'), top: 0, left: 0 },
        M.tokens,
        'loginSizes.panel',
        { top: 'panel.top=0(由 LoginSkinControls.tsx:1323)', left: 'panel.left=0(由 LoginSkinControls.tsx:1320)' },
      ),
      flowHeight: leaf(numField(mLoginSizesObj, 'flowHeight'), M.tokens, 'loginSizes.flowHeight'),
      stageShort: leafFields({ designHeight: numField(mShortObj, 'designHeight'), loginY: numField(mShortObj, 'loginY') }, M.skinLayout, 'LOGIN_STAGE_SHORT'),
      stageLong: leafFields({ designHeight: numField(mLongObj, 'designHeight'), loginY: numField(mLongObj, 'loginY') }, M.skinLayout, 'LOGIN_STAGE_LONG'),
      title: leafFields({ y: numField(mTitleObj, 'y'), height: numField(mTitleObj, 'height'), fontSize: numField(mTitleObj, 'font') }, M.skinLayout, 'LOGIN_TITLE'),
      control: leafFields({ x: numField(mControlObj, 'x'), inputY: numField(mControlObj, 'inputY'), buttonY: numField(mControlObj, 'buttonY'), width: numField(mControlObj, 'width'), height: numField(mControlObj, 'height'), radius: numField(mControlObj, 'radius'), fontSize: numField(mControlObj, 'font'), textPadLeft: numField(mControlObj, 'textPadLeft') }, M.skinLayout, 'LOGIN_CONTROL'),
      social: leafFields({ y: numField(mSocialObj, 'y'), size: numField(mSocialObj, 'size'), gap: numField(mSocialObj, 'gap'), iconSize: numField(mSocialObj, 'icon') }, M.skinLayout, 'LOGIN_SOCIAL'),
      consentRow: leafFields(
        {
          y: numField(mConsentObj, 'y'),
          width: numField(mConsentObj, 'width'),
          height: numField(mConsentObj, 'height'),
          gap: numField(mConsentObj, 'gap'),
          fontSize: numField(mConsentObj, 'font'),
          lineHeight: numField(mConsentObj, 'lineHeight'),
          bottomOverflow: numField(mConsentObj, 'bottomOverflow'),
          radioHitSize: numField(mConsentObj, 'hitSize'),
          radioRingSize: numField(mConsentObj, 'ringSize'),
          radioRingRadius: numField(mConsentObj, 'ringRadius'),
          radioRingStroke: numField(mConsentObj, 'ringStroke'),
          radioPressSize: numField(mConsentObj, 'pressSize'),
          radioCheckStroke: numField(mConsentObj, 'checkStroke'),
          rowTop: numField(mConsentObj, 'y') - (numField(mConsentObj, 'pressSize') - numField(mConsentObj, 'height')),
        },
        M.skinLayout,
        'LOGIN_CONSENT_ROW',
        {
          radioHitSize: 'LOGIN_CONSENT_ROW.radio.hitSize',
          radioRingSize: 'LOGIN_CONSENT_ROW.radio.ringSize',
          radioRingRadius: 'LOGIN_CONSENT_ROW.radio.ringRadius',
          radioRingStroke: 'LOGIN_CONSENT_ROW.radio.ringStroke',
          radioPressSize: 'LOGIN_CONSENT_ROW.radio.pressSize',
          radioCheckStroke: 'LOGIN_CONSENT_ROW.radio.checkStroke',
          rowTop: '行容器顶 = y-(pressSize-height)(LoginSkinControls.tsx:199 top:LOGIN_CONSENT_ROW.y-pressExpand;常量均在 loginSkinLayout.ts)',
        },
      ),
      banner: leafFields(
        {
          borderWidth: 1, // StyleSheet.hairlineWidth ≈ 1 design px
          radius: numField(mRadiusObj, 'control'), // radius.control
          pad: numField(mSpacingObj, 'md'), // padding: spacing.md
          gap: numField(mSpacingObj, 'sm'), // gap: spacing.sm
          titleFontSize: numField(mTypeObj, 'body'), // typeScale.body
          titleWeight: 600, // fontWeight.semibold
          copyFontSize: numField(mTypeObj, 'footnote'), // typeScale.footnote
          copyLineHeight: numField(mLineObj, 'caption'), // lineHeight.caption
          dismissMinHeight: fullButtonMinHeight, // styles.fullButton 覆盖 compact 38
          dismissPadX: compactPadH,
          dismissFontSize: numField(mTypeObj, 'caption'), // mainActionButtonTextCompact
          dismissRadius: pillRadius, // radius.pill
        },
        M.loginTsx,
        'makeStyles.deletionStatus*',
        {
          borderWidth: 'StyleSheet.hairlineWidth≈1(deletionStatus.borderWidth)',
          radius: 'deletionStatus.borderRadius=radius.control',
          pad: 'deletionStatus.padding=spacing.md',
          gap: 'deletionStatus.gap=spacing.sm',
          titleFontSize: 'deletionStatusTitle.fontSize=typeScale.body',
          titleWeight: 'deletionStatusTitle.fontWeight=semibold=600',
          copyFontSize: 'deletionStatusCopy.fontSize=typeScale.footnote',
          copyLineHeight: 'deletionStatusCopy.lineHeight=lineHeight.caption',
          dismissMinHeight: 'fullButton.minHeight(login.tsx:1505,覆盖 compact 38)',
          dismissPadX: 'mainActionButtonCompact.paddingHorizontal=spacing.md',
          dismissFontSize: 'mainActionButtonTextCompact.fontSize=typeScale.caption',
          dismissRadius: 'mainActionButton.borderRadius=radius.pill',
        },
      ),
    },
    colors: (() => {
      const out = {};
      for (const key of ['bgBase', 'panelBg', 'panelBorder', 'titleText', 'secondaryText', 'controlBg', 'controlBorder', 'controlText', 'controlPlaceholder', 'primaryButtonBg', 'primaryButtonBorder', 'primaryButtonText', 'consentRadioBg', 'consentRadioBorder', 'consentRadioCheckedBg', 'consentRadioCheck', 'appleCircleBg', 'appleLogoInk', 'brandAccent', 'invertedButtonBorder', 'linkText']) {
        out[key] = {
          light: leaf(paletteVal('light', key), M.tokens, `loginPalettes.light.${key}`),
          dark: leaf(paletteVal('dark', key), M.tokens, `loginPalettes.dark.${key}`),
        };
      }
      const textPrimary = extractThemeColorPair(mTokensSrc, 'textPrimary');
      const textSecondary = extractThemeColorPair(mTokensSrc, 'textSecondary');
      const borderStrong = extractThemeColorPair(mTokensSrc, 'borderStrong');
      const border = extractThemeColorPair(mTokensSrc, 'border');
      out.bannerTitleText = { light: leaf(textPrimary.light, M.tokens, 'ThemeColors.light.textPrimary'), dark: leaf(textPrimary.dark, M.tokens, 'ThemeColors.dark.textPrimary') };
      out.bannerCopyText = { light: leaf(textSecondary.light, M.tokens, 'ThemeColors.light.textSecondary'), dark: leaf(textSecondary.dark, M.tokens, 'ThemeColors.dark.textSecondary') };
      out.bannerBorder = { light: leaf(borderStrong.light, M.tokens, 'ThemeColors.light.borderStrong'), dark: leaf(borderStrong.dark, M.tokens, 'ThemeColors.dark.borderStrong') };
      out.dismissBorder = { light: leaf(border.light, M.tokens, 'ThemeColors.light.border'), dark: leaf(border.dark, M.tokens, 'ThemeColors.dark.border') };
      out.bannerBg = {
        light: leaf('transparent', M.loginTsx, 'makeStyles.deletionStatus 无 backgroundColor(横幅无底色)'),
        dark: leaf('transparent', M.loginTsx, 'makeStyles.deletionStatus 无 backgroundColor(横幅无底色)'),
      };
      out.dismissBg = {
        light: leaf('transparent', M.primitives, 'mainActionButton 无 backgroundColor(secondary 默认 tone 透明底)'),
        dark: leaf('transparent', M.primitives, 'mainActionButton 无 backgroundColor(secondary 默认 tone 透明底)'),
      };
      return out;
    })(),
    icons: {
      apple: {
        viewBox: leaf(appleIco.viewBox, M.skinControls, 'AppleLogoGlyph Svg viewBox'),
        d: leaf(appleIco.paths[0], M.skinControls, 'AppleLogoGlyph Path d'),
      },
      google: {
        viewBox: leaf(googleIco.viewBox, M.skinControls, 'GoogleIcon Svg viewBox'),
        paths: leaf(googleIco.paths, M.skinControls, 'GoogleIcon Path d ×4'),
        fills: leaf(googleIco.fills, M.skinControls, 'GoogleIcon 品牌色字面值 ×4'),
      },
      wechat: {
        viewBox: leaf(wechatIco.viewBox, M.skinControls, 'WeChatIcon Svg viewBox'),
        d: leaf(wechatIco.paths[0], M.skinControls, 'WeChatIcon Path d'),
        fill: leaf(wechatIco.fills[0], M.skinControls, 'WeChatIcon 品牌绿字面值'),
      },
      sso: {
        viewBox: leaf(ssoIco.viewBox, M.skinControls, 'SsoIcon Svg viewBox'),
        paths: leaf(ssoIco.paths, M.skinControls, 'SsoIcon Path d ×3'),
        fillLight: leaf(ssoFillTri[2], M.skinControls, "SsoIcon fill light(mode==='dark'?…:'#EEEEEE')"),
        fillDark: leaf(ssoFillTri[1], M.skinControls, "SsoIcon fill dark(mode==='dark'?'#2A2828':…)"),
      },
      consentCheck: {
        d: leaf(mCheckPathM[1], M.skinControls, 'ConsentCheckGlyph path d'),
        stroke: leaf(numField(mConsentObj, 'checkStroke'), M.skinLayout, 'LOGIN_CONSENT_ROW.radio.checkStroke'),
      },
    },
    constants: {
      socialProviders: {
        cn: leaf(parseSocial(socialFixM[1]), M.fixtures, 'providersFor defaults social(cn)'),
        global: leaf(parseSocial(socialFixM[2]), M.fixtures, 'providersFor defaults social(global)'),
      },
      appleIosOnly: leaf(true, M.nativeSocial, "isNativeSocialProviderSupported:provider==='apple'→Platform.OS==='ios'"),
      cnPhonePrefix: leaf(cnPrefixM[1], M.cnPhone, 'CN_PHONE_PREFIX'),
      identifierMethod: {
        cn: leaf('phone', M.identifierMethod, "resolveIdentifierMethod:region!=='global'→phone(providers 双 true 仿真)"),
        global: leaf('email', M.identifierMethod, "resolveIdentifierMethod:region==='global'→email(providers 双 true 仿真)"),
      },
      legalLinks: {
        cn: leaf({ terms: 'https://protocol.xd.cn/cindy/agreement.html', privacy: mPrivacyCnM[1] }, M.legalLinks, 'cn 区协议链接'),
        global: leaf({ terms: mTermsGlM[1], privacy: mPrivacyGlM[1] }, M.legalLinks, 'global 区协议链接'),
      },
    },
    copy: Object.fromEntries(MSG_LOCALES.map((loc) => [loc, leaf(mCopy[loc], M.loginMessages, 'accountDeletion* + title/phonePlaceholder/emailPlaceholder/continue/consentStatement/ssoEntry/social(apple|google|wechat)')])),
  },
};

// 全部 provenance 源文件已读齐(hashes 的键集合)——落盘 _pinned/ 后再输出 truth
// (provenance.source 指向 _pinned/,校验器按磁盘复核 hash 时与 pinned 字节一致)。
dumpPinnedSources();

process.stdout.write(JSON.stringify(truth, null, 1) + '\n');
