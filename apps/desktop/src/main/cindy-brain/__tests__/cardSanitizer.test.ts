/**
 * cardSanitizer.test.ts — 意识聊天卡片 HTML 净化器单测(纯函数,无 Electron)。
 * 覆盖:脚本/事件属性/危险 URL 剥除、cindy-media 图片放行、CSS url/@import
 * 过滤、未知标签拆壳、raw-text 标签连内容丢弃、文本转义、体积上限、畸形
 * 输入不抛异常且输出平衡闭合。
 */

import { describe, expect, it } from 'vitest';

import { sanitizeGhostCardHtml } from '../cardSanitizer';
import { GHOST_CARD_HTML_MAX_BYTES } from '../../../shared/ghost';
import { readGhostCardForm } from '@cindy/maker-shared/ghost-card-form';

const HASH = 'a'.repeat(64);
const GOOD_IMG = `cindy-media://blobs/${HASH}.png`;

function ok(html: string): string {
  const r = sanitizeGhostCardHtml(html);
  expect(r.ok).toBe(true);
  return r.ok ? r.html : '';
}

describe('sanitizeGhostCardHtml', () => {
  it('permits inert form declarations without enabling native forms, scripts or navigation', () => {
    const fields = [{ name: 'body', label: 'Message', value: '<script>"&', multiline: true }];
    const encoded = JSON.stringify(fields).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const html = ok(`<div data-ghost-form="${encoded}" onclick="bad()">Preview</div><button data-ghost-action="save" data-ghost-submit="true" formaction="https://example.test">Save</button><input value="secret"><script>bad()</script>`);
    expect(readGhostCardForm(html)).toEqual(fields);
    expect(html).toContain('data-ghost-submit="true"');
    expect(html).not.toMatch(/onclick|formaction|<input|<script/);
    expect(ok('<div data-ghost-form="bad">Preview</div>')).not.toContain('data-ghost-form');
  });
  it('保留白名单结构与文本', () => {
    const out = ok('<div><p>你好 <strong>世界</strong></p></div>');
    expect(out).toBe('<div><p>你好 <strong>世界</strong></p></div>');
  });

  it('<script> 连内容整体剥除', () => {
    const out = ok('<div>前</div><script>alert(1)</script><div>后</div>');
    expect(out).toBe('<div>前</div><div>后</div>');
    expect(out).not.toContain('alert');
  });

  it('on* 事件属性剥除', () => {
    const out = ok('<div onclick="evil()" style="color:red">x</div>');
    expect(out).not.toContain('onclick');
    expect(out).toContain('style="color:red"');
  });

  it('img:cindy-media 地址放行,其它地址整元素丢弃', () => {
    expect(ok(`<img src="${GOOD_IMG}" alt="猫">`)).toBe(
      `<img src="${GOOD_IMG}" alt="猫"/>`,
    );
    const bad = sanitizeGhostCardHtml('<img src="https://evil.com/a.png">');
    expect(bad.ok).toBe(false); // 只剩空输出 → empty-after-sanitize
    const mixed = ok(`<p>t</p><img src="javascript:alert(1)">`);
    expect(mixed).toBe('<p>t</p>');
  });

  it('img 尺寸属性仅收纯数字', () => {
    const out = ok(`<img src="${GOOD_IMG}" width="400" height="30%">`);
    expect(out).toContain('width="400"');
    expect(out).not.toContain('height');
  });

  it('style 属性:外链 url 替换为 none,cindy-media url 放行', () => {
    const out = ok(
      `<div style="background:url(https://evil.com/x.png);color:blue">x</div>` +
        `<div style="background:url('${GOOD_IMG}')">y</div>`,
    );
    expect(out).not.toContain('evil.com');
    expect(out).toContain('background:none');
    expect(out).toContain(`url(&quot;${GOOD_IMG}&quot;)`);
  });

  it('<style> 块:@import 整段拒,url 过滤同 style 属性', () => {
    const out = ok('<style>@import "https://e.com/a.css"; .a{color:red}</style><p>x</p>');
    expect(out).not.toContain('@import');
    expect(out).toBe('<p>x</p>');
    const out2 = ok(`<style>.a{background:url(https://e.com/x.png)}</style><p>x</p>`);
    expect(out2).toContain('background:none');
  });

  it('未知标签拆壳留子(<article> 丢壳留文字)', () => {
    const out = ok('<article><marquee>点我</marquee></article>');
    expect(out).toBe('点我');
  });

  it('raw-text 危险标签连内容丢弃(iframe/svg/textarea)', () => {
    expect(ok('<p>a</p><iframe src="https://e.com"></iframe>')).toBe('<p>a</p>');
    expect(ok('<p>a</p><svg><script>1</script></svg>')).toBe('<p>a</p>');
    expect(ok('<p>a</p><textarea><img src=x onerror=1></textarea>')).toBe('<p>a</p>');
  });

  it('注释 / CDATA / doctype 丢弃', () => {
    expect(ok('<!doctype html><!-- 注释 --><p>x</p>')).toBe('<p>x</p>');
  });

  it('文本转义:裸 < > & 不会形成新标签', () => {
    const out = ok('<p>1 < 2 && 3 > 2</p>');
    expect(out).toBe('<p>1 &lt; 2 &amp;&amp; 3 &gt; 2</p>');
  });

  it('畸形输入不抛异常且输出平衡闭合', () => {
    const out = ok('<div><p>未闭合<span>嵌套错</div>');
    expect(out).toBe('<div><p>未闭合<span>嵌套错</span></p></div>');
    expect(() => sanitizeGhostCardHtml('<<<><//>< p <div')).not.toThrow();
  });

  it('preserves escaped mail text without turning encoded markup into elements', () => {
    const html = '<p>Dash &lt;self@example.test&gt; &amp; &quot;team&quot; &#39; &#x1F600; &amp;lt;script&amp;gt;</p>';
    expect(ok(html)).toBe(html);
    expect(ok(ok(html))).toBe(html);
    const encodedAttack = '<p>&lt;img src=x onerror=alert(1)&gt; &#60;script&#62;bad()&#60;/script&#62;</p>';
    expect(ok(encodedAttack)).toBe(encodedAttack);
    expect(ok(encodedAttack)).not.toMatch(/<img|<script/);
  });

  it('plaintext 吞掉余下输入', () => {
    const out = ok('<p>前</p><plaintext><script>x</script>');
    expect(out).toBe('<p>前</p>');
  });

  it('超过体积上限整条拒', () => {
    const big = `<p>${'x'.repeat(GHOST_CARD_HTML_MAX_BYTES)}</p>`;
    const r = sanitizeGhostCardHtml(big);
    expect(r).toEqual({ ok: false, reason: 'oversize' });
  });

  it('空输入与净化后为空都拒', () => {
    expect(sanitizeGhostCardHtml('   ').ok).toBe(false);
    expect(sanitizeGhostCardHtml('<script>x</script>').ok).toBe(false);
  });
});

