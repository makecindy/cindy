import { describe, expect, it } from 'vitest';

import {
  applyHtmlResourceUrls,
  htmlResourceMimeFor,
  collectHtmlLocalResourceRefs,
  htmlBaseDirOf,
  decodeHtmlCharRefs,
  findRawTextContentSpans,
  isWindowsAbsPath,
  joinRemotePath,
  HTML_RESOURCE_LIMIT,
  planHtmlResourceFetches,
  resolveHtmlResourcePath,
  HTML_RESOURCE_TOTAL_MAX_CHARS,
} from '@/session/htmlLocalResources';
import { fetchHtmlResourceUrls } from '@/session/useHtmlLocalResources';

const BASE = '/Users/me/drafts';

/** 取件目标简写(取件编排只关心 absPath + mimeType)。 */
const t = (absPath: string, refCount = 1) => ({ absPath, mimeType: 'image/png', refCount });

describe('resolveHtmlResourcePath(引用 → 被控端绝对路径)', () => {
  it('相对引用按 HTML 所在目录换算', () => {
    expect(resolveHtmlResourcePath(BASE, 'chart.png')).toBe('/Users/me/drafts/chart.png');
    expect(resolveHtmlResourcePath(BASE, './chart.png')).toBe('/Users/me/drafts/chart.png');
    expect(resolveHtmlResourcePath(BASE, 'assets/app.css')).toBe('/Users/me/drafts/assets/app.css');
    expect(resolveHtmlResourcePath(BASE, 'a//b/./c.js')).toBe('/Users/me/drafts/a/b/c.js');
  });

  it('尾分隔符的 baseDir 不产生双斜杠', () => {
    expect(resolveHtmlResourcePath('/Users/me/drafts/', 'x.png')).toBe('/Users/me/drafts/x.png');
  });

  it('查询串与片段剥掉(改写会替掉整个引用,丢掉它们无副作用)', () => {
    expect(resolveHtmlResourcePath(BASE, 'app.css?v=2')).toBe('/Users/me/drafts/app.css');
    expect(resolveHtmlResourcePath(BASE, 'icons.svg#logo')).toBe('/Users/me/drafts/icons.svg');
  });

  it('百分号编码还原成真实文件名;非法序列不 throw', () => {
    expect(resolveHtmlResourcePath(BASE, 'my%20chart.png')).toBe('/Users/me/drafts/my chart.png');
    expect(resolveHtmlResourcePath(BASE, '50%off.png')).toBe('/Users/me/drafts/50%off.png');
  });

  it('Windows 被控端按反斜杠 join', () => {
    expect(resolveHtmlResourcePath('C:\\proj\\drafts', 'assets/x.png'))
      .toBe('C:\\proj\\drafts\\assets\\x.png');
  });

  it('中文目录名照常', () => {
    expect(resolveHtmlResourcePath(BASE, '设计稿/图 1.png'))
      .toBe('/Users/me/drafts/设计稿/图 1.png');
  });

  // ── fail-closed:以下一律不改写,保持原引用 ──

  it('含 `..` 段一律拒绝(逃出 HTML 所在目录子树)', () => {
    expect(resolveHtmlResourcePath(BASE, '../shared/x.png')).toBeNull();
    expect(resolveHtmlResourcePath(BASE, 'assets/../../x.png')).toBeNull();
    expect(resolveHtmlResourcePath(BASE, '..')).toBeNull();
  });

  it('根相对与本机绝对拒绝(前者语义是 web root,后者是最该警惕的形态)', () => {
    expect(resolveHtmlResourcePath(BASE, '/assets/x.png')).toBeNull();
    expect(resolveHtmlResourcePath(BASE, '/etc/passwd')).toBeNull();
    expect(resolveHtmlResourcePath('C:\\proj', 'D:\\other\\x.png')).toBeNull();
  });

  it('带 scheme 与协议相对拒绝(本来就能加载,或本来就不该加载)', () => {
    expect(resolveHtmlResourcePath(BASE, 'https://cdn.example.com/x.png')).toBeNull();
    expect(resolveHtmlResourcePath(BASE, 'http://localhost:5173/x.js')).toBeNull();
    expect(resolveHtmlResourcePath(BASE, 'data:image/png;base64,AAAA')).toBeNull();
    expect(resolveHtmlResourcePath(BASE, 'file:///Users/me/x.png')).toBeNull();
    expect(resolveHtmlResourcePath(BASE, '//cdn.example.com/x.png')).toBeNull();
  });

  it('纯锚点 / 空 / 无 baseDir 拒绝', () => {
    expect(resolveHtmlResourcePath(BASE, '#top')).toBeNull();
    expect(resolveHtmlResourcePath(BASE, '   ')).toBeNull();
    expect(resolveHtmlResourcePath('', 'x.png')).toBeNull();
  });
});

describe('htmlBaseDirOf', () => {
  it('取父目录,保住根形态', () => {
    expect(htmlBaseDirOf('/Users/me/drafts/a.html')).toBe('/Users/me/drafts');
    expect(htmlBaseDirOf('/a.html')).toBe('/');
    expect(htmlBaseDirOf('C:\\proj\\a.html')).toBe('C:\\proj');
    expect(htmlBaseDirOf('a.html')).toBe('');
  });
});

