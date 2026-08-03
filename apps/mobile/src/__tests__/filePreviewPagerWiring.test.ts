import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { interceptHtmlNavigation } from '@/session/htmlNavigationPolicy';
import { pathDisplayName } from '@/session/chatPathCandidate';
import { isHtmlFilePreviewCandidate } from '@/session/filePreview';

/**
 * 源码契约用例的统一读法:**必须把 CRLF 归一成 LF**。
 *
 * Windows CI 的 checkout 走 `core.autocrlf=true`,而 .gitattributes 只给
 * `.sh` / `.mjs` / `.githooks/**` / migration `.sql` 钉了 `eol=lf` —— `.tsx` 不在其中,
 * 于是 runner 上读到的源码是 CRLF。任何跨行的字面量或含 `\n` 的正则断言不归一就只在
 * Windows 上红(实捉:head c6527c24 的 `Windows unit tests (1/2)` 卡在一条 `visible ? (\n…`
 * 断言上,Linux 全绿)。断言本意是代码结构,与行尾无关,所以在读入口一次性抹平。
 */
function readSource(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');
}

const source = readSource('app/files/preview/[sessionId].tsx');

describe('remote file preview pager wiring', () => {
  it('reserves horizontal gestures for the PDF WebView', () => {
    expect(source).toContain("current.previewKind !== 'pdf'");
  });

  it('HTML 渲染态同样让出外层横滑,让内层 WebView 能横向平移', () => {
    // 固定宽度布局 / 放大后需要横向平移,pager 抢走手势就永远看不到超出视口的内容。
    expect(source).toContain("scrollEnabled={current.previewKind !== 'pdf' && htmlPanPageKey !== current.key}");
    // 让路状态按页 key 存,不存布尔:翻页时新旧两页的上报先后顺序不能决定结果。
    expect(source).toContain('setHtmlPanPageKey((prev) => (wants ? key : (prev === key ? null : prev)))');
    // 只有真的挂着 WebView 的那种组合才要横滑;cleanup 必须无条件归还。
    expect(source).toContain("visible && richKind === 'html' && richView === 'rendered' && state.status === 'ready'");
    expect(source).toContain('return () => onHtmlPanChange?.(item.key, false)');
  });

  it('keeps ordinary PDF gestures out of WebView remount and reload triggers', () => {
    expect(source).toContain("item.previewKind === 'pdf' ? item.key : `${item.key}:${recoveryEpoch}`");
    expect(source).not.toContain('keyExtractor={(item) => `${item.key}:${pageIndex}');
    expect(source).not.toContain('<WebView key=');
    expect(source).toContain('const pdfSource = useMemo(() => (url ? { uri: url } : null), [url]);');
    expect(source).toContain('<WebView source={pdfSource}');
  });

  it('retries a failed PDF after device recovery without remounting a loaded WebView', () => {
    expect(source).toContain('requestedAtRecoveryEpochRef.current >= recoveryEpoch');
    expect(source).toContain('setRequestEpoch((epoch) => epoch + 1)');
  });
});

const htmlReaderSource = readSource('src/session/HtmlFileReader.tsx');
const source_reader = htmlReaderSource;
const navPolicySource = readSource('src/session/htmlNavigationPolicy.ts');

