/**
 * cardSanitizer.ts — 意识聊天卡片 HTML 净化器(卡槽③海报模式)。
 *
 * 设计原则:**白名单重建**,不是黑名单删除——输入只当 token 流读,输出由
 * 本文件重新序列化,凡不认识的标签/属性/URL 一概不落地。这样解析差异
 * (mXSS)攻击面收敛到"我们自己序列化的东西",而非"攻击者构造的原文"。
 *
 * 纵深关系:本文件是第一道(内容层);renderer 侧 iframe sandbox 不带
 * allow-scripts 是第二道(执行层,规范级硬禁);srcdoc 脚手架里的 meta CSP
 * 是第三道(子资源层)。本文件漏了什么,后两道兜底。
 *
 * 纯函数、零依赖、零 Electron —— main 进程无 DOM,不能用 DOMPurify/jsdom
 * (后者仅 devDependencies),故手写小型 tokenizer(规则 9:代码确定性)。
 */

import { parseGhostCardForm } from '@cindy/maker-shared/ghost-card-form';
import {
  GHOST_CARD_ACTION_ID_RE,
  GHOST_CARD_HTML_MAX_BYTES,
  GHOST_CARD_PROMPT_PLACEHOLDER_MAX_LEN,
  isGhostCardLinkAllowed,
} from '../../shared/ghost.js';

/** 允许保留(含子树)的标签。仅结构/排版/图片 + 交互按钮(v2,零脚本:
 *  点击由宿主受信桥委托,见 GhostToolCard.attachClickBridge);无脚本载体。
 *  外链只以声明式属性存在(data-ghost-link,<a href> 被转写、真实 href 永不
 *  落地),点击经宿主确认框才 openExternal——卡内无可导航链接。 */
const ALLOWED_TAGS = new Set([
  'div', 'span', 'p', 'h1', 'h2', 'h3', 'h4',
  'ul', 'ol', 'li',
  'strong', 'em', 'b', 'i', 'u', 's', 'small',
  'br', 'hr',
  'img', 'figure', 'figcaption',
  'blockquote', 'code', 'pre',
  'table', 'thead', 'tbody', 'tr', 'td', 'th',
  'section', 'header', 'footer',
  'style',
  'button',
  'a',
]);

/** 无内容自闭合标签。 */
const VOID_TAGS = new Set(['br', 'hr', 'img']);

/**
 * 连内容一起整体丢弃的标签(raw-text / 脚本载体 / 外来命名空间)。
 * 其余不认识的标签只拆壳留子(如 <a>丢链接壳、文字保留)。
 * plaintext 语义是"吞掉余下全部输入",单独处理。
 */
const DROP_WITH_CONTENT = new Set([
  'script', 'textarea', 'title', 'xmp', 'noscript', 'noembed', 'noframes',
  'iframe', 'object', 'embed', 'template', 'svg', 'math', 'select',
]);

/** img.src 唯一放行形态:本机媒体总仓图片地址(整串精确匹配)。 */
const IMG_SRC_RE = /^cindy-media:\/\/blobs\/[0-9a-f]{64}\.(?:png|jpe?g|gif|webp)$/;

/** img 的 data-ghost-model 唯一放行形态:媒体总仓 GLB 地址(整串精确匹配,
 *  与 img src 同一信任边界——内容寻址、只读协议)。声明后宿主点击桥把该
 *  预览图路由到应用内 3D 查看器(ModelLightbox)而非图片 lightbox。 */
const IMG_MODEL_RE = /^cindy-media:\/\/blobs\/[0-9a-f]{64}\.glb$/;

/** div 的 data-ghost-audio 唯一放行形态:媒体总仓音频地址(扩展名对齐
 *  blobStore 音频白名单)。声明后该 div 成为宿主托管的播放器插槽:宿主受信桥
 *  清空其子树、注入与基座 ChatAudioCard 同款的播放器行(播放/暂停 + 进度条
 *  scrub + 时间),<audio> 实体活在宿主文档、经全局媒体互斥总线管理——卡内
 *  仍零脚本,意识声明不了播放行为、只声明"这里放一个标准播放器"。 */