describe('collectHtmlLocalResourceRefs(词法定位)', () => {
  const values = (html: string): string[] =>
    collectHtmlLocalResourceRefs(html, BASE).map((ref) => ref.raw);

  it('收白名单标签上的资源属性', () => {
    const html = [
      '<link rel="stylesheet" href="assets/app.css">',
      '<script src="./app.js"></script>',
      '<img src="chart.png" alt="图">',
      '<video src="clip.mp4" poster="cover.jpg"></video>',
      '<source src=\'audio.mp3\'>',
    ].join('\n');
    // 音视频**刻意不在 MIME 表里**:资源要整份内联成 data: URI,一段视频足以撑爆内存。
    // 它们保持原引用(渲染成不可播放的占位),poster 图这类静态图仍照常内联。
    expect(values(html)).toEqual([
      'assets/app.css', './app.js', 'chart.png', 'cover.jpg',
    ]);
  });

  it('不在白名单的标签 / 属性不碰', () => {
    // `<a href>` 是导航不是资源;`data-src` 不是资源属性。
    expect(values('<a href="other.html">x</a>')).toEqual([]);
    expect(values('<div data-src="x.png"></div>')).toEqual([]);
    // 标签名必须恰好匹配:img-wrapper 不是 img。
    expect(values('<img-wrapper src="x.png"></img-wrapper>')).toEqual([]);
  });

  it('无引号属性值也收', () => {
    expect(values('<img src=chart.png>')).toEqual(['chart.png']);
  });

  it('http(s) / data: 引用不收(它们本来就能加载)', () => {
    expect(values('<img src="https://cdn.example.com/a.png"><img src="data:image/png;base64,AA">'))
      .toEqual([]);
  });

  it('<style> 块里的 url() 收(同一份文档里的内联样式)', () => {
    const html = '<style>body{background:url("bg.png")} .a{mask:url(m.svg)}</style>';
    expect(values(html)).toEqual(['bg.png', 'm.svg']);
  });

  it('空文档 / 无 baseDir 返回空', () => {
    expect(collectHtmlLocalResourceRefs('', BASE)).toEqual([]);
    expect(collectHtmlLocalResourceRefs('<img src="a.png">', '')).toEqual([]);
  });

  it('区间精确指向属性值本身(不含引号)', () => {
    const html = '<img src="chart.png">';
    const [ref] = collectHtmlLocalResourceRefs(html, BASE);
    expect(html.slice(ref.start, ref.end)).toBe('chart.png');
    expect(ref.absPath).toBe('/Users/me/drafts/chart.png');
  });

  it('多处引用按位置升序(回填从后往前才安全)', () => {
    const refs = collectHtmlLocalResourceRefs(
      '<style>.a{background:url(bg.png)}</style><img src="chart.png">',
      BASE,
    );
    expect(refs.map((r) => r.raw)).toEqual(['bg.png', 'chart.png']);
    expect(refs[0].start).toBeLessThan(refs[1].start);
  });
});

describe('applyHtmlResourceUrls(回填)', () => {
  it('多处引用整体替换,区间不串位', () => {
    const html = '<link href="a.css"><img src="b.png"><script src="c.js"></script>';
    const refs = collectHtmlLocalResourceRefs(html, BASE);
    const urls = new Map([
      ['/Users/me/drafts/a.css', 'https://oss/a'],
      ['/Users/me/drafts/b.png', 'https://oss/b'],
      ['/Users/me/drafts/c.js', 'https://oss/c'],
    ]);
    expect(applyHtmlResourceUrls(html, refs, urls)).toBe(
      '<link href="https://oss/a"><img src="https://oss/b"><script src="https://oss/c"></script>',
    );
  });

  it('取不到的保留原引用(渲染成破图比换成错地址诚实)', () => {
    const html = '<img src="a.png"><img src="b.png">';
    const refs = collectHtmlLocalResourceRefs(html, BASE);
    const urls = new Map([['/Users/me/drafts/b.png', 'https://oss/b']]);
    expect(applyHtmlResourceUrls(html, refs, urls)).toBe(
      '<img src="a.png"><img src="https://oss/b">',
    );
  });

  it('同一路径多处引用共用一个取回地址', () => {
    const html = '<img src="a.png"><img src="./a.png">';
    const refs = collectHtmlLocalResourceRefs(html, BASE);
    const urls = new Map([['/Users/me/drafts/a.png', 'https://oss/a']]);
    expect(applyHtmlResourceUrls(html, refs, urls)).toBe(
      '<img src="https://oss/a"><img src="https://oss/a">',
    );
  });

  it('style 块与属性混排也不串位', () => {
    const html = '<style>.a{background:url(bg.png)}</style><img src="chart.png">';
    const refs = collectHtmlLocalResourceRefs(html, BASE);
    const urls = new Map([
      ['/Users/me/drafts/bg.png', 'https://oss/bg'],
      ['/Users/me/drafts/chart.png', 'https://oss/chart'],
    ]);
    expect(applyHtmlResourceUrls(html, refs, urls)).toBe(
      '<style>.a{background:url(https://oss/bg)}</style><img src="https://oss/chart">',
    );
  });
});

describe('planHtmlResourceFetches(去重与上限)', () => {
  it('按首次出现顺序去重', () => {
    const refs = collectHtmlLocalResourceRefs(
      '<img src="b.png"><img src="a.png"><img src="./b.png">',
      BASE,
    );
    expect(planHtmlResourceFetches(refs)).toEqual({
      targets: [
        // b.png 出现两次 → 仍只取一次件,但 refCount 记 2(预算按回填倍数计费)。
        { absPath: '/Users/me/drafts/b.png', mimeType: 'image/png', refCount: 2 },
        { absPath: '/Users/me/drafts/a.png', mimeType: 'image/png', refCount: 1 },
      ],
      skipped: 0,
    });
  });

  it('超上限的计入 skipped,不静默截断', () => {
    const html = Array.from({ length: HTML_RESOURCE_LIMIT + 3 }, (_, i) => `<img src="a${i}.png">`).join('');
    const plan = planHtmlResourceFetches(collectHtmlLocalResourceRefs(html, BASE));
    expect(plan.targets).toHaveLength(HTML_RESOURCE_LIMIT);
    expect(plan.skipped).toBe(3);
  });

  it('自包含页面 → 零待取(零请求路径)', () => {
    const html = '<style>body{color:red}</style><img src="data:image/png;base64,AA">';
    expect(planHtmlResourceFetches(collectHtmlLocalResourceRefs(html, BASE)).targets).toEqual([]);
  });
});