describe('内置意识 cindy-art 的卡片排版守卫(净化器与 builtin 供片不漂移)', () => {
  it('过程卡与终版卡的标签/样式全量存活', () => {
    const progress =
      '<div style="height:290px;box-sizing:border-box;padding-top:8px;font-family:system-ui;' +
      'background:var(--msg-tool-card-bg,var(--surface-elevated,#ffffff));' +
      'color:var(--msg-tool-card-text,var(--text-primary,#1a1a1a))">' +
      '<div style="margin:0 0 8px;padding:0 12px;font-size:12px;line-height:16px;' +
      'color:var(--text-secondary,#6b6b66);text-align:center;' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis">「一只猫」</div>' +
      '<div style="height:258px;border-radius:10px;' +
      'background:linear-gradient(135deg,var(--surface-chip,#eeeeec),' +
      'var(--surface,#f7f7f5) 55%,var(--surface-chip,#eeeeec));' +
      'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px">' +
      '<div style="font-size:26px;line-height:1">🎨</div>' +
      '<div style="font-size:12px;color:var(--text-secondary,#6b6b66);font-weight:500">正在起草</div>' +
      '<div style="font-size:10px;color:var(--text-tertiary,#9a9a94)">通常 10–30 秒</div>' +
      '</div></div>';
    const p = sanitizeGhostCardHtml(progress);
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.html).toContain('background:var(--msg-tool-card-bg,var(--surface-elevated,#ffffff))');
      expect(p.html).toContain('linear-gradient(135deg,var(--surface-chip,#eeeeec)');
      expect(p.html).toContain('display:flex');
      expect(p.html).toContain('text-align:center');
      expect(p.html).toContain('🎨');
      expect(p.html).toContain('「一只猫」');
    }

    const result =
      '<div style="font-family:system-ui;background:var(--msg-tool-card-bg,var(--surface-elevated,#ffffff));' +
      'color:var(--msg-tool-card-text,var(--text-primary,#1a1a1a))">' +
      `<img src="${GOOD_IMG}" style="display:block;width:100%;height:auto">` +
      '<div style="padding:8px 12px 10px">' +
      '<div style="font-size:12px;color:var(--text-secondary,#6b6b66);text-align:center;' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis">「一只猫」</div>' +
      '<div style="margin-top:3px;font-size:10px;color:var(--text-tertiary,#9a9a94);text-align:center">Cindy Art · GPT Image 2</div>' +
      '</div></div>';
    const r = sanitizeGhostCardHtml(result);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.html).toContain(`src="${GOOD_IMG}"`);
      expect(r.html).toContain('height:auto');
      expect(r.html).toContain('background:var(--msg-tool-card-bg,var(--surface-elevated,#ffffff))');
      expect(r.html).toContain('text-align:center');
      expect(r.html).toContain('Cindy Art · GPT Image 2');
    }
  });
});