const AUDIO_SLOT_RE = /^cindy-media:\/\/blobs\/[0-9a-f]{64}\.(?:mp3|wav|m4a)$/;

/** data-ghost-audio-duration(可选):秒数,metadata 未加载前的时长占位。 */
const AUDIO_DURATION_RE = /^\d{1,5}(?:\.\d{1,2})?$/;

/** CSS url(...) 里唯一放行的形态(同上,允许可选引号由调用侧剥掉后匹配)。 */
const CSS_URL_ALLOWED_RE = /^cindy-media:\/\/blobs\/[0-9a-f]{64}\.(?:png|jpe?g|gif|webp)$/;

/**
 * 净化产物(双版本):
 * - html:静态版——动画全剥,落库持久化 / settle 后与历史回放用它,
 *   历史卡永远静止(规则 7);
 * - animatedHtml:动画版——保留意识自绘的 @keyframes/animation,仅当全部
 *   keyframes 只动 transform/opacity(合成器白名单,与主机自身动效同一
 *   性能标准)才产出;只随推送走、只在 running 期间装进画布,从不落库。
 *   源码无动画或校验不过 = 无此字段(renderer 回退主机扫光)。
 */
export type SanitizeCardResult =
  | { ok: true; html: string; animatedHtml?: string }
  | { ok: false; reason: string };

/** @keyframes 体内允许的属性(合成器动画白名单;其余出现即动画版作废)。 */
const KEYFRAME_ALLOWED_PROPS = new Set(['transform', 'opacity', 'animation-timing-function']);

/** CSS 处理选项:keepAnimations 时校验 keyframes,违规置 violated。 */
interface CssOpts {
  keepAnimations: boolean;
  violated: { v: boolean };
}