describe('HTML 渲染态的 WebView 约束', () => {
  it('显式给 baseUrl,不吃两端默认值不一致(Android 空串会吞掉页内锚点)', () => {
    expect(htmlReaderSource).toContain("source={{ baseUrl: 'about:blank', html: guardedHtml }}");
  });

  it('回调是唯一导航决策点:originWhitelist 不得收窄', () => {
    expect(htmlReaderSource).toContain('onShouldStartLoadWithRequest={interceptNavigation}');
    // 载体只负责传闩,判定在纯策略模块里(便于行为级用例)。
    expect(htmlReaderSource).toContain('interceptHtmlNavigation(request, documentSettledRef.current)');
    // 收窄成 ['about:blank'] 会让 RNW 在回调**之前**拒掉非白名单 URL,并把它交给
    // RN Linking 让系统处理 —— tel: / mailto: / 自定义 scheme 会拉起外部应用,
    // 整段策略被绕过(review P2 实捉)。必须放到 '*' 让回调拿到全部请求。
    expect(htmlReaderSource).toContain("originWhitelist={['*']}");
    expect(htmlReaderSource).not.toContain("originWhitelist={['about:blank']}");
  });

  it('Android 多窗口必须关闭:window.open / target=_blank 不经过导航回调', () => {
    // 留着默认支持时这两条路走 onCreateWindow,整个绕过 click 门与 scheme 拒绝(review P1)。
    expect(htmlReaderSource).toContain('setSupportMultipleWindows={false}');
  });

  it('Android 关掉 file:// 读取能力(不可信页面不得探测 app 沙盒)', () => {
    expect(htmlReaderSource).toContain('allowFileAccess={false}');
  });

  it('零出网信道:连用户点击的 http(s) 外链也不外送', () => {
    // 导航回调**只管导航**,`new Image().src` / `fetch` 这类子资源请求完全不经过它 ——
    // 出网必须由 CSP 在引擎层关掉(见 htmlPreviewCsp)。这里关的是另一半:顶层跳转。
    // 连「用户点击的外链」也不放:页面里有从被控端取回的内容,脚本能把它拼进一个真实
    // <a href> 让用户去点,CSP 管不到顶层导航(navigate-to 已从 CSP3 移除)(review P1)。
    //
    // 判据写成「模块既不 import 也不调用 Linking」:比检查某个分支更难绕过。
    // (注意别写成 /Linking/ —— 头注里本来就在解释「为什么不用 Linking」,会自我命中。)
    expect(htmlReaderSource).toContain("import { StyleSheet, View } from 'react-native';");
    expect(htmlReaderSource).not.toMatch(/\bLinking\.\w/);
    // 回调必须以无条件拒绝收尾(默认拒绝,不是默认放行)。
    const decision = /export function interceptHtmlNavigation[\s\S]*?\n\}/.exec(navPolicySource);
    expect(decision, '未找到导航决策函数').not.toBeNull();
    expect(decision![0].trimEnd().endsWith('return false;\n}')).toBe(true);
    // **不得**放行整个 about:* —— 那会让页面把自己导航到 about:blank、换掉加固过的文档。
    // 注意别写成裸字符串 —— 头注里正在解释「为什么不再这么做」,会自我命中(第 5 次踩)。
    // 只禁代码形态:整段 about: 前缀放行的 return。
    expect(navPolicySource).not.toMatch(/if\s*\(.*startsWith\('about:'\).*\)\s*return true/);
    // 策略模块必须保持无 RN 运行时依赖(否则契约用例又只能读源码字符串)。
    expect(navPolicySource).not.toMatch(/^import \{[^}]*\} from 'react-native'/m);
    // onMessage 缺席是刻意的:不给任意生成物一条通向 RN 的桥。
    // 只匹配 JSX 属性形态 —— 头注里说明「不挂 onMessage」的那句话不算挂上。
    expect(htmlReaderSource).not.toMatch(/onMessage\s*=/);
  });

  it('可执行 WebView 只为真正可见的当前页挂载', () => {
    // 相邻预取页(active)不得提前挂 WebView:里面的脚本 / 计时器 / 网络请求会在
    // 用户还没打开该文件时就跑起来,滑走后还继续跑(review P1)。
    //
    // 断言写成空白宽松的正则而不是跨行字面量:意图是「visible 直接包住 HtmlFileReader,
    // 中间没有夹别的东西」,与缩进、行尾都无关(见 readSource 的 CRLF 说明)。
    expect(source).toMatch(/visible\s*\?\s*\(\s*<HtmlFileReader/);
    expect(source).toContain('testID="filePreview.htmlOffscreen"');
    // 挂载门必须是 visible 而不是 active。
    expect(source).not.toMatch(/active\s*\?\s*\(\s*<HtmlFileReader/);
  });

  it('挂载门含屏级焦点,本屏被压栈后脚本不再跑', () => {
    // 深链进预览 → 点「发送到会话」→ router.navigate 把会话页推到根 Stack:
    // 预览路由默认仍挂载、pageIndex 也不变,只看 pageIndex 的话 WebView 会在用户
    // 已经回到对话界面之后继续执行脚本 / 计时器 / 网络请求(review P1 第二轮)。
    expect(source).toContain('visible={screenFocused && index === pageIndex}');
    expect(source).toContain('const screenFocused = useIsFocused()');
    // 用 expo-router 的再导出,不新增依赖 —— apps/mobile 的依赖是 runtime fingerprint
    // 输入,加包会触发冷更门(见 docs/dev-rules/mobile-development.md)。
    expect(source).toMatch(/import \{[^}]*useIsFocused[^}]*\} from 'expo-router'/);
  });
});