describe('CSS 动画剥除(规则 7:历史卡纯静态,主机代码强制)', () => {
  it('@keyframes 块与 animation 声明剥除,transition 保留', () => {
    const out = ok(
      '<style>@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}} ' +
        '.a{animation:spin 1s infinite;color:red;transition:opacity .2s}</style><p>x</p>',
    );
    expect(out).not.toContain('@keyframes');
    expect(out).not.toContain('animation');
    expect(out).toContain('color:red');
    expect(out).toContain('transition:opacity .2s');

    const inline = ok('<div style="animation:pulse 2s infinite;color:blue">x</div>');
    expect(inline).not.toContain('animation');
    expect(inline).toContain('color:blue');
  });
});

describe('CSS 动画剥除的绕过手法封堵(注释间隔 / ident 转义 / 厂商前缀)', () => {
  it('注释间隔(/**/animation:)骗不过剥除:注释先剥,动画照掐', () => {
    const out = ok('<div style="color:red;/**/animation:spin 1s infinite">x</div>');
    expect(out).not.toContain('animation');
    expect(out).toContain('color:red');
    const block = ok('<style>.a{/**/animation:spin 1s infinite;color:red}</style><p>x</p>');
    expect(block).not.toContain('animation');
  });

  it('CSS ident 转义(anim\\61tion / @\\6b eyframes)fail-closed:整段 CSS 拒收', () => {
    const inline = ok('<div style="color:red;anim\\61tion:spin 1s infinite">x</div>');
    expect(inline).not.toContain('61tion');
    expect(inline).not.toContain('style='); // 整个 style 属性被拒
    const block = ok('<style>@\\6b eyframes spin{to{transform:rotate(1turn)}}</style><p>x</p>');
    expect(block).not.toContain('eyframes');
    expect(block).toBe('<p>x</p>'); // 整个 <style> 块被拒
  });

  it('-webkit-animation 厂商前缀同样剥除', () => {
    const out = ok('<div style="-webkit-animation:spin 1s infinite;color:red">x</div>');
    expect(out).not.toContain('animation');
    expect(out).toContain('color:red');
  });
});