describe('fetchHtmlResourceUrls(限并发批量取件)', () => {
  it('全部成功:地址齐全,失败数为 0', async () => {
    const out = await fetchHtmlResourceUrls(
      [t('/a.png'), t('/b.png')],
      async ({ absPath }) => `data:image/png;base64,${absPath}`,
    );
    expect(out.failed).toBe(0);
    expect([...out.urlByAbsPath]).toEqual([
      ['/a.png', 'data:image/png;base64,/a.png'],
      ['/b.png', 'data:image/png;base64,/b.png'],
    ]);
  });

  it('单个失败不影响其它(整页不因一张图取不到而失败)', async () => {
    const out = await fetchHtmlResourceUrls(
      [t('/a.png'), t('/bad.png'), t('/c.png')],
      async ({ absPath }) => {
        if (absPath === '/bad.png') throw new Error('nope');
        return `data:image/png;base64,${absPath}`;
      },
    );
    expect(out.failed).toBe(1);
    expect(out.urlByAbsPath.has('/bad.png')).toBe(false);
    expect(out.urlByAbsPath.size).toBe(2);
  });

  it('回空地址也算失败(不把空串回填进 HTML)', async () => {
    const out = await fetchHtmlResourceUrls([t('/a.png')], async () => '');
    expect(out.failed).toBe(1);
    expect(out.urlByAbsPath.size).toBe(0);
  });

  it('并发不超过上限,且每个路径只取一次', async () => {
    let inFlight = 0;
    let peak = 0;
    const calls: string[] = [];
    const paths = Array.from({ length: 9 }, (_, i) => t(`/a${i}.png`));
    const out = await fetchHtmlResourceUrls(
      paths,
      async ({ absPath }) => {
        calls.push(absPath);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return `data:image/png;base64,${absPath}`;
      },
      { concurrency: 3 },
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(calls).toHaveLength(9);
    expect(new Set(calls).size).toBe(9);
    expect(out.urlByAbsPath.size).toBe(9);
  });

  it('已取消时停止后续取件(卸载 / 换文档后不白发请求)', async () => {
    const calls: string[] = [];
    let cancelled = false;
    const out = await fetchHtmlResourceUrls(
      Array.from({ length: 8 }, (_, i) => t(`/a${i}.png`)),
      async ({ absPath }) => {
        calls.push(absPath);
        cancelled = true; // 第一批发出后即取消
        return `data:image/png;base64,${absPath}`;
      },
      { concurrency: 1, isCancelled: () => cancelled },
    );
    expect(calls).toEqual(['/a0.png']);
    expect(out.urlByAbsPath.size).toBe(1);
  });

  it('空清单不发请求', async () => {
    let called = false;
    const out = await fetchHtmlResourceUrls([], async () => {
      called = true;
      return 'x';
    });
    expect(called).toBe(false);
    expect(out).toEqual({ urlByAbsPath: new Map(), failed: 0, overBudget: 0 });
  });
});

describe('htmlResourceMimeFor(data: URI 的类型)', () => {
  it('常见 web 资源给准类型', () => {
    expect(htmlResourceMimeFor('a/app.css')).toBe('text/css');
    expect(htmlResourceMimeFor('a/app.js')).toBe('text/javascript');
    expect(htmlResourceMimeFor('a/logo.SVG')).toBe('image/svg+xml');
    expect(htmlResourceMimeFor('a/f.woff2')).toBe('font/woff2');
    // **入参是文件系统路径,不是 URL**(review P2):`a/x.png?v=2` 这种形态在生产中不会出现 ——
    // 唯一调用方传的是 resolveHtmlResourcePath 的输出,query/fragment 已经在那里按 URL 规则
    // 剥过、并做完百分号解码。这里再剥一次会把文件名里合法的 `?` / `#` 当语法,
    // 让 `chart#1.png` 这类真实文件判不出扩展名(见下面 review P2 那组用例)。
    // 所以带 query 的字符串现在按「文件名里含 `?`」处理:扩展名是 `.png?v=2`,表外 → null。
    expect(htmlResourceMimeFor('a/x.png?v=2')).toBeNull();
  });

  it('表外类型不猜 —— 猜错会让浏览器拒收样式表/脚本,静默失效', () => {
    expect(htmlResourceMimeFor('a/data.bin')).toBeNull();
    expect(htmlResourceMimeFor('a/archive.zip')).toBeNull();
    expect(htmlResourceMimeFor('noext')).toBeNull();
  });
});

describe('MIME 未知的引用不进候选(fail-closed)', () => {
  it('未知类型不改写,保持原引用', () => {
    const refs = collectHtmlLocalResourceRefs('<img src="a.png"><embed src="x.bin">', BASE);
    expect(refs.map((r) => r.raw)).toEqual(['a.png']);
    expect(refs[0].mimeType).toBe('image/png');
  });
});

describe('SVG fragment 必须保留(sprite 靠它选 symbol)', () => {
  it('属性与 url() 两种形态都把 fragment 补回 data: URI 之后', () => {
    const html = '<img src="icons.svg#logo"><style>.a{background:url(sprite.svg#download)}</style>';
    const refs = collectHtmlLocalResourceRefs(html, BASE);
    expect(refs.map((r) => r.fragment)).toEqual(['#logo', '#download']);
    // 取件按无 fragment 的路径走(同一个文件只取一次)。
    expect(refs[0].absPath).toBe('/Users/me/drafts/icons.svg');
    expect(refs[1].absPath).toBe('/Users/me/drafts/sprite.svg');
    const urls = new Map([
      ['/Users/me/drafts/icons.svg', 'data:image/svg+xml;base64,AAA'],
      ['/Users/me/drafts/sprite.svg', 'data:image/svg+xml;base64,BBB'],
    ]);
    expect(applyHtmlResourceUrls(html, refs, urls)).toBe(
      '<img src="data:image/svg+xml;base64,AAA#logo">'
      + '<style>.a{background:url(data:image/svg+xml;base64,BBB#download)}</style>',
    );
  });

  it('无 fragment 时不多加 `#`', () => {
    const html = '<img src="a.png">';
    const refs = collectHtmlLocalResourceRefs(html, BASE);
    expect(refs[0].fragment).toBe('');
    expect(applyHtmlResourceUrls(html, refs, new Map([['/Users/me/drafts/a.png', 'data:image/png;base64,X']])))
      .toBe('<img src="data:image/png;base64,X">');
  });

  it('同一 SVG 的不同 fragment 只取一次件', () => {
    const refs = collectHtmlLocalResourceRefs('<img src="s.svg#a"><img src="s.svg#b">', BASE);
    expect(planHtmlResourceFetches(refs).targets).toEqual([
      { absPath: '/Users/me/drafts/s.svg', mimeType: 'image/svg+xml', refCount: 2 },
    ]);
  });
});

describe('整页内联总量预算(不可信产物的 DoS 面)', () => {
  it('逐文件上限挡不住总量:预算用尽后不再取件', async () => {
    // 32 个接近单文件上限的资源 ≈ 85 MiB base64,取件 Map / 回填 HTML / WebView 序列化
    // 会同时各持一份,足以 OOM(review P1)。
    const targets = Array.from({ length: 10 }, (_, i) => ({
      absPath: `/a${i}.png`,
      mimeType: 'image/png',
      refCount: 1,
    }));
    const chunk = 'x'.repeat(100);
    let calls = 0;
    const out = await fetchHtmlResourceUrls(
      targets,
      async () => {
        calls += 1;
        return chunk;
      },
      { concurrency: 1, totalBudgetChars: 250 },
    );
    // 250 字符预算装得下 2 个 100 字符的资源,第 3 个超预算被丢。
    expect(out.urlByAbsPath.size).toBe(2);
    expect(out.overBudget).toBe(8);
    expect(out.failed).toBe(0);
    // 预算耗尽后不再下载:第 3 个取回来才知道装不下(它置耗尽标记),之后 7 个直接跳过。
    // 若只比 usedChars >= budget,usedChars 会永远停在 200、早退从不触发,10 个全下载。
    expect(calls).toBe(3);
  });

  it('超预算的那个保留原引用,不占内存也不换错地址', async () => {
    const out = await fetchHtmlResourceUrls(
      [{ absPath: '/big.png', mimeType: 'image/png', refCount: 1 }],
      async () => 'y'.repeat(500),
      { totalBudgetChars: 100 },
    );
    expect(out.urlByAbsPath.size).toBe(0);
    expect(out.overBudget).toBe(1);
  });

  it('预算内不受影响,且默认预算是显式常量', async () => {
    const out = await fetchHtmlResourceUrls(
      [{ absPath: '/a.png', mimeType: 'image/png', refCount: 1 }],
      async () => 'data:image/png;base64,AAA',
    );
    expect(out.urlByAbsPath.size).toBe(1);
    expect(out.overBudget).toBe(0);
    expect(HTML_RESOURCE_TOTAL_MAX_CHARS).toBeGreaterThan(0);
  });
});

describe('总量预算按回填后的实际增量计费', () => {
  it('同一资源被多处引用时按 refCount 倍计费', () => {
    // 去重后只有 1 个 target,但回填会插入 100 次 —— 只计一次就会放过 100 倍的内存。
    const refs = collectHtmlLocalResourceRefs(
      Array.from({ length: 100 }, () => '<img src="a.png">').join(''),
      BASE,
    );
    const plan = planHtmlResourceFetches(refs);
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0].refCount).toBe(100);
  });

  it('单份能装下、乘以引用次数装不下 → 拒绝并计入 overBudget', async () => {
    const out = await fetchHtmlResourceUrls(
      [{ absPath: '/a.png', mimeType: 'image/png', refCount: 100 }],
      async () => 'x'.repeat(200),
      { totalBudgetChars: 1000 },
    );
    expect(out.urlByAbsPath.size).toBe(0);
    expect(out.overBudget).toBe(1);
  });

  it('引用一次时行为不变(不因新计费方式变严)', async () => {
    const out = await fetchHtmlResourceUrls(
      [{ absPath: '/a.png', mimeType: 'image/png', refCount: 1 }],
      async () => 'x'.repeat(200),
      { totalBudgetChars: 1000 },
    );
    expect(out.urlByAbsPath.size).toBe(1);
    expect(out.overBudget).toBe(0);
  });

  it('refCount 缺失 / 为 0 / 非数时按 1 计,预算判断不得 fail-open', async () => {
    // `Math.max(1, undefined)` 是 NaN,而 `usedChars + NaN > budget` 恒为 false ——
    // 少一个字段就让整条预算判断放行一切。三种脏形态都必须退化成「按 1 计」。
    for (const dirty of [
      { absPath: '/a.png', mimeType: 'image/png' } as never,
      { absPath: '/a.png', mimeType: 'image/png', refCount: 0 },
      { absPath: '/a.png', mimeType: 'image/png', refCount: Number.NaN },
    ]) {
      const out = await fetchHtmlResourceUrls(
        [dirty],
        async () => 'x'.repeat(2000),
        { totalBudgetChars: 1000 },
      );
      expect(out.urlByAbsPath.size).toBe(0);
      expect(out.overBudget).toBe(1);
    }
  });
});