/** 校验全部 @keyframes 块只动白名单属性(动画版专用;不修改内容)。 */
function validateKeyframes(css: string, violated: { v: boolean }): void {
  // 名字位(@keyframes 与 { 之间)出现引号显式否决:字符串名没有正当理由,
  // 且带花括号的字符串名会让下面的块扫描失配(那种由计数守卫兜底)。这行
  // 让"keyframes 里出现引号即作废"成为精确契约,与 FORGE_GUIDE 措辞一致。
  if (/@[-a-z]*keyframes[^{]*['"]/i.test(css)) {
    violated.v = true;
    return;
  }
  const re = /@[-a-z]*keyframes[^{]*\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}/gi;
  let m: RegExpExecArray | null;
  let scanned = 0;
  while ((m = re.exec(css)) !== null) {
    scanned++;
    // 字符串字面量能藏花括号骗过本函数的块扫描(content:'}' 类边界混淆),
    // 而白名单属性(transform/opacity/timing-function)没有任何用引号的正当
    // 理由——keyframes 体内出现引号直接判违规。
    if (/['"]/.test(m[1])) {
      violated.v = true;
      return;
    }
    const declBlocks = m[1].match(/\{[^{}]*\}/g) ?? [];
    for (const block of declBlocks) {
      for (const decl of block.slice(1, -1).split(';')) {
        const prop = decl.split(':')[0]?.trim().toLowerCase();
        if (prop && !KEYFRAME_ALLOWED_PROPS.has(prop)) {
          violated.v = true;
          return;
        }
      }
    }
  }
  // 失配即违规:文本里出现的 @keyframes 数与块扫描实际扫到的数对不上,
  // 说明有块骗过了上面的正则(如字符串名 `@keyframes "a{"` 让 prelude 段
  // 吃进花括号导致整块免检)——一律 fail-closed,防"匹配失败 = 免检"。
  const total = (css.match(/@[-a-z]*keyframes/gi) ?? []).length;
  if (scanned !== total) violated.v = true;
}

function escapeText(s: string): string {
  // Preserve character references in text tokens. Never decode them before
  // tokenization: encoded markup must remain inert text, including on re-sanitize.
  return s.replace(/&(?!(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]*);)/gi, '&amp;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * CSS 值过滤(style 属性与 <style> 块共用):
 * - 注释先剥、反斜杠(CSS ident 转义)出现即整段拒——两者都能让下面的
 *   字面量匹配失明,而动画剥除没有 CSP 兜底,必须 fail-closed;
 * - `@import` / `expression(` 出现即整段拒(替换为空);
 * - `url(...)` 仅放行 cindy-media 图片地址,其余整个替换为 `none`;
 * - 剥控制字符,防解析歧义。
 */
/** 剥控制字符(NUL–0x1F 与 DEL),防解析歧义;逐字符实现,避免正则里写控制字符转义。 */
function stripControlChars(s: string): string {
  let r = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 32 && c !== 127) r += s[i];
  }
  return r;
}

function sanitizeCss(css: string, opts: CssOpts): string {
  let out = stripControlChars(css);
  // 注释先剥(无语义,零损失):`/**/` 可以插在任意 token 中间当空白骗过
  // 后续所有字面量正则(如 `;/**/animation:`),必须在一切匹配之前清场。
  out = out.replace(/\/\*[\s\S]*?\*\//g, '');
  // 反斜杠 fail-closed:CSS ident 转义(`anim\61tion:`、`@\6b eyframes`)能让
  // 字面量正则全部失明,而动画剥除没有 CSP 那样的后手兜底。海报 CSS 没有
  // 正当理由用转义,整段拒绝(与 @import 同款处理)。
  if (out.includes('\\')) return '';
  if (/@import/i.test(out) || /expression\s*\(/i.test(out)) return '';
  out = out.replace(/url\s*\(\s*(['"]?)([^)'"]*)\1\s*\)/gi, (_m, _q: string, inner: string) =>
    CSS_URL_ALLOWED_RE.test(inner.trim()) ? `url("${inner.trim()}")` : 'none',
  );
  if (opts.keepAnimations) {
    // 动画版:意识自绘动画放行,但 keyframes 体内只许 transform/opacity
    // (合成器白名单,违规整卡回退静态版)。本版本只随推送给活卡,不落库。
    // !important 一律拒:宿主的 reduced-motion 停播门控(srcdoc 脚手架的
    // *{animation:none!important})会被 inline important / 高特异性 important
    // 顶掉——动画版出现 important 即作废,回退主机扫光(扫光自带停播查询)。
    if (/!\s*important/i.test(out)) {
      opts.violated.v = true;
      return out;
    }
    validateKeyframes(out, opts.violated);
    return out;
  }
  // 静态版(落库/历史回放):掐 CSS 动画(规则 7:历史卡纯静态,常驻动画 =
  // 持续 CPU 泄漏,主机代码强制、不靠作者自觉):@keyframes 块整体剥除
  // (容一层嵌套花括号),animation / animation-* 声明剥除。transition
  // 保留——无脚本下只有 :hover 等瞬态能触发,属一次性过渡,不常驻。
  out = out.replace(/@[-a-z]*keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/gi, '');
  // 容 -webkit- 等厂商前缀:`-webkit-animation` 是 Blink 认的别名,不带前缀
  // 匹配会整体漏过。
  out = out.replace(/(^|[;{])\s*(?:-[a-z]+-)?animation[a-z-]*\s*:[^;}]*/gi, '$1');
  return out;
}

interface ParsedAttrs {
  [key: string]: string;
}

/** Decode the five standard HTML character references so parsed attribute values
 *  reflect their logical content before re-escaping. &amp; is decoded LAST to
 *  prevent double-unescaping (e.g. &amp;lt; must not become < in two steps). */
function decodeAttrEntities(s: string): string {
  return s
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

/** 解析开始标签的属性段(引号感知);畸形输入尽量吞掉不抛。 */
function parseAttrs(raw: string): ParsedAttrs {
  const attrs: ParsedAttrs = {};
  const re = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|[^\s"'>]+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const name = m[1].toLowerCase();
    let value = '';
    if (m[2] !== undefined) {
      if (m[3] !== undefined) value = m[3];
      else if (m[4] !== undefined) value = m[4];
      else value = m[2];
    }
    if (!(name in attrs)) attrs[name] = decodeAttrEntities(value);
  }
  return attrs;
}

/** 按标签挑出允许的属性并净化值;返回可直接拼接的属性串(含前导空格)或空串。 */
function sanitizeAttrs(tag: string, attrs: ParsedAttrs, opts: CssOpts): string | null {
  const parts: string[] = [];
  if (tag === 'div' && parseGhostCardForm(attrs['data-ghost-form'])) {
    parts.push(` data-ghost-form="${escapeAttr(attrs['data-ghost-form'])}"`);
    if (GHOST_CARD_ACTION_ID_RE.test(attrs['data-ghost-change'] || '')) parts.push(` data-ghost-change="${escapeAttr(attrs['data-ghost-change'])}"`);
  }
  const style = attrs['style'];
  if (typeof style === 'string' && style.length > 0) {
    const clean = sanitizeCss(style, opts);
    if (clean.length > 0) parts.push(` style="${escapeAttr(clean)}"`);
  }
  if (tag === 'img') {
    const src = (attrs['src'] ?? '').trim();
    // 图片地址不合白名单 → 整个 <img> 丢弃(返回 null 由调用侧处理)。
    if (!IMG_SRC_RE.test(src)) return null;
    parts.push(` src="${escapeAttr(src)}"`);
    const alt = attrs['alt'];
    if (typeof alt === 'string') parts.push(` alt="${escapeAttr(alt)}"`);
    for (const dim of ['width', 'height'] as const) {
      const v = (attrs[dim] ?? '').trim();
      if (/^\d{1,4}$/.test(v)) parts.push(` ${dim}="${v}"`);
    }
    // 3D 预览声明:点击该图 → 应用内 3D 查看器加载所指 GLB。不合法只丢
    // 属性(图退化为普通看大图),不牵连元素。
    const model = (attrs['data-ghost-model'] ?? '').trim();
    if (IMG_MODEL_RE.test(model)) parts.push(` data-ghost-model="${escapeAttr(model)}"`);
  }
  if (tag === 'td' || tag === 'th') {
    for (const span of ['colspan', 'rowspan'] as const) {
      const v = (attrs[span] ?? '').trim();
      if (/^\d{1,2}$/.test(v)) parts.push(` ${span}="${v}"`);
    }
  }
  // 播放器插槽:data-ghost-audio 仅挂 div(值不合法只丢属性,div 与子树保留)。
  // 插槽由宿主整体接管渲染,同元素上的 data-ghost-action 无意义,一并忽略
  // (子树反正会被宿主清空,动作声明放插槽里等于永远点不到)。
  let audioSlot = false;
  if (tag === 'div') {
    const audioDecl = (attrs['data-ghost-audio'] ?? '').trim();
    if (AUDIO_SLOT_RE.test(audioDecl)) {
      audioSlot = true;
      parts.push(` data-ghost-audio="${escapeAttr(audioDecl)}"`);
      const dur = (attrs['data-ghost-audio-duration'] ?? '').trim();
      if (AUDIO_DURATION_RE.test(dur)) parts.push(` data-ghost-audio-duration="${dur}"`);
    }
  }
  // 在线指示(data-ghost-live):空值属性,只挂 span / div。宿主给它播统一的呼吸光环
  // (transform + opacity,卡片不可见时暂停),卡内仍零动画源码,历史卡照样静态存档。
  if ((tag === 'span' || tag === 'div') && attrs['data-ghost-live'] !== undefined) parts.push(' data-ghost-live=""');
  // 位置声明(data-ghost-placement):只挂 div、只认 turn-end,宿主据此把卡排到本轮末尾
  // (isTurnEndGhostCardHtml)。其它值只丢属性。
  if (tag === 'div' && attrs['data-ghost-placement']?.trim() === 'turn-end') parts.push(' data-ghost-placement="turn-end"');
  // 宽度声明(data-ghost-width):只挂 div、只认 full,宿主据此让卡铺满消息列(isFullWidthGhostCardHtml)。
  if (tag === 'div' && attrs['data-ghost-width']?.trim() === 'full') parts.push(' data-ghost-width="full"');
  // 交互卡(v2):data-ghost-action 声明可点区域(任意允许标签都可挂)。
  // 值过 GHOST_CARD_ACTION_ID_RE 才落地——不合法只丢这条属性(元素与文字
  // 保留,只是点不动),不牵连整个元素。点击由宿主受信桥委托回传,卡内零脚本。
  const action = audioSlot ? '' : (attrs['data-ghost-action'] ?? '').trim();
  const actionValid = GHOST_CARD_ACTION_ID_RE.test(action);
  if (actionValid) {
    parts.push(` data-ghost-action="${escapeAttr(action)}"`);
    if (attrs['data-ghost-submit'] === 'true') parts.push(' data-ghost-submit="true"');
    // data-ghost-prompt:该动作需要用户输入文字(宿主点击时弹输入框收集,
    // 文字随 card-action 的 prompt 字段回传)。属性值 = 输入框占位文案
    // (可空;超限整属性丢)。只在动作合法时放行——无动作的输入声明无意义。
    const promptDecl = attrs['data-ghost-prompt'];
    if (typeof promptDecl === 'string' && promptDecl.length <= GHOST_CARD_PROMPT_PLACEHOLDER_MAX_LEN) {
      parts.push(` data-ghost-prompt="${escapeAttr(promptDecl)}"`);
    }
  }
  // 卡内外链(v3):data-ghost-link 声明"点击经宿主确认框后 openExternal"。
  // <a href> 转写为同一声明——真实 href 不落地(无脚本 iframe 里点真链接会把
  // 外部页面导航进卡片画布)。一元素一行为:合法动作/音频插槽在场即忽略;
  // 值必须整串 http/https(isGhostCardLinkAllowed),不合法只丢属性。
  if (!audioSlot && !actionValid) {
    const explicit = (attrs['data-ghost-link'] ?? '').trim();
    const linkDecl = explicit !== '' || tag !== 'a' ? explicit : (attrs['href'] ?? '').trim();
    if (isGhostCardLinkAllowed(linkDecl)) {
      parts.push(` data-ghost-link="${escapeAttr(linkDecl)}"`);
    }
  }
  if (tag === 'button') {
    // type 强制 button(挡 submit 语义);可选无障碍名与禁用态。
    parts.push(` type="button"`);
    const aria = attrs['aria-label'];
    if (typeof aria === 'string' && aria.length > 0 && aria.length <= 128) {
      parts.push(` aria-label="${escapeAttr(aria)}"`);
    }
    if ('disabled' in attrs) parts.push(` disabled`);
  }
  return parts.join('');
}

/** 从 pos 起寻找 `</name` 的关闭标签,返回其 '>' 之后的下标;找不到返回输入末尾。 */
function skipToClose(input: string, pos: number, name: string): number {
  const re = new RegExp(`</${name}(?=[\\s>/])|</${name}$`, 'ig');
  re.lastIndex = pos;
  const m = re.exec(input);
  if (!m) return input.length;
  const gt = input.indexOf('>', m.index);
  return gt === -1 ? input.length : gt + 1;
}

/**
 * 净化入口。永不抛异常;畸形 HTML 按"能救多少救多少"处理。
 * 输出保证:仅白名单标签、平衡闭合、属性经净化、文本已转义。
 * 双版本:html = 静态版(动画剥除);源码带动画且 keyframes 全过白名单
 * 校验时另出 animatedHtml(动画保留,仅供活卡)。
 */
export function sanitizeGhostCardHtml(html: string): SanitizeCardResult {
  const staticResult = rebuildGhostCardHtml(html, { keepAnimations: false, violated: { v: false } });
  if (!staticResult.ok) return staticResult;
  // 源码不含动画字面量就不做第二遍(常态零开销)。
  if (!/animation|@[-a-z]*keyframes/i.test(html)) return staticResult;
  const violated = { v: false };
  const animated = rebuildGhostCardHtml(html, { keepAnimations: true, violated });
  if (!animated.ok || violated.v || animated.html === staticResult.html) return staticResult;
  return { ok: true, html: staticResult.html, animatedHtml: animated.html };
}

/** 单版本重建(sanitizeGhostCardHtml 的工作体;opts 决定动画去留)。 */
function rebuildGhostCardHtml(
  html: string,
  opts: CssOpts,
): { ok: true; html: string } | { ok: false; reason: string } {
  if (typeof html !== 'string' || html.trim().length === 0) {
    return { ok: false, reason: 'empty' };
  }
  if (Buffer.byteLength(html, 'utf8') > GHOST_CARD_HTML_MAX_BYTES) {
    return { ok: false, reason: 'oversize' };
  }

  const out: string[] = [];
  const stack: string[] = [];
  let i = 0;
  const n = html.length;

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      out.push(escapeText(html.slice(i)));
      break;
    }
    if (lt > i) out.push(escapeText(html.slice(i, lt)));

    // 注释 / CDATA / DOCTYPE / 处理指令:整段丢弃。
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (html.startsWith('<![CDATA[', lt)) {
      const end = html.indexOf(']]>', lt + 9);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt);
      i = end === -1 ? n : end + 1;
      continue;
    }

    // 关闭标签。
    if (html.startsWith('</', lt)) {
      const m = /^<\/\s*([a-zA-Z][a-zA-Z0-9-]*)\s*>/.exec(html.slice(lt));
      if (!m) {
        // 畸形关闭:当文本转义输出 '<',继续。
        out.push('&lt;');
        i = lt + 1;
        continue;
      }
      const name = m[1].toLowerCase();
      const idx = stack.lastIndexOf(name);
      if (idx !== -1) {
        // 关到目标为止(隐式闭合中间层,保证输出平衡)。
        while (stack.length > idx) {
          out.push(`</${stack.pop()}>`);
        }
      }
      i = lt + m[0].length;
      continue;
    }

    // 开始标签。
    const m = /^<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/.exec(html.slice(lt));
    if (!m) {
      out.push('&lt;');
      i = lt + 1;
      continue;
    }
    const name = m[1].toLowerCase();
    const rawAttrs = m[2];
    const selfClosed = /\/\s*$/.test(rawAttrs);
    const afterTag = lt + m[0].length;

    if (name === 'plaintext') {
      // plaintext 吞掉余下全部输入 —— 直接结束。
      break;
    }
    if (DROP_WITH_CONTENT.has(name)) {
      i = selfClosed ? afterTag : skipToClose(html, afterTag, name);
      continue;
    }
    if (!ALLOWED_TAGS.has(name)) {
      // 不认识但无脚本载体:拆壳留子。
      i = afterTag;
      continue;
    }

    if (name === 'style') {
      // raw-text:收内容到 </style>,CSS 过滤后原样(不转义,CSS 不是 HTML)落地。
      const closeRe = /<\/style\s*>/gi;
      closeRe.lastIndex = afterTag;
      const cm = closeRe.exec(html);
      const cssEnd = cm ? cm.index : n;
      const clean = sanitizeCss(html.slice(afterTag, cssEnd), opts);
      // '<' 在 CSS 里无害,但为防序列化歧义仍剥掉闭合序列。
      const safe = clean.replace(/<\/(style)/gi, '');
      if (safe.trim().length > 0) out.push(`<style>${safe}</style>`);
      i = cm ? cm.index + cm[0].length : n;
      continue;
    }

    const attrs = sanitizeAttrs(name, parseAttrs(rawAttrs), opts);
    if (attrs === null) {
      // 属性校验判死(img 无合法 src):整元素丢弃。void 标签无内容可跳。
      i = afterTag;
      continue;
    }

    if (VOID_TAGS.has(name)) {
      out.push(`<${name}${attrs}/>`);
      i = afterTag;
      continue;
    }

    out.push(`<${name}${attrs}>`);
    if (!selfClosed) stack.push(name);
    else out.push(`</${name}>`);
    i = afterTag;
  }

  while (stack.length > 0) out.push(`</${stack.pop()}>`);

  const result = out.join('');
  if (result.trim().length === 0) return { ok: false, reason: 'empty-after-sanitize' };
  return { ok: true, html: result };
}