describe('animatedHtml(意识自绘动画的白名单校验)', () => {
  const ANIMATED =
    '<style>@keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}</style>' +
    '<div style="animation:bob 1.6s ease-in-out infinite;color:red">x</div>';

  it('keyframes 只动 transform/opacity → 出 animatedHtml(保留动画),html 为静态版', () => {
    const r = sanitizeGhostCardHtml(ANIMATED);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.animatedHtml).toBeDefined();
      expect(r.animatedHtml).toContain('@keyframes bob');
      expect(r.animatedHtml).toContain('animation:bob');
      expect(r.html).not.toContain('@keyframes');
      expect(r.html).not.toContain('animation');
      expect(r.html).toContain('color:red');
    }
  });

  it('keyframes 动了白名单外属性(如 width)→ 无 animatedHtml,整卡回退静态', () => {
    const bad =
      '<style>@keyframes grow{from{width:0}to{width:100px}}</style>' +
      '<div style="animation:grow 1s infinite">x</div>';
    const r = sanitizeGhostCardHtml(bad);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.animatedHtml).toBeUndefined();
      expect(r.html).not.toContain('animation');
    }
  });

  it('CSS 出现 !important → 无 animatedHtml(会顶掉宿主 reduced-motion 停播门控)', () => {
    const r = sanitizeGhostCardHtml(
      '<style>@keyframes f{from{opacity:0}to{opacity:1}}</style>' +
        '<div style="animation:f 1s infinite !important">x</div>',
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.animatedHtml).toBeUndefined();
      expect(r.html).not.toContain('animation');
    }
  });

  it('keyframes 体内出现引号(字符串可造花括号边界混淆)→ 无 animatedHtml', () => {
    const r = sanitizeGhostCardHtml(
      "<style>@keyframes f{from{opacity:0}to{opacity:1;--x:'}'}}</style>" +
        '<div style="animation:f 1s infinite">x</div>',
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.animatedHtml).toBeUndefined();
  });

  it('keyframes 字符串名(名字位引号)→ 违规,无 animatedHtml(含块扫描失配的构造)', () => {
    // 带花括号的字符串名:块匹配正则失配,由"名字位引号 + 计数守卫"双层接住。
    const r = sanitizeGhostCardHtml(
      '<style>@keyframes "a{" {from{margin-left:0}to{margin-left:200px}}</style>' +
        '<div style=\'animation-name:"a{";animation-duration:1s\'>x</div>',
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.animatedHtml).toBeUndefined();
    // 不带花括号的字符串名:块能正常匹配,仍按"名字位出现引号"显式作废
    // (与 FORGE_GUIDE"keyframes 里出现引号即作废"的契约一致)。
    const r2 = sanitizeGhostCardHtml(
      '<style>@keyframes "spin" {from{opacity:0}to{opacity:1}}</style>' +
        '<div style=\'animation:"spin" 1s infinite\'>x</div>',
    );
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.animatedHtml).toBeUndefined();
  });

  it('源码无动画 → 无 animatedHtml(不做第二遍重建)', () => {
    const r = sanitizeGhostCardHtml('<p>静态内容</p>');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.animatedHtml).toBeUndefined();
  });

  it('animatedHtml 同样吃全套净化(脚本/外链照剥)', () => {
    const r = sanitizeGhostCardHtml(
      '<style>@keyframes f{from{opacity:0}to{opacity:1}}</style>' +
        '<script>evil()</script><div style="animation:f 1s;background:url(https://e.com/x.png)">x</div>',
    );
    expect(r.ok).toBe(true);
    if (r.ok && r.animatedHtml) {
      expect(r.animatedHtml).not.toContain('script');
      expect(r.animatedHtml).not.toContain('evil.com');
      expect(r.animatedHtml).toContain('background:none');
    }
  });
});