describe('CSP 必然拦掉的嵌入类型不取回(review P2)', () => {
  it('iframe / embed 不进候选:frame-src / object-src 都是 none', () => {
    // 取回来也渲染不出,白花一次上传 + 下载 + OSS 对象创建与回收,还占掉 32 项配额。
    expect(collectHtmlLocalResourceRefs('<iframe src="diagram.svg"></iframe>', BASE)).toEqual([]);
    expect(collectHtmlLocalResourceRefs('<embed src="diagram.svg">', BASE)).toEqual([]);
    // CSP 放行得了的类型照旧。
    expect(collectHtmlLocalResourceRefs('<img src="diagram.svg">', BASE).map((r) => r.raw))
      .toEqual(['diagram.svg']);
  });
});

describe('掩码层已删除:注释等惰性文本里的伪引用会占配额(刻意接受的退化)', () => {
  it('注释里的伪引用仍会进候选 —— 代价只是图少取几个', () => {
    // 掩码被 review 连挖五轮(注释 → template → 属性字面标签 → 脚本字符串 → 跨属性配对),
    // 根因是正则认不出「`<` 在哪个数据态」。两种失败模式代价差一个数量级:不掩最多让伪
    // 引用占配额,掩错会把真资源整段抹掉。所以放弃掩码,这里钉住新口径。
    // **例外是 RAWTEXT 内容(script / textarea / title),见下一个 describe** —— 它的终止规则
    // 由规范写死、是闭合的,且不跳过会真的改写作者脚本源码,比占配额严重一档。
    const refs = collectHtmlLocalResourceRefs('<!-- <img src="ghost.png"> --><img src="real.png">', BASE);
    expect(refs.map((r) => r.raw)).toEqual(['ghost.png', 'real.png']);
  });

  it('跨属性的 `<!--` / `-->` 不再吞掉中间的真资源(本轮 review P1)', () => {
    const html = '<div a="<!--"></div><img src="real.png"><div b="-->"></div>';
    expect(collectHtmlLocalResourceRefs(html, BASE).map((r) => r.raw)).toEqual(['real.png']);
  });
});