describe('HTML 生成物的渲染态接线', () => {
  it('渲染态复用已读文本,不为 HTML 另走一遍 OSS 导出', () => {
    // 取件通道保持一条:richKind 非空时才留原文,渲染态直接把它喂 HtmlFileReader。
    expect(source).toContain('content: richKind ? content : undefined');
    expect(source).toContain("<HtmlFileReader html={state.content ?? ''}");
    // HTML 不得混进 exportToUrl 那条(图片 / PDF / 音视频 / 下载共用的)导出链路。
    expect(source).not.toMatch(/HtmlFileReader[^>]*exportToUrl/);
  });

  it('markdown 与 HTML 共用同一套双态机(不再是 markdown 专用)', () => {
    expect(source).toContain("const richKind = richTextKindOf(item.relPath)");
    expect(source).toContain("useState<'rendered' | 'source'>(richKind ? 'rendered' : 'source')");
    // 双态切换只在这两类文本上出现,其余仍恒为源码态。
    expect(source).toContain("const canRenderRich = richKind !== null && typeof state.content === 'string'");
  });

  it('进 WebView 的判定必须吃 relPath(真实路径),不得吃 name(展示名)', () => {
    // review P1 第三轮,同一根因的**调用方**入口:`absPathItem` 的 name 走 pathDisplayName,
    // 它 split(/[\\/]/).filter(Boolean) 会把 macOS/Linux 上合法的 `report.html\` 削成
    // `report.html` —— 判定函数内部再严也拿不回上游丢掉的字符。relPath 两种模式下都是
    // 未归一化的真实路径,所以判定一律以它为输入。
    expect(source).toContain('richTextKindOf(item.relPath)');
    expect(source).toContain('avKindFor(item.relPath)');
    // 不许有任何一处判定回退到 name(这两个写法就是上一版的漏洞形态)。
    expect(source).not.toContain('richTextKindOf(item.name)');
    expect(source).not.toContain('avKindFor(item.name)');
    // pathDisplayName 仍只用于展示(标题栏 / 合成 item 的 name),不得进判定。
    expect(source).not.toMatch(/richTextKindOf\(\s*pathDisplayName/);
    expect(source).not.toMatch(/isHtmlFilePreviewCandidate\(\s*pathDisplayName/);
  });

  it('行为级证据:pathDisplayName 会削掉尾随反斜杠,足以让非 HTML 文件冒充 HTML', () => {
    // 上面那条是源码守卫(防写法回归),这条是**行为**证据 —— 证明这两个入参不等价、
    // 且差异恰好落在「进不进可执行 WebView」上,而不是只在措辞上不同。
    const posixTrailingBackslash = '/repo/report.html\\'; // macOS / Linux 上的合法文件名
    // 归一化后 `\` 消失 → 冒充成 .html。
    expect(pathDisplayName(posixTrailingBackslash)).toBe('report.html');
    expect(isHtmlFilePreviewCandidate(pathDisplayName(posixTrailingBackslash))).toBe(true);
    // 直接吃真实路径 → 最后一段为空 → fail-closed,不进渲染态。
    expect(isHtmlFilePreviewCandidate(posixTrailingBackslash)).toBe(false);
    // 正常路径两条路结论一致(修复没有把正常文件挡在外面)。
    expect(isHtmlFilePreviewCandidate('/repo/report.html')).toBe(true);
    expect(isHtmlFilePreviewCandidate(pathDisplayName('/repo/report.html'))).toBe(true);
    // Windows 被控端的正常形态照旧可进(`\` 在那里是真分隔符)。
    expect(isHtmlFilePreviewCandidate('C:\\proj\\report.html')).toBe(true);
  });

  it('HTML 判定取共享层口径,不在页面里另写一份扩展名表', () => {
    expect(source).toContain('isHtmlFilePreviewCandidate');
    expect(source).not.toMatch(/\/\\\.\(html\|htm/);
  });
});

describe('导航门:只放行同文档锚点与首份文档加载(review P1)', () => {
  it('同文档锚点放行 —— 不替换文档,CSP 与能力剥离都还在', () => {
    for (const settled of [false, true]) {
      expect(interceptHtmlNavigation({ url: 'about:blank#toc' } as never, settled)).toBe(true);
      expect(interceptHtmlNavigation({ url: 'about:blank#a/b' } as never, settled)).toBe(true);
    }
  });

  it('首份文档加载放行一次,上闩之后 about:blank 一律拒绝', () => {
    // 早先 `startsWith('about:')` 一律放行 → 页面能把自己导航到 about:blank,新文档不再
    // 经过 withHtmlPreviewCsp,iOS 侧原生 RTCPeerConnection 复活(review P1)。
    expect(interceptHtmlNavigation({ url: 'about:blank' } as never, false)).toBe(true);
    expect(interceptHtmlNavigation({ url: '' } as never, false)).toBe(true);
    expect(interceptHtmlNavigation({ url: 'about:blank' } as never, true)).toBe(false);
    expect(interceptHtmlNavigation({ url: '' } as never, true)).toBe(false);
  });

  it('其它 about: 形态一律拒绝(不再整段放行)', () => {
    for (const settled of [false, true]) {
      for (const url of ['about:srcdoc', 'about:config', 'about:blank?x=1', 'ABOUT:BLANK']) {
        expect(interceptHtmlNavigation({ url } as never, settled)).toBe(false);
      }
    }
  });

  it('http(s) / 自定义 scheme / file 一律拒绝,与闩状态无关', () => {
    for (const settled of [false, true]) {
      for (const url of [
        'https://evil.example/?d=x', 'http://x', 'file:///etc/passwd',
        'tel:123', 'mailto:a@b.c', 'intent://x', 'javascript:alert(1)',
      ]) {
        expect(interceptHtmlNavigation({ url } as never, settled)).toBe(false);
      }
    }
  });

  it('闩由 onLoadEnd 合上,换 html 时重置(渲染期比对,不用弱 key)', () => {
    expect(source_reader).toContain('onLoadEnd={() => { documentSettledRef.current = true; }}');
    expect(source_reader).toContain('lastHtmlRef.current !== guardedHtml');
    expect(source_reader).toContain('documentSettledRef.current = false');
    // 不得退回用长度当 key 的弱判据。
    expect(source_reader).not.toContain('key={guardedHtml.length}');
  });
});