describe('sanitizeGhostCardHtml · 交互卡按钮(v2,data-ghost-action)', () => {
  it('button + 合法 data-ghost-action 保留,type 强制 button', () => {
    const out = ok('<button data-ghost-action="U1">放大</button>');
    expect(out).toContain('data-ghost-action="U1"');
    expect(out).toContain('type="button"');
    expect(out).toContain('放大');
  });

  it('放行含 :: 的真实 mivo customId', () => {
    const cid = 'MJ::JOB::upsample::1::0f3a2b1c-4d5e-6f70-8a9b-0c1d2e3f4a5b';
    const out = ok(`<button data-ghost-action="${cid}">U1</button>`);
    expect(out).toContain(`data-ghost-action="${cid}"`);
  });

  it('data-ghost-action 可挂在非 button 元素(div/span)', () => {
    const out = ok('<div data-ghost-action="reroll">重绘</div>');
    expect(out).toContain('data-ghost-action="reroll"');
  });

  it('非法 action 值(空/超长/带空格或引号/中文)只丢该属性,元素与文字保留', () => {
    for (const bad of ['has space', 'x'.repeat(129), '中文', 'a"b']) {
      const out = ok(`<button data-ghost-action="${bad.replace(/"/g, '&quot;')}">点</button>`);
      expect(out, bad).not.toContain('data-ghost-action');
      // button 壳与文字仍在(只是点不动)。
      expect(out, bad).toContain('点');
      expect(out, bad).toContain('type="button"');
    }
  });

  it('button 的 disabled 保留、aria-label 保留;其它属性(onclick/id/class)一律剥', () => {
    const out = ok('<button data-ghost-action="U1" disabled aria-label="放大第一张" onclick="x()" id="b" class="c">U1</button>');
    expect(out).toContain('disabled');
    expect(out).toContain('aria-label="放大第一张"');
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('id=');
    expect(out).not.toContain('class=');
  });

  it('普通 data-* 属性仍被剥(只放行 data-ghost-action)', () => {
    const out = ok('<div data-foo="bar" data-ghost-action="ok">x</div>');
    expect(out).toContain('data-ghost-action="ok"');
    expect(out).not.toContain('data-foo');
  });

  it('img 的 data-ghost-model:合法 GLB 总仓地址保留,非法值只丢属性', () => {
    const img = `cindy-media://blobs/${'a'.repeat(64)}.png`;
    const glb = `cindy-media://blobs/${'b'.repeat(64)}.glb`;
    const out = ok(`<img src="${img}" data-ghost-model="${glb}">`);
    expect(out).toContain(`data-ghost-model="${glb}"`);
    // 非法:外链 / 非 glb 后缀 / 指纹不合形 —— 属性丢,img 本体保留。
    for (const bad of ['https://evil.com/x.glb', `cindy-media://blobs/${'c'.repeat(64)}.png`, 'cindy-media://blobs/short.glb']) {
      const o = ok(`<img src="${img}" data-ghost-model="${bad}">`);
      expect(o, bad).not.toContain('data-ghost-model');
      expect(o, bad).toContain(`src="${img}"`);
    }
  });

  it('data-ghost-prompt(输入类动作声明)随合法 action 保留,占位文案转义', () => {
    const out = ok('<button data-ghost-action="imgPrompt-1" data-ghost-prompt="想怎么改?<输入>">改写</button>');
    expect(out).toContain('data-ghost-prompt="想怎么改?&lt;输入&gt;"');
    // 空串占位也保留(presence 即声明)。
    const empty = ok('<button data-ghost-action="p1" data-ghost-prompt="">改写</button>');
    expect(empty).toContain('data-ghost-prompt=""');
  });

  it('data-ghost-prompt 无合法 action 时被剥;占位超 128 字整属性丢', () => {
    const noAction = ok('<button data-ghost-prompt="占位">点</button>');
    expect(noAction).not.toContain('data-ghost-prompt');
    const oversize = ok(`<button data-ghost-action="p1" data-ghost-prompt="${'长'.repeat(129)}">点</button>`);
    expect(oversize).not.toContain('data-ghost-prompt');
    expect(oversize).toContain('data-ghost-action="p1"');
  });
});

// PR 卡片的「跟进中」要持续几天,卡内不能留动画源码;宿主按这个标记播统一光环。
describe('sanitizeGhostCardHtml · 在线指示(data-ghost-live)', () => {
  it('span / div 上保留为空值属性,其它标签与属性值都不放行', () => {
    expect(ok('<span data-ghost-live="anything">x</span><div data-ghost-live>y</div>')).toBe(
      '<span data-ghost-live="">x</span><div data-ghost-live="">y</div>',
    );
    expect(ok('<button data-ghost-live>z</button>')).not.toContain('data-ghost-live');
  });
});