describe('RAWTEXT 内容整段跳过(review P1:回填会改写作者脚本源码)', () => {
  it('脚本字符串里的伪标签不进候选,也就不会被回填', () => {
    // 不跳过时 applyHtmlResourceUrls 会把 `logo.png` 真的替成 data: URI,于是作者脚本
    // 后续的 tpl.replace('logo.png', …) 全部失效 —— 打坏的是**正常页面**(把 HTML 模板
    // 放 JS 字符串里是常见写法)。
    const html = '<script>const tpl = \'<img src="logo.png">\';</script><img src="real.png">';
    const refs = collectHtmlLocalResourceRefs(html, BASE);
    expect(refs.map((r) => r.raw)).toEqual(['real.png']);
    // 端到端:回填后脚本源码一字不动。
    const urls = new Map(refs.map((r) => [r.absPath, 'data:image/png;base64,AAA']));
    const out = applyHtmlResourceUrls(html, refs, urls);
    expect(out).toContain('const tpl = \'<img src="logo.png">\';');
    expect(out).toContain('<img src="data:image/png;base64,AAA">');
  });

  it('开标签本身不在跳过区间:<script src> 仍要收', () => {
    const refs = collectHtmlLocalResourceRefs('<script src="app.js"></script>', BASE);
    expect(refs.map((r) => r.raw)).toEqual(['app.js']);
  });

  it('textarea / title 体同样跳过(RCDATA 里的 `<` 也不开标签)', () => {
    expect(collectHtmlLocalResourceRefs('<textarea><img src="g.png"></textarea>', BASE)).toEqual([]);
    expect(collectHtmlLocalResourceRefs('<title><img src="g.png"></title>', BASE)).toEqual([]);
  });

  it('终止序列按规范判:`</script` 后须跟空白 / `/` / `>`,大小写不敏感', () => {
    // `</scriptx>` 不终止脚本体 —— 后面那个 img 仍在 RAWTEXT 里。
    expect(collectHtmlLocalResourceRefs('<script>a</scriptx><img src="g.png"></script>', BASE)).toEqual([]);
    // 大写结束标签正常终止。
    const refs = collectHtmlLocalResourceRefs('<SCRIPT>a</SCRIPT><img src="real.png">', BASE);
    expect(refs.map((r) => r.raw)).toEqual(['real.png']);
    // 带空白的结束标签也终止。
    const refs2 = collectHtmlLocalResourceRefs('<script>a</script ><img src="real.png">', BASE);
    expect(refs2.map((r) => r.raw)).toEqual(['real.png']);
  });

  it('未闭合的 script 体一直到文末(与解析器一致)', () => {
    expect(collectHtmlLocalResourceRefs('<script><img src="g.png">', BASE)).toEqual([]);
  });

  it('脚本体里的 <style> 字面量不算样式块', () => {
    const html = '<script>var s = \'<style>body{background:url(g.png)}</style>\';</script>';
    expect(collectHtmlLocalResourceRefs(html, BASE)).toEqual([]);
  });

  it('span 计算:体内的 `<script>` 字面量不被当成新的开标签(顺序扫描)', () => {
    const html = '<script>var a = "<script>";</script><img src="real.png">';
    const spans = findRawTextContentSpans(html);
    expect(spans).toHaveLength(1);
    // 一个 span,从第一个开标签之后到第一个合法 `</script` 之前。
    expect(html.slice(spans[0].start, spans[0].end)).toBe('var a = "<script>";');
    expect(collectHtmlLocalResourceRefs(html, BASE).map((r) => r.raw)).toEqual(['real.png']);
  });

  it('spans 按 start 升序且互不重叠(isInsideSpans 用二分,依赖这个前提)', () => {
    const html = '<script>a</script><img src="a.png"><script>b</script><img src="b.png"><textarea>c</textarea>';
    const spans = findRawTextContentSpans(html);
    expect(spans).toHaveLength(3);
    for (let i = 1; i < spans.length; i += 1) {
      expect(spans[i].start).toBeGreaterThanOrEqual(spans[i - 1].end);
    }
    // 前提成立时判定结果正确:两个真 img 都收到。
    expect(collectHtmlLocalResourceRefs(html, BASE).map((r) => r.raw)).toEqual(['a.png', 'b.png']);
  });

  it('大量 script 时仍线性完成(不可信产物的 DoS 面,二分而非 O(n·m))', () => {
    // 自审补:线性判定下 5000 段 script 会产生约 5×10⁷ 次比较,足以卡住 JS 线程。
    const N = 3000;
    const html = Array.from({ length: N }, (_, i) =>
      `<script>var x${i} = '<img src="ghost${i}.png">';</script><img src="real${i}.png">`).join('');
    const started = performance.now();
    const refs = collectHtmlLocalResourceRefs(html, BASE);
    const elapsed = performance.now() - started;
    // 伪引用一个都不收,真引用全收(受 32 项上限约束的是取件计划,不是扫描)。
    expect(refs).toHaveLength(N);
    expect(refs.every((r) => r.raw.startsWith('real'))).toBe(true);
    // 宽松上限:只用来挡住量级退化(线性判定在本机约慢一个数量级),不做精确基准。
    expect(elapsed).toBeLessThan(3000);
  });

  it('<style> 体同样跳过标签扫描,但 CSS url() 扫描照旧(review P2)', () => {
    // `<style>` 在 HTML 规范里也是 RAWTEXT。实测(Chromium):
    // `<style>code::before{content:'<img src="a.png">'}</style>` 里的 `<img>` **不成为元素**,
    // `content` 就是那段字面文本 —— 当成真标签回填就**篡改了页面显示内容**。
    const html = '<style>code::before{content:\'<img src="a.png">\'}</style><img src="real.png">';
    const refs = collectHtmlLocalResourceRefs(html, BASE);
    expect(refs.map((r) => r.raw)).toEqual(['real.png']);
    // 端到端:CSS 字符串一字不动。
    const urls = new Map(refs.map((r) => [r.absPath, 'data:image/png;base64,AAA']));
    expect(applyHtmlResourceUrls(html, refs, urls)).toContain('content:\'<img src="a.png">\'');
  });

  it('两个 span 集合必须分开:style 进标签跳过表,但不能让样式 url() 跟着丢', () => {
    // 若 CSS 扫描也按含 style 的 span 判跳过,就会自我否定 —— 样式块里的 url() 全部丢失,
    // 多文件产物的背景图整批缺失。这条钉住分工。
    const html = '<style>body{background:url(bg.png)}</style><img src="real.png">';
    expect(collectHtmlLocalResourceRefs(html, BASE).map((r) => r.raw)).toEqual(['bg.png', 'real.png']);
    // 同时:脚本字符串里的 <style> 字面量仍不算样式块(CSS 扫描跳过 script 体)。
    const inScript = '<script>var s = \'<style>body{background:url(g.png)}</style>\';</script>';
    expect(collectHtmlLocalResourceRefs(inScript, BASE)).toEqual([]);
    // 两种 tag 集合的 span 数不同,函数参数化后各取所需。
    expect(findRawTextContentSpans(html).length).toBe(1);                       // 默认含 style
    expect(findRawTextContentSpans(html, ['script', 'textarea', 'title']).length).toBe(0);
  });

  it('joinRemotePath / isWindowsAbsPath 按根形态判(两处共用一份实现,review P2)', () => {
    // 预览页的 absolutePathOf 与 resolveHtmlResourcePath 曾各写一份「含反斜杠即 Windows」,
    // 修一处漏一处。现在共用:POSIX 上 workdir 名含反斜杠时不得改写相对路径里的斜杠。
    expect(isWindowsAbsPath('/tmp/a\\b')).toBe(false);
    expect(isWindowsAbsPath('C:\\proj')).toBe(true);
    expect(isWindowsAbsPath('C:/proj')).toBe(true);
    expect(isWindowsAbsPath('\\\\server\\share\\d')).toBe(true);
    // workdir `/tmp/a\b` + `pages/index.html` → 必须保持正斜杠。
    expect(joinRemotePath('/tmp/a\\b', 'pages/index.html')).toBe('/tmp/a\\b/pages/index.html');
    // Windows 才把相对路径里的 `/` 换成 `\`。
    expect(joinRemotePath('C:\\proj', 'pages/index.html')).toBe('C:\\proj\\pages\\index.html');
    // 尾分隔符不产生双分隔符;空 base 原样返回。
    expect(joinRemotePath('/tmp/x/', 'a.html')).toBe('/tmp/x/a.html');
    expect(joinRemotePath('', 'a.html')).toBe('a.html');
  });

  it('两次 span 扫描不可合并成「扫全集再 filter」—— 那不是等价变换', () => {
    // span 边界依赖 tag 集合本身:命中一段后游标推到体尾,所以集合里少一个 tag 会让原本被它
    // 吞掉的内层伪标签重新成段。这条钉住实测差异,防止以后有人"顺手优化"成一次扫描。
    const html = "<style>var s='<script>x</script>'</style>";
    const all = findRawTextContentSpans(html);
    const exceptStyle = findRawTextContentSpans(html, ['script', 'textarea', 'title']);
    expect(all).toHaveLength(1);
    expect(exceptStyle).toHaveLength(1);
    // 位置不同:全集里是整个 style 体;除 style 时反而是体内那个伪 script。
    expect(all[0].start).not.toBe(exceptStyle[0].start);
    expect(all[0].end).not.toBe(exceptStyle[0].end);
    expect(html.slice(all[0].start, all[0].end)).toBe("var s='<script>x</script>'");
    expect(html.slice(exceptStyle[0].start, exceptStyle[0].end)).toBe('x');
  });

  it('CSS 注释里的伪 script 不影响同一 style 块的 url() 收集', () => {
    // 除 style 扫描会在 CSS 注释处产生一个伪 script span(无结束标签 → 延伸到文末),
    // 但 styleRe 判的是**开标签位置**,它在该 span 之前 → 不跳过;url() 扫描在 body 文本内
    // 独立进行,不受 span 影响 → 两个 url() 都收到。
    const html = '<style>body{background:url(bg.png)} /* <script> */ .a{background:url(a.png)}</style>';
    expect(collectHtmlLocalResourceRefs(html, BASE).map((r) => r.raw)).toEqual(['bg.png', 'a.png']);
  });

  it('⚠️ 已知残留:属性值里的字面 `<script>` 会造成误判(如实钉住,不假装没有)', () => {
    // 开标签仍靠正则找,`[^<>]*` 遇到属性值里的 `<` 就停,于是这里的 `<script>` 被当成真开标签,
    // 后面那个真引用被跳过 → 缺图。该形态极罕见,而「HTML 模板放 JS 字符串」很常见,净收益为正。
    // 两种失败都只影响资源是否内联,不影响文档结构。
    const html = '<div data-tpl="<script>"></div><img src="real.png">';
    expect(collectHtmlLocalResourceRefs(html, BASE)).toEqual([]);
  });
});