describe('sanitizeGhostCardHtml · 卡内音频播放器插槽(data-ghost-audio)', () => {
  const mp3 = `cindy-media://blobs/${'d'.repeat(64)}.mp3`;

  it('div 上的合法总仓音频地址保留;duration 数值合形随行', () => {
    const out = ok(`<div data-ghost-audio="${mp3}" data-ghost-audio-duration="176.5">占位</div>`);
    expect(out).toContain(`data-ghost-audio="${mp3}"`);
    expect(out).toContain('data-ghost-audio-duration="176.5"');
  });

  it('非法地址只丢属性(div 与子树保留);非 div 元素不放行', () => {
    for (const bad of [
      'https://evil.com/x.mp3',
      `cindy-media://blobs/${'e'.repeat(64)}.glb`,
      'cindy-media://blobs/short.mp3',
      `xdt-audio://local/?path=x`,
    ]) {
      const o = ok(`<div data-ghost-audio="${bad}">文字</div>`);
      expect(o, bad).not.toContain('data-ghost-audio');
      expect(o, bad).toContain('文字');
    }
    const span = ok(`<span data-ghost-audio="${mp3}">x</span>`);
    expect(span).not.toContain('data-ghost-audio');
  });

  it('duration 不合形(负数/超长/非数字)只丢 duration,插槽保留', () => {
    for (const bad of ['-3', '1e5', '123456', 'abc']) {
      const o = ok(`<div data-ghost-audio="${mp3}" data-ghost-audio-duration="${bad}">x</div>`);
      expect(o, bad).toContain('data-ghost-audio=');
      expect(o, bad).not.toContain('data-ghost-audio-duration');
    }
  });

  it('音频插槽上的 data-ghost-action 被忽略(插槽由宿主整体接管)', () => {
    const out = ok(`<div data-ghost-audio="${mp3}" data-ghost-action="U1">x</div>`);
    expect(out).toContain('data-ghost-audio=');
    expect(out).not.toContain('data-ghost-action');
  });
});

describe('sanitizeGhostCardHtml · 卡内外链声明(v3,data-ghost-link)', () => {
  it('<a href> 转写为 data-ghost-link,真实 href 永不落地', () => {
    const out = ok('<a href="https://example.com/x?a=1&b=2">官网</a>');
    expect(out).toBe('<a data-ghost-link="https://example.com/x?a=1&amp;b=2">官网</a>');
    expect(out).not.toContain('href=');
  });

  it('data-ghost-link 可挂任意允许标签(span/div/img)', () => {
    expect(ok('<span data-ghost-link="http://a.com/">x</span>')).toBe(
      '<span data-ghost-link="http://a.com/">x</span>',
    );
    const img = ok(`<img src="${GOOD_IMG}" data-ghost-link="https://a.com/p">`);
    expect(img).toContain('data-ghost-link="https://a.com/p"');
  });

  it('显式 data-ghost-link 优先于 <a> 的 href', () => {
    const out = ok('<a href="https://evil.com" data-ghost-link="https://good.com">x</a>');
    expect(out).toBe('<a data-ghost-link="https://good.com">x</a>');
  });

  it('非 http/https 协议整属性丢(元素与文字保留)', () => {
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,x',
      'ftp://a.com/f',
      'file:///etc/passwd',
      `cindy-media://blobs/${HASH}.png`,
      'https//missing-colon.com',
      '//protocol-relative.com',
    ]) {
      const o = ok(`<a href="${bad}">点我</a>`);
      expect(o, bad).toBe('<a>点我</a>');
    }
  });

  it('值内出现空白/控制字符即拒(URL 构造器会剥 TAB/CR/LF,原文校验防混淆)', () => {
    for (const bad of ['https://a.com/\npath', 'https://a.com/ path', 'https://a.\tcom/']) {
      const o = ok(`<span data-ghost-link="${bad}">x</span>`);
      expect(o, JSON.stringify(bad)).toBe('<span>x</span>');
    }
  });

  it('超长(>2048)整属性丢', () => {
    const long = `https://a.com/${'x'.repeat(2048)}`;
    expect(ok(`<a href="${long}">x</a>`)).toBe('<a>x</a>');
  });

  it('与合法 data-ghost-action 同挂时动作优先,链接声明被忽略', () => {
    const out = ok('<button data-ghost-action="U1" data-ghost-link="https://a.com/">x</button>');
    expect(out).toContain('data-ghost-action="U1"');
    expect(out).not.toContain('data-ghost-link');
  });

  it('音频插槽上的 data-ghost-link 被忽略(插槽由宿主整体接管)', () => {
    const mp3 = `cindy-media://blobs/${'c'.repeat(64)}.mp3`;
    const out = ok(`<div data-ghost-audio="${mp3}" data-ghost-link="https://a.com/">x</div>`);
    expect(out).toContain('data-ghost-audio=');
    expect(out).not.toContain('data-ghost-link');
  });

  it('<a> 的其它属性(target/rel/onclick/download)一律剥除', () => {
    const out = ok(
      '<a href="https://a.com/" target="_blank" rel="opener" onclick="x()" download>x</a>',
    );
    expect(out).toBe('<a data-ghost-link="https://a.com/">x</a>');
  });
});