describe('CSS url() 函数名大小写不敏感(review P1)', () => {
  it('URL(...) / Url(...) 与小写等价', () => {
    for (const fn of ['url', 'URL', 'Url', 'uRl']) {
      const refs = collectHtmlLocalResourceRefs(`<style>body{background:${fn}("hero.png")}</style>`, BASE);
      expect(refs.map((r) => r.raw), fn).toEqual(['hero.png']);
    }
  });

  it('style 属性里同样不敏感', () => {
    const refs = collectHtmlLocalResourceRefs('<div style="background:URL(\'hero.png\')"></div>', BASE);
    expect(refs.map((r) => r.raw)).toEqual(['hero.png']);
  });
});

describe('内联 SVG 的 image href / xlink:href(review P1)', () => {
  it('href / xlink:href / src 三条路都收(CSP 的 img-src data: 放行它们)', () => {
    const refs = collectHtmlLocalResourceRefs('<svg><image href="chart.png"/></svg>', BASE);
    expect(refs.map((r) => r.raw)).toEqual(['chart.png']);
    const legacy = collectHtmlLocalResourceRefs('<svg><image xlink:href="chart.png"/></svg>', BASE);
    expect(legacy.map((r) => r.raw)).toEqual(['chart.png']);
    // **HTML 里 `<image>` 是 `<img>` 的废弃别名**(自审补,review 未提):实测 Chromium 把
    // `<image src="a.png">` 解析成 IMG 且是 HTMLImageElement,浏览器照常加载 —— 只收 href
    // 会让这种写法漏掉。
    const htmlAlias = collectHtmlLocalResourceRefs('<image src="chart.png" alt="x">', BASE);
    expect(htmlAlias.map((r) => r.raw)).toEqual(['chart.png']);
  });

  it('image 之外的标签不因此放开 href', () => {
    // a[href] 是导航不是资源,不该被取件回填。
    expect(collectHtmlLocalResourceRefs('<a href="page.html">x</a>', BASE)).toEqual([]);
  });
});

describe('Windows 路径判定只看根形态(review P2)', () => {
  it('POSIX 目录名里的反斜杠不再被误判成 Windows', () => {
    // `/tmp/a\b` 是 macOS / Linux 上合法目录名;误判会拼出 `/tmp/a\b\chart.png`,
    // POSIX 把后一个反斜杠也当普通字符 → 路径不存在 → 该页所有同目录资源全失败。
    expect(resolveHtmlResourcePath('/tmp/a\\b', 'chart.png')).toBe('/tmp/a\\b/chart.png');
  });

  it('盘符与 UNC 根仍按 Windows 分隔符拼接', () => {
    expect(resolveHtmlResourcePath('C:\\proj\\docs', 'chart.png')).toBe('C:\\proj\\docs\\chart.png');
    expect(resolveHtmlResourcePath('C:/proj/docs', 'chart.png')).toBe('C:/proj/docs\\chart.png');
    expect(resolveHtmlResourcePath('\\\\server\\share\\docs', 'chart.png'))
      .toBe('\\\\server\\share\\docs\\chart.png');
  });
});

describe('MIME 判定不对已解析的文件系统路径再剥 query/fragment(review P2)', () => {
  it('文件名里合法含 `#` 的资源仍能判出扩展名', () => {
    // 引用按 URL 规则写成 `chart%231.png`,解析后是真实路径 `/…/chart#1.png`。
    // 原实现在 MIME 判定时把 `#1.png` 当 fragment 截掉 → 判定失败 → 引用被静默排除,
    // 而浏览器实际会正常加载它。
    expect(htmlResourceMimeFor('/Users/me/drafts/chart#1.png')).toBe('image/png');
    expect(htmlResourceMimeFor('/Users/me/drafts/data?v=1.css')).toBe('text/css');
    const refs = collectHtmlLocalResourceRefs('<img src="chart%231.png">', BASE);
    expect(refs.map((r) => r.absPath)).toEqual([`${BASE}/chart#1.png`]);
    expect(refs[0].mimeType).toBe('image/png');
    // fragment 仍为空:`%23` 解出来的 `#` 属于文件名,不是 URL fragment。
    expect(refs[0].fragment).toBe('');
  });

  it('目录名带点、文件名不带点时扩展名判定失败(不误取目录后缀)', () => {
    expect(htmlResourceMimeFor('/Users/me/a.css/plain')).toBeNull();
  });
});

describe('内联 style 属性里的 url()(review P1)', () => {
  it('任意标签的 style 属性都收,不受资源标签白名单限制', () => {
    const html = '<div style="background-image:url(\'./hero.png\')"></div>';
    const refs = collectHtmlLocalResourceRefs(html, BASE);
    expect(refs.map((r) => r.raw)).toEqual(['./hero.png']);
    // 区间精确指向属性内的那段 URL,回填不串位。
    expect(html.slice(refs[0].start, refs[0].end)).toBe('./hero.png');
  });

  it('style 属性与 <style> 块混排,按位置升序且各自不串位', () => {
    // 双引号属性里必须用单引号或 &quot;,套双引号是非法 HTML(第一版 fixture 写错过)。
    const html = '<style>body{background:url(bg.png)}</style><p style="background:url(\'in.png\')">x</p>';
    const refs = collectHtmlLocalResourceRefs(html, BASE);
    expect(refs.map((r) => r.raw)).toEqual(['bg.png', 'in.png']);
    const urls = new Map(refs.map((r) => [r.absPath, `data:image/png;base64,AAA`]));
    const out = applyHtmlResourceUrls(html, refs, urls);
    expect(out).toBe('<style>body{background:url(data:image/png;base64,AAA)}</style>'
      + '<p style="background:url(\'data:image/png;base64,AAA\')">x</p>');
  });

  it('style 属性里的 http(s) / 越界引用照旧不改写', () => {
    expect(collectHtmlLocalResourceRefs('<div style="background:url(https://cdn/x.png)"></div>', BASE)).toEqual([]);
    expect(collectHtmlLocalResourceRefs('<div style="background:url(../x.png)"></div>', BASE)).toEqual([]);
  });
});

describe('decodeHtmlCharRefs(属性值里的字符引用,review P2)', () => {
  it('命名引用:`&` 在属性里必须转义,不解码会取一个不存在的名字', () => {
    expect(decodeHtmlCharRefs('charts/A&amp;B.png')).toBe('charts/A&B.png');
    expect(decodeHtmlCharRefs('a&lt;b&gt;c&quot;d&apos;e')).toBe('a<b>c"d\'e');
  });

  it('十进制与十六进制数字引用', () => {
    expect(decodeHtmlCharRefs('a&#38;b')).toBe('a&b');
    expect(decodeHtmlCharRefs('a&#x26;b')).toBe('a&b');
    expect(decodeHtmlCharRefs('&#22909;.png')).toBe('好.png');
  });

  it('表外命名引用 / 非法码点原样保留(fail-closed,猜错会造出不存在的路径)', () => {
    expect(decodeHtmlCharRefs('a&notarealref;b')).toBe('a&notarealref;b');
    expect(decodeHtmlCharRefs('a&#xD800;b')).toBe('a&#xD800;b');   // 代理区
    expect(decodeHtmlCharRefs('a&#1114112;b')).toBe('a&#1114112;b'); // 越界
    expect(decodeHtmlCharRefs('a&#0;b')).toBe('a&#0;b');
  });

  it('无 & 时廉价短路;不做百分号解码(那一步在 resolveHtmlResourcePath)', () => {
    expect(decodeHtmlCharRefs('plain/a.png')).toBe('plain/a.png');
    expect(decodeHtmlCharRefs('a%20b.png')).toBe('a%20b.png');
  });

  it('端到端:带字符引用的属性按解码后的名字取件,回填仍替原样那段', () => {
    const html = '<img src="charts/A&amp;B.png">';
    const refs = collectHtmlLocalResourceRefs(html, BASE);
    expect(refs).toHaveLength(1);
    expect(refs[0].absPath).toBe(`${BASE}/charts/A&B.png`);
    // 区间是原始文本那段,回填替换的是它。
    expect(html.slice(refs[0].start, refs[0].end)).toBe('charts/A&amp;B.png');
    expect(applyHtmlResourceUrls(html, refs, new Map([[refs[0].absPath, 'data:image/png;base64,AAA']])))
      .toBe('<img src="data:image/png;base64,AAA">');
  });
});
